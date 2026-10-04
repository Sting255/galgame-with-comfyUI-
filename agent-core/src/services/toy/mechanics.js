/**
 * services/toy/mechanics.js —— 玩具玩法机制（纯函数，零 DB / 零 IO）
 *
 * 三类机制，全部是**可注入假时钟的纯函数**（单测不 sleep、不依赖真实时间）：
 *   ① **组合佩戴** `comboEffects(wornList)`     —— 多件同时戴：叠加 / 互相影响 / 过载
 *   ② **振动模式** `modeFactor / modePhase`     —— 持续 / 脉冲 / 渐变 / 随机，决定她的反应节奏
 *   ③ **强度曲线** `curveTargetAt / curveProgress` —— 随时间自动升降，由 `toyService.tickToys` 推进
 *
 * 为什么单独一个文件：这三件事一个纯函数就能钉住，不需要 DB；而 `toyService.js` 已经背了
 * 佩戴生命周期 + 注入块 + 出图，再往里塞模式/曲线会让那一个文件变成两千行。
 * **依赖方向**：本文件不 import 任何其它模块（catalog 也不 import），`toyService` 单向引用它。
 */

// ── ② 振动模式 ───────────────────────────────────────────────────────────────

/**
 * 四种模式。`rhythm` 是**节奏指引**（进 prompt，让模型按节奏演，而不是只换个形容词），
 * `lowFactor` 是波谷系数（1 = 不衰减）。
 */
export const VIBRATION_MODES = Object.freeze({
  steady: Object.freeze({
    key: 'steady', label: '持续', desc: '一直震，没有间隙',
    rhythm: '持续不断、均匀的刺激，她的反应是一条不断抬高的线（越到后面越压不住）',
    lowFactor: 1, periodSec: 0,
  }),
  pulse: Object.freeze({
    key: 'pulse', label: '脉冲', desc: '一阵一阵，断续',
    rhythm: '一阵一阵的冲击：冲上来时她的话被截断，退下去时她刚喘半口气就又被顶起来',
    lowFactor: 0.35, periodSec: 6, onSec: 2.4,
  }),
  wave: Object.freeze({
    key: 'wave', label: '渐变', desc: '慢起慢落，像波浪',
    rhythm: '缓慢的涨落：她会在不知不觉中被推高，又在退潮时软下来，情绪跟着一起一伏',
    lowFactor: 0.45, periodSec: 24,
  }),
  random: Object.freeze({
    key: 'random', label: '随机', desc: '忽强忽弱，猜不到下一次',
    rhythm: '毫无规律的强弱跳变：她没法预判下一次，只能被动地一次次被吓到，句子越来越碎',
    lowFactor: 0.3, periodSec: 0, stepSec: 5,
  }),
});

export const VIBRATION_MODE_KEYS = Object.freeze(Object.keys(VIBRATION_MODES));

/** 默认模式：`steady`（旧数据没有模式列 ⇒ 行为与加功能前逐字节一致） */
export const DEFAULT_VIBRATION_MODE = 'steady';

export function isVibrationMode(mode) {
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(VIBRATION_MODES, mode);
}

/** 未知/空 → steady（兼容旧调用；要"不认识就拒绝"请先问 isVibrationMode） */
export function normalizeMode(mode) {
  return isVibrationMode(mode) ? mode : DEFAULT_VIBRATION_MODE;
}

export function modeLabel(mode) {
  return (VIBRATION_MODES[normalizeMode(mode)] || VIBRATION_MODES.steady).label;
}

export function modeMeta(mode) {
  return VIBRATION_MODES[normalizeMode(mode)] || VIBRATION_MODES.steady;
}

/**
 * 确定性伪随机（0~1）：**同一件玩具、同一个时间片 ⇒ 同一个值**。
 * 这是"随机模式也能被单测钉住"的关键：随机是对她随机，不是对测试随机。
 */
