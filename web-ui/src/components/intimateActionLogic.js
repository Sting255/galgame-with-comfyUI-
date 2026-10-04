/**
 * 性爱交互「可点击推进」· 前端纯逻辑（task-1，2026-10-01）
 *
 * **本文件是服务层 `agent-core/src/services/intimateActionService.js` 的前端镜像**：
 * web-ui 不能 import agent-core（跨包），所以在端点 `GET /api/intimate-actions/:id/state` 拿不到时，
 * 面板仍要能渲染出正确的状态行、档位、体位胶囊与按钮置灰 —— 这份镜像就是那个回落。
 *
 * 口径（**服务端返回永远是唯一口径**，镜像只在端点不可用时兜底，与 touchActionLogic 同款）：
 *   · 入参：后端 state / her / actions 的原样对象（字段名逐字对齐，无需翻译层）；
 *   · 出参：{ allowed, code, message }，code 取服务层 INTIMATE_REJECT_CODES；
 *   · 节奏档 1~4 = 缓 / 正常 / 快 / 冲刺；累积 0~100，≥60 高潮边缘、≥85 绷不住；
 *   · 未插入时「继续抽插 / 加速 / 慢下来 / 一起到」一律不可用（拒绝码 not_penetrating）。
 *
 * 纯函数、零依赖、无浏览器 API：`web-ui/test/intimateAction*.test.js` 直接 import 本文件断言。
 */

/** 节奏档（与服务层 PACE_LEVELS 逐字一致） */
export const PACE_LEVELS = [
  { value: 1, key: 'slow', label: '缓' },
  { value: 2, key: 'normal', label: '正常' },
  { value: 3, key: 'fast', label: '快' },
  { value: 4, key: 'sprint', label: '冲刺' },
]

export const PACE_MIN = 1
export const PACE_MAX = 4
export const DEFAULT_PACE = 2

/** 累积度阈值（与服务层一致） */
export const MAX_ACCUMULATION = 100
export const EDGE_THRESHOLD = 60
export const OVERLOAD_THRESHOLD = 85
export const CLIMAX_MIN_ACCUMULATION = 60

/** 动作清单镜像（与服务层 INTIMATE_ACTIONS 的 key/label/hint/tone 一致） */
export const INTIMATE_ACTIONS = [
  { key: 'enter', label: '进入她', hint: '插进去，正式开始这一轮' },
  { key: 'thrust', label: '继续抽插', hint: '保持现在的节奏往里推' },
  { key: 'faster', label: '加速抽插', hint: '节奏升一档（最高「冲刺」）', tone: 'primary' },
  { key: 'slower', label: '慢下来', hint: '节奏降一档，把她的感觉吊住' },
  // ⚠️ `stop` 的 label 是「拔出」（2026-10-04 用户：「面板里的那个停止就换成拔出吧」）。
  //    这里与服务层 `INTIMATE_ACTIONS` 必须**逐字一致**（跨包契约测试会比对）；只改文案不改行为。
  { key: 'stop', label: '拔出', hint: '整根退出来，让两个人都喘口气' },
  { key: 'position', label: '换姿势', hint: '点下面的体位让她换过去' },
  { key: 'climax', label: '一起到', hint: '在高潮边缘直接把她推过去', tone: 'danger' },
  // 2026-10-02 新玩法（与服务层 INTIMATE_ACTIONS 逐字一致；跨包契约测试会比对）
  // 2026-10-03 用户澄清「自动的意思是自动插入 不是自己动 命令那个可以改成命令自己动」⇒ 这两条文案改了，
  // 服务层同步改过（`intimateNewPlays` / `autoPace` 两个测试都钉着）。
  { key: 'command', label: '命令她自己动', hint: '不许他动手，全要你自己来 —— 被束着时她只能照做（SM 服从玩法）' },
  { key: 'spank', label: '拍打', hint: '一记落在臀上：痛感与羞耻也在把她往高潮推' },
  { key: 'bondage', label: '捆手', hint: '把她的手腕束起来（再点一次解开）：她推不开你，累积涨得更快' },
  // 2026-10-02 分型捆绑（与服务层逐字一致；`bondage` 在服务端是**位掩码** ⇒ 可同时绑多处，
  // 面板按快照里的 `bonds` 逐位显示选中态）
  { key: 'bind_box', label: '龟甲缚', hint: '绳从颈后绕到胸前再收去胯下（再点一次解开）：整条躯干被固定，她只能挺着受' },
  { key: 'bind_legs', label: '束脚', hint: '脚踝并拢束住、腿分不开（再点一次解开）：角度全由你摆' },
  { key: 'bind_body', label: '全身束', hint: '手腕、脚踝与躯干一起固定（再点一次解开）：她几乎完全动不了' },
  { key: 'bind_gag', label: '口球', hint: '嘴里被塞住（再点一次取下）：她只能发出含混的声音，说不成完整句子' },
  { key: 'auto', label: '自动插入', hint: '他自己按「自动速度」一下一下插送（再点一次停下）：你可以腾出手去做别的' },
  { key: 'denial', label: '禁止高潮', hint: '不许她到（再点一次解开）：憋着能涨过满格，解开那一瞬间才是释放', tone: 'danger' },
]

