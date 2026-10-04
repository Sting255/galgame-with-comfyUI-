/**
 * 玩具系统前端镜像（专题 §2.8 / §2.9-7）。
 *
 * 权威口径在 `agent-core/src/services/toyService.js` 的 TOYS / `services/toy/*` —— 这里只做**展示镜像**：
 * 名称 / 部位 / 最大强度 / 效果语义给 UI 用，**不参与任何门控决策**（allowed 一律照服务端结论渲染）。
 * 用户已拍板：首批 5 种；**项圈不给强度档**（maxIntensity = 0 ⇒ 无档位）。
 *
 * 2026-10-02 玩法扩充（用户原话「玩具玩法有点太少了」）：
 *   · `TOYS` / `TOY_KEYS` **保持首批 5 件不动**（既有测试逐项钉住它）；第二批 6 件走 `EXTRA_TOYS`，
 *     合并视图是 `ALL_TOYS` / `ALL_TOY_KEYS`，`getToy()` 认识全部 11 件；
 *   · 模式 / 曲线 / 实时状态**只显示服务端给的结论**（`liveIntensity` / `mode` / `remainingSec` / `combo`），
 *     前端**不重算**曲线（重算就等于第二份口径，改一处漏一处）。
 */
export const TOYS = Object.freeze({
  vibe_egg:     { key: 'vibe_egg',     label: '跳蛋',  part: '阴蒂', maxIntensity: 5, level: 4, effect: '贴着阴蒂一直震：写她坐姿发僵、腿根夹紧，句子被震得一顿一顿' },
  vibe_stick:   { key: 'vibe_stick',   label: '振动棒', part: '阴道', maxIntensity: 5, level: 4, effect: '体内被撑开又被震：写她走路变慢、坐下时不敢坐实' },
  anal_plug:    { key: 'anal_plug',    label: '肛塞',  part: '后庭', maxIntensity: 3, level: 4, effect: '后庭被塞满的胀感：写她坐着时重心偏一边、被顶到时呼吸一抖' },
  nipple_clamp: { key: 'nipple_clamp', label: '乳夹',  part: '乳头', maxIntensity: 3, level: 3, effect: '乳尖被夹住的钝痛与麻：写她含胸、手臂挡在胸前' },
  collar:       { key: 'collar',       label: '项圈',  part: '颈部', maxIntensity: 0, level: 3, effect: '脖子上那一圈的存在感：写她下意识去摸它、被提到时就安静下来' },
})

/** 第二批（与 `services/toy/catalog.js` 对齐：部位 / 刺激类型 / 上限 / 效果语义） */
export const EXTRA_TOYS = Object.freeze({
  clit_sucker:   { key: 'clit_sucker',   label: '吸吮器',        part: '阴蒂',             maxIntensity: 5, level: 4, stimulus: 'suction',   effect: '负压吸住阴蒂不停嘬：写她小腹一下一下发紧、气音被吸断' },
  g_spot_vibe:   { key: 'g_spot_vibe',   label: 'G点棒',         part: '阴道前壁（G点）',  maxIntensity: 5, level: 4, stimulus: 'vibration', effect: '酸胀感从体内往外顶：写她腰塌下去、忍不住往前迎' },
  anal_beads:    { key: 'anal_beads',    label: '串珠',          part: '后庭',             maxIntensity: 3, level: 4, stimulus: 'beads',     effect: '每推进一颗都是一次新的撑开：写她屏住呼吸、后腰绷紧' },
  nipple_sucker: { key: 'nipple_sucker', label: '乳尖吸吮器',    part: '乳头',             maxIntensity: 3, level: 3, stimulus: 'suction',   effect: '乳尖被吸得发胀：写她含胸、衣料蹭到都难受' },
  chain_clamp:   { key: 'chain_clamp',   label: '乳链',          part: '双乳',             maxIntensity: 2, level: 3, stimulus: 'clamp',     effect: '链条把两边连在一起：写她不敢乱动、动作被迫放慢' },
  thigh_vibe:    { key: 'thigh_vibe',    label: '大腿绑带振动器', part: '大腿内侧',        maxIntensity: 3, level: 3, stimulus: 'vibration', effect: '震动顺着腿根往上爬却差一点：写她夹不紧腿、坐着不停挪动' },
})