export function hash01(seed, n) {
  let x = (Number(seed) || 0) * 2654435761 + (Number(n) || 0) * 40503 + 2166136261;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 2246822507) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x / 4294967296;
}

/** 每件（角色, 玩具）一个稳定种子：随机模式与随机挑选都靠它复算 */
export function seedOf(characterId, toyKey) {
  let h = 2166136261;
  const s = String(characterId || 0) + '|' + String(toyKey || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 模式包络：把「曲线/基准给出的目标档」乘上当前节奏系数。
 * @returns {{factor:number, phase:string, phaseText:string}}
 */
export function modePhase(mode, { elapsedSec = 0, seed = 0 } = {}) {
  const meta = modeMeta(mode);
  const t = Math.max(0, Number(elapsedSec) || 0);
  if (meta.key === 'steady') {
    return { factor: 1, phase: 'steady', phaseText: '持续不断' };
  }
  if (meta.key === 'pulse') {
    const period = meta.periodSec || 6;
    const inPeriod = t % period;
    const on = inPeriod < (meta.onSec || 2.4);
    return on
      ? { factor: 1, phase: 'peak', phaseText: '正被这一波顶着' }
      : { factor: meta.lowFactor, phase: 'trough', phaseText: '刚退下去、只剩余震' };
  }
  if (meta.key === 'wave') {
    const period = meta.periodSec || 24;
    const x = (t % period) / period;
    const s = 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
    const rising = x < 0.5;
    return {
      factor: meta.lowFactor + (1 - meta.lowFactor) * s,
      phase: rising ? 'rise' : 'fall',
      phaseText: rising ? '正在慢慢涨上来' : '正在退潮',
    };
  }
  // random：每 stepSec 换一次值，值由 (seed, 时间片) 决定 ⇒ 测试可复算
  const step = meta.stepSec || 5;
  const slot = Math.floor(t / step);
  const r = hash01(seed, slot + 1);
  return {
    factor: meta.lowFactor + (1 - meta.lowFactor) * r,
    phase: r >= 0.5 ? 'peak' : 'trough',
    phaseText: r >= 0.5 ? '突然一下被顶到最高' : '忽然弱下去、几乎停住',
  };
}

// ── ③ 强度曲线（随时间自动升降）────────────────────────────────────────────────

export const CURVE_MIN_SECONDS = 10;
export const CURVE_MAX_SECONDS = 3600;

/**
 * 四种曲线。`from` / `to` 是**档位**（不是百分比）—— 让模型与 UI 都能直接读。
 * 走完（非 loop）后的行为：ramp_up 停在 `to`，其余停在 `from`（wave 是"回到中间"，surge 是"退回来"）。
 */
export const INTENSITY_CURVES = Object.freeze({
  ramp_up: Object.freeze({ key: 'ramp_up', label: '渐强', desc: '从起始档一路升到目标档', hold: 'to' }),
  ramp_down: Object.freeze({ key: 'ramp_down', label: '渐弱', desc: '从起始档缓缓降下来', hold: 'to' }),
  wave: Object.freeze({ key: 'wave', label: '起伏', desc: '在两个档位之间来回起伏', hold: 'from' }),
  surge: Object.freeze({ key: 'surge', label: '冲刺', desc: '先快速冲到最高档，再慢慢回落', hold: 'from' }),
});

export const INTENSITY_CURVE_KEYS = Object.freeze(Object.keys(INTENSITY_CURVES));

export function isIntensityCurveType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(INTENSITY_CURVES, type);
}

const clampInt = (value, max) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, max), Math.max(0, n));
};

/**
 * 归一化曲线输入（路由/服务共用一道闸门）。
 * `null` / `''` / `{type:'off'}` / 缺字段 ⇒ **null（表示"关掉曲线"）**；
 * 类型不认识 ⇒ `{ invalid: true }`（由调用方决定 400 还是忽略）。
 */