/**
 * 体位镜像（只在 `/state` 的 positionOptions 为空时用；label 与词表里的中文名一致）。
 * ⚠️ 这些 key 全部实测存在于后端 `adult_pose_vocabulary`；
 * 后端加了精选清单也不用改这里 —— 服务端给了就以服务端为准。
 */
export const FALLBACK_POSITIONS = [
  { key: 'missionary', label: '传教士体位', penetrative: true },
  { key: 'doggystyle', label: '狗爬式', penetrative: true },
  { key: 'cowgirl position', label: '女上正骑', penetrative: true },
  { key: 'reverse cowgirl', label: '女上反骑', penetrative: true },
  { key: 'prone bone, sex from behind', label: '俯卧后入', penetrative: true },
  { key: 'arms grab, sex from behind', label: '抱腰后入', penetrative: true },
  { key: 'standing sex, doggystyle', label: '站姿后入', penetrative: true },
  { key: 'kneeling, blowjob', label: '跪姿口交', penetrative: false },
  { key: 'deepthroat', label: '深喉', penetrative: false },
  { key: 'paizuri', label: '乳交', penetrative: false },
  { key: 'handjob', label: '手交', penetrative: false },
  { key: 'cunnilingus', label: '舔阴', penetrative: false },
  { key: 'anal insertion', label: '肛内插入', penetrative: true },
]

/** 默认体位（与服务层 DEFAULT_POSITION_KEY 一致） */
export const DEFAULT_POSITION_KEY = 'missionary'

/** 拒绝码白名单（与服务层 INTIMATE_REJECT_CODES 一致） */
export const INTIMATE_REJECT_CODES = [
  'ok', 'unknown_action', 'invalid_position', 'not_penetrating', 'already_penetrating',
  'position_not_penetrative', 'pace_max', 'pace_min', 'not_edge', 'not_active', 'she_refuses',
]

