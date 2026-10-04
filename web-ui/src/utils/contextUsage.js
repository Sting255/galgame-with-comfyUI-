/**
 * 上下文用量浮层（App.vue 左上角）的纯逻辑层。
 *
 * 后端契约（`GET /api/context/usage?conversationId=`）：
 *   { conversationId, model, contextWindow, contextWindowSource,
 *     usedTokens, usedPercent, remainingTokens, source, updatedAt,
 *     breakdown[], breakdownCalibrated }
 *   · usedPercent 是 0~100 的百分数（不是 0~1 比例）
 *   · breakdown 可能为空数组；contextWindow 可能为 null
 *   · source 可能是 'last-request' / 'estimate' / 'snapshot' / 'none'
 *     'snapshot' = 进程重启后从持久化快照读到的「上一次请求」，因此必须说清是「上次」而不是「刚刚」
 *   · updatedAt 可能是 null（没有可信的更新时间就不显示，绝不假装刚刚更新）
 *   · 标定：顶层 breakdownCalibrated，以及分项的 tokensCalibrated（真实总量按估算比例分摊）。
 *     有标定值时显示 tokensCalibrated，否则回落到估算的 tokens
 *
 * 这里只放不依赖 Vue / DOM 的纯函数，便于 `node --test` 直接覆盖；
 * 组件里只做响应式接线与模板渲染。
 */

/** 进度条 / 环形进度 / 数字配色分档：占用越高越警示（阈值改这里即可） */
export const CONTEXT_LEVEL_THRESHOLDS = Object.freeze({
  /** ≥70% 进入警示（暖橙） */
  warn: 70,
  /** ≥90% 进入危险（红），并提示尽快压缩 */
  danger: 90,
})

const K = 1000
const M = 1000 * 1000

/**
 * 人类可读的 token 数：999 → '999'，1000 → '1.0K'，4408 → '4.4K'，
 * 168000 → '168K'，1000000 → '1.0M'。
 *
 * 口径：K/M 进制、最多 1 位小数；十进制进位（10 的整数倍）省掉无用的小数位，
 * 只有 1.0K 这种「进位后只剩一位有效数字」的才补 .0，便于和 4.4K / 168K 对齐阅读。
 * 边界：0 → '0'；null/undefined/''/NaN → '—'；负数保留符号；1e12 以上走 G。
 */
export function formatTokenCount(value) {
  // 只认数字与数字字符串；对象 / 数组 / 布尔 / 空串一律按「无数据」处理
  const isNumberLike = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '')
  if (!isNumberLike) return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'

  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const unit = (scaled, suffix) => {
    const text = (Math.round(scaled * 10) / 10).toFixed(1)
    // 168.0K → 168K；但 1.0K 保留一位小数，读起来与 4.4K 同族。
    // 判定用「缩放进位后的数值」：|=1| 才补 .0，|>=10| 是整数就省掉。
    const absScaled = Math.abs(Math.round(scaled * 10) / 10)
    const trimmed = text.endsWith('.0') && absScaled >= 10 ? text.slice(0, -2) : text
    return `${sign}${trimmed}${suffix}`
  }

  if (abs < K) return `${sign}${Math.round(abs)}`
  if (abs < M) return unit(abs / K, 'K')
  if (abs < K * M) return unit(abs / M, 'M')
  return unit(abs / (K * M), 'G')
}

/**
 * 稳定前缀指纹对比（审查 §2.3）：与**同一会话的上一轮**比，回答「这轮前缀缓存为什么可能没命中」。
 *
 * 后端 GET /api/context/usage 顶层新增 `stablePrefixHash` / `fullPrefixHash` / `requestHash`
 * （纯加法、可为 null）；这里只做**纯比较**，缓存与「上一轮从哪来」交给组件（内存缓存、不持久化）。
 *
 * @returns {{state:'unknown'|'first'|'same'|'tail-only'|'stable-changed', text:string, detail:string}}
 */
