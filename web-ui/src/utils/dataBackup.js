/**
 * 数据备份（一键导出 / 一键导入）的纯逻辑层。
 *
 * 后端契约（`agent-core/src/routes/data.js`）：
 *   GET  /api/data/export?includeConfig=0|1 → 200 二进制 `.tar.gz`
 *        响应头 `Content-Disposition: attachment; filename="linshe-backup-<YYYYMMDD-HHmm>.tar.gz"`
 *   GET  /api/data/export/info → { ok, dbBytes, counts:{characters,messages,groups,memories}, lastExportAt }
 *        · dbBytes 是**估算上界**（库文件 + WAL），文案里绝不能写「精确」
 *   POST /api/data/import       → body 为归档原始字节（Content-Type: application/gzip）
 *        200 { ok, restored:{files,bytes,counts}, backupPath, restartRecommended, message }
 *        400/413/500 { error, detail, backupPath? }（500 会带 backupPath，必须显示出来给用户留退路）
 *
 * 这里只放不依赖 Vue / DOM 的纯函数，便于 `node --test` 直接覆盖；
 * 真正的 fetch / 下载触发在 `src/api/index.js`，页面只做接线。
 */

/** 单次导入的大小上限：与后端 LINSHE_BACKUP_MAX_BYTES 的默认值保持一致（2GiB） */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024

/** 可接受的归档后缀（大小写不敏感） */
const ARCHIVE_SUFFIX = /\.(?:tar\.gz|tgz|gz)$/i

const UNIT_BYTES = 1024

/** 字节数 → 人话（B / KB / MB / GB，KB 以上保留一位小数、整数去掉 .0） */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '—'
  const n = typeof bytes === 'number' ? bytes : Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < UNIT_BYTES) return `${Math.round(n)} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / UNIT_BYTES
  let index = 0
  while (value >= UNIT_BYTES && index < units.length - 1) {
    value /= UNIT_BYTES
    index += 1
  }
  const text = value.toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text} ${units[index]}`
}

const two = n => String(n).padStart(2, '0')

/** 与后端同名规则：linshe-backup-<YYYYMMDD-HHmm>.tar.gz（下载头拿不到时的兜底文件名） */
export function defaultBackupFileName(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
  return `linshe-backup-${stamp}.tar.gz`
}

/**
 * 从 `Content-Disposition` 里取文件名。
 * 支持 `filename="..."` / `filename=...` / RFC 5987 的 `filename*=UTF-8''...`；
 * 带路径的（恶意或代理改写）只取最后一段，取不到就用 fallback。
 */
export function parseBackupFileName(contentDisposition, fallback = '') {
  const header = typeof contentDisposition === 'string' ? contentDisposition : ''
  if (!header.trim()) return fallback

  let name = ''
  // 先认 filename*（带编码），它比 filename 更权威
  const extended = header.match(/filename\*\s*=\s*([^;]+)/i)
  if (extended) {
    let raw = extended[1].trim().replace(/^"|"$/g, '')
    const charsetMatch = raw.match(/^([^']*)'[^']*'(.*)$/)
    if (charsetMatch) raw = charsetMatch[2]
    try {
      name = decodeURIComponent(raw)
    } catch {
      name = raw
    }
  }
  if (!name) {
    const plain = header.match(/filename\s*=\s*("([^"]*)"|([^;]+))/i)
    if (plain) name = (plain[2] ?? plain[3] ?? '').trim()
  }
  if (!name) return fallback

  // 只取最后一段路径，挡住 `..\..\x.tar.gz` 这类写法混进 download 属性
  const base = name.split(/[\\/]/).pop() || ''
  return base.trim() || fallback
}

/** 条数：非数字一律显示 —（后端找不到表时会给 null） */
function countText(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n < 0) return '—'
  return String(Math.round(n))
}

/** 上次导出时间：完整日期，避免「09:26」这种看不出哪天的写法 */
export function formatLastExport(iso, now = new Date()) {
  if (typeof iso !== 'string' || iso.trim() === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  const day = d.getFullYear() === ref.getFullYear()
    ? `${two(d.getMonth() + 1)}-${two(d.getDate())}`
    : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
  return `上次导出 ${day} ${time}`
}

/** 次数统计拼成一段（导出摘要与导入回执共用口径） */
export function countsText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {}
  return [
    `角色 ${countText(c.characters)}`,
    `消息 ${countText(c.messages)}`,
    `群聊 ${countText(c.groups)}`,
    `记忆 ${countText(c.memories)}`,
  ].join(' · ')
}

/**
 * `GET /api/data/export/info` → 设置页那行摘要。
 * 大小一定写成「预计大小 …（估算上界）」：dbBytes 只是库文件 + WAL 的估算，不是最终归档体积。
 */
export function formatExportSummary(info, now = new Date()) {
  const data = info && typeof info === 'object' ? info : null
  if (!data) return '暂无可用数据'
  const parts = [countsText(data.counts)]
  if (data.dbBytes !== null && data.dbBytes !== undefined) {
    parts.push(`预计大小 ${formatBytes(data.dbBytes)}（估算上界）`)
  }
  const last = formatLastExport(data.lastExportAt, now)
  if (last) parts.push(last)
  return parts.join(' · ')
}

/**
 * 上传前的本地预检：文件在、后缀对、不是空文件、不超过上限。
 * @returns {{ok:boolean, code:'ok'|'missing'|'suffix'|'empty'|'too-large', reason:string}}
 */
export function validateImportFile(file, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_IMPORT_BYTES
  if (!file || typeof file !== 'object' || typeof file.name !== 'string' || !file.name.trim()) {
    return { ok: false, code: 'missing', reason: '请先选择要导入的备份文件' }
  }
  if (!ARCHIVE_SUFFIX.test(file.name.trim())) {
    return { ok: false, code: 'suffix', reason: '只支持 .tar.gz / .tgz / .gz 的备份文件' }
  }
  const size = Number(file.size)
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, code: 'empty', reason: '这个文件是空的，无法导入' }
  }
  if (size > limit) {
    return {
      ok: false,
      code: 'too-large',
      reason: `文件 ${formatBytes(size)} 超过 ${formatBytes(limit)} 上限，无法导入`,
    }
  }
  return { ok: true, code: 'ok', reason: '' }
}

/** 导入回执里的 restored → 人话（文件数 / 字节数 / 各类条数） */
export function restoredText(restored) {
  const data = restored && typeof restored === 'object' ? restored : null
  if (!data) return ''
  const parts = []
  const files = Number(data.files)
  if (Number.isFinite(files) && files > 0) parts.push(`${Math.round(files)} 个文件`)
  if (data.bytes !== null && data.bytes !== undefined) parts.push(formatBytes(data.bytes))
  const head = parts.length ? `已恢复 ${parts.join(' / ')}` : '已恢复数据'
  const counts = data.counts && typeof data.counts === 'object' ? `；${countsText(data.counts)}` : ''
  return `${head}${counts}`
}

/** 导入成功的 toast 文案（restartRecommended 为真时补一句建议重启） */
export function importSuccessText(result) {
  const data = result && typeof result === 'object' ? result : {}
  const message = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : '备份已导入'
  return data.restartRecommended ? `${message}；建议重启应用` : message
}

/** 导入失败的 toast 文案：带 backupPath 时把路径写出来，让用户知道回滚到哪 */
export function importFailureText(err) {
  const message = err && err.message ? String(err.message) : '导入失败'
  const backupPath = err && typeof err.backupPath === 'string' ? err.backupPath.trim() : ''
  return backupPath ? `${message}；导入前的数据已自动备份到 ${backupPath}` : message
}