const toInt = (value, fallback = 0) => {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

const clamp = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 节奏档中文名（越界夹取，非法回落「正常」） */
export function paceLabelOf(pace) {
  const level = clamp(pace, PACE_MIN, PACE_MAX, DEFAULT_PACE)
  return PACE_LEVELS.find(p => p.value === level)?.label || '正常'
}

/** 节奏分段（LinsheTabs 用；`disabled` 时只作状态显示，不参与切换） */
export function paceOptions() {
  return PACE_LEVELS.map(p => ({ value: p.value, label: p.label }))
}

/** 节奏档夹取（手动节奏档与**自动速度**共用；面板点页签时先夹一次，脏值不发出去） */
export function clampPaceForUi(pace) {
  return clamp(pace, PACE_MIN, PACE_MAX, 0)
}

/** 累积度档位文案（与服务层 accumulationTier 同阈值） */
export function accumulationTierOf(accumulation) {
  const value = clamp(accumulation, 0, MAX_ACCUMULATION, 0)
  if (value >= OVERLOAD_THRESHOLD) return { key: 'overload', label: '绷不住', value }
  if (value >= EDGE_THRESHOLD) return { key: 'edge', label: '高潮边缘', value }
  if (value >= 30) return { key: 'rising', label: '渐入', value }
  return { key: 'calm', label: '还稳得住', value }
}

/**
 * 后端 state（或它的子集）→ 面板视图模型。缺字段一律给安全默认，绝不 throw
 * （面板是"点一下就要有反应"的交互件，不能因为一个字段缺失整块白屏）。
 */
export function normalizeIntimateState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const active = source.active === true
  const penetrating = active && source.penetrating === true
  const accumulation = clamp(source.accumulation, 0, MAX_ACCUMULATION, 0)
  const pace = clamp(source.pace, PACE_MIN, PACE_MAX, DEFAULT_PACE)
  const positionKey = String(source.positionKey || DEFAULT_POSITION_KEY)
  const tier = accumulationTierOf(accumulation)
  return {
    active,
    penetrating,
    positionKey,
    positionLabel: String(source.positionLabel || positionKey),
    actKey: String(source.actKey || 'vaginal'),
    pace,
    paceLabel: String(source.paceLabel || paceLabelOf(pace)),
    accumulation,
    accumulationTier: String(source.accumulationTier || tier.key),
    accumulationLabel: String(source.accumulationLabel || tier.label),
    climaxCount: Math.max(0, toInt(source.climaxCount, 0)),
    rounds: Math.max(0, toInt(source.rounds, 0)),
    startedAt: source.startedAt || null,
    lastActionAt: source.lastActionAt || null,
    edge: accumulation >= EDGE_THRESHOLD,
    overload: accumulation >= OVERLOAD_THRESHOLD,
    // 「一起到」的门槛随她自己的敏感度浮动（45~60，服务端口径见 intimateActionService.climaxThreshold）。
    // ⚠️ 面板以前写死 60 显示"还差多少"，敏感度高的她会显示错（按钮能点、提示却说没到）。
    climaxThreshold: clamp(source.climaxThreshold, 20, MAX_ACCUMULATION, EDGE_THRESHOLD),
    // 自动速度（2026-10-03 独立旋钮）：她自己动的快慢与每下涨多少，跟手动节奏档无关
    autoThrust: source.autoThrust === true || source.autoThrust === 1,
    autoPace: clamp(source.autoPace, PACE_MIN, PACE_MAX, DEFAULT_PACE),
    autoPaceLabel: String(source.autoPaceLabel || paceLabelOf(clamp(source.autoPace, PACE_MIN, PACE_MAX, DEFAULT_PACE))),
    autoIntervalMs: clamp(source.autoIntervalMs, 500, 60000, AUTO_PACE_INTERVALS_FALLBACK[clamp(source.autoPace, PACE_MIN, PACE_MAX, DEFAULT_PACE)]),
    autoTickGain: clamp(source.autoTickGain, 0, 20, 0),
  }
}

/** 自动速度表：服务端 `AUTO_PACE_INTERVALS` 的前端镜像（后端没给 ms 时兜底，别写死一格） */
export const AUTO_PACE_INTERVALS_FALLBACK = Object.freeze({ 1: 5000, 2: 3000, 3: 2000, 4: 1500 });

/** 自动速度那一排页签的 title（说清"改的是他自动插送的快慢"） */
export function autoPaceTitle(state) {
  const s = normalizeIntimateState(state)
  if (!s.autoThrust) return '先点「自动插入」让他自己按节奏动，这里再调他自动插送的快慢'
  return `他自动插送的速度：${s.autoPaceLabel}（每 ${(s.autoIntervalMs / 1000).toFixed(1)} 秒一下，每下 +${s.autoTickGain}）——与上面的「节奏」无关`
}

/**
 * 敏感度专用夹取：**保留一位小数**。
 * ⚠️ 不能复用上面的 `clamp`（它走 `parseInt` ⇒ 12.4 会被截成 12）。一次推进只涨 0.5，
 * 取整之后就"永远不动" —— 用户真机反馈的「性爱并没有增加敏感度」有一半就是这么来的。
 */
const clampDecimal = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(max, Math.max(min, n)) * 10) / 10
}

/**
 * 她的敏感度（新数值系统，2026-10-02）→ 面板文案。
 * 后端 `her.sensitivity = { value, tier, tierLabel, multiplier, heat, climaxStrength }`；
 * 缺字段一律给安全默认（面板绝不能因为数值系统缺失白屏）。
 */
