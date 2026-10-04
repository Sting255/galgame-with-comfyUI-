/**
 * 催眠手机面板的纯逻辑层（无 Vue 依赖、无请求，可被 node:test 直接引入）。
 *
 * 与 `components/character/intimateLogic.js` 同一定位：组件只负责画，
 * 判定口径（时长 / 剩余时间 / 状态视图 / 按钮矩阵 / 门控文案 / 遗忘记录 / 恢复文案）都在这里，
 * 便于单测覆盖，也避免后来者去 api 层找这些规则。
 *
 * 请求与错误翻译在 `api/hypnosis.js`。
 */

// 唯一引入：toyLogic 是一张**纯数据 + 纯函数**的镜像表（无 Vue、无请求、无副作用），
// 用来把 force_toy 指令里的 toyKey 翻成中文名（否则面板会显示 "force_toy|vibe_egg|4"）。
import { getToy } from './toyLogic.js';

/** 时长边界（与后端一致：1~720 分钟） */
export const MIN_MINUTES = 1
export const MAX_MINUTES = 720
export const DEFAULT_MINUTES = 30

/**
 * 时长清洗：能解析成数字的按 1~720 夹取（四舍五入），
 * 空 / 非数字 → 回到默认 30（宁可给默认值，也不要因为输入框清空就把人催眠 1 分钟）。
 */
export function clampMinutes(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_MINUTES
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_MINUTES
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)))
}

/**
 * 解析后端时间串 → epoch ms（无效值给 NaN）。
 *
 * 后端给的 `activeUntil` / `startedAt` / `fromAt` / `toAt` / `createdAt` 都是 SQLite
 * `datetime('now')` 的产物：**不带时区标记的 UTC 串**（`"YYYY-MM-DD HH:MM:SS"`）。
 * JS 规范把"没有时区标记"的日期串按**本地时间**解析，于是东八区会整体偏 8 小时——
 * 症状是刚点「催眠」面板就显示「已结束」、遗忘记录的时间也差 8 小时（实测剩余分钟 -450）。
 * 所以这里统一：**没有时区标记就按 UTC 解析**；已带 `Z` / `±hh:mm` 的原样交给 Date。
 * 新增取时间的代码请一律走这里，不要直接 `new Date(后端串)`。
 */
