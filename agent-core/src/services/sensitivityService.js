/**
 * 敏感度（2026-10-02 用户提的新数值系统）
 *
 * 用户原话：
 *   「新增一个数值 叫敏感度 所有和性爱相关的内容 都会和这个挂钩 数值高了低了会有不一样的表现」
 *   「然后再在催眠手机里加一个选项 叫发情模式 角色的敏感度就会直接拉满」
 *   「正常情况的敏感度 会和角色发生性爱相关内容的时候 缓慢累加 玩具也算性爱相关
 *     触摸里的敏感哪一款私处那一块也算」
 *   「敏感度越高角色高潮的强度越高 也越频繁 性爱的频率也会越频繁」
 *   「再增加一个事件 叫自慰 和角色敏感度也相关 越高发生概率也就越高 这个可以算到日程里」
 *
 * 设计（v1）：
 *   · **一个数值 0~100，存在 characters 上**（`sensitivity`），所有性爱相关链都读它：
 *     推进面板的增益 / 高潮阈值 / 玩具与触摸的刺激下游 / 自慰概率 / 提示词里的表现指导。
 *   · **缓慢累加**：每次性爱相关事件加一点点（点数按来源分级，见 GROWTH），并随时间**缓慢回落** ——
 *     所以"这段时间常做"与"很久没碰"是两种状态。
 *   · **发情模式**：催眠手机里的开关 ⇒ 直接拉满（100）并在一段时间内不回落到阈值以下。
 *   · **分档（tier）**：冷淡 / 普通 / 敏感 / 很敏感 / 极度敏感，每档有自己的行为指导与倍率，
 *     写进 prompt（她"表现不一样"）+ 参与数值计算（她"更容易到"）。
 *
 * 与 intimateActionService 的关系：那边管"这一场怎么走"，这里管"她这个人现在有多敏感"。
 * `planIntimateAction` 收一个 `sensitivity` 倍率（本模块的 `sensitivityMultiplier`）来放大增益。
 */

import { getDb } from '../db/index.js';

export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 100;
/** 发情模式：直接拉满 */
export const HEAT_SENSITIVITY = SENSITIVITY_MAX;
/** 发情模式默认持续（分钟）—— 到点自然回落，除非再点一次关掉 */
export const HEAT_DEFAULT_MINUTES = 120;
/** 每周期的自然回落（点数 / 小时）：约 8 小时掉 1 点 ⇒ "一段时间不做会慢慢降下来" */
export const DECAY_PER_HOUR = 0.125;

/**
 * 「缓慢累加」的闸门（2026-10-03 复查补上，当天又修正过一次口径）。
 *
 * 要同时满足两条**用户原话**，所以闸门只拦"定时器自己推的那一跳"，不拦玩家真的点：
 *   · 「性爱并没有增加敏感度」是 bug ⇒ 玩家手点/玩具/高潮**每一下都必须算数**；
 *   · 「缓慢累加」 ⇒ 但不能让"自动插入开着不管"或连点脚本把数值刷满。
 *
 * ⚠️ 第一版把 15 秒闸门套在**所有**性相关来源上 ⇒ 手点 12 下只 +0.5，用户那条回归用例
 *   （`intimateSensitivityGrowth.test.js`：一场 ≥5 点）当场变红 —— 等于把老 bug 换了个形式。
 *   现在拆成两类：
 *   · **玩家动作**（intimate_action / climax / toy / touch_* / self_play / hypnosis）
 *     —— 照给，只受每日上限约束；
 *   · **自动插入的每一跳**（auto_tick，服务端 ticker 与面板节拍发的）
 *     —— 15 秒内只记一次，而且单跳份量很小（`GROWTH.auto_tick`），
 *     否则冲刺档 1.5 秒一跳 = 每分钟 +20、五分钟顶满。
 */
