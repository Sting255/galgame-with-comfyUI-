/**
 * 亲密看板的纯逻辑层（无 Vue 依赖，可被 node:test 直接引入）。
 *
 * 只放「与渲染无关」的口径换算：
 *   - AI 修改权限字段的默认值与清洗
 *   - 统计口径（viewScope）↔ 后端 partnerKinds query 的互转
 *   - 敏感部位增删 / 排序 / 等级映射（文案、宽度、色阶 token）
 *   - 体位排行取 TopN、次数与时间格式化
 *   - AI 判断行为的每日配额（0 = 不限制）与手动补判回执文案
 * 组件 IntimatePanel.vue 只负责把这里的结果画出来。
 */

/** 敏感部位等级上限（与后端 parseZones 的 clampInt(...,0,5) 对齐） */
export const ZONE_MAX_LEVEL = 5
/** 后端字段长度限制（intimateService.parseZones）：key ≤32、label ≤24 */
export const ZONE_KEY_MAX = 32
export const ZONE_LABEL_MAX = 24

// ── AI 修改权限 ──

/** 允许 AI 修改的字段清单；stats 是唯一默认开启项（口径与后端默认值一致） */
export const AI_EDIT_FIELD_DEFS = Object.freeze([
  { key: 'body', label: '身体信息', desc: '身高 / 三围 / 罩杯' },
  { key: 'sensitiveZones', label: '部位敏感度', desc: '敏感部位与等级' },
  { key: 'note', label: '身体备注', desc: '档案备注文本' },
  { key: 'firsts', label: '初次信息', desc: '初次 / 破处时间' },
  { key: 'stats', label: '统计数据', desc: '次数、排名等结算数据' },
])

export const AI_EDIT_FIELD_KEYS = Object.freeze(AI_EDIT_FIELD_DEFS.map(d => d.key))
export const DEFAULT_AI_EDIT_FIELDS = Object.freeze(['stats'])

/**
 * 清洗 AI 修改权限：过滤未知键与重复项，并按清单顺序归一。
 *
 * 与后端 same 语义（intimateService.normalizeAiEditFields，权限判定 fail-closed）：
 *   - 字段缺省（undefined / null）＝用户没表过态 → 默认 ['stats']
 *   - 显式空数组 ＝ 用户把 AI 权限全关掉 → 保持空，不要偷偷回填默认
 *   - 其它脏值（字符串 / 对象）→ 空（不给权限）
 */
export function normalizeAiEditFields(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_AI_EDIT_FIELDS]
  if (!Array.isArray(raw)) return []
  const set = new Set(raw.map(v => String(v || '').trim()).filter(k => AI_EDIT_FIELD_KEYS.includes(k)))
  return AI_EDIT_FIELD_KEYS.filter(k => set.has(k))
}

/**
 * 切换单个权限键，返回新的清单（保持清单顺序，不受点击顺序影响）。
 * 与 normalizeAiEditFields 的差别：这里尊重空的选集合（用户可以把 AI 权限全关掉，
 * 而读取服务端数据时空值才回落默认 ['stats']）。
 */
export function toggleAiEditField(list, key) {
  const base = Array.isArray(list) ? list.map(v => String(v || '').trim()) : []
  const current = new Set(base.filter(k => AI_EDIT_FIELD_KEYS.includes(k)))
  if (current.has(key)) current.delete(key)
  else if (AI_EDIT_FIELD_KEYS.includes(key)) current.add(key)
  return AI_EDIT_FIELD_KEYS.filter(k => current.has(k))
}

// ── 统计口径（viewScope ↔ partnerKinds） ──

/** 口径选项的键与后端 partner_kind 取值同名，可直接拼 query */
export const VIEW_SCOPE_DEFS = Object.freeze([
  { key: 'user', label: '用户↔角色' },
  { key: 'character', label: '角色↔角色' },
  { key: 'npc', label: '小镇NPC' },
])

export const VIEW_SCOPE_KEYS = Object.freeze(VIEW_SCOPE_DEFS.map(d => d.key))
/** 默认统计「用户↔角色 + 角色↔角色」（与后端 DEFAULT_VIEW_SCOPE 一致，群聊行为默认可见） */
export const DEFAULT_VIEW_SCOPE = Object.freeze(['user', 'character'])
/** 「看全部」＝勾选三类（后端不接受空数组，也不接 'all' 逃生门） */
export const ALL_VIEW_SCOPE = VIEW_SCOPE_KEYS