export const TOY_KEYS = Object.freeze(Object.keys(TOYS))

/** 全部 11 件（面板的可选清单用这一份；门控仍以服务端 `allowed` 为准） */
export const ALL_TOYS = Object.freeze({ ...TOYS, ...EXTRA_TOYS })
export const ALL_TOY_KEYS = Object.freeze(Object.keys(ALL_TOYS))

export function getToy(toyKey) {
  return ALL_TOYS[toyKey] || null
}

/**
 * 玩具键 → 中文名 / 部位（**唯一来源**：面板、手机、日志都调它）。
 *
 * ⚠️ 真机踩过的坑（用户截图：后 6 件显示 `clit_sucker · · 最多 5 档`）：
 *   面板自己写了一份 `TOYS[key] || listAllToys().find(t => t.toyKey === key)` ——
 *   而镜像里每条记录的字段叫 **`key`**，不是 `toyKey` ⇒ 第二批（EXTRA_TOYS）**永远找不到** ⇒
 *   回落到把键名糊到用户脸上。教训：解析只留一处，并且**兜底也不许露出键名**。
 */
export function toyLabelOf(toyKey) {
  const toy = getToy(String(toyKey ?? ''))
  return (toy && (toy.label || toy.name)) || '未知玩具'
}

/** 玩具键 → 部位中文；认不出给空串（面板按「名 · 部位 · 档位」拼，空串自然退化成两段） */
export function toyPartOf(toyKey) {
  const toy = getToy(String(toyKey ?? ''))
  return (toy && toy.part) || ''
}

/** 全部玩具数组（顺序 = 首批 5 件在前，与后端 `ALL_TOY_KEYS` 同序） */
export function listAllToys() {
  return ALL_TOY_KEYS.map(key => ALL_TOYS[key])
}

/** 最大强度；不认识的玩具 → 0（不炸） */
export function maxIntensityOf(toyKey) {
  const toy = getToy(toyKey)
  return toy ? toy.maxIntensity : 0
}

/** 有没有强度档（项圈没有 —— 用户拍板） */
export function hasIntensity(toyKey) {
  return maxIntensityOf(toyKey) > 0
}

/**
 * 背包胶囊上的"强度上限"文案（2026-10-02 用户截图反馈）。
 *
 * 原来模板直接写 `最多 {{ maxIntensity }} 档` ⇒ 项圈（`maxIntensity: 0`，它是**象征物**、
 * 本来就没有强度档，这个 0 是刻意的）显示成「项圈 · 颈部 · 最多 **0** 档」——
 * 用户一眼看去像 bug。没有档位的玩具要说清"它不是靠档位玩的"，而不是报个 0。
 */
export function intensityCapText(toyKeyOrToy) {
  const key = typeof toyKeyOrToy === 'string' ? toyKeyOrToy : (toyKeyOrToy?.key || toyKeyOrToy?.toyKey)
  const toy = getToy(key)
  const max = typeof toyKeyOrToy === 'object' && toyKeyOrToy?.maxIntensity != null
    ? Number(toyKeyOrToy.maxIntensity)
    : (toy ? toy.maxIntensity : 0)
  if (!(max > 0)) return '象征物 · 无强度档'
  return `最多 ${max} 档`
}

/** 强度夹到 0~max 的整数档；无档位 / 不认识的玩具恒 0 */
export function clampIntensity(toyKey, value) {
  const max = maxIntensityOf(toyKey)
  if (max <= 0) return 0
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(0, Math.round(n)))
}

/** 展示用：'3/5'；无档位 → '无档位' */
export function intensityLabel(toyKey, value) {
  if (!hasIntensity(toyKey)) return '无档位'
  return clampIntensity(toyKey, value) + '/' + maxIntensityOf(toyKey)
}

// ── 玩法（模式 / 曲线 / 实时状态）· 只做展示，判定与计算全在服务端 ──────────────

/** 振动模式（与 `services/toy/mechanics.js` 的 VIBRATION_MODES 对齐：value/label/desc） */
export const VIBRATION_MODES = Object.freeze([
  { value: 'steady', label: '持续', desc: '一直震，没有间隙' },
  { value: 'pulse', label: '脉冲', desc: '一阵一阵，断续' },
  { value: 'wave', label: '渐变', desc: '慢起慢落，像波浪' },
  { value: 'random', label: '随机', desc: '忽强忽弱，猜不到下一次' },
])