/** 只有"定时器自己推的那一跳"受限：同一角色 15 秒内只记一次 */
export const AUTO_TICK_MIN_INTERVAL_MS = 15000;
/** 性相关来源：每天（真实 UTC 日）最多涨这么多点，跨日自动归零（发情模式与手动设置不受限） */
export const SEX_DAILY_CAP = 20;
/** 受**每日上限**约束的来源（`manual` / `heat_mode` 不受限） */
export const SEX_SOURCES = Object.freeze(new Set([
  'intimate_action', 'climax', 'toy', 'touch_sensitive', 'touch_normal', 'self_play', 'hypnosis', 'auto_tick',
]));
/** 受**15 秒节流**约束的来源：只有自动插入的每一跳 */
export const TICK_SOURCES = Object.freeze(new Set(['auto_tick']));
/** UTC 日期串（与发情/每日额度的跨日口径一致；数值系统吃**真实时间**，不吃程序钟 —— 见文件头注释） */
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * 各类性爱相关事件"加多少点"。**实际节奏受下面两道闸门约束**（2026-10-03 复查补上后，
 * 这里写的"一场涨多少"只是上限，不再等于一场的真实收益）：
 *   · 性相关来源 15 秒内只记一次 ⇒ 一场十几下的连续推进大约只记 **4 笔**（≈ +2~3 点）；
 *   · 每天最多 +20 点 ⇒ 0 → "很敏感"（60）大约是**几天**的频率积累，不是几场。
 * 想立刻看高敏感度的表现，用催眠手机的**发情模式**（直接拉满，不受闸门限制）。
 */
export const GROWTH = Object.freeze({
  // ⚠️ 2026-10-03 真机反馈「性爱并没有增加敏感度」后重定：原来是 0.2 且推进面板只给半权重
  // ⇒ 一下只涨 **0.1**、一场十几下也就 +2，而面板显示的是取整后的数 ⇒ 玩家看到的永远是 0。
  // 现在：推进一下 0.5（面板两下就能看见 +1），高潮走 GROWTH.climax × 强度（1.2~6）。
  // ⚠️⚠️ 再往下读之前先看文件头 `SEX_GROWTH_MIN_INTERVAL_MS` / `SEX_DAILY_CAP` 的说明：
  //    有了那两道闸门之后，"一场 +10~14"只是**理论上限**，真实收益约 +5/场、+20/天。
  intimate_action: 0.5,   // 推进面板的一下（**玩家点的**每一下都算）
  auto_tick: 0.1,         // 自动插入的**每一跳**（服务端 ticker / 面板节拍）—— 小份量 + 15 秒节流
  climax: 1.2,            // 她到一次（按强度 1~5 加权 ⇒ 1.2~6.0）
  toy: 0.15,              // 玩具 tick（戴着就有）
  touch_sensitive: 0.3,   // 触摸到私处/敏感部位那几款
  touch_normal: 0.08,     // 普通触摸
  self_play: 0.6,         // 她自己玩一轮
  hypnosis: 0.8,          // 催眠指令（强制高潮一类）
  heat_mode: 0,           // 发情模式本身不加（它直接拉满）
  manual: 1,              // 手动/测试
});

/** 分档：阈值从低到高；`multiplier` 同时用于增益与"多容易到"。 */
export const SENSITIVITY_TIERS = Object.freeze([
  { key: 'cold', min: 0, max: 19, label: '冷淡', multiplier: 0.75 },
  { key: 'normal', min: 20, max: 39, label: '普通', multiplier: 0.9 },
  { key: 'warm', min: 40, max: 59, label: '敏感', multiplier: 1.0 },
  { key: 'high', min: 60, max: 79, label: '很敏感', multiplier: 1.15 },
  { key: 'extreme', min: 80, max: 100, label: '极度敏感', multiplier: 1.35 },
]);

export function clampSensitivity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, Math.round(n * 100) / 100));
}

export function sensitivityTier(value) {
  const v = clampSensitivity(value);
  return SENSITIVITY_TIERS.find(t => v >= t.min && v <= t.max) || SENSITIVITY_TIERS[0];
}

/** 增益倍率（喂给 planIntimateAction 的 `sensitivity`，也用于刺激下游） */
export function sensitivityMultiplier(value) {
  return sensitivityTier(value).multiplier;
}