/**
 * 清洗口径：未知键丢弃、按清单顺序归一；
 * 空数组 / 非法值一律回落到默认口径（后端同样把空规范化成默认口径）。
 */
export function normalizeViewScope(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_VIEW_SCOPE]
  const set = new Set(raw.map(v => String(v || '').trim()).filter(k => VIEW_SCOPE_KEYS.includes(k)))
  const out = VIEW_SCOPE_KEYS.filter(k => set.has(k))
  return out.length ? out : [...DEFAULT_VIEW_SCOPE]
}

/** 是否已勾满三类（用于「全部」chip 的选中态） */
export function isAllViewScope(list) {
  const scope = normalizeViewScope(list)
  return VIEW_SCOPE_KEYS.every(k => scope.includes(k))
}

/**
 * 切换单个口径。取消最后一个时不允许归零：回退为默认口径并标记 clamped，
 * 由 UI 提示一次「至少保留一个统计口径」（避免取消勾选反而看到更多数据）。
 * @returns {{ scope: string[], clamped: boolean }}
 */
export function viewScopeToggleResult(list, key) {
  const current = new Set(normalizeViewScope(list))
  if (!VIEW_SCOPE_KEYS.includes(key)) return { scope: normalizeViewScope(list), clamped: false }
  if (current.has(key)) {
    if (current.size <= 1) return { scope: [...DEFAULT_VIEW_SCOPE], clamped: true }
    current.delete(key)
  } else {
    current.add(key)
  }
  return { scope: VIEW_SCOPE_KEYS.filter(k => current.has(k)), clamped: false }
}

/** 切换单个口径，返回新的口径数组（忽略 clamped 标记时用） */
export function toggleViewScope(list, key) {
  return viewScopeToggleResult(list, key).scope
}

/** 口径 → 后端 GET /log 的 partnerKinds query（逗号分隔，永不提交空数组） */
export function viewScopeToPartnerKinds(scope) {
  return normalizeViewScope(scope).join(',')
}

/**
 * 后端 partnerKinds（字符串或数组）→ 口径数组。
 * 空值回落默认 ['user','character']（DEFAULT_VIEW_SCOPE）；'all' 是后端调试逃生门，只在回读时当作全选，面板不会提交它。
 */
export function partnerKindsToViewScope(raw) {
  if (Array.isArray(raw)) return normalizeViewScope(raw)
  const text = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!text) return [...DEFAULT_VIEW_SCOPE]
  if (text === 'all') return [...VIEW_SCOPE_KEYS]
  return normalizeViewScope(text.split(','))
}

// ── 敏感部位 ──

function zoneKey(label, index = 0) {
  const text = String(label || '').trim()
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ZONE_KEY_MAX)
  if (ascii) return ascii
  // 中文部位名无法 slug 时直接用名称当 key（后端 key 上限 32 字符，放得下）
  if (text) return text.slice(0, ZONE_KEY_MAX)
  // 连名字都还没填的占位行用序号兜底，保存时会被真正的 key 替换
  return `zone-${index + 1}`
}

/** 清洗部位列表：等级夹到 0~5、补 key，按等级降序（同级按名称）排列；空行保留（编辑中） */
export function normalizeZones(raw) {
  return withDerivedZoneKeys(raw, { keepEmpty: true }).sort(compareZones)
}

/** 落库用：丢掉用户没填 label 的空行，其余同上 */
export function zonesForSave(raw) {
  return withDerivedZoneKeys(raw, { keepEmpty: false }).sort(compareZones)
}

/**
 * key 补齐：占位 key（zone-1…）用 label 的 slug 替换，重复 key 加序号。
 * 编辑过程中不改 key（避免 v-for 重建导致输入框失焦），只在保存 / 载入时归一。
 */
export function withDerivedZoneKeys(raw, { keepEmpty = true } = {}) {
  const seen = new Set()
  return (Array.isArray(raw) ? raw : [])
    .map((z, i) => {
      const label = String(z?.label || '').trim().slice(0, ZONE_LABEL_MAX)
      const rawKey = String(z?.key || '').trim().slice(0, ZONE_KEY_MAX)
      const isPlaceholder = !rawKey || /^zone-\d+$/.test(rawKey)
      const base = isPlaceholder ? zoneKey(label, i) : rawKey
      let key = base
      let n = 2
      while (seen.has(key)) {
        key = `${base}-${n}`.slice(0, ZONE_KEY_MAX)
        n += 1
      }
      seen.add(key)
      return { key, label, level: clampLevel(z?.level), filled: !!label }
    })
    .filter(z => keepEmpty || z.filled)
    .map(z => ({ key: z.key, label: z.label, level: z.level }))
}