export function normalizeCurve(input, { maxIntensity = 5 } = {}) {
  if (input === null || input === undefined || input === '' || input === false) return null;
  if (typeof input === 'string') {
    if (input === 'off' || input === 'none') return null;
    return isIntensityCurveType(input) ? normalizeCurve({ type: input }, { maxIntensity }) : { invalid: true };
  }
  if (typeof input !== 'object') return { invalid: true };
  if (input.type === 'off' || input.type === 'none') return null;
  if (!isIntensityCurveType(input.type)) return { invalid: true };
  const max = Math.max(0, Number(maxIntensity) || 0);
  const rawFrom = input.from === undefined || input.from === null ? 0 : Number(input.from);
  const rawTo = input.to === undefined || input.to === null ? max : Number(input.to);
  const durationSec = clampInt(input.durationSec === undefined ? 300 : input.durationSec, CURVE_MAX_SECONDS);
  return {
    type: input.type,
    from: clampInt(Number.isFinite(rawFrom) ? rawFrom : 0, max),
    to: clampInt(Number.isFinite(rawTo) ? rawTo : max, max),
    durationSec: Math.max(CURVE_MIN_SECONDS, durationSec),
    loop: input.loop === true,
  };
}

export function curveLabel(curve) {
  if (!curve || !isIntensityCurveType(curve.type)) return '';
  const meta = INTENSITY_CURVES[curve.type];
  return meta.label + ' ' + curve.from + '→' + curve.to + '档/' + curve.durationSec + '秒' + (curve.loop ? '（循环）' : '');
}

/** 曲线走了多久（毫秒）；startedAtMs 缺失按 0 走 */
export function curveElapsedMs(curve, { startedAtMs = 0, now = 0 } = {}) {
  if (!curve) return 0;
  const start = Number(startedAtMs) || 0;
  return Math.max(0, (Number(now) || 0) - start);
}

/** 曲线进度 0~1（loop 时在单个周期内取模）；无曲线 → null */
export function curveProgress(curve, { startedAtMs = 0, now = 0 } = {}) {
  if (!curve || !isIntensityCurveType(curve.type)) return null;
  const total = Math.max(1, Number(curve.durationSec) || 1) * 1000;
  const elapsed = curveElapsedMs(curve, { startedAtMs, now });
  const inCycle = curve.loop ? elapsed % total : elapsed;
  return Math.min(1, inCycle / total);
}

/** 曲线还剩多少秒；无曲线 → null；非 loop 且已走完 → 0 */
export function curveRemainingSec(curve, { startedAtMs = 0, now = 0 } = {}) {
  if (!curve || !isIntensityCurveType(curve.type)) return null;
  const total = Math.max(1, Number(curve.durationSec) || 1);
  const elapsed = curveElapsedMs(curve, { startedAtMs, now }) / 1000;
  if (curve.loop) return Math.ceil(total - (elapsed % total));
  return Math.max(0, Math.ceil(total - elapsed));
}

/** 曲线**已走完**（非 loop 且进度到 1） */
export function curveFinished(curve, { startedAtMs = 0, now = 0 } = {}) {
  if (!curve || !isIntensityCurveType(curve.type)) return false;
  if (curve.loop) return false;
  return curveRemainingSec(curve, { startedAtMs, now }) === 0;
}

/** 曲线在某一刻给出的**目标档**（0~max 整数） */
export function curveTargetAt(curve, { startedAtMs = 0, now = 0, maxIntensity = 5 } = {}) {
  const max = Math.max(0, Number(maxIntensity) || 0);
  if (!curve || !isIntensityCurveType(curve.type)) return null;
  const from = clampInt(curve.from, max);
  const to = clampInt(curve.to, max);
  const p = curveProgress(curve, { startedAtMs, now });
  const q = p === null ? 0 : p;
  let raw;
  switch (curve.type) {
    case 'ramp_up':
      raw = from + (to - from) * q;
      break;
    case 'ramp_down':
      raw = from - (from - to) * q;
      break;
    case 'wave': {
      const s = 0.5 - 0.5 * Math.cos(2 * Math.PI * q);
      raw = from + (to - from) * s;
      break;
    }
    case 'surge':
      raw = q <= 0.15 ? (from + (to - from) * (q / 0.15)) : (to - (to - from) * ((q - 0.15) / 0.85));
      break;
    default:
      raw = from;
  }
  return clampInt(Math.round(raw), max);
}