export function parseBackendTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const s = String(value == null ? '' : value).trim()
  if (!s) return NaN
  // 已带时区标记（Z / +08:00 / +0800）→ 按原样解析
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s).getTime()
  // 纯日期 "YYYY-MM-DD" → 补成当日 UTC 零点
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`).getTime()
  const iso = (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z'
  return new Date(iso).getTime()
}

/** 剩余秒数：无 activeUntil / 已过期 → 0 */
export function remainingSeconds(activeUntil, now = Date.now()) {
  const until = parseBackendTime(activeUntil)
  if (!Number.isFinite(until)) return 0
  const diff = Math.floor((until - Number(now)) / 1000)
  return diff > 0 ? diff : 0
}

/** 剩余时间文案：mm:ss（分钟数不设上限，12 小时即 720:00）；过期显示「已结束」 */
export function formatRemaining(activeUntil, now = Date.now()) {
  const total = remainingSeconds(activeUntil, now)
  if (total <= 0) return '已结束'
  const mm = Math.floor(total / 60)
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** mm:ss 的另一种读法：口语化剩余（用于按钮/提示，例如「12 分 30 秒」） */
export function formatRemainingWords(activeUntil, now = Date.now()) {
  const total = remainingSeconds(activeUntil, now)
  if (total <= 0) return '已结束'
  const mm = Math.floor(total / 60)
  const ss = total % 60
  if (mm <= 0) return `${ss} 秒`
  return ss > 0 ? `${mm} 分 ${ss} 秒` : `${mm} 分`
}

/**
 * 把后端状态整理成面板直接可渲染的视图。
 * 关键点：`active` 是后端标记，而剩余时间可能先走完 —— 两者不一致时以时间为准显示「已结束」，
 * 但 `active` 仍然要用来决定「唤醒 / 遗忘」是否可点（否则过期后就再也清不掉状态了）。
 */
export function hypnosisViewModel(state, now = Date.now()) {
  const raw = state || {}
  const active = !!raw.active
  const expired = active && remainingSeconds(raw.activeUntil, now) <= 0
  const hypnotized = active && !expired
  const gate = normalizeGate(raw.gate)
  // 未催眠时意志必然是清醒的、身体必然是自由的：不要用可能残留的旧标记
  const mindAwake = hypnotized ? raw.mindAwake !== false : true
  const bodyControlled = hypnotized ? raw.bodyControlled === true : false
  return {
    characterId: raw.characterId ?? null,
    active,
    expired,
    hypnotized,
    mindAwake,
    bodyControlled,
    activeUntil: raw.activeUntil || null,
    startedAt: raw.startedAt || null,
    commandCount: Number(raw.commandCount) || 0,
    pendingDirective: String(raw.pendingDirective || ''),
    lastCommand: String(raw.lastCommand || ''),
    gate,
    remainingText: active ? formatRemaining(raw.activeUntil, now) : '—',
    statusText: !active ? '未催眠' : (expired ? '已结束' : `催眠中 · 剩余 ${formatRemaining(raw.activeUntil, now)}`),
    mindText: mindAwake ? '清醒' : '被压制',
    bodyText: bodyControlled ? '受控' : '自由',
  }
}

/** 门控机器码（后端权威口径；allowed === true 时是 'ok'） */
export const GATE_CODES = Object.freeze(['ok', 'no_phone', 'affinity_low', 'not_oath'])

/** gate 归一：缺字段时按「不允许」，避免前端在门控未知时误放行；code 只留白名单内的值 */
export function normalizeGate(gate) {
  const raw = gate && typeof gate === 'object' ? gate : {}
  const code = String(raw.code || '').trim().toLowerCase()
  return {
    allowed: raw.allowed === true,
    code: GATE_CODES.includes(code) ? code : '',
    reason: String(raw.reason || ''),
    affinity: raw.affinity ?? null,
    isOath: raw.isOath === true,
  }
}

/**
 * 门控类型判定（**机器码优先**）：
 *   1) allowed === true → 'ok'（门控通过，机器码不再参与）
 *   2) gate.code 命中白名单 → 直接采信（后端 task-28 的权威字段，不依赖文案措辞）
 *   3) code 缺失 / 未知（旧后端）→ 退回关键词匹配 reason 作为兼容路径
 *   4) 都不命中 → 'unknown'（调用方原样展示 reason，联调时能一眼看到后端新原因）
 */
export function resolveGateKind(gate) {
  const g = normalizeGate(gate)
  if (g.allowed) return 'ok'
  if (g.code && g.code !== 'ok') return g.code
  if (/phone|手机/i.test(g.reason)) return 'no_phone'
  if (/affinity|favor|好感|亲密/i.test(g.reason)) return 'affinity_low'
  if (/oath|誓约/i.test(g.reason)) return 'not_oath'
  return 'unknown'
}

/**
 * 门控文案：
 *  - 门控通过 → ''
 *  - 机器码 / 关键词命中手机 → 明确的领取引导
 *  - 好感 / 誓约 → 带上数值的说明
 *  - 其它 → 原样展示后端 reason（不猜、不吞）
 */
export function gateText(gate) {
  const g = normalizeGate(gate)
  const kind = resolveGateKind(g)
  if (kind === 'ok') return ''
  if (kind === 'no_phone') return '还没有催眠手机，先领一部再来。'
  if (kind === 'affinity_low') {
    const value = g.affinity === null || g.affinity === undefined ? '' : `（当前 ${g.affinity}）`
    return `和 TA 还不够亲近${value}，好感度再高一些就能用了。`
  }
  if (kind === 'not_oath') return '需要先和 TA 立下誓约，才能使用催眠手机。'
  return g.reason || '还不能使用催眠手机。'
}

/** 门控原因是否是「没有手机」（决定要不要显示「领取催眠手机」按钮；机器码优先，关键词兜底） */
export function isPhoneMissing(gate) {
  return resolveGateKind(gate) === 'no_phone'
}

/** 传入的是不是已经整理好的视图（视图一定有布尔 hypnotized；后端原始状态没有） */
export function isHypnosisView(value) {
  return !!value && typeof value === 'object' && typeof value.hypnotized === 'boolean' && !!value.gate
}

/**
 * 五个按钮的启用矩阵。入参可以是后端原始状态，也可以是 hypnosisViewModel 的产物。
 * 统一前提：gate.allowed === false 时全部置灰（面板顶部给出 gateText 原因）。
 *
 * 2026-09-28：去掉「身体控制」——它与「催眠状态」（深度催眠 = 完全控制）和「只唤醒意志」
 * 表达的是同一件事，属于重复入口（用户裁决）。后端 kind 仍然保留，只是面板不再提供。
 */
export function actionMatrix(state, now = Date.now()) {
  const view = isHypnosisView(state) ? state : hypnosisViewModel(state, now)
  const gateOk = view.gate.allowed
  return {
    // 已经处在催眠中时不允许再点「催眠」（避免"延长还是重开"的歧义）；过期后可以重新催眠
    hypnotize: gateOk && !view.hypnotized,
    // active 但已过期时仍可唤醒，用来把后端状态清干净
    wake: gateOk && view.active,
    // 「只唤醒意志」只在真正催眠中、且意志还被压制时可点
    wakeMind: gateOk && view.hypnotized && !view.mindAwake,
    // 强制高潮：**不再要求催眠**（task-42 用户口径「强制高潮不需要催眠 随时都能触发」）——
    // 门控通过（背包里有手机）即可点；后端非催眠态也照常下发指令并立刻触发一轮。
    forcedClimax: gateOk,
    // 遗忘：催眠中或刚结束（active 未清）可点
    forget: gateOk && view.active,
    // 命令她用玩具（force_toy，2026-10-01 修）：**在催眠中即可**。
    // ⚠️ 这里曾经漏过这个键，而面板写的是 `matrix.body_control`（矩阵里根本不存在的键）
    // ⇒ `!undefined === true` ⇒ 按钮**永远置灰**，用户报「催眠玩具不能点击」。
    // 教训：矩阵键是「组件与测试共用的唯一口径」，面板里引用的每个 matrix.X 都必须在这里产出
    //（web-ui/test/hypnosisForceToyUi.test.js 现在有结构性守卫，防止再犯）。
    // 后端第二层门控同步放宽为「active 即可」（原来要求 bodyControlled=完全控制，过严）。
    forceToy: gateOk && (view.hypnotized || view.active),
  }
}

/** 五按钮的展示顺序与文案（组件与测试共用一份口径） */
export const ACTION_DEFS = Object.freeze([
  { key: 'hypnotize', label: '催眠', variant: 'primary' },
  { key: 'wake', label: '唤醒', variant: 'secondary' },
  { key: 'wakeMind', label: '只唤醒意志', variant: 'secondary' },
  { key: 'forcedClimax', label: '强制高潮', variant: 'secondary' },
  { key: 'forget', label: '遗忘被控制这段时间', variant: 'danger' },
])

/** 只唤醒意志后的说明文案（面板文案区用） */
export const WAKE_MIND_NOTICE = '她已经清醒地知道发生了什么，但身体仍旧不听使唤。'

// ── 睡眠控制（**独立于催眠指令**：这是"她睡没睡"，不是"对她下指令"）──
//
// 用户口径：「催眠手机是全覆盖的」（睡眠控制要有入口）、「单独一个选项控制睡眠」。
// 所以面板上睡眠自成一区：状态来自睡眠服务（characters.is_sleeping / sleep_until），
// 与上面的催眠状态、催眠指令是两套东西（睡着可以被催眠，被催眠也能照样睡）。
// 后端返回形状：{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }。

/** 睡眠区的两个动作（独立分区，故意不混进 ACTION_DEFS / GROUP_BATCH_ACTIONS） */
export const SLEEP_ACTIONS = Object.freeze([
  { key: 'sleep', label: '睡觉', variant: 'secondary' },
  { key: 'wakeUp', label: '唤醒', variant: 'secondary' },
])

/** 睡眠区的说明（写在面板上，避免和上面的催眠按钮混为一谈） */
export const SLEEP_SECTION_NOTE = '这一区只管她睡没睡，与上面的催眠指令互不影响：睡着时照样能被催眠，被催眠也能照样睡觉。「唤醒」是把她从睡梦里叫起来，之后是否继续睡由她的日程决定。'

/**
 * 睡眠状态归一化：后端两种命名（camelCase / snake_case）、以及"挂在 GET /hypnosis 状态里"
 * 的嵌套形状（`{ sleep: {...} }`）都要认。
 *
 * `known` 表示"这一份数据里到底有没有睡眠信息"——**没有就说没有**，
 * 不要用默认值假装"她是醒着的"（否则后端还没上线时面板会显示一个假的「清醒」）。
 */
export function normalizeSleep(raw) {
  const source = raw && typeof raw === 'object'
    ? (raw.sleep && typeof raw.sleep === 'object' ? raw.sleep : (raw.sleepState && typeof raw.sleepState === 'object' ? raw.sleepState : raw))
    : null
  if (!source) return { known: false, isSleeping: false, sleepUntil: null, temporaryWakeUntil: null }

  const hasSleeping = source.isSleeping !== undefined || source.is_sleeping !== undefined
  const hasUntil = source.sleepUntil !== undefined || source.sleep_until !== undefined
  const hasTemp = source.temporaryWakeUntil !== undefined || source.temporary_wake_until !== undefined
  if (!hasSleeping && !hasUntil && !hasTemp) {
    return { known: false, isSleeping: false, sleepUntil: null, temporaryWakeUntil: null }
  }

  const rawSleeping = source.isSleeping ?? source.is_sleeping
  const rawUntil = source.sleepUntil ?? source.sleep_until
  const rawTemp = source.temporaryWakeUntil ?? source.temporary_wake_until
  // 认 SQLite 的 0/1、字符串 '1'/'0' 与布尔；只给了 sleep_until 没给标记时，有值即视为在睡
  const sleepingFlag = rawSleeping === undefined ? !!rawUntil : (rawSleeping === true || rawSleeping === 1 || String(rawSleeping).trim() === '1')
  return {
    known: true,
    isSleeping: sleepingFlag,
    sleepUntil: rawUntil ? String(rawUntil) : null,
    temporaryWakeUntil: rawTemp ? String(rawTemp) : null,
  }
}

/** 依次取第一个"真的有睡眠信息"的数据源（POST 返回 → GET /hypnosis 状态 → 角色行） */
export function resolveSleep(...sources) {
  for (const source of sources) {
    const normalized = normalizeSleep(source)
    if (normalized.known) return normalized
  }
  return { known: false, isSleeping: false, sleepUntil: null, temporaryWakeUntil: null }
}

/**
 * 睡眠区视图：状态文案 + 时间文案 + 两个按钮能不能点。
 *
 * 边界：`temporaryWakeUntil` 在未来 = 她被临时叫醒过（此时后端 `is_sleeping` 已是 0），
 * 只作为一行补充说明展示，不改变"睡 / 醒"的主判定（主判定永远听后端的 is_sleeping）。
 */
export function sleepViewModel(raw, now = Date.now()) {
  // 已经归一化过的产物（resolveSleep 的返回值）直接用，避免把 { known:false } 再当成"醒着"
  const sleep = raw && typeof raw === 'object' && raw.known === false
    ? { known: false, isSleeping: false, sleepUntil: null, temporaryWakeUntil: null }
    : normalizeSleep(raw)
  const tempUntil = parseBackendTime(sleep.temporaryWakeUntil)
  const tempActive = Number.isFinite(tempUntil) && tempUntil > Number(now)

  let statusText = '未知'
  if (sleep.known) statusText = sleep.isSleeping ? '睡眠中' : '清醒'

  return {
    known: sleep.known,
    isSleeping: sleep.isSleeping,
    sleepUntil: sleep.sleepUntil,
    temporaryWakeUntil: sleep.temporaryWakeUntil,
    tempWoken: tempActive,
    statusText,
    // 预计醒来的时刻（只在她真的睡着、且后端给了 sleepUntil 时展示）
    untilText: sleep.isSleeping && sleep.sleepUntil ? `预计 ${formatWindowTime(sleep.sleepUntil)} 醒来` : '',
    tempWakeText: tempActive ? `被临时叫醒，醒着到 ${formatWindowTime(sleep.temporaryWakeUntil)}` : '',
    // 已知状态时按状态置灰；**未知时两个都放开**（读不到不代表不能点，让后端给出结果，
    // 否则后端接口还没上线时用户会以为按钮坏了）
    canSleep: !sleep.known || !sleep.isSleeping,
    canWake: !sleep.known || sleep.isSleeping,
  }
}

/** 睡眠动作成功后的 toast 文案 */
export const SLEEP_TOAST = Object.freeze({
  sleep: '她已经去睡了',
  wakeUp: '她醒过来了',
})

// ── 发情模式（2026-10-02 用户原话「然后再在催眠手机里加一个选项 叫发情模式
//    角色的敏感度就会直接拉满」）──
//
// 它**不是催眠指令**：管的是"她这个人现在有多敏感"，跟催不催眠完全无关
// ⇒ 面板上刻意不挂 actionMatrix 门控（手机没催眠时这颗开关照样能拨）。
// 后端 GET/POST 返回同一形状 `{ heat, value, tier, tierLabel, multiplier, until? }`。
//
// ⚠️ `tier` 的口径有两种：服务层 getSensitivity 给的是**对象** `{key,label,multiplier}`，
//    路由给的是**字符串键**（外加 tierLabel）。这里两种都吃 —— 只看一种的话，
//    另一条链路会渲染成 "undefined"（这个仓库栽过好几次的"假绿"类型）。

/** 分档中文名（与 agent-core 的 SENSITIVITY_TIERS 对齐；后端没给 label 时兜底） */
export const SENSITIVITY_TIER_LABELS = Object.freeze({
  cold: '冷淡',
  normal: '普通',
  warm: '敏感',
  high: '很敏感',
  extreme: '极度敏感',
})

/** 敏感度夹取（0~100，**保留一位小数**：数值系统要看得出在动，见 intimateActionLogic.sensitivityView） */
export function clampSensitivityValue(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10
}

/** 归一化后端发情模式返回（容错：缺字段 / tier 两种口径 / 布尔或 0-1 的 heat） */
export function normalizeHeat(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const detail = src.tier && typeof src.tier === 'object' ? src.tier : {}
  const key = String(detail.key || (typeof src.tier === 'string' ? src.tier : '') || 'cold')
  return {
    heat: src.heat === true || src.heat === 1 || src.heat === '1',
    value: clampSensitivityValue(src.value),
    tierKey: key,
    tierLabel: String(detail.label || src.tierLabel || SENSITIVITY_TIER_LABELS[key] || '未知'),
    until: src.until || null,
  }
}

/** 面板视图：数值文案 / 档位 / 开关状态字 / 说明 / 到点倒计时 */
export function heatViewModel(raw, now = Date.now()) {
  const h = normalizeHeat(raw)
  const left = remainingSeconds(h.until, now)
  return {
    heat: h.heat,
    value: h.value,
    tierKey: h.tierKey,
    tierLabel: h.tierLabel,
    valueText: `${h.value}/100 · ${h.tierLabel}`,
    // 只在"真的开着 + 后端给了到点时间 + 还没到点"时显示倒计时；否则说"已拉满"
    // （⚠️ 只判 `h.until` 有值是不够的：已过点时 remainingSeconds 给 0，
    //   formatRemainingWords 会返回「已结束」⇒ 面板上出现「已结束后自然回落」这种傻话）
    untilText: h.heat && h.until && left > 0 ? `${formatRemainingWords(h.until, now)}后自然回落` : '',
    switchText: h.heat ? '发情中' : '已关闭',
    note: h.heat
      ? '她被拉到最敏感：几乎没有前戏就会被推上去，高潮来得又急又密，也会主动索要。'
      : '打开后敏感度直接拉满：更容易被推上去、高潮更频繁更强，她也会更主动。',
  }
}

// ── 群聊里的催眠手机（task-31）──
//
// 群聊面板的结构：先选人（可单选可多选）→
//   选 1 人 = **单独使用模式**（直接给完整的单人面板，与私聊一致，含遗忘与遗忘记录）；
//   选多人 = **批量模式**（下面四个按钮一次性对所有人下指令，逐个反馈成功/失败）。
// 语义与私聊共用一个后端状态（每人一份，互相独立），因此"重复使用"天然成立（再点一次催眠 = 重开）。

/** 批量模式提供的动作（不含遗忘按钮：遗忘要逐人确认，只放在单独使用模式里。
 *  注意——**按钮不在这里 ≠ 遗忘不覆盖群聊**：task-1 起遗忘按窗口 from_at→to_at 的时间区间
 *  屏蔽群聊 transcript 并归档群聊长期记忆，批量区只是不发这条指令。口径见 docs/hypnosis-phone.md §14.1） */
export const GROUP_BATCH_ACTIONS = Object.freeze([
  { key: 'hypnotize', label: '催眠', variant: 'primary' },
  { key: 'wake', label: '唤醒', variant: 'secondary' },
  { key: 'wakeMind', label: '只唤醒意志', variant: 'secondary' },
  { key: 'forcedClimax', label: '强制高潮', variant: 'secondary' },
])

/** 按选中 id 过滤群成员（保持群里的原始顺序，避免"选择顺序"造成的随机性） */
export function selectedMembers(members, ids) {
  const list = Array.isArray(members) ? members : []
  const picked = new Set((Array.isArray(ids) ? ids : []).map(Number))
  return list.filter(m => picked.has(Number(m?.id)))
}

/** 群成员当前状态短文案（给选择胶囊用；无状态/读失败 = 未知） */
export function memberStateText(rawState, now = Date.now()) {
  if (!rawState || typeof rawState !== 'object') return '…'
  const view = hypnosisViewModel(rawState, now)
  return view.statusText || '…'
}

/**
 * 批量结果汇总 → 一句话（toast 用）。
 * @param {{name?:string, ok:boolean, error?:string}[]} results
 * @returns {{okCount:number, failedCount:number, text:string, failed:{name:string,error:string}[]}}
 */
export function summarizeBatch(results) {
  const list = Array.isArray(results) ? results : []
  const failed = list
    .filter(r => !r?.ok)
    .map(r => ({ name: r?.name || 'TA', error: r?.error || '操作失败' }))
  const okCount = list.length - failed.length
  if (list.length === 0) return { okCount: 0, failedCount: 0, text: '', failed }
  if (failed.length === 0) return { okCount, failedCount: 0, text: `已对 ${okCount} 人完成操作`, failed }
  if (okCount === 0) return { okCount: 0, failedCount: failed.length, text: `操作失败：${failed.map(f => `${f.name}（${f.error}）`).join('；')}`, failed }
  return {
    okCount,
    failedCount: failed.length,
    text: `已对 ${okCount} 人完成，${failed.length} 人失败：${failed.map(f => `${f.name}（${f.error}）`).join('；')}`,
    failed,
  }
}

/** 遗忘前的二次确认文案 */
export function forgetConfirmMessage(characterName = 'TA') {
  return `会把这期间 ${characterName} 的长期记忆归档，这段时间的对话不再进入她的上下文。\n之后可以在下面的「遗忘记录」里让她恢复这段记忆。`
}

/** 遗忘记录状态 → 中文（状态词未知时原样展示，并且默认可恢复） */
export function forgottenStatusText(status) {
  const key = String(status || '').trim().toLowerCase()
  // 恢复走叙事口径：对外一律说「已恢复」，不用「已撤销 / 已还原」这种后台词
  if (key === 'restored' || key === 'reverted' || key === 'undone') return '已恢复'
  if (key === 'active' || key === 'forgotten' || key === 'archived' || key === '') return '已遗忘'
  return key
}

/** 遗忘记录能否恢复：已恢复的（无论后端用 status 还是 restored/restoredAt 表达）不再给按钮 */
export function canRestoreForgotten(row) {
  if (row?.restored === true || row?.restoredAt || row?.restored_at) return false
  const key = String(row?.status || '').trim().toLowerCase()
  return !(key === 'restored' || key === 'reverted' || key === 'undone')
}

/**
 * 恢复结果文案（用户口径：把记忆还给她）。
 * 后端返回 { restored, pendingDirective:'memory_restore', ... }：
 *   - restored > 0 → 「已还原 N 条记忆，她会在下一次对话中想起」
 *   - restored === 0 → 明确说明"没有抽取到长期记忆，但屏蔽已解除"，
 *     否则用户会以为是按钮没生效（这条区分很重要）
 */
export function restoreResultText(result) {
  const restored = Number(result?.restored ?? result?.restoredCount ?? 0) || 0
  const pending = String(result?.pendingDirective || '')
  const recall = pending === 'memory_restore' || !pending
    ? '她会在下一次对话中想起'
    : '她会在下一次对话中慢慢想起来'
  if (restored > 0) return `已还原 ${restored} 条记忆，${recall}`
  return '这段时间没有抽取到长期记忆，但上下文屏蔽已解除'
}

/** 恢复成功的 toast 文案（固定叙事口径，不用"已撤销"） */
export const RESTORE_TOAST_TEXT = '她想起了这段时间的记忆'

/** 指令 / 待执行指令 → 中文（未知指令原样返回，不吞） */
export function directiveText(directive) {
  const key = String(directive == null ? '' : directive).trim()
  if (!key) return ''
  // force_toy 是**编码值** `force_toy|<toyKey>|<intensity>[|<mode>]`（2026-10-01 新增；10-02 加可选模式段）：
  // 不认这一条的话，面板上会原样显示 "force_toy|vibe_egg|4"。第三段可选 ⇒ 老指令照旧翻译。
  const forceToy = /^force_toy\|([a-z0-9_]+)\|(\d+)(?:\|([a-z_]+))?$/i.exec(key)
  if (forceToy) {
    const toy = getToy(forceToy[1])
    const label = toy ? toy.label : forceToy[1]
    const modeKey = forceToy[3]
    const modeLabel = modeKey ? (toy?.modes?.find(m => m.key === modeKey)?.label || modeKey) : ''
    return `强制用玩具：${label} 强度 ${forceToy[2]}${modeLabel ? ` · ${modeLabel}` : ''}`
  }
  const table = {
    memory_restore: '恢复记忆',
    wake_reaction: '唤醒反应',
    body_control: '身体控制',
    forced_climax: '强制高潮',
    force_toy: '强制用玩具',
    hypnotize: '催眠',
    wake: '唤醒',
    wake_mind: '只唤醒意志',
    forget: '遗忘',
  }
  return table[key.toLowerCase()] || key
}

function pad2(n) { return String(n).padStart(2, '0') }

/** 后端时间串 → 「MM-DD HH:mm」（本地时区展示）；非法值给占位 */
export function formatWindowTime(iso) {
  const ms = parseBackendTime(iso)
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 遗忘记录列表：倒序（最新在前）+ 展示字段。
 * 排序口径：createdAt 倒序，缺失或相同则按 id 倒序（新建的记录 id 更大）。
 */
export function forgottenRows(list) {
  const rows = (Array.isArray(list) ? list : []).map(raw => {
    const id = raw?.id ?? raw?.windowId ?? 0
    const fromRawId = Number(raw?.fromRawId) || 0
    const toRawId = Number(raw?.toRawId) || 0
    const memoriesArchived = Number(raw?.memoriesArchived ?? raw?.archived) || 0
    return {
      id,
      fromRawId,
      toRawId,
      fromAt: raw?.fromAt || '',
      toAt: raw?.toAt || '',
      memoriesArchived,
      status: String(raw?.status || ''),
      restored: raw?.restored === true || !!raw?.restoredAt || !!raw?.restored_at,
      createdAt: raw?.createdAt || raw?.created_at || '',
      statusText: forgottenStatusText(raw?.status),
      canRestore: canRestoreForgotten(raw),
      timeText: `${formatWindowTime(raw?.fromAt)} → ${formatWindowTime(raw?.toAt)}`,
      archivedText: memoriesArchived > 0 ? `归档 ${memoriesArchived} 条记忆` : '没有可归档的记忆',
      rangeText: fromRawId || toRawId ? `#${fromRawId} ~ #${toRawId}` : '',
    }
  })
  return rows.sort((a, b) => {
    const ta = parseBackendTime(a.createdAt)
    const tb = parseBackendTime(b.createdAt)
    const va = Number.isFinite(ta) ? ta : 0
    const vb = Number.isFinite(tb) ? tb : 0
    if (vb !== va) return vb - va
    return Number(b.id) - Number(a.id)
  })
}