function compareZones(a, b) {
  if (b.level !== a.level) return b.level - a.level
  return String(a.label).localeCompare(String(b.label), 'zh-Hans-CN')
}

/** 等级夹取：非法值当 0 */
export function clampLevel(level) {
  const n = Number(level)
  if (!Number.isFinite(n)) return 0
  return Math.min(ZONE_MAX_LEVEL, Math.max(0, Math.round(n)))
}

/** 追加一个空部位（追加在末尾，不重排，避免刚加的行跳走；排序交给落库载荷） */
export function addZone(list) {
  const current = Array.isArray(list) ? list : []
  const used = new Set(current.map(z => String(z?.key || '')))
  let i = current.length + 1
  let key = `zone-${i}`
  while (used.has(key)) { i += 1; key = `zone-${i}` }
  return [...current, { key, label: '', level: 3 }]
}

/** 按 key 删除（key 缺省时不删，避免误删第一行） */
export function removeZone(list, key) {
  const current = Array.isArray(list) ? list : []
  if (key == null || key === '') return normalizeZones(current)
  return normalizeZones(current.filter(z => String(z?.key || '') !== String(key)))
}

/**
 * 等级 → 文案（0~5 六档）
 * **权威口径**与后端一致：intimateAiEdit 的 ZONE_LEVEL_TEXT 与 intimatePrompt 的 ZONE_LEVEL_LABELS
 * 都是 level 1~5 = 轻微/一般/较强/很强/极强；level 0 = 未评级（后端不注入）。
 * 三处必须用同一套文案，否则同一部位在「敏感度条带」与「AI 提议预览」里会显示不同档位名。
 */
const ZONE_LEVEL_LABELS = ['未评级', '轻微', '一般', '较强', '很强', '极强']
export function zoneLevelLabel(level) {
  return ZONE_LEVEL_LABELS[clampLevel(level)]
}

/** 等级 → 横向色带宽度百分比（0 级仍留 4% 让用户看到这一行存在） */
export function zoneLevelPercent(level) {
  const lv = clampLevel(level)
  if (lv <= 0) return 4
  return Math.round((lv / ZONE_MAX_LEVEL) * 100)
}

/** 等级 → 色阶 token（只能用现有 --fun-* / --accent，随主题联动） */
const ZONE_LEVEL_TOKENS = [
  'var(--fun-neutral)',
  'var(--fun-blue)',
  'var(--fun-teal)',
  'var(--fun-gold)',
  'var(--fun-orange)',
  'var(--fun-pink)',
]
export function zoneLevelToken(level) {
  return ZONE_LEVEL_TOKENS[clampLevel(level)]
}

/** 等级 → 具体几档可用（滑杆 max） */
export function zoneLevelSteps() {
  return Array.from({ length: ZONE_MAX_LEVEL + 1 }, (_, i) => ({ value: i, label: zoneLevelLabel(i) }))
}

// ── 统计 / 排行 ──

/**
 * 体位排行取前 N。
 *
 * 过滤规则（顺序固定）：
 *   1. 丢掉零次项；
 *   2. **优先只保留出现 ≥2 次的条目**：task-25 的全量测量显示，混进排行的噪声词
 *      （`tile floor`→瓷砖跪口交、`red hair`→办公桌下口交、`mirror`→照镜子、`multiple penis`→多根阴茎…）
 *      几乎都是一次性出现，而真正的体位会随互动反复累计。这是**展示层缓解**：
 *      不改变后端归因口径（`byPosition` 仍返回全量，数据一条不丢），也不动词表索引。
 *   3. 若一条 ≥2 次的都没有（新角色、或只发生过一次），退回显示全部可用条目，
 *      避免刚用起来的角色看到空排行。
 * 排序：次数降序，同级按中文 label；最后按 limit 截断（默认 5）。
 */