// ── ① 组合佩戴（多件同时戴：叠加 / 互相影响）────────────────────────────────────

/**
 * 组合规则，两种形状：
 *   · `groups`：每组至少命中一件（组内是"任一"）—— 用于"双穴/上下两点"这类成对语义；
 *   · `any` + `minKeys`：命中清单里至少 N 件 —— 用于"多点齐震"这种同类叠加。
 * `needExtra` = 除了命中的之外还得有别的玩具（项圈这种象征物不能自己成立）。
 * `note` 是要进正文的语义（模型照着演），不是给自己看的注释。
 */
export const COMBO_RULES = Object.freeze([
  Object.freeze({
    key: 'dual_hole', label: '双穴同时', groups: [['vibe_stick', 'g_spot_vibe'], ['anal_plug', 'anal_beads']],
    note: '前面和后面同时被填满：她任何一种姿势都会牵动另一处，身体没有一处能放松',
  }),
  Object.freeze({
    key: 'front_back', label: '前后夹击', groups: [['vibe_egg', 'clit_sucker'], ['anal_plug', 'anal_beads']],
    note: '阴蒂与后庭同时被刺激：一波还没退，另一波又叠上来，她分不清是哪一处让她发抖',
  }),
  Object.freeze({
    key: 'up_down', label: '上下两点', groups: [['vibe_egg', 'clit_sucker'], ['nipple_clamp', 'nipple_sucker', 'chain_clamp']],
    note: '乳尖与下面同时被占住：上半身的胀和下半身的酸互相拉高，她的呼吸先乱',
  }),
  Object.freeze({
    key: 'suction_pair', label: '两口同时吸', groups: [['clit_sucker'], ['nipple_sucker']],
    note: '两处同时被吸住嘬：像被两只嘴咬着不放，她只剩下"被含住"这一种感觉',
  }),
  Object.freeze({
    key: 'multi_vibe', label: '多点齐震', any: ['vibe_egg', 'vibe_stick', 'g_spot_vibe', 'thigh_vibe'],
    minKeys: 2,
    note: '不止一处同时在震：震动从不同地方同时上来，她的注意力被撕成几块，句子越来越短',
  }),
  Object.freeze({
    key: 'collared', label: '项圈在场', groups: [['collar']], needExtra: true,
    note: '脖子上还扣着项圈：她潜意识里更不敢拒绝、更愿意顺从，被玩的时候会主动迎合',
  }),
]);

/** 会震/会吸的玩具才算"负载"；项圈这类象征物不计 */
const LOAD_STIMULUS = new Set(['vibration', 'suction', 'beads', 'clamp']);

/** 规则是否成立（纯函数，方便单测单独钉） */
export function comboRuleMatches(rule, keySet, count) {
  if (!rule) return false;
  if (Array.isArray(rule.any)) {
    const hits = rule.any.filter(k => keySet.has(k)).length;
    if (hits < (Number(rule.minKeys) || 1)) return false;
  }
  if (Array.isArray(rule.groups)) {
    const hitGroups = rule.groups.filter(group => group.some(k => keySet.has(k))).length;
    if (hitGroups < rule.groups.length) return false;
  }
  if (rule.needExtra && count < 2) return false;
  return true;
}