export function sensitivityView(her) {
  const s = her && typeof her === 'object' ? (her.sensitivity || {}) : {}
  const value = clampDecimal(s.value, 0, 100, 0)
  const tierLabel = String(s.tierLabel || '')
  const heat = s.heat === true
  return {
    available: Boolean(s.tierLabel || s.tier || s.value),
    value,
    tier: String(s.tier || ''),
    tierLabel,
    heat,
    climaxStrength: clamp(s.climaxStrength, 1, 5, 3),
    // 面板上那一行：「敏感度 68.5/100 · 很敏感」；发情模式时直接说"发情中"
    // （数值是 Number ⇒ 整数不会显示成 "55.0"，小数才带一位）
    text: heat ? `敏感度 ${value}/100 · 发情中` : (tierLabel ? `敏感度 ${value}/100 · ${tierLabel}` : ''),
    title: heat
      ? '发情模式：她的敏感度被拉满 —— 更快到、更频繁、高潮更重'
      : '敏感度：这段时间她身体被碰得多不多。越高越容易被推上去，高潮也越强',
  }
}

/** 累积度进度条百分比（0~100，整数） */
export function progressPercent(state) {
  const normalized = normalizeIntimateState(state)
  return Math.round((normalized.accumulation / MAX_ACCUMULATION) * 100)
}

/** 一行摘要：「狗爬式 · 插入中 · 快 · 累积 62%」 */
export function summaryText(state) {
  const s = normalizeIntimateState(state)
  const where = s.penetrating ? '插入中' : (s.active ? '停在外面' : '还没开始')
  return `${s.positionLabel} · ${where} · ${s.paceLabel} · 累积 ${progressPercent(s)}%`
}

/** 状态徽标文案（HUD 用；与服务端口径一致：未开始 / 停在外面 / 插入中） */
export function statusChipText(state) {
  const s = normalizeIntimateState(state)
  if (s.penetrating) return '插入中'
  return s.active ? '停在外面' : '还没开始'
}

/** 累积度提示（进度条 title / 下方小字） */
export function accumulationHint(state) {
  const s = normalizeIntimateState(state)
  if (s.overload) return '她快绷不住了：再说一句完整的话都难，随时会被顶过去'
  if (s.edge) return '高潮边缘：再推进就会失控'
  if (s.accumulation >= 30) return '已经入戏：句子开始断，呼吸乱了'
  return '还稳得住：能嘴硬、能催他'
}

/** 体位清单：服务端给了就用服务端的（唯一口径），没有才回落镜像 */
export function positionOptionsOf(state) {
  const list = state && Array.isArray(state.positionOptions) ? state.positionOptions : []
  const usable = list.filter(item => item && item.key && item.label)
  return usable.length > 0 ? usable : FALLBACK_POSITIONS
}

/** 动作按钮清单：服务端 actions 优先（含 available / reason），没有才用镜像自算 */
export function actionButtonsOf(state) {
  const list = state && Array.isArray(state.actions) ? state.actions : []
  const usable = list.filter(item => item && item.key)
  if (usable.length > 0) {
    return usable.map(item => ({
      key: item.key,
      label: item.label || item.key,
      hint: item.hint || '',
      tone: item.tone || '',
      available: item.available === true,
      reason: item.reason || '',
      code: item.code || (item.available ? 'ok' : ''),
    }))
  }
  const normalized = normalizeIntimateState(state)
  return INTIMATE_ACTIONS.map(action => {
    const probe = localAvailability(action.key, normalized)
    return { ...action, available: probe.allowed, reason: probe.message, code: probe.code }
  })
}

/**
 * 前端镜像门控：端点不可用时按钮的置灰与理由。
 * **服务端说不行就是不行**；这里只保证"端点没落地也不给死按钮"。
 */
