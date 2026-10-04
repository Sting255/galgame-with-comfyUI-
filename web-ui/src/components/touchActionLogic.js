/**
 * SLG 动作系统 · 阶段一（私聊）· 前端纯逻辑（服务层镜像）
 *
 * 口径冻结自 目标/规划/专题-SLG动作系统.md §1.1（清单/分级）、§1.3（门控）、§3.1（置灰 + 剧情化 toast）。
 *
 * **本文件是服务层 agent-core/src/services/touchActionService.js 的前端镜像。**
 * web-ui 不能 import agent-core（跨包），所以在端点
 * GET /api/characters/:id/touch/actions 落地前，前端自己算一份门控用于「置灰 + 文案」。
 * 为将来**零翻译层**接线，这里刻意沿用服务层的字段名与机器码口径：
 *   - 入参：affinity / isOath / hypnotized / sleeping / intimateAuthorized / scene / allowGroupAdult / thresholds
 *   - 出参：{ allowed, code, message, wakesSleeping, level, exempt }，code 取服务层 TOUCH_GATE_CODES
 *   - message：镜像文案（端点落地前的回落）；**服务端返回的 message 才是唯一口径**，接线后优先用它
 *
 * 镜像表与服务层的一致性由 web-ui/test/touchActionBar.test.js 的契约测试钉住：
 * 服务层加/改动作而前端没跟上会直接红，不会静默漏显示。
 */

/** 动作清单（专题 §1.1；与服务层 TOUCH_ACTIONS 的 key/label/level/wakes 一致，契约测试钉住） */
export const TOUCH_ACTIONS = [
  // Lv1 日常：任何关系下可做，不越界
  { key: 'pat_head', label: '摸头', level: 1 },
  { key: 'pat_shoulder', label: '拍拍肩', level: 1 },
  { key: 'hold_hand', label: '拉手', level: 1 },
  { key: 'hug', label: '抱抱', level: 1 },
  { key: 'tickle', label: '挠痒痒', level: 1, wakes: true },
  { key: 'pinch_cheek', label: '捏脸', level: 1, wakes: true },
  // Lv2 亲密：需要好感 / 关系门槛
  { key: 'stroke_hair', label: '摸头发', level: 2 },
  { key: 'stroke_back', label: '摸背', level: 2 },
  { key: 'hold_waist', label: '搂腰', level: 2 },
  { key: 'kiss_cheek', label: '亲脸颊', level: 2 },
  { key: 'cuddle', label: '贴贴', level: 2 },
  // Lv3 敏感：成人向，映射亲密看板
  { key: 'touch_breast', label: '摸胸', level: 3 },
  { key: 'touch_butt', label: '摸臀', level: 3 },
  { key: 'touch_thigh', label: '摸大腿', level: 3 },
  // 「腰部游走」专题只给了中文名；本 key 与服务层独立选定的 key 一致（契约测试钉住）
  { key: 'stroke_waist', label: '腰部游走', level: 3 },
  { key: 'whisper_ear', label: '耳后吹气', level: 3 },
  // Lv4 私密（专题 §十，2026-09-30）：门槛好感 ≥80 或誓约 + 亲密授权；群聊里无条件拦
  { key: 'touch_pussy', label: '摸私处', level: 4 },
  { key: 'touch_clit', label: '摸阴蒂', level: 4 },
  { key: 'finger_insert', label: '手指进入', level: 4 },
  { key: 'touch_neck', label: '抚摸脖颈', level: 4 },
  { key: 'lick_neck', label: '舔颈', level: 4 },
  { key: 'suck_nipple', label: '吮吸乳头', level: 4 },
  { key: 'touch_nipple', label: '捏乳头', level: 4 },
  { key: 'ear_nibble', label: '咬耳朵', level: 4 },
  { key: 'inner_thigh', label: '抚摸大腿内侧', level: 4 },
  // 击打类（2026-10-02，与后端 TOUCH_ACTIONS 同步）：动作系统里第一次有「打」——
  // 连点涨腻烦比抚摸类快（后端 annoyanceGainMultiplier），所以这两级要经得起连点
  { key: 'spank_butt', label: '拍屁股', level: 3 },
  { key: 'spank_thigh', label: '拍大腿', level: 3 },
  { key: 'slap_face_light', label: '轻拍脸颊', level: 4 },
]