/** 时间衰减后的当前值（`sensitivity_updated_at` 起算，只减不增） */
export function decayedSensitivity(raw, updatedAt, { now = Date.now() } = {}) {
  const base = clampSensitivity(raw);
  if (!updatedAt) return base;
  const at = Date.parse(String(updatedAt).replace(' ', 'T') + (String(updatedAt).includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(at)) return base;
  const hours = Math.max(0, (now - at) / 3600000);
  return clampSensitivity(base - hours * DECAY_PER_HOUR);
}

/**
 * ISO / SQL 时间戳 → 毫秒。
 * ⚠️ 我第一版在这里踩了坑：`Date.parse(str + 'Z')` 对**已经带 Z** 的 ISO 串会拼成 `...ZZ`
 * ⇒ 解析失败 ⇒ 发情模式的 `heat_until` 永远算"还没到点"⇒ **发情模式关不掉也过期不了**（守卫抓到了）。
 * 现在只在缺时区时才补 Z。
 */
function parseTime(value) {
  if (!value) return NaN;
  const s = String(value).trim().replace(' ', 'T');
  return Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

/** 发情模式是否仍然生效（heat_mode=1 且未到 heat_until） */
function heatActive(row, now) {
  if (!row || Number(row.heat_mode) !== 1) return false;
  const until = parseTime(row.heat_until);
  return !Number.isFinite(until) || until > now;
}

/**
 * 读这一行时要带上的列。
 * ⚠️ 2026-10-03：一开始漏了三个 sex 列 ⇒ 闸门拿不到"今天已经涨了多少 / 上次是哪一秒"
 *   （`row.sensitivity_sex_day` 是 undefined）⇒ **限流与每日上限静默失效**，测试当场抓到。
 *   加列时记得**同时**改这里（读路径与闸门共用一行）。
 */
const SENS_COLUMNS = 'sensitivity, sensitivity_updated_at, heat_mode, heat_until, sensitivity_before_heat, '
  + 'sensitivity_sex_day, sensitivity_sex_day_gain, sensitivity_sex_last_at';
/** 老库兜底：只有最初四列时的读法 */
const SENS_COLUMNS_LEGACY = 'sensitivity, sensitivity_updated_at, heat_mode, heat_until';

/** 读一行（含发情前值 + 闸门记账）。列缺失时退回旧列，**绝不让整条数值链失效**。 */
function readSensRow(db, id) {
  try {
    return db.prepare(`SELECT ${SENS_COLUMNS} FROM characters WHERE id = ?`).get(id);
  } catch (err) {
    if (/no such column/i.test(String(err?.message || ''))) {
      console.warn('[sensitivity] 复查新增列缺失（迁移没跑）——本次按旧口径处理:', err?.message || err);
      return db.prepare(`SELECT ${SENS_COLUMNS_LEGACY} FROM characters WHERE id = ?`).get(id);
    }
    throw err;
  }
}

/** 保留两位小数落库（0.1+0.2 这类浮点尾巴不该进库、也不该出现在面板上） */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/** 空值→NaN（**不能**用 `Number(null)`：那是 0，会被当成"发情前的值是 0"） */
const numOrNaN = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * 发情模式到点 / 关掉之后，把她带回**发情前的那个值**。
 *
 * ⚠️ 2026-10-03 复查发现两个洞（都在"结束发情"这一步）：
 *   ① **到点没人写回**：`heatActive` 过了 `heat_until` 就返回 false，可读路径只"读"不"写" ——
 *      存库里的 100 一直躺着，而衰减是 0.125/小时 ⇒ 100 掉回 55 要 **360 小时（15 天）**。
 *      发情模式只开 2 小时，她却会"极度敏感"半个月（倍率 1.35、门槛 45 全都跟着错）。
 *   ② **关掉会把真实值砍掉**：原来一律 `min(当前, 55)`；她本来就因为玩得多而到 80 的话，
 *      开关一次发情模式就把 80 变成 55 —— 数值被"开关"吃掉了。
 * 所以开的时候先把当前值存进 `sensitivity_before_heat`，结束（手动关或自然到点）时恢复它；
 * 老数据没有这一列时退回旧口径 `min(当前, 55)`。
 */
function restoreFromHeat(db, id, row, now) {
  // ⚠️ `Number(null)` 是 **0**（会通过 isFinite）—— 早期版本就栽在这里：老数据本来该退回
  //   `min(当前,55)`，却因为"发情前值 = 0"直接把她清零。所以空值必须先变成 NaN。
  const stored = numOrNaN(row?.sensitivity_before_heat);
  const back = decayedSensitivity(row?.sensitivity, row?.sensitivity_updated_at, { now });
  const restored = round2(clampSensitivity(Number.isFinite(stored) && stored >= 0 ? stored : Math.min(back, 55)));
  db.prepare('UPDATE characters SET heat_mode = 0, heat_until = NULL, sensitivity = ?, sensitivity_updated_at = ?, '
    + 'sensitivity_before_heat = NULL WHERE id = ?')
    .run(restored, new Date(now).toISOString(), id);
  return restored;
}

/** 读一次（带衰减 + 发情模式覆盖 + 到点自动回落）。任何异常都返回 0，绝不让性爱链因为数值系统崩掉。 */
export function getSensitivity(characterId, { now = Date.now() } = {}) {
  try {
    const id = Number(characterId);
    const db = getDb();
    const row = readSensRow(db, id);
    if (!row) return { value: 0, tier: sensitivityTier(0), multiplier: sensitivityMultiplier(0), heat: false };
    const heat = heatActive(row, now);
    // 发情模式**已经到点**：这里顺手把她带回发情前的值（惰性写回，只发生一次）
    if (!heat && Number(row.heat_mode) === 1) {
      const restored = restoreFromHeat(db, id, row, now);
      return { value: restored, tier: sensitivityTier(restored), multiplier: sensitivityMultiplier(restored), heat: false, heatExpired: true };
    }
    const value = heat ? HEAT_SENSITIVITY : decayedSensitivity(row.sensitivity, row.sensitivity_updated_at, { now });
    return { value, tier: sensitivityTier(value), multiplier: sensitivityMultiplier(value), heat };
  } catch (err) {
    // ⚠️ 这个 warn 是**唯一**能暴露"列不存在"的地方：真机上曾经整条数值链静默失效
    //（迁移没跑 ⇒ 四列没有 ⇒ 这里按 0 兜住 ⇒ 单测全绿、只有 POST /heat 500）。看见它就查迁移。
    console.warn('[sensitivity] 读取失败（按 0 处理）——若提示 no such column: characters 缺 sensitivity 四列（迁移没跑）:', err?.message || err);
    return { value: 0, tier: sensitivityTier(0), multiplier: sensitivityMultiplier(0), heat: false };
  }
}

/**
 * 缓慢累加一次（发情模式下不再累加 —— 已经满了）。
 * @param {number|string} characterId
 * @param {string} source GROWTH 的键
 * @param {{weight?:number, now?:number}} [opts] weight：强度系数（例如高潮强度）
 */
export function addSensitivity(characterId, source, { weight = 1, now = Date.now() } = {}) {
  try {
    const id = Number(characterId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const db = getDb();
    let row = readSensRow(db, id);
    if (!row) return null;
    // 发情模式已到点 ⇒ 先回落（否则下面会从 100 起算，等于没到期）
    if (Number(row.heat_mode) === 1 && !heatActive(row, now)) {
      restoreFromHeat(db, id, row, now);
      row = readSensRow(db, id);
    } else if (heatActive(row, now)) {
      return { value: HEAT_SENSITIVITY, gain: 0, heat: true };   // 发情模式：已满，不再累加
    }
    let gain = (GROWTH[source] ?? 0) * Math.max(0, Number(weight) || 0);
    // 未知来源 / 权重为 0 ⇒ 老契约：返回 null（"这件事跟敏感度无关"，调用方据此跳过）
    if (!(source in GROWTH) || gain <= 0) return null;

    // ── 闸门（2026-10-03 复查补）──────────────────────────────────────────────
    // 没有闸门时，"自动插入"开着（冲刺档 1.5 秒一下）等于 **+0.5/1.5 秒 = 每分钟 +20**，
    // 五分钟就把她顶到 100；手点连点同理。于是"缓慢累加"这条口径等于没写，
    // 发情模式（直接拉满）也失去了意义。两道闸门：
    //   ① 性相关来源 15 秒内只记一次（**高潮不受限**：那是决定性的那一下，不能被吞）；
    //   ② 性相关来源每天最多 +SEX_DAILY_CAP（跨日自动归零），发情模式与手动设置不受限。
    let rateLimited = false;
    let capped = false;
    if (SEX_SOURCES.has(source)) {
      const day = utcDay(now);
      const used = String(row.sensitivity_sex_day || '') === day ? (Number(row.sensitivity_sex_day_gain) || 0) : 0;
      const left = Math.max(0, SEX_DAILY_CAP - used);
      if (left <= 0) {
        capped = true;
        gain = 0;
      } else {
        // 只有**自动插入的每一跳**受 15 秒节流（玩家真点的每一下都必须算数，见上面常量注释）
        if (TICK_SOURCES.has(source)) {
          const last = parseTime(row.sensitivity_sex_last_at);
          if (Number.isFinite(last) && now - last < AUTO_TICK_MIN_INTERVAL_MS) rateLimited = true;
        }
        if (rateLimited) {
          gain = 0;
        } else if (gain > left) {
          gain = left;      // 部分记账：当天额度只剩多少就涨多少，不用整笔记不上
          capped = true;
        }
      }
      if (gain <= 0) {
        return { value: decayedSensitivity(row.sensitivity, row.sensitivity_updated_at, { now }), gain: 0, heat: false, rateLimited, capped };
      }
      const before0 = decayedSensitivity(row.sensitivity, row.sensitivity_updated_at, { now });
      const after0 = round2(clampSensitivity(before0 + gain));
      const granted = round2(clampSensitivity(after0 - before0));
      db.prepare('UPDATE characters SET sensitivity = ?, sensitivity_updated_at = ?, sensitivity_sex_day = ?, '
        + 'sensitivity_sex_day_gain = ?, sensitivity_sex_last_at = ? WHERE id = ?')
        .run(after0, new Date(now).toISOString(), day, round2(used + granted), new Date(now).toISOString(), id);
      return { value: after0, gain: granted, heat: false, rateLimited, capped, dayUsed: round2(used + granted) };
    }

    const before = decayedSensitivity(row.sensitivity, row.sensitivity_updated_at, { now });
    const after = round2(clampSensitivity(before + gain));
    db.prepare('UPDATE characters SET sensitivity = ?, sensitivity_updated_at = ? WHERE id = ?')
      .run(after, new Date(now).toISOString(), id);
    return { value: after, gain: round2(clampSensitivity(after - before)), heat: false };
  } catch (err) {
    console.warn('[sensitivity] 累加失败（不影响玩法）:', err?.message || err);
    return null;
  }
}

/** 发情模式开关（催眠手机用）。开 ⇒ 拉满并设一个到点时间；关 ⇒ 立刻回到**发情前的值**。 */
export function setHeatMode(characterId, on, { minutes = HEAT_DEFAULT_MINUTES, now = Date.now() } = {}) {
  const id = Number(characterId);
  const db = getDb();
  const row = readSensRow(db, id);
  if (!row) return null;
  if (on) {
    const until = new Date(now + Math.max(1, Number(minutes) || HEAT_DEFAULT_MINUTES) * 60000).toISOString();
    // 拉满 100，并把**发情前的真实值**存起来（结束时要还给她，见 restoreFromHeat）
    const keepRaw = numOrNaN(row.sensitivity_before_heat);
    const keep = Number.isFinite(keepRaw) && keepRaw >= 0 && Number(row.heat_mode) === 1
      ? keepRaw                                                        // 已经在发情中又点开：保留最早那个值
      : decayedSensitivity(row.sensitivity, row.sensitivity_updated_at, { now });
    const keepValue = round2(clampSensitivity(keep));
    db.prepare('UPDATE characters SET heat_mode = 1, heat_until = ?, sensitivity = ?, sensitivity_updated_at = ?, '
      + 'sensitivity_before_heat = ? WHERE id = ?')
      .run(until, HEAT_SENSITIVITY, new Date(now).toISOString(), keepValue, id);
    return { heat: true, value: HEAT_SENSITIVITY, until, before: keepValue };
  }
  const restored = restoreFromHeat(db, id, row, now);
  return { heat: false, value: restored };
}

/**
 * 发情模式的到点时间（ISO 串；没开或已过期返回 null）。
 * 面板要显示「还有多久自然回落」，但**别让它自己算** —— 时间口径只住在本模块（parseTime 的坑见过一次了）。
 */
export function getHeatUntil(characterId, { now = Date.now() } = {}) {
  try {
    const row = getDb().prepare('SELECT heat_mode, heat_until FROM characters WHERE id = ?').get(Number(characterId));
    if (!heatActive(row, now)) return null;
    return row.heat_until || null;
  } catch {
    return null;
  }
}

/**
 * 写进 prompt 的一行（她"表现得不一样"）。空串 = 冷淡/普通档不注入（零 token）。
 */
export function buildSensitivityPromptLine(characterId, { now = Date.now() } = {}) {
  const st = getSensitivity(characterId, { now });
  if (st.value < 40 && !st.heat) return '';
  const head = st.heat
    ? '【发情模式（最高优先级）】她现在处于发情状态：身体被调到最敏感，几乎没有前戏就能被推上去，'
      + '会主动索要、会自己靠过来、会明确说想要 —— 不要写成她能忍。'
    : `【她的敏感度：${st.tier.label}（${Math.round(st.value)}/100）】`;
  const body = {
    warm: '这段时间她常被碰，身体已经习惯了这份感觉：同样的动作对她更容易起效，湿得更快、反应更直接。',
    high: '她很敏感：轻微的刺激就会有明显反应，会不自觉地夹紧、发抖、出声，忍不了多久。',
    extreme: '她极度敏感：一点点刺激就能把她推到边缘，高潮来得又急又密；她会主动求、会说不够、会一直要。',
  }[st.tier.key] || '';
  return head + (body ? ' ' + body : '');
}