export function localAvailability(actionKey, state) {
  const s = normalizeIntimateState(state)
  switch (actionKey) {
    case 'enter':
      if (s.penetrating) return { allowed: false, code: 'already_penetrating', message: '她已经含着你，直接点「继续抽插」就好。' }
      if (!isPenetrativePosition(s.positionKey)) {
        return { allowed: false, code: 'position_not_penetrative', message: `「${s.positionLabel}」插不进去：先换个能插入的体位。` }
      }
      return { allowed: true, code: 'ok', message: '' }
    case 'thrust':
    case 'faster':
    case 'slower':
    case 'climax':
      if (!s.penetrating) return { allowed: false, code: 'not_penetrating', message: '还没插进去：先点「进入她」，或者换个能插入的体位。' }
      if (actionKey === 'faster' && s.pace >= PACE_MAX) return { allowed: false, code: 'pace_max', message: '已经是「冲刺」档了，没有更快的。' }
      if (actionKey === 'slower' && s.pace <= PACE_MIN) return { allowed: false, code: 'pace_min', message: '已经是最慢的节奏了：想再缓一点就点「停下」。' }
      if (actionKey === 'climax' && s.accumulation < CLIMAX_MIN_ACCUMULATION) {
        return { allowed: false, code: 'not_edge', message: `她还远没到：现在累积 ${s.accumulation}，先推上去。` }
      }
      return { allowed: true, code: 'ok', message: '' }
    case 'stop':
      if (!s.active) return { allowed: false, code: 'not_active', message: '这一场还没开始，不用停。' }
      return { allowed: true, code: 'ok', message: '' }
    case 'position':
      return { allowed: true, code: 'ok', message: '' }
    default:
      return { allowed: false, code: 'unknown_action', message: '没有这个动作。' }
  }
}

/** 该体位能不能插入（按镜像清单判；服务端会用自己的词表再判一次） */
export function isPenetrativePosition(positionKey) {
  const key = String(positionKey || '')
  const hit = FALLBACK_POSITIONS.find(p => p.key === key)
  if (hit) return hit.penetrative !== false
  // 镜像里没有的 key（服务端自定义体位）：保守放行，让服务端说了算，别在前端造第二套判定
  return true
}

/** 体位胶囊的 title（能不能插入 / 是否当前体位） */
export function positionTitle(position, state) {
  const item = position || {}
  const current = normalizeIntimateState(state)
  const marks = []
  if (item.key === current.positionKey) marks.push('当前体位')
  marks.push(item.penetrative === false ? '非插入体位（口 / 手 / 乳）' : '可插入')
  if (item.actKey) marks.push(`行为：${item.actKey}`)
  return `${item.label || item.key}（${marks.join('，')}）`
}

/**
 * 解析一次 POST 的返回（**只认服务端的 allowed / code / message**）。
 * @returns {{allowed:boolean, code:string, message:string, state:object|null, reaction:object|null, notice:string, mode:string, fallback:boolean}}
 */
export function parseActionResponse(payload) {
  const data = payload && typeof payload === 'object' ? payload : {}
  const allowed = data.allowed === true
  const code = String(data.code || (allowed ? 'ok' : 'unknown_action'))
  return {
    allowed,
    // 白名单只是"前端认识哪些码"的文档；未知码原样透传，不做静默改写
    code,
    knownCode: INTIMATE_REJECT_CODES.includes(code),
    message: String(data.message || ''),
    state: data.state && typeof data.state === 'object' ? data.state : null,
    reaction: data.reaction && typeof data.reaction === 'object' ? data.reaction : null,
    notice: String(data.notice || ''),
    mode: String(data.mode || ''),
    fallback: data.fallback === true,
    climaxed: data.climaxed === true,
  }
}

/**
 * 点完之后给用户的一句短反馈（面板底部小字；服务端 message / notice 优先）。
 *
 * 口径（Lead 裁决 2026-10-01）：
 *   · 被门控拒绝 → **原样用服务端那句 message**（面板同时 toast 它，绝不静默）；
 *   · `reaction:null` 的成功（省额度模式 / 模型失败 / 回执没带反应）→ 必须给一行"已推进"，
 *     不能留空白让人以为点坏了。
 */
export function actionFeedbackText(result) {
  const parsed = parseActionResponse(result)
  if (!parsed.allowed) return parsed.message || '现在还不行。'
  if (parsed.notice) return parsed.notice
  if (parsed.fallback) return '她的反应没写出来（模型调用失败）：状态已经推进，这一下会在下一轮补演。'
  if (parsed.climaxed) return '她到了 —— 身体还在抖，喘得说不出完整的话。'
  // 成功但没有即时反应正文：明确告诉用户"推进生效了、她稍后回应"，别留空白
  if (!parsed.reaction) {
    return parsed.mode === 'implicit'
      ? '已推进：这一下她会在下一轮聊天里回应你。'
      : '已推进：她这一下没有立刻回话，稍后会在聊天里出现。'
  }
  return '已推进：她的反应已经发到聊天里了。'
}