export function topPositions(byPosition, limit = 5) {
  if (!Array.isArray(byPosition)) return []
  const rows = byPosition
    .map(p => ({
      positionKey: String(p?.positionKey || ''),
      label: String(p?.label || p?.positionKey || '未知'),
      count: Number(p?.count) || 0,
    }))
    .filter(p => p.count > 0)
    .sort((a, b) => (b.count - a.count) || String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'))
  const repeated = rows.filter(p => p.count >= 2)
  const picked = repeated.length > 0 ? repeated : rows
  return picked.slice(0, Math.max(0, limit))
}

/** 基础统计的键值对（byAct，数值用 --accent 强调；label 用后端给的） */
export function actStatRows(stats) {
  if (!Array.isArray(stats?.byAct)) return []
  return stats.byAct.map(a => ({
    key: String(a?.actKey || ''),
    label: String(a?.label || a?.customLabel || a?.actKey || '未知'),
    count: Number(a?.count) || 0,
    climax: Number(a?.climax) || 0,
    firstAt: a?.firstAt || null,
  }))
}

/** 概要数值（总次数 / 高潮 / 行为种类） */
export function statSummary(stats) {
  return {
    totalActs: Number(stats?.totalActs) || 0,
    totalClimax: Number(stats?.totalClimax) || 0,
    actKinds: Number(stats?.actKinds) || 0,
    firstAt: stats?.firstAt || null,
    lastAt: stats?.lastAt || null,
  }
}

// ── 格式化 ──

/**
 * 后端时间串统一解析：无时区标记的 SQLite UTC 串（"2026-09-28 05:55:59"）按 UTC 解析，
 * 带 Z / ±hh:mm 的原样。历史上 ai-judge 手动补判曾把裸 SQLite 串落库（后端已收口转 ISO），
 * 这里兜住存量数据，否则东八区显示偏 8 小时。与催眠侧 hypnosisLogic 的 parseBackendTime 同口径。
 */
function parseBackendTime(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return null
  // 无时区标记（SQLite datetime('now') 的产物）：补 Z 按 UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    const d = new Date(`${raw.slice(0, 19).replace(' ', 'T')}Z`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** ISO / 日期串 → input[type=date] 需要的 YYYY-MM-DD；空值返回 '' */
export function toDateInput(iso) {
  const text = String(iso == null ? '' : iso).trim()
  if (!text) return ''
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** 日期输入值 → 提交给后端的 firstAt；空串 = 清空（null） */
export function fromDateInput(value) {
  const text = String(value == null ? '' : value).trim()
  return text ? text : null
}

/** ISO → 「MM-DD HH:mm」（流水明细用；无时区 SQLite 串按 UTC 解析，见 parseBackendTime） */
export function formatDateTime(iso) {
  const d = parseBackendTime(iso)
  if (!d) return '—'
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO → 「YYYY-MM-DD」；空值显示占位 */
export function formatDay(iso, fallback = '—') {
  const day = toDateInput(iso)
  return day || fallback
}

/** 流水来源 → 中文标记 */
export function sourceLabel(source) {
  const key = String(source || '').trim().toLowerCase()
  if (key === 'manual') return '人工'
  if (key === 'auto' || key === 'derived' || key === 'prompt') return '自动'
  return key || '自动'
}

// ── AI 整理档案：待确认提议 ──

/** 提议字段 → 中文名（与面板「AI 修改权限」的复选键一一对应） */
export const SUGGESTION_FIELD_LABELS = Object.freeze({
  body: '身体信息',
  sensitiveZones: '敏感带',
  note: '备注',
  firsts: '初次',
  stats: '统计数据',
})

/** body 字段内部的子键 ↔ 中文名（用于把 JSON 建议渲染成人话） */
const BODY_FIELD_LABELS = Object.freeze([
  ['height', '身高'],
  ['bust', '胸围'],
  ['waist', '腰围'],
  ['hip', '臀围'],
  ['cup', '罩杯'],
])

export function suggestionFieldLabel(field) {
  const key = String(field == null ? '' : field).trim()
  return SUGGESTION_FIELD_LABELS[key] || key || '未知字段'
}

/** 尝试把提议里的文本解析成数组 / 对象；不是 JSON 就返回 null */
function parseJsonValue(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return null
  if (text[0] !== '[' && text[0] !== '{') {
    // 后端可能把数组存成不带括号的多行文本，这里不做猜测
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把提议的 currentValue / suggestion 渲染成人话。
 * 后端这两列都是 TEXT（对象 / 数组会被 JSON.stringify 存进去），直接展示会是一坨 JSON。
 * @param {string} field body / sensitiveZones / note / firsts
 * @param {unknown} raw 原始文本或对象
 * @param {{maxChars?:number, actLabels?:Map<string,string>|Record<string,string>}} [opts]
 */
export function formatSuggestionValue(field, raw, opts = {}) {
  const key = String(field == null ? '' : field).trim()
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 120
  const actLabels = opts.actLabels instanceof Map ? opts.actLabels : new Map(Object.entries(opts.actLabels || {}))

  const parsed = typeof raw === 'object' && raw !== null ? raw : parseJsonValue(raw)
  const text = typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : String(raw == null ? '' : raw).trim()

  if (key === 'body') {
    const obj = parsed && !Array.isArray(parsed) ? parsed : null
    if (obj) {
      const parts = BODY_FIELD_LABELS
        .map(([k, label]) => [label, String(obj[k] == null ? '' : obj[k]).trim()])
        .filter(([, value]) => value)
        .map(([label, value]) => `${label} ${value}`)
      return parts.length ? parts.join('、') : '（空）'
    }
  }

  if (key === 'sensitiveZones') {
    const list = Array.isArray(parsed) ? parsed : null
    if (list) {
      const parts = list
        .map(z => {
          const name = String(z?.label || z?.key || '').trim()
          if (!name) return ''
          return `${name}（${zoneLevelLabel(z?.level)}）`
        })
        .filter(Boolean)
      return parts.length ? parts.join('、') : '（空）'
    }
  }

  if (key === 'firsts') {
    const list = Array.isArray(parsed) ? parsed : null
    if (list) {
      const parts = list
        .map(f => {
          const actKey = String(f?.actKey || '').trim()
          if (!actKey) return ''
          const name = actLabels.get(actKey) || actKey
          const day = toDateInput(f?.firstAt)
          return day ? `${name} ${day}` : name
        })
        .filter(Boolean)
      return parts.length ? parts.join('、') : '（空）'
    }
  }

  if (!text) return '（空）'
  if (Array.isArray(parsed) && parsed.length === 0) return '（空）'
  if (parsed && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return '（空）'
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/**
 * 清洗待确认提议列表：兼容 camelCase / snake_case，只保留 status='pending'，
 * 并预先算好中文字段名与「当前值 → 建议值」的展示文本。
 *
 * 后端（intimateAiEdit.rowToSuggestion）已经返回可读的 suggestion / currentValue 预览串与
 * fieldLabel；这里优先沿用服务端的串，只有拿到机器载荷（JSON）时才自己格式化兜底。
 */
export function normalizeSuggestions(raw, opts = {}) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .map((item, index) => {
      const field = String(item?.field || '')
      const currentValue = item?.currentValue ?? item?.current_value ?? ''
      const suggestion = item?.suggestion ?? ''
      return {
        id: item?.id ?? item?.sid ?? index,
        field,
        fieldLabel: String(item?.fieldLabel || '').trim() || suggestionFieldLabel(field),
        currentValue,
        suggestion: String(suggestion),
        reason: String(item?.reason || ''),
        status: String(item?.status || 'pending').toLowerCase(),
        createdAt: item?.createdAt || item?.created_at || '',
        currentText: formatSuggestionValue(field, currentValue, opts),
        suggestionText: formatSuggestionValue(field, suggestion, opts),
      }
    })
    .filter(item => item.status === 'pending')
}

/** 整理结果 → Toast 文案（已应用 N 项 / 没有可应用的字段） */
export function aiEditResultText(result) {
  if (result?.empty) return '最近的对话内容太少，暂时整理不出档案'
  const applied = Array.isArray(result?.applied) ? result.applied.length : 0
  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions.length : 0
  if (applied > 0) return `已更新 ${applied} 项档案`
  if (suggestions > 0) return '有字段需要你确认，已放进待确认提议'
  return '整理完成，没有可更新的档案'
}

/**
 * 回填状态常量（后端 task-4 的引擎沿用这套取值）
 * 6 态：idle 未开始 / running 进行中 / partial 受预算限制未扫完（可继续）/ done 完成 /
 *       blocked 角色未授权 stats（引擎停线且不推进游标，重新授权后可重扫）/ error 出错
 */
export const BACKFILL_STATUS = Object.freeze({
  idle: 'idle',
  running: 'running',
  partial: 'partial',
  done: 'done',
  blocked: 'blocked',
  error: 'error',
})

/** 回填进度归一：status 保留后端原文（引擎可能用 paused / scanning 等，不强行改写成 idle） */
export function normalizeBackfill(raw) {
  const status = String(raw?.status || BACKFILL_STATUS.idle).trim().toLowerCase() || BACKFILL_STATUS.idle
  return {
    status,
    scanned: Math.max(0, Number(raw?.scanned) || 0),
    inserted: Math.max(0, Number(raw?.inserted) || 0),
    lastRawId: Number(raw?.lastRawId) || 0,
  }
}

/** 回填按钮文案：进行中 / 已完成 / 待开始 */
export function backfillButtonText(backfill) {
  const b = normalizeBackfill(backfill)
  if (b.status === BACKFILL_STATUS.running) return '回填中…'
  if (b.status === BACKFILL_STATUS.done) return '重新回填'
  return '开始 / 继续回填'
}

/** 回填状态文案：已知状态给中文，未知状态原样展示（不误报成「待开始」） */
export function backfillStatusText(backfill, enabled = true) {
  const b = normalizeBackfill(backfill)
  if (b.status === BACKFILL_STATUS.running) return '正在回填…'
  if (b.status === BACKFILL_STATUS.partial) return '未扫完，可继续回填'
  if (b.status === BACKFILL_STATUS.done) return '回填已完成'
  if (b.status === BACKFILL_STATUS.blocked) return '已暂停：该角色未授权 AI 写入统计'
  if (b.status === BACKFILL_STATUS.error) return '回填出错，可重试'
  if (b.status === BACKFILL_STATUS.idle) return enabled ? '待开始' : '已关闭'
  return `状态：${b.status}`
}

/** 初次信息行：词表行为 + 已有里程碑合并成面板行 */
export function firstsRows(acts, firsts) {
  const defs = Array.isArray(acts) ? acts : []
  const saved = new Map((Array.isArray(firsts) ? firsts : []).map(f => [String(f?.actKey || ''), f]))
  const rows = defs.map(a => {
    const key = String(a?.key || a?.actKey || '')
    const hit = saved.get(key)
    saved.delete(key)
    return {
      actKey: key,
      label: String(a?.label || hit?.label || key),
      firstAt: hit?.firstAt || '',
      note: hit?.note || '',
      source: hit?.source || '',
      manual: String(hit?.source || '') === 'manual',
    }
  })
  // 词表里没有（自定义行为）但已落库的里程碑也别丢
  for (const [key, hit] of saved) {
    rows.push({
      actKey: key,
      label: String(hit?.label || key),
      firstAt: hit?.firstAt || '',
      note: hit?.note || '',
      source: hit?.source || '',
      manual: String(hit?.source || '') === 'manual',
    })
  }
  return rows
}

/** 流水行 → 展示文案（行为 label 用词表兜底，人工补录有 customLabel） */
export function logRowText(log, vocab) {
  const acts = new Map((Array.isArray(vocab?.acts) ? vocab.acts : []).map(a => [String(a?.key || ''), String(a?.label || '')]))
  const positions = new Map((Array.isArray(vocab?.positions) ? vocab.positions : []).map(p => [String(p?.key || ''), String(p?.label || '')]))
  const actKey = String(log?.actKey || '')
  const posKey = String(log?.positionKey || '')
  return {
    actLabel: String(log?.customLabel || acts.get(actKey) || actKey || '未知'),
    positionLabel: posKey ? String(positions.get(posKey) || posKey) : '',
    actCount: Number(log?.actCount) || 0,
    climaxCount: Number(log?.climaxCount) || 0,
    occurredAt: log?.occurredAt || '',
    source: sourceLabel(log?.source),
    partnerKind: String(log?.partnerKind || ''),
  }
}

// ── AI 判断行为的每日配额（task-32 收尾）──
//
// 契约（全局配额，与角色无关）：
//   GET  /api/config 顶层 aiJudge = { dailyLimit, usedToday, remaining, unlimited }
//   PUT  /api/config/ai-judge  body { dailyLimit }（0 = 不限制）→ 返回同一个对象
//   POST /api/characters/:id/intimate/ai-judge/run → 额外带 quota（同一形状）
//
// 口径：dailyLimit === 0 即不限制（unlimited 标记更权威，给了就以它为准）。

/** 输入框允许的上限：够大（后端没有上限）又不至于把值打成天文数字 */
export const AI_JUDGE_DAILY_LIMIT_MAX = 100000

/** 人话说明里的固定前缀（输入框旁注共用一份，避免两处口径漂移） */
export const AI_JUDGE_LIMIT_HINT = '0 = 不限制'

/**
 * 配额归一化。拿不到对象时 `known: false` —— 页面据此只显示「0 = 不限制」，
 * 不显示「当前已用 0 次」这种凭空的数字。
 * @returns {{known:boolean, dailyLimit:number, usedToday:number, remaining:number|null, unlimited:boolean, exhausted:boolean}}
 */
export function normalizeAiJudgeQuota(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { known: false, dailyLimit: 0, usedToday: 0, remaining: null, unlimited: false, exhausted: false }
  }
  const dailyLimit = clampDailyLimit(raw.dailyLimit)
  const usedToday = Math.max(0, Math.floor(Number(raw.usedToday) || 0))

  let unlimited
  if (typeof raw.unlimited === 'boolean') unlimited = raw.unlimited
  else if (raw.unlimited === 0 || raw.unlimited === 1) unlimited = raw.unlimited === 1
  else unlimited = dailyLimit === 0

  const remainingRaw = raw.remaining === null || raw.remaining === undefined || raw.remaining === ''
    ? null
    : Number(raw.remaining)
  const remaining = Number.isFinite(remainingRaw)
    ? Math.max(0, Math.floor(remainingRaw))
    : (unlimited ? null : Math.max(0, dailyLimit - usedToday))

  return {
    known: true,
    dailyLimit,
    usedToday,
    remaining,
    unlimited,
    // 后端在 run 回执的 quota 里会直接给 exhausted；它给了就以它为准，没给再按 remaining 推
    exhausted: typeof raw.exhausted === 'boolean' ? raw.exhausted : (!unlimited && remaining !== null && remaining <= 0),
  }
}

/** 输入框 → 合法上限：非数字按 0（不限制）处理，负数归 0，超过上限夹住 */
export function clampDailyLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(AI_JUDGE_DAILY_LIMIT_MAX, Math.max(0, Math.floor(n)))
}

/** 输入框旁注：「0 = 不限制；当前已用 N 次」（不限制时不编「还剩」） */
export function aiJudgeQuotaNote(raw) {
  const quota = normalizeAiJudgeQuota(raw)
  if (!quota.known) return AI_JUDGE_LIMIT_HINT
  const base = `${AI_JUDGE_LIMIT_HINT}；当前已用 ${quota.usedToday} 次`
  if (quota.unlimited || quota.remaining === null) return base
  return `${base}，今日还剩 ${quota.remaining} 次`
}

/**
 * 手动补判（POST …/ai-judge/run）的回执 → toast 文案。
 *
 * 后端回执形状是 `{ scanned, judged, recorded, skipped, superseded, errors[], quota }`
 * —— 没有人话 message 字段，配额耗尽时的那句话在 `errors[0]` 里（quotaExhaustedMessage 生成），
 * 所以这里 message / errors 两条都认，且**一轮都没跑成**时才以它为主文案。
 * @returns {{text:string, type:'success'|'warning'}}
 */
export function aiJudgeRunToast(result, fallbackText = '') {
  const data = result && typeof result === 'object' ? result : {}
  const errors = (Array.isArray(data.errors) ? data.errors : []).filter(Boolean)
  const message = typeof data.message === 'string' ? data.message.trim() : ''
  const quota = normalizeAiJudgeQuota(data.quota)
  const judged = Number(data.judged) || 0
  const recorded = Number(data.recorded) || 0
  const didWork = judged > 0 || recorded > 0

  // 一次都没judge成 + 配额耗尽：后端的原话就是最准确的原因，直接用
  if (quota.exhausted && !didWork) {
    return {
      text: message || errors[0] || `今日 AI 判断次数已用完（上限 ${quota.dailyLimit} 次）`,
      type: 'warning',
    }
  }

  const text = fallbackText || `已判断 ${judged} 轮，补记 ${recorded} 笔`
  // 刚好用掉最后一次：先报本轮结果，再补一句「配额已用完」，别让用户以为明天还能自动判断
  if (quota.exhausted) return { text: `${text}；${errors[0] || '今日配额已用完'}`, type: 'warning' }
  if (errors.length) return { text: `${text}；${errors[0]}`, type: 'warning' }
  return { text, type: 'success' }
}