export function prefixFingerprintVerdict(prev, current) {
  const read = raw => {
    const v = raw && typeof raw === 'object' ? raw : {}
    const pick = key => (v[key] === undefined || v[key] === null ? null : v[key])
    return { stable: pick('stablePrefixHash'), full: pick('fullPrefixHash'), request: pick('requestHash') }
  }
  const cur = read(current)
  const old = read(prev)

  // 后端没给指纹（旧后端 / 纯估算响应）：不给任何结论，界面也不显示这一行
  if (cur.stable === null && cur.full === null && cur.request === null) {
    return { state: 'unknown', text: '', detail: '后端未提供指纹' }
  }
  // 有本轮但没有可比的上一轮：说「首轮」，别误报成「变化」
  if (old.stable === null && old.full === null && old.request === null) {
    return { state: 'first', text: '首轮（没有上一轮可比）', detail: '' }
  }

  const stableChanged = cur.stable !== null && old.stable !== null && cur.stable !== old.stable
  const fullChanged = cur.full !== null && old.full !== null && cur.full !== old.full
  if (stableChanged || fullChanged) {
    const which = []
    if (stableChanged) which.push('stablePrefixHash')
    if (fullChanged) which.push('fullPrefixHash')
    return { state: 'stable-changed', text: '稳定前缀变化（前缀缓存要重算）', detail: which.join(' + ') }
  }
  const requestChanged = cur.request !== null && old.request !== null && cur.request !== old.request
  if (requestChanged) {
    return { state: 'tail-only', text: '仅动态尾部变化（前缀缓存不受影响）', detail: 'requestHash' }
  }
  return { state: 'same', text: '与上一轮一致（前缀缓存可复用）', detail: '' }
}

/** 占用百分比 → 分档：normal（主色）/ warn（警示）/ danger（危险） */
export function contextLevel(percent) {
  const p = typeof percent === 'number' ? percent : Number(percent)
  if (!Number.isFinite(p)) return 'normal'
  if (p >= CONTEXT_LEVEL_THRESHOLDS.danger) return 'danger'
  if (p >= CONTEXT_LEVEL_THRESHOLDS.warn) return 'warn'
  return 'normal'
}

/** 把任意输入夹到 0~100；非有限数 / 空串返回 null（调用方走「未知」分支） */
export function clampPercent(percent) {
  if (percent === null || percent === undefined || percent === '') return null
  const p = typeof percent === 'number' ? percent : Number(percent)
  if (!Number.isFinite(p)) return null
  return Math.min(100, Math.max(0, p))
}

/** 进度条宽度：只在已量化到 1% 时才动，避免零点几的抖动；0% 给一点可见残留 */
export function progressBarWidth(percent) {
  const p = clampPercent(percent)
  if (p === null) return 0
  if (p <= 0) return 0
  const rounded = Math.round(p * 10) / 10
  return Math.max(2, Math.min(100, rounded))
}

/** 环形进度：百分比 → 一个周长的 dashoffset 比例（0~1 的已用占比） */
export function ringRatio(percent) {
  const p = clampPercent(percent)
  if (p === null) return 0
  return p / 100
}

/** 百分比显示文案：33.4 → '33%'；无数据显示 '—' */
export function formatPercent(percent) {
  const p = clampPercent(percent)
  if (p === null) return '—'
  return `${Math.round(p)}%`
}

/**
 * 数据来源说明（展开卡片脚注 + 收起态 title）。
 *
 * 'snapshot' 与 'last-request' 的区别是**持久化**：进程内刚记下的用量叫 last-request，
 * 重启后从落盘快照读回来的叫 snapshot —— 它可能是几小时前的，所以文案必须说「上次」
 * 并配 updatedAtLabel 一起看，绝不能写成「刚刚」。
 */
export const USAGE_SOURCE_LABELS = Object.freeze({
  'last-request': '来自上一次请求',
  snapshot: '上次请求（已持久化）',
  estimate: '估算值（还没有真实请求）',
  none: '暂无数据',
})

/** 上下文窗口来源说明（模型配置里的 contextWindowSource） */
export const WINDOW_SOURCE_LABELS = Object.freeze({
  declared: '手动声明',
  provider: '服务端探测',
  default: '默认值',
})

/** 上下文窗口来源整句（面板脚注用）：三种来源都给人话，未知来源返回空串不硬凑 */
export function windowSourceText(source) {
  const label = WINDOW_SOURCE_LABELS[source]
  return label ? `窗口来源：${label}` : ''
}

/** 分项标定状态标签：有标定值说「已标定」，否则如实说「估算」 */
export const BREAKDOWN_TAGS = Object.freeze({
  calibrated: '已标定',
  estimate: '估算',
})

/** 分项标定说明（只在与后端标定口径一致、即真有标定值时出现在卡片里） */
export const BREAKDOWN_CALIBRATED_NOTE = '分项已按真实总量标定'