/** 强度曲线类型（服务端要 `{type, from, to, durationSec, loop}`，这里只给选项） */
export const INTENSITY_CURVES = Object.freeze([
  { value: 'ramp_up', label: '渐强', desc: '从起始档一路升到目标档' },
  { value: 'ramp_down', label: '渐弱', desc: '从起始档缓缓降下来' },
  { value: 'wave', label: '起伏', desc: '在两个档位之间来回起伏' },
  { value: 'surge', label: '冲刺', desc: '先冲到最高档，再慢慢回落' },
])

/** 曲线默认时长（秒）：5 分钟；面板也可以给 2 / 10 分钟档 */
export const CURVE_DURATIONS = Object.freeze([120, 300, 600])
export const DEFAULT_CURVE_DURATION = 300

export function modeLabelOf(mode) {
  const found = VIBRATION_MODES.find(m => m.value === mode)
  return found ? found.label : '持续'
}

export function modeDescOf(mode) {
  const found = VIBRATION_MODES.find(m => m.value === mode)
  return found ? found.desc : ''
}

export function curveLabelOf(curve) {
  if (!curve || !curve.type) return ''
  const found = INTENSITY_CURVES.find(c => c.value === curve.type)
  const name = found ? found.label : curve.type
  return name + ' ' + curve.from + '→' + curve.to + '档/' + durationText(curve.durationSec) + (curve.loop ? '（循环）' : '')
}

/** 秒 → '2 分 30 秒' / '45 秒' */
export function durationText(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0))
  if (n < 60) return n + ' 秒'
  const m = Math.floor(n / 60)
  const s = n % 60
  return s > 0 ? (m + ' 分 ' + s + ' 秒') : (m + ' 分钟')
}

/** 此刻生效的档位：服务端给了 liveIntensity 就用它，否则退回基准档（旧响应也渲染得出来） */
export function liveIntensityOf(worn) {
  if (!worn) return 0
  const live = Number(worn.liveIntensity)
  return Number.isFinite(live) ? live : (Number(worn.intensity) || 0)
}

/** 曲线剩余时间文案；没有曲线 → ''；走完 → '曲线已走完' */
export function remainingText(worn) {
  if (!worn || !worn.curve) return ''
  if (worn.curveFinished === true) return '曲线已走完'
  const sec = Number(worn.remainingSec)
  if (!Number.isFinite(sec)) return ''
  return '还剩 ' + durationText(sec)
}

/** 已戴玩具那一行的状态串：强度 / 模式 / 剩余（面板直接显示，不重算） */
export function wornStatusText(worn) {
  if (!worn) return ''
  const bits = ['强度 ' + liveIntensityOf(worn) + '/' + (Number(worn.maxIntensity) || maxIntensityOf(worn.toyKey))]
  if (worn.mode && worn.mode !== 'steady') {
    bits.push(modeLabelOf(worn.mode) + (worn.modePhaseText ? '（' + worn.modePhaseText + '）' : ''))
  }
  const remain = remainingText(worn)
  if (remain) bits.push(remain)
  return bits.join(' · ')
}

/** 组合佩戴摘要（服务端 combos）：没组合 → '' */
export function comboSummaryText(combos) {
  if (!combos || !Array.isArray(combos.labels) || combos.labels.length === 0) return ''
  const head = '同时成立：' + combos.labels.join('、')
  if (combos.overload) return head + '（已经过载，她快跟不上了）'
  if (combos.heavy) return head + '（叠加明显）'
  return head
}

/** 她自己玩的判定文案（面板把服务端的判定原样说人话） */
export function selfPlayText(decision, { last = null } = {}) {
  if (!decision) return ''
  if (decision.play) {
    return decision.secret ? '她可能会偷偷自己玩（看你现在有没有在看着她）' : '她现在有点想自己玩'
  }
  const map = {
    not_yet: '关系还没到那一步，她不会自己去碰',
    cooldown: '刚过去没多久，她还没缓过来',
    daily_limit: '今天已经够多次了',
    sleeping: '她睡着了',
    no_toy: '她手上没有可用的玩具',
    held_back: '她动了下念头，又忍住了',
  }
  return map[decision.code] || (decision.reason || '')
}