/** 分级元信息（数组顺序即展示顺序） */
export const TOUCH_LEVELS = [
  { level: 1, label: '日常' },
  { level: 2, label: '亲密' },
  { level: 3, label: '敏感' },
  { level: 4, label: '私密' },
]

/**
 * 门控阈值默认值（**必须与服务层 `DEFAULT_TOUCH_THRESHOLDS` 逐字一致**）。
 *
 * ⚠️ `lv4Affinity = 0` —— 2026-10-04 用户裁决「**Lv4 私密整档直接开放**」：
 *    Lv4 不再吃好感门槛、也不再要求「亲密」授权（判定见 resolveActionGate 里那条 `level === 4`）。
 *    **Lv2(40)/Lv3(60) 别顺手动** —— 用户只要求放开 Lv4。
 *    服务层同名常量在 `agent-core/src/services/touchActionService.js`，两边必须同时改；
 *    `web-ui/test/touchLv4Mirror.test.js` 就是钉这个镜像一致性的。
 */
export const DEFAULT_GATE_THRESHOLDS = {
  lv2Affinity: 40,
  lv4Affinity: 0,
  lv3Affinity: 60,
}

/** 服务层机器码白名单（同 TOUCH_GATE_CODES）；前端只认这几个 code，不依赖服务端措辞 */
export const TOUCH_GATE_CODES = [
  'ok',
  'unknown_action',
  'affinity_low',
  'sleeping_blocked',
  'group_adult_blocked',
  'intimate_not_authorized',
]

/** 镜像拒绝对白（服务层 message 为唯一口径；这里是端点落地前的回落文案，剧情化、不机械报错） */
export const GATE_MESSAGES = {
  unknown_action: '这个动作不存在',
  affinity_low_lv2: '她现在还不愿意让你这样',
  affinity_low_lv3: '还不到那一步——先让她更信任你',
  sleeping_blocked: '她睡着了，这么做不合适',
  group_adult_blocked: '这种事别在群里做',
  intimate_not_authorized: '你们还没熟到能碰那儿',
}

/** 睡着时点到唤醒类动作的提示（专题 §四：重动作会把她弄醒） */
export const WAKE_WARNING_TEXT = '她睡着了，这一下会把她弄醒'

// ── 动作出图档位（阶段三；与后端 features.touchImageMode 同一口径）──
// 契约（Lead 2026-09-30 裁决）：取值 'always' | 'smart' | 'never'，**默认 'smart'**；
// 走既有通用 PUT /api/config/features（body { key, value }）；非法值后端回落 'smart'。
export const TOUCH_IMAGE_MODE_KEY = 'touchImageMode'
export const DEFAULT_TOUCH_IMAGE_MODE = 'smart'
export const TOUCH_IMAGE_MODES = [
  { value: 'always', label: '总是' },
  { value: 'smart', label: '智能' },
  { value: 'never', label: '从不' },
]

/** 任意输入 → 合法档位；不认识的一律回落默认 'smart'（与后端同口径） */
export function normalizeTouchImageMode(value) {
  return TOUCH_IMAGE_MODES.some(mode => mode.value === value) ? value : DEFAULT_TOUCH_IMAGE_MODE
}

/** 档位 → 中文标签（总是 / 智能 / 从不）；非法值按默认档的标签 */
export function touchImageModeLabel(value) {
  const mode = TOUCH_IMAGE_MODES.find(item => item.value === normalizeTouchImageMode(value))
  return mode ? mode.label : ''
}

/**
 * 待回应提示文案（task-25 ③）。
 * 数据来自 GET /api/characters/:id/touch/state 的 pendingCount（动作做下、还等着她回应的条数）。
 * 🔌 后端该字段**写作时尚未落地**：读不到 / 非数字一律给空串（不显示、不弹错），落地后自然生效。
 */
export function pendingHintOf(count) {
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return ''
  return '还有 ' + Math.floor(n) + ' 个动作等她回应'
}

