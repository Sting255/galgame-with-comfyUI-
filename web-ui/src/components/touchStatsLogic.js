/**
 * SLG 动作系统 · 阶段三 · 触摸互动统计（前端纯逻辑）
 *
 * 数据源：GET /api/characters/:id/touch/stats —— **形状已落地**（task-19，契约见 docs/touch-system.md §3.3）：
 *   { characterId, generatedAt, range:{days,from},
 *     totals:{ events, injected, pending, done, expired, dropped, byMode, peakAnnoyance, intimateActs, images },
 *     byAction:[{ actionKey, label, level, levelLabel, count, lastAt, byMode, byStatus, peakAnnoyance,
 *                 avgAnnoyance, currentAnnoyance, annoyanceTier, likeRatio, intimateActs, images }],
 *     byLevel:[{ level, label, count }], daily:[{date,count}],
 *     recent:[{ id, actionKey, label, level, mode, status, annoyance, annoyanceTier, likeRatio,
 *               reaction, facialExpression, createdAt }] }
 *
 * 专题 §3.3 要求面板**不暴露原始数值**，一律用档位文案（很喜欢 / 一般 / 有点腻了、还好 / 有点烦了）。
 * 归一化仍保留对旧命名（actions / stats / uses / maxAnnoyance）的兼容，免得后端再调形状时面板直接白屏。
 *
 * 时间解析一律走 hypnosisLogic 的 parseBackendTime（编程模式 §5.2 的收口点：
 * 后端时间串是无时区 UTC，禁止直接 new Date(后端串)）。
 */
import { parseBackendTime } from './hypnosisLogic.js'
import { TOUCH_ACTIONS, TOUCH_LEVELS } from './touchActionLogic.js'

/** 偏好档位（专题 §3.3：不暴露原始 likeRatio） */
export const LIKE_TIERS = {
  loved: '很喜欢',
  normal: '一般',
  tired: '有点腻了',
}

/** likeRatio → 档位文案（>1.15 很喜欢 / <0.85 有点腻了 / 其余一般） */
export function likeTierOf(likeRatio) {
  const ratio = Number(likeRatio)
  if (!Number.isFinite(ratio)) return LIKE_TIERS.normal
  if (ratio >= 1.15) return LIKE_TIERS.loved
  if (ratio <= 0.85) return LIKE_TIERS.tired
  return LIKE_TIERS.normal
}

/** 腻烦值 → 档位文案（阈值沿用专题 §2.3：50 转冷、80 拒绝） */
export function annoyanceTierOf(annoyance) {
  const value = Number(annoyance)
  if (!Number.isFinite(value) || value < 50) return '还好'
  if (value >= 80) return '有点腻了'
  return '有点烦了'
}

/** 取第一个能转成有限数的值 */
function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return NaN
}

/**
 * 宽容地取出条目数组。
 * 真实形状是 byAction: []（task-19）；同时兼容 actions[] / stats[] / stats{} / byAction{}。
 * 注意 byAction 是**数组**，别按对象遍历（会把下标当 key）。
 */
function toRows(raw) {
  if (Array.isArray(raw.byAction)) return raw.byAction
  if (Array.isArray(raw.actions)) return raw.actions
  if (Array.isArray(raw.stats)) return raw.stats
  const map = (raw.stats && !Array.isArray(raw.stats) && typeof raw.stats === 'object' && raw.stats)
    || (raw.byAction && !Array.isArray(raw.byAction) && typeof raw.byAction === 'object' && raw.byAction)
    || null
  if (!map) return []
  return Object.keys(map).map(key => Object.assign({ actionKey: key }, map[key] || {}))
}

/** 后端 stats 响应 → 渲染用的规整结构（字段缺失 / 多命名都能吃） */
export function normalizeTouchStats(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {}
  const totals = raw.totals && typeof raw.totals === 'object' ? raw.totals : {}

  const rows = toRows(raw)
    .map(item => {
      const key = String((item && (item.actionKey || item.key || item.action)) || '')
      const known = TOUCH_ACTIONS.find(action => action.key === key) || null
      const count = firstFinite(item && (item.count ?? item.uses ?? item.times ?? item.total), 0)
      const likeRatio = firstFinite(item && (item.likeRatio ?? item.like_ratio), 1)
      // 「当前耐受度」取 currentAnnoyance（真实形状）；峰值另存，别混用
      const current = firstFinite(item && (item.currentAnnoyance ?? item.annoyance), 0)
      const peak = firstFinite(item && (item.peakAnnoyance ?? item.maxAnnoyance), current)
      return {
        key,
        label: (item && item.label) || (known && known.label) || key,
        level: firstFinite(item && item.level, known && known.level, 1),
        count: count > 0 ? count : 0,
        lastAt: (item && (item.lastAt || item.last_at || item.updatedAt || item.updated_at)) || null,
        likeRatio,
        likeTier: likeTierOf(likeRatio),
        annoyance: current > 0 ? current : 0,
        peakAnnoyance: peak > 0 ? peak : 0,
        annoyanceTier: annoyanceTierOf(current),
      }
    })
    .filter(row => row.key)

  // 等级分布：优先服务端 byLevel，缺了再按行汇总
  const serverLevels = Array.isArray(raw.byLevel) ? raw.byLevel : null
  const levels = serverLevels && serverLevels.length
    ? serverLevels.map(item => ({
      level: firstFinite(item && item.level, 0),
      label: (item && item.label) || (TOUCH_LEVELS.find(meta => meta.level === (item && item.level)) || {}).label || '',
      count: firstFinite(item && item.count, 0),
    }))
    : TOUCH_LEVELS.map(meta => ({
      level: meta.level,
      label: meta.label,
      count: rows.filter(row => row.level === meta.level).reduce((sum, row) => sum + row.count, 0),
    }))

  const recentLatest = Array.isArray(raw.recent) && raw.recent.length
    ? (raw.recent[0].createdAt || raw.recent[0].created_at || null)
    : null
  const total = firstFinite(totals.events, raw.total, rows.reduce((sum, row) => sum + row.count, 0))
  const lastAt = recentLatest || raw.lastAt || raw.last_at || rows.reduce((latest, row) => {
    if (!row.lastAt) return latest
    if (!latest) return row.lastAt
    return String(row.lastAt) > String(latest) ? row.lastAt : latest
  }, null)
  const peakAnnoyance = firstFinite(
    totals.peakAnnoyance,
    raw.peakAnnoyance,
    raw.peak_annoyance,
    rows.reduce((max, row) => Math.max(max, row.peakAnnoyance), 0),
  )
  const images = firstFinite(totals.images, raw.images, 0)
  const intimateActs = firstFinite(totals.intimateActs, raw.intimateActs, 0)
  const daily = normalizeDaily(raw.daily)

  return {
    hasData: total > 0 || rows.some(row => row.count > 0),
    total: total > 0 ? total : 0,
    rows: rows.slice().sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key))),
    levels,
    lastAt,
    peakAnnoyance: peakAnnoyance > 0 ? peakAnnoyance : 0,
    images: images > 0 ? images : 0,
    intimateActs: intimateActs > 0 ? intimateActs : 0,
    daily,
    dailyTotal: daily.reduce((sum, item) => sum + item.count, 0),
  }
}