/**
 * 当前佩戴组合的叠加/影响。
 * @param {Array<{toyKey:string, liveIntensity?:number, intensity?:number, stimulus?:string, maxIntensity?:number}>} wornList
 * @param {{maxLoad?:number, overloadCount?:number, heavyLoad?:number, heavyCount?:number}} [options]
 * @returns {{keys:string[], labels:string[], notes:string[], load:number, count:number, overload:boolean, heavy:boolean, summary:string}}
 */
export function comboEffects(wornList = [], { maxLoad = 10, overloadCount = 4, heavyLoad = 6, heavyCount = 3 } = {}) {
  const list = Array.isArray(wornList) ? wornList.filter(Boolean) : [];
  const keys = list.map(t => String(t.toyKey || t.key || '')).filter(Boolean);
  const keySet = new Set(keys);
  const labels = [];
  const notes = [];
  for (const rule of COMBO_RULES) {
    if (!comboRuleMatches(rule, keySet, keys.length)) continue;
    labels.push(rule.label);
    notes.push(rule.note);
  }
  let load = 0;
  for (const t of list) {
    const stimulus = t.stimulus || t.intensityKind || 'vibration';
    if (!LOAD_STIMULUS.has(stimulus)) continue;
    const value = Number(t.liveIntensity !== undefined ? t.liveIntensity : t.intensity) || 0;
    load += Math.max(0, value);
  }
  const count = keys.length;
  const overload = load >= maxLoad || count >= overloadCount;
  const heavy = overload || load >= heavyLoad || count >= heavyCount;
  const summary = overload
    ? ('已经戴了 ' + count + ' 件、总刺激 ' + load + ' 档，明显过载：她接近失神，几乎跟不上对话')
    : (heavy
      ? ('戴了 ' + count + ' 件、总刺激 ' + load + ' 档：叠加已经很明显，她的反应比单件时更碎')
      : '');
  return { keys, labels, notes, load, count, overload, heavy, summary };
}

// ── 统一求值：曲线（慢变量）× 模式（快变量）────────────────────────────────────

/**
 * 某一刻的**有效强度**：曲线给目标档，模式给节奏包络。
 * 无曲线且模式为 steady ⇒ 就等于基准档（旧行为逐字节一致）。
 *
 * @returns {{intensity:number, curveIntensity:number, modeFactor:number, phase:string, phaseText:string,
 *            curveProgress:number|null, remainingSec:number|null, finished:boolean}}
 */
export function evaluateToyPlay({
  baseIntensity = 0, maxIntensity = 0, mode = DEFAULT_VIBRATION_MODE,
  curve = null, curveStartedAtMs = 0, equippedAtMs = 0, now = 0, seed = 0,
} = {}) {
  const max = Math.max(0, Number(maxIntensity) || 0);
  const base = clampInt(baseIntensity, max);
  const startedAt = Number(curveStartedAtMs) || Number(equippedAtMs) || 0;
  const curveTarget = curve ? curveTargetAt(curve, { startedAtMs: startedAt, now, maxIntensity: max }) : null;
  const target = curveTarget === null ? base : curveTarget;
  // 注意 `equippedAtMs === 0` 是**合法输入**（测试里的假时钟就从这个值开始），不能用 `||` 兜底成 now
  const nowMs = Number(now) || 0;
  const eqMs = Number.isFinite(Number(equippedAtMs)) ? Number(equippedAtMs) : nowMs;
  const elapsedSec = Math.max(0, (nowMs - eqMs) / 1000);
  const { factor, phase, phaseText } = modePhase(mode, { elapsedSec, seed });
  const intensity = clampInt(Math.round(target * factor), max);
  return {
    intensity,
    curveIntensity: target,
    modeFactor: factor,
    phase,
    phaseText,
    curveProgress: curveProgress(curve, { startedAtMs: startedAt, now }),
    remainingSec: curveRemainingSec(curve, { startedAtMs: startedAt, now }),
    finished: curveFinished(curve, { startedAtMs: startedAt, now }),
  };
}