/**
 * 更新时间文案：「更新于 09:26」。
 *  · 同一天：只给时刻
 *  · 同年不同天：补「MM-DD」
 *  · 跨年：补完整日期
 *  · 非法 / 空值：返回空串（模板据此不渲染这一行，不显示「更新于 —」）
 */
export function formatUpdatedAt(iso, now = new Date()) {
  if (typeof iso !== 'string' || iso.trim() === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()

  const two = n => String(n).padStart(2, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`
  if (date.getFullYear() !== ref.getFullYear()) {
    return `更新于 ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`
  }
  if (date.getMonth() !== ref.getMonth() || date.getDate() !== ref.getDate()) {
    return `更新于 ${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`
  }
  return `更新于 ${time}`
}

/**
 * 把接口返回的任意形状归一化成模板直接可用的状态。
 *
 * 空态兜底：接口失败 / 没有数据时传 `null`，得到 `hasData: false`，
 * 模板显示「窗口未知 / 暂无数据」，绝不抛错。
 */
export function normalizeUsage(raw) {
  const w = raw && typeof raw === 'object' ? raw : {}

  const contextWindow = toPositiveNumber(w.contextWindow)
  const usedTokens = toNonNegativeNumber(w.usedTokens)
  const remainingTokens = toNonNegativeNumber(w.remainingTokens)

  // usedPercent 是权威值；缺失时用 tokens 推算；都缺则 null
  let percent = clampPercent(w.usedPercent)
  if (percent === null && contextWindow && usedTokens !== null) {
    percent = clampPercent((usedTokens / contextWindow) * 100)
  }

  // 服务端按固定分段返回（system/memory/transcript/directive/other），
  // 本次没命中的分段 tokens 为 0 —— 只展示真正占用的行，空分项不占版面。
  // 有标定值（tokensCalibrated）时以标定值为准：它是把真实总量按估算比例分摊后的结果，
  // 比纯字符估算更接近事实；估算值仍留着，鼠标悬停时可以对照。
  const breakdown = (Array.isArray(w.breakdown) ? w.breakdown : [])
    .filter(item => item && typeof item === 'object')
    .map((item, index) => {
      const estimated = toNonNegativeNumber(item.tokens)
      const calibrated = toNonNegativeNumber(item.tokensCalibrated)
      const shown = calibrated !== null ? calibrated : estimated
      const row = {
        key: String(item.key ?? `item-${index}`),
        label: String(item.label ?? item.key ?? '未命名'),
        tokens: shown,
        tokensLabel: formatTokenCount(shown),
      }
      // 只有真的带了标定值才挂标定字段：没有标定值的行保持原字段形状（不多塞 calibrated:false），
      // 模板统一按「缺 calibrated 就是估算」分支渲染。
      if (calibrated !== null) {
        row.calibrated = true
        row.tokensCalibrated = calibrated
        row.estimateTokens = estimated
        row.estimateLabel = formatTokenCount(estimated)
      }
      return row
    })
    .filter(item => item.tokens !== null && item.tokens > 0)

  const windowKnown = Boolean(contextWindow)
  // 标定状态 = 分项里真有标定值（我们确实在展示标定数）或后端顶层明确声称整张分项已标定。
  // 两层都认：顶层为 true 时后端可能已经把 tokens 换成了标定值、只是没逐项再给一遍；
  // 而分项带了 tokensCalibrated 却没有顶层标记时，我们展示的就是标定值，也必须说「已标定」。
  const flagCalibrated = w.breakdownCalibrated === true || w.breakdownCalibrated === 1
  const breakdownCalibrated = breakdown.some(item => item.calibrated === true)
    || (flagCalibrated && breakdown.length > 0)
  const updatedAt = typeof w.updatedAt === 'string' ? w.updatedAt : ''

  return {
    // 空对象 / 只有 conversationId 的响应视为「还没有数据」，模板走未知态而不是显示 0
    hasData: windowKnown || usedTokens !== null || percent !== null,
    conversationId: typeof w.conversationId === 'string' ? w.conversationId : '',
    // 稳定前缀指纹（审查 §2.3，纯加法）：旧后端没有这三个键 → null，不报错、不显示结论
    stablePrefixHash: typeof w.stablePrefixHash === 'string' ? w.stablePrefixHash : null,
    fullPrefixHash: typeof w.fullPrefixHash === 'string' ? w.fullPrefixHash : null,
    requestHash: typeof w.requestHash === 'string' ? w.requestHash : null,
    model: typeof w.model === 'string' ? w.model : '',
    contextWindow: contextWindow,
    windowKnown,
    windowLabel: windowKnown ? formatTokenCount(contextWindow) : '—',
    contextWindowSource: typeof w.contextWindowSource === 'string' ? w.contextWindowSource : '',
    windowSourceText: windowSourceText(w.contextWindowSource),
    source: typeof w.source === 'string' ? w.source : 'none',
    sourceLabel: USAGE_SOURCE_LABELS[w.source] || '',
    usedTokens,
    usedLabel: formatTokenCount(usedTokens),
    remainingTokens: remainingTokens === null && windowKnown && usedTokens !== null
      ? Math.max(0, contextWindow - usedTokens)
      : remainingTokens,
    percent,
    percentLabel: formatPercent(percent),
    level: contextLevel(percent),
    barWidth: progressBarWidth(percent),
    breakdown,
    breakdownCalibrated,
    breakdownTag: breakdownCalibrated ? BREAKDOWN_TAGS.calibrated : BREAKDOWN_TAGS.estimate,
    breakdownNote: breakdownCalibrated ? BREAKDOWN_CALIBRATED_NOTE : '',
    updatedAt,
    updatedAtLabel: formatUpdatedAt(updatedAt),
  }
}

/**
 * 当前生效的会话 id。私聊 `char_<角色id>`、群聊 `group_<群id>`。
 *
 * 优先看路由（`/chat`、`/group`）——`activeCharId` 离开聊天页后不会清空，
 * 只用 store 判断会在设置页等位置显示一个早已不活跃的会话。
 */
export function resolveConversationId({ path = '', activeCharId = null, activeGroupId = null } = {}) {
  const isGroupRoute = typeof path === 'string' && path.startsWith('/group')
  const isCharRoute = typeof path === 'string' && path.startsWith('/chat')

  if (isGroupRoute && activeGroupId !== null && activeGroupId !== undefined && activeGroupId !== '') {
    return `group_${activeGroupId}`
  }
  if (isCharRoute && activeCharId !== null && activeCharId !== undefined && activeCharId !== '') {
    return `char_${activeCharId}`
  }
  return ''
}

/** 后端 409（正在压缩）在 api 层被塞进 err.status */
export function isCompressConflict(err) {
  return Boolean(err) && (err.status === 409 || err.code === 'compression in progress')
}

/**
 * 刷新节流器：把「事件触发 + 兜底轮询」的多次请求收敛成一次。
 *
 * · 同一会话在 `minIntervalMs` 内重复调用直接复用进行中的 Promise（不重复打请求）
 * · 超过 `minIntervalMs` 才真正再发一次
 * · 不同会话（key 变化）立即放行 —— 切会话必须马上看到新数据，
 *   哪怕上一个会话的请求还挂着，也不能把新会话的刷新吞掉。
 */
export class UsageRefreshGovernor {
  constructor({ minIntervalMs = 3000 } = {}) {
    this.minIntervalMs = minIntervalMs
    this.lastStartedAt = 0
    this.lastKey = ''
    /** { key, promise } | null */
    this.inflight = null
  }

  /** 是否应当立刻发请求（纯函数，便于单测） */
  shouldFetch(key, now) {
    if (key !== this.lastKey) return true
    return now - this.lastStartedAt >= this.minIntervalMs
  }

  run(key, task, now = Date.now()) {
    // 同一会话已有请求在飞 → 复用，不重复打接口
    if (this.inflight && this.inflight.key === key) return this.inflight.promise
    if (!this.shouldFetch(key, now)) return Promise.resolve(null)

    this.lastStartedAt = now
    this.lastKey = key
    const entry = {
      key,
      promise: Promise.resolve().then(task).finally(() => {
        // 只清理自己，避免把切会话后新起的请求误清
        if (this.inflight === entry) this.inflight = null
      }),
    }
    this.inflight = entry
    return entry.promise
  }
}

/** 是否是「AI 回复完成」的刷新信号（群聊消息事件只认 assistant） */
export function isAssistantMessage(data) {
  return Boolean(data) && typeof data === 'object' && data.role === 'assistant'
}

function toPositiveNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function toNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}