/**
 * 合并器（task-29 问题 3）：**同一轮多条消息只触发一次刷新**。
 *
 * 一轮回复会连续插入好几条消息（她的话 + 可能的气泡更新），逐个触发会白打一堆请求；
 * 这里用「前缘合并」：窗口内第一次 schedule 真的排上，后续的**直接丢掉**（不延期、不排队），
 * 定时器触发后窗口重开。定时器与清理函数可注入，方便单测用假时钟确定性地验。
 *
 * @param {{delay?:number, run:()=>void, setTimer?:Function, clearTimer?:Function}} options
 */
export function createCoalescer({ delay = 350, run, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null
  return {
    /** @returns {boolean} 是否真的排上了（false = 被窗口合并掉了） */
    schedule() {
      if (timer !== null) return false
      timer = setTimer(() => { timer = null; run() }, delay)
      return true
    },
    get pending() { return timer !== null },
    /** @returns {boolean} 是否取消了待执行的一次（切角色 / 换对象时用） */
    cancel() {
      if (timer === null) return false
      clearTimer(timer)
      timer = null
      return true
    },
  }
}

// ── 卡片状态行（交互改版 §3.2）：耐受档 + 偏好角标 ──
// 阈值与后端 touchActionService 同源：ANNOYANCE_TIERS { fine,warm,refusing }、
// WARM_THRESHOLD 50、REFUSE_THRESHOLD 80（判定用「大于」）；文案取 prompt 措辞的短句形式。

/** 耐受档位 → 短文案（卡片底部小字，SLG 手感外显；不用悬停） */
export const ANNOYANCE_TIER_LABELS = Object.freeze({
  fine: '还乐意',
  warm: '有点不耐烦了',
  refusing: '已经很烦了',
})

/** 腻烦值 → 机器档位（与后端 annoyanceTier 同阈值） */
export function annoyanceTierKey(annoyance) {
  const value = Number(annoyance)
  if (!Number.isFinite(value)) return 'fine'
  if (value > 80) return 'refusing'
  if (value > 50) return 'warm'
  return 'fine'
}

/**
 * 卡片状态行：**优先用服务端给的 tier**（GET /touch/state 的 states[key].tier），
 * tier 缺失或认不出时按 annoyance 数值推；两者都没有就是 fine（默认耐受）。
 */
export function toleranceLabel(state) {
  const raw = state && typeof state === 'object' ? state : {}
  const tier = ANNOYANCE_TIER_LABELS[raw.tier] ? raw.tier : annoyanceTierKey(raw.annoyance)
  return ANNOYANCE_TIER_LABELS[tier] || ANNOYANCE_TIER_LABELS.fine
}

/** 偏好角标：like_ratio ≥1.25 喜欢♥ / ≤0.75 讨厌～ / 其余不显示（阈值同后端 likeRatioText） */
export function likeBadgeOf(likeRatio) {
  const ratio = Number(likeRatio)
  if (!Number.isFinite(ratio)) return ''
  if (ratio >= 1.25) return '♥'
  if (ratio <= 0.75) return '～'
  return ''
}

/**
 * 催眠状态徽标（复审遗留 2）：**只看服务端给的 active / mindAwake**，前端零推断。
 *   · active 且 mindAwake === false → 「完全控制」（身体顺从）
 *   · active 且 mindAwake === true  → 「意志清醒」（只唤醒意志：身体仍受控，但她的意志醒着）
 *   · 取不到 / active 非 true / mindAwake 不是布尔 → **null（不显示）** —— 绝不默认「完全控制」。
 */
export const HYPNOSIS_BADGES = Object.freeze({ full: '完全控制', awake: '意志清醒' })

export function hypnosisBadgeOf(state) {
  const s = state && typeof state === 'object' ? state : null
  if (!s || s.active !== true) return null
  if (typeof s.mindAwake !== 'boolean') return null   // 拿不准就不显示
  return s.mindAwake
    ? { key: 'awake', label: HYPNOSIS_BADGES.awake }
    : { key: 'full', label: HYPNOSIS_BADGES.full }
}

/** 隐式待回应的专用文案（专题 §七 问题 3）：即时动作不需要「等回应」，只有隐式才要提醒用户去说话 */
export const PENDING_IMPLICIT_HINT = '她还没回应你的动作，跟她说句话吧'

/**
 * 提示行文案（mode 感知）：有 implicit 待回应 → 「跟她说句话吧」；否则回落「还有 N 个动作等她回应」。
 * 🔌 后端 GET /touch/state 的 pendingByMode: { instant, implicit } **写作时尚未落地** ——
 *    缺字段 / 非数字一律回落旧文案（不显示错的东西、也不弹错），落地后自然生效。
 */
export function pendingHintByMode({ count, byMode } = {}) {
  const implicit = Number(byMode && byMode.implicit)
  if (Number.isFinite(implicit) && implicit > 0) return PENDING_IMPLICIT_HINT
  return pendingHintOf(count)
}

/** code + 等级 → 镜像文案（affinity_low 按等级分文案，其余按 code） */
export function gateMessage(code, level) {
  if (code === 'affinity_low') {
    return level === 3 ? GATE_MESSAGES.affinity_low_lv3 : GATE_MESSAGES.affinity_low_lv2
  }
  return GATE_MESSAGES[code] || ''
}

/** 按 key 找动作，找不到返回 null */
export function findTouchAction(actionKey) {
  return TOUCH_ACTIONS.find(a => a.key === actionKey) || null
}

/**
 * 判定单个动作当前能不能做（服务层 getTouchGate 的镜像，判定顺序逐条对齐）。
 *
 * 顺序（先到先拦，决定 code / 文案）：
 *   1. 催眠中 → 无条件放行（排在睡眠前：睡着的她在催眠里也能做）
 *   2. Lv1 → 无门控
 *   3. 睡着 + Lv3 → sleeping_blocked
 *   4. 群聊 + Lv3 + 未开群聊成人 → group_adult_blocked（阶段二生效，口径先对齐）
 *   5. 好感 < 门槛 且 未誓约 → affinity_low
 *   6. Lv3 还要过亲密看板授权 → intimate_not_authorized
 *
 * @param {{key:string,label:string,level:number,wakes?:boolean}} action
 * @param {object} [state] affinity / isOath / hypnotized / sleeping / intimateAuthorized / scene / allowGroupAdult / thresholds
 * @returns {{allowed:boolean,code:string,message:string,wakesSleeping:boolean,level:number|null,exempt:string|null,source:'mirror'}}
 */
export function resolveActionGate(action, {
  affinity = 0,
  isOath = false,
  hypnotized = false,
  sleeping = false,
  intimateAuthorized = false,
  scene = 'chat',
  allowGroupAdult = false,
  thresholds = DEFAULT_GATE_THRESHOLDS,
} = {}) {
  if (!action || !action.key) {
    return { allowed: false, code: 'unknown_action', message: gateMessage('unknown_action', null), wakesSleeping: false, level: null, exempt: null, source: 'mirror' }
  }
  const limit = { ...DEFAULT_GATE_THRESHOLDS, ...(thresholds || {}) }
  const level = Number(action.level) || 1
  // 她睡着时点到唤醒类动作（tickle / pinch_cheek）不拦，但要让调用方知道会吵醒她
  const wakesSleeping = Boolean(action.wakes && sleeping)

  const allow = (extra = {}) => ({ allowed: true, code: 'ok', message: '', wakesSleeping, level, exempt: null, source: 'mirror', ...extra })
  const block = (code) => ({ allowed: false, code, message: gateMessage(code, level), wakesSleeping: false, level, exempt: null, source: 'mirror' })

  if (hypnotized === true) return allow({ exempt: 'hypnosis' })
  if (level === 1) return allow()

  // ⚠️ 与服务层 `getTouchGate` **同口径**：Lv3 敏感 与 Lv4 私密同属"成人向"，
  //    睡着 / 群聊成人开关这两道闸门对**两档都生效**。
  //    原来这里写的是 `level === 3`，是前端漏判 —— Lv4 当时掉进了下面 `need` 的 else 分支
  //    按 lv2Affinity(40) 算，而服务层要的是 lv4Affinity(80)，两边对不上（Lv4 前端比后端松）。
  //    现在两档都判，`need` 也按 level 三分支取，逐条对齐服务层。
  const adult = level === 3 || level === 4
  if (sleeping === true && adult) return block('sleeping_blocked')
  if (scene === 'group' && adult && allowGroupAdult !== true) return block('group_adult_blocked')

  // Lv4 私密整档直接开放（2026-10-04 用户裁决）：
  //   `lv4Affinity = 0` ⇒ 恒过好感门槛；下面那条授权也**只对 Lv3 生效**。
  const need = level === 4 ? limit.lv4Affinity : (level === 3 ? limit.lv3Affinity : limit.lv2Affinity)
  if (!(Number(affinity) >= need || isOath === true)) return block('affinity_low')
  if (level === 3 && intimateAuthorized !== true) return block('intimate_not_authorized')
  return allow()
}

/** 把动作清单按分级分组，并逐条算好门控（渲染直接用） */
export function buildActionGroups(state = {}, actions = TOUCH_ACTIONS) {
  return TOUCH_LEVELS
    .map(meta => ({
      level: meta.level,
      label: meta.label,
      actions: actions
        .filter(a => a.level === meta.level)
        .map(a => ({ ...a, gate: resolveActionGate(a, state) })),
    }))
    .filter(group => group.actions.length > 0)
}

/** 当前解锁（可点）的动作数，用于收起态角标 */
export function countAvailableActions(state = {}, actions = TOUCH_ACTIONS) {
  return actions.filter(a => resolveActionGate(a, state).allowed).length
}
// ── 服务端响应 → 渲染分组 ──
// 正常路径**一律吃服务端 code/message**（它就是 getTouchGate 的真实结果，零翻译、零自算）；
// 镜像只在「端点不可用 / 早期加载 / 字段缺失」时兜底。

/** 服务端分级标签（如 'Lv1 日常'）→ 前端短标签（'日常'） */
function stripLevelPrefix(label) {
  if (typeof label !== 'string') return ''
  return label.replace(/^Lv\s*\d+\s*/i, '').trim()
}

/**
 * 归一化服务端 gate：字段齐全时**一律以服务端为准**（哪怕与镜像算出来的不一致——镜像只是兜底口径），
 * 只有服务端字段缺失才回落到镜像结果。
 */
export function normalizeServerGate(serverGate, mirrorGate) {
  if (!serverGate || typeof serverGate.allowed !== 'boolean') {
    return { ...mirrorGate, source: 'mirror' }
  }
  const allowed = serverGate.allowed === true
  const code = typeof serverGate.code === 'string' && serverGate.code ? serverGate.code : (allowed ? 'ok' : mirrorGate.code)
  const serverMessage = typeof serverGate.message === 'string' ? serverGate.message : ''
  return {
    allowed,
    code,
    // 放行时服务端 message 本就是空串；被拒时优先用服务端那句人话，缺失才回落镜像文案
    message: serverMessage || (allowed ? '' : mirrorGate.message),
    wakesSleeping: serverGate.wakesSleeping === true,
    exempt: serverGate.exempt || null,
    level: mirrorGate.level,
    source: 'server',
  }
}

/**
 * 把 GET /api/characters/:id/touch/actions 的响应变成组件用的分组结构。
 * 清单也用服务端的（服务层加了动作前端自动跟上，不必等镜像表同步）。
 * payload 为空 / 没有 actions → 返回 []，组件自动回落到镜像门控。
 */
export function buildGroupsFromServer(payload) {
  const rows = Array.isArray(payload?.actions) ? payload.actions : []
  if (!rows.length) return []
  const gateMap = payload?.gate || {}
  const levelLabels = payload?.levels || {}

  const levels = []
  for (const row of rows) {
    const level = Number(row.level) || 1
    if (!levels.includes(level)) levels.push(level)
  }
  levels.sort((a, b) => a - b)

  return levels.map(level => ({
    level,
    label: stripLevelPrefix(levelLabels[level]) || (TOUCH_LEVELS.find(item => item.level === level) || {}).label || '',
    actions: rows
      .filter(row => (Number(row.level) || 1) === level)
      .map(row => {
        const mirrorAction = findTouchAction(row.key) || { key: row.key, label: row.label, level, wakes: row.wakes === true }
        return {
          key: row.key,
          label: row.label,
          level,
          wakes: row.wakes === true,
          gate: normalizeServerGate(gateMap[row.key], resolveActionGate(mirrorAction, {})),
        }
      }),
  }))
}