// ── 按天序列（P2-1 曲线）──
// 后端 daily 形状：[{ date: 'YYYY-MM-DD', count: N }]（UTC 日期，SQLite 无时区串前 10 位）

/** 规整 daily：丢掉没日期的、次数取非负整数、按日期升序；非数组一律给空数组 */
export function normalizeDaily(daily) {
  if (!Array.isArray(daily)) return []
  return daily
    .map(item => {
      const date = String((item && item.date) || '').trim()
      const n = Number(item && item.count)
      return { date, count: Number.isFinite(n) && n > 0 ? Math.round(n) : 0 }
    })
    .filter(item => item.date)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 'YYYY-MM-DD' → 'MM-DD'（轴标签用）；认不出就原样返回 */
export function dailyLabel(date) {
  const text = String(date == null ? '' : date).trim()
  if (!text) return ''
  const matched = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!matched) return text
  const pad = n => (n.length < 2 ? '0' + n : n)
  return pad(matched[2]) + '-' + pad(matched[3])
}

/**
 * 折线点串（SVG polyline 的 points）。
 * **少于 2 个点返回空串** —— 一个点画不出线，面板据此走中性说明，别硬画一条假的平线。
 * 纵向按当前窗口最大值归一化（全 0 时最大值兜底 1，线落在顶部，不会除零）。
 */
export function buildDailyPoints(daily, { width = 260, height = 44, pad = 4 } = {}) {
  const rows = normalizeDaily(daily)
  if (rows.length < 2) return ''
  const w = Number(width) || 260
  const h = Number(height) || 44
  const p = Number.isFinite(Number(pad)) ? Number(pad) : 4
  const innerW = Math.max(1, w - p * 2)
  const innerH = Math.max(1, h - p * 2)
  const max = Math.max(1, ...rows.map(row => row.count))
  return rows
    .map((row, index) => {
      const x = p + (innerW * index) / (rows.length - 1)
      const y = p + innerH * (1 - row.count / max)
      return Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10
    })
    .join(' ')
}

/**
 * 横轴日期刻度（C1 · 规划-下一步）：把 daily 均匀取样成最多 maxTicks 个刻度。
 *
 * 返回 [{ date, label, percent }]：percent 是 0~100 的横向位置，**与 buildDailyPoints 的 x 同一套归一化**
 * （都按索引均分），所以刻度天然对得上折线节点。
 * · 空序列 → 空数组（面板走中性空态）；
 * · 点比 maxTicks 少 → 有几个给几个，不做重复取样；
 * · 首尾必在，中间均分，去重后按顺序返回。
 */
export function buildDailyTicks(daily, maxTicks = 4) {
  const rows = normalizeDaily(daily)
  if (rows.length === 0) return []
  const last = rows.length - 1
  if (last === 0) return [{ date: rows[0].date, label: dailyLabel(rows[0].date), percent: 0 }]
  const limit = Math.max(2, Math.min(Math.floor(Number(maxTicks)) || 4, rows.length))
  const indexes = []
  for (let i = 0; i < limit; i += 1) indexes.push(Math.round((last * i) / (limit - 1)))
  const unique = Array.from(new Set(indexes))
  return unique.map(index => ({
    date: rows[index].date,
    label: dailyLabel(rows[index].date),
    percent: Math.round((index / last) * 1000) / 10,
  }))
}

/** 最近一次 → 「刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD」；解析不了给空串 */
export function formatLastSeen(value, now) {
  const ms = parseBackendTime(value)
  if (!Number.isFinite(ms)) return ''
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const diff = current - ms
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 2592000000) return Math.floor(diff / 86400000) + ' 天前'
  const d = new Date(ms)
  const pad = n => (n < 10 ? '0' + n : String(n))
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
}
