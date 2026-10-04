/**
 * services/privateMomentService.js —— 「私密时刻」：她一个人在做的私密事（自慰）
 * ============================================================================
 *
 * 用户原话：
 *   「再增加一个事件 叫自慰 和角色敏感度也相关 越高发生概率也就越高 这个可以算到日程里」
 *   「这个时候再去找角色私聊就会触发事件 玩家闯入角色正在自慰的情况」
 *
 * ## 它是什么
 * 从她**今天的日程**里挑一段"她一个人在屋里"的时间（非睡眠、独处/在家/睡前那类活动），
 * 按她的**敏感度**掷一次骰子（确定性：种子 + 槽位哈希 ⇒ 刷新/多条消息之间结论稳定）：
 *   · 掷中 ⇒ 在这段日程里挖一个 20~40 分钟的窗口，她在里面**自慰**；
 *   · 你在这个窗口里私聊她 ⇒ 触发「**你闯进来了**」事件（prompt 块 + 一次敏感度累加）。
 *
 * ## 为什么挂在日程上（而不是"每条消息随机"）
 * 用户要的是"可以算到日程里"。挂在日程槽上之后：
 *   ① 它是**她这一天安排里的一件事**，不是凭空冒出来的（作息、独处、时间长度都来自日程）；
 *   ② 判定按（角色, 日期, 槽位）落库一次 ⇒ 不会"刚判定没做、再看又做了"；
 *   ③ 日程 UI 能显示它（`GET /api/characters/:id/private-moment`），玩家能"看见她在屋里"。
 *
 * ## 与"她自己玩玩具"（`services/toy/selfPlay.js`）的分工
 * 那条链路是**用玩具**、门槛是好感/淫乱度；本模块是**自慰本身**（用手也算，不需要道具），
 * 驱动量是敏感度。两条互不冲突：玩具那条继续管"她会不会戴上玩具自己玩"。
 *
 * ## 纯函数 / DB 分离
 * 概率、选槽、挖窗口、prompt 文案全在纯函数里（可注入 now / random ⇒ 单测不需要 DB、不需要 sleep）；
 * `ensurePrivateMoment` / `catchPrivateMoment` 才碰库，且**任何失败都不抛**（旁路）。
 */

import { getDb } from '../db/index.js';
import { getTodaySchedule } from './scheduleManager.js';
import { getProgramNow, getProgramDateKey, parseHhmm, formatHhmm, toSqlUtc } from './programTime.js';
import { getSensitivity, addSensitivity } from './sensitivityService.js';
import { hash01 } from './toy/mechanics.js';

/** 事件种类：目前只有"自慰"（玩具那条走 selfPlay） */
export const PRIVATE_MOMENT_KINDS = Object.freeze({ SELF_PLAY: 'self_play' });
export const PRIVATE_MOMENT_LABEL = '自慰';

/**
 * 概率参数（写在这里就是收口点：改"她多久自己来一次"只改这里）。
 * 敏感度是主驱动（用户：「越高发生概率也就越高」）：0.10 ~ 0.42；
 * 发情模式直接顶到上限附近；好感再添一点点（关系越近越放得开）。
 */
export const PRIVATE_MOMENT_TUNING = Object.freeze({
  base: 0.10,             // 底概率（她本来就会，只是少）
  sensitivitySpan: 0.32,  // 敏感度 0~100 贡献 0~0.32
  heatBonus: 0.25,        // 发情模式额外加成
  affinitySpan: 0.10,     // 好感 0~100 贡献 0~0.10
  max: 0.72,              // 上限：再敏感也不是"每次找她都在自慰"
  durationMinMin: 20,     // 窗口最短（分钟）
  durationMaxMin: 40,     // 窗口最长
  edgeMarginMin: 8,       // 窗口距日程块两端至少留多少分钟（别卡在换场的点上）
  minSlotMin: 25,         // 日程块短于这个就不考虑（来不及）
});

/** 「独处 / 在家」的活动特征：她一个人在屋里才可能发生这件事 */
const ALONE_PATTERNS = [
  /一个人|独自|独处|自己(一个人)?待|没人|独居/,
  /在家|家里|屋内|屋里|房间|卧室|卧室里|公寓|宿舍|租房|家中/,
  /休息|放松|发呆|闲着|自由时间|睡前|洗漱|洗澡|泡澡|换衣服|躺|看书|追剧|听歌|写日记|玩手机|发呆/,
];
/** 睡眠类活动（明确排除；她睡着的时候不发生这件事） */
const SLEEP_PATTERNS = [/睡|午休|歇着|打盹|梦/];

function str(value, max = 60) {
  const s = String(value == null ? '' : value).trim();
  return s.length <= max ? s : s.slice(0, max);
}

/** 0~1 的确定性伪随机（与 routes/toys.js 同款：种子 + 窗口序号） */
function roll01(seed, window) {
  return hash01(Number(seed) || 0, Math.floor(Number(window) || 0) + 1);
}

/**
 * 这次"会不会发生"的概率（0~1，纯函数）。
 * @param {{sensitivity?:number, heat?:boolean, affinity?:number}} input sensitivity 是 0~100 的**值**（不是倍率）
 */
export function privateMomentProbability({ sensitivity = 0, heat = false, affinity = 0, tuning = PRIVATE_MOMENT_TUNING } = {}) {
  const t = { ...PRIVATE_MOMENT_TUNING, ...(tuning || {}) };
  const sens = Math.max(0, Math.min(100, Number(sensitivity) || 0));
  const aff = Math.max(0, Math.min(100, Number(affinity) || 0));
  let p = t.base + (sens / 100) * t.sensitivitySpan + (aff / 100) * t.affinitySpan;
  if (heat) p += t.heatBonus;
  return Math.max(0, Math.min(t.max, Math.round(p * 1000) / 1000));
}

/** 日程块 → { startMinute, endMinute, activity, location }；时间残缺的块返回 null */
export function slotOf(activity = {}) {
  const startMinute = parseHhmm(activity.startTime);
  let endMinute = parseHhmm(activity.endTime);
  if (startMinute === null || endMinute === null) return null;
  // 跨零点的块（23:00~06:00）按"到第二天"处理：内部一律用大于 1440 的分钟
  if (endMinute <= startMinute) endMinute += 24 * 60;
  return {
    startMinute,
    endMinute,
    activity: str(activity.activity, 40),
    location: str(activity.location, 40),
    tags: Array.isArray(activity.tags) ? activity.tags : [],
  };
}

/** 这个日程块是不是"她一个人在屋里"（睡眠块直接否） */
export function isPrivateSlot(activity = {}) {
  const text = `${activity.activity || ''} ${activity.location || ''} ${(activity.tags || []).join(' ')}`;
  if (SLEEP_PATTERNS.some(re => re.test(str(activity.activity, 40)))) return false;
  if (/睡/.test(str(activity.tags?.join(' ') || '', 40))) return false;
  return ALONE_PATTERNS.some(re => re.test(text));
}

/**
 * 从今天的日程里挑出候选槽位（按时间升序）。
 * @returns {Array<{startMinute:number,endMinute:number,activity:string,location:string,key:string}>}
 */
export function privateSlots(schedule, { tuning = PRIVATE_MOMENT_TUNING } = {}) {
  const t = { ...PRIVATE_MOMENT_TUNING, ...(tuning || {}) };
  const out = [];
  for (const act of Array.isArray(schedule) ? schedule : []) {
    if (!isPrivateSlot(act)) continue;
    const slot = slotOf(act);
    if (!slot) continue;
    if (slot.endMinute - slot.startMinute < t.minSlotMin) continue;
    out.push({ ...slot, key: `${formatHhmm(slot.startMinute % 1440)}-${formatHhmm(slot.endMinute % 1440)}-${slot.activity}` });
  }
  return out.sort((a, b) => a.startMinute - b.startMinute);
}

/**
 * 在槽位里"挖"出她真正在做那件事的那个窗口（纯函数，确定性）。
 * 窗口长度与位置都由 (角色, 日期, 槽位) 派生 ⇒ 同一天多次询问得到同一个窗口。
 */
export function privateWindow(slot, { seed = 0, dateKey = '', tuning = PRIVATE_MOMENT_TUNING } = {}) {
  const t = { ...PRIVATE_MOMENT_TUNING, ...(tuning || {}) };
  const windowSeed = Number(seed) || 0;
  const slotSpan = Math.max(0, slot.endMinute - slot.startMinute);
  const usable = Math.max(1, slotSpan - t.edgeMarginMin * 2);
  const length = Math.min(
    usable,
    Math.max(10, Math.round(t.durationMinMin + roll01(windowSeed + slot.startMinute, 3) * (t.durationMaxMin - t.durationMinMin))),
  );
  // ⚠️ 起点的上限必须**同时**扣掉"窗口长度"和"两端边距"，否则窗口会顶到日程块的尾巴上
  //（我第一版只扣了长度 ⇒ 边距被吃掉，自己的用例当场抓住：end=1375 vs 允许的 1372）。
  const latest = Math.max(0, slotSpan - t.edgeMarginMin * 2 - length);
  const offset = t.edgeMarginMin + Math.round(roll01(windowSeed + slot.startMinute, 5) * latest);
  const startMinute = slot.startMinute + Math.min(offset, t.edgeMarginMin + latest);
  return { startMinute, endMinute: startMinute + length, dateKey, slotKey: slot.key };
}

/**
 * 一天里"她到底做不做这件事"的判定（纯函数 ⇒ 可单测）。
 * 一天只掷**一次**（按日期 + 槽位），掷中之后取当天**第一个**掷中的槽位当窗口。
 *
 * @param {Array} slots `privateSlots` 的产物
 * @param {{sensitivity?:number, heat?:boolean, affinity?:number, seed?:number, dateKey?:string}} input
 * @returns {{fired:boolean, probability:number, slot:object|null, window:object|null, roll:number}}
 */
export function planPrivateMoment(slots, { sensitivity = 0, heat = false, affinity = 0, seed = 0, dateKey = '', tuning = PRIVATE_MOMENT_TUNING } = {}) {
  const probability = privateMomentProbability({ sensitivity, heat, affinity, tuning });
  const list = Array.isArray(slots) ? slots : [];
  if (list.length === 0) return { fired: false, probability, slot: null, window: null, roll: 1 };
  // 按"日期 + 槽位"逐个掷，取**第一个**掷中的（同一天结论稳定；多槽位只是给她更多机会）
  for (let i = 0; i < list.length; i++) {
    const slot = list[i];
    // 每个槽位的骰子互相独立（同一天有几个独处时段就有几次机会，但每次都是同一个概率）
    const roll = roll01(Number(seed) + i * 977, slot.startMinute);
    if (roll < probability) {
      return { fired: true, probability, slot, window: privateWindow(slot, { seed: Number(seed) + i * 977, dateKey, tuning }), roll };
    }
  }
  return { fired: false, probability, slot: null, window: null, roll: 1 };
}

/**
 * 现在是不是正处在她"正在自慰"的那个窗口里（纯函数）。
 * @param {{startMinute:number,endMinute:number}} window
 * @param {number} nowMinute 程序时间的当天分钟数
 */
/**
 * 这一刻在不在窗口里。
 * ⚠️ 2026-10-03 复查抓到的洞：跨零点的日程块（23:00~06:00）在 `privateWindow` 里被写成
 * `endMinute > 1440`（内部口径），而这里传进来的 `nowMinute` 恒在 0..1439 ⇒ **午夜之后那一段
 * 永远不 active**（日程页与聊天注入同时"没有这件事"，哪怕刚刚才撞见过）。
 * 现在把"现在"折算到窗口自己的时间轴上（早于起点就当成第二天的那一段）。
 */
export function isMomentNow(window, nowMinute) {
  if (!window) return false;
  const now = Number(nowMinute);
  if (!Number.isFinite(now)) return false;
  return minuteInWindow(window, now) !== null;
}

/**
 * 把 0..1439 的"今天第几分钟"折算进窗口的时间轴：
 *   · 窗口跨零点（endMinute > 1440）且现在早于起点 ⇒ 加上一天的分钟数（= 第二天凌晨那一段）；
 *   · 不在窗口内 ⇒ null。
 */
export function minuteInWindow(window, nowMinute) {
  if (!window) return null;
  const start = Number(window.startMinute) || 0;
  const end = Number(window.endMinute) || 0;
  let now = Number(nowMinute);
  if (!Number.isFinite(now)) return null;
  if (end > 1440 && now < start) now += 1440;
  return now >= start && now < end ? now : null;
}

/** 窗口还剩多少分钟（已过 → 0；跨零点窗口按折算后的时间轴算） */
export function minutesLeft(window, nowMinute) {
  if (!window) return 0;
  const at = minuteInWindow(window, nowMinute);
  if (at === null) return 0;
  return Math.max(0, Math.round(Number(window.endMinute) - at));
}

// ── 以下碰库（全部 try/catch：私密时刻是旁路，坏了不许影响聊天）──────────────────

function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 她的（角色, 日期）种子：稳定、与别的链路不撞 */
function seedOf(characterId, dateKey) {
  const s = `${characterId}|${dateKey}|private_moment`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 2147483647;
  return h;
}

/**
 * 取（必要时创建）她今天这一次私密时刻的行。
 * @param {{now?:Date, affinity?:number, schedule?:Array, tuning?:object}} [options]
 *   `schedule`：显式喂日程（测试/复用）；`tuning`：概率参数覆盖（测试把骰子钉死用）
 * @returns {{row:object|null, window:object|null, active:boolean, probability:number, reason:string}}
 */
export function ensurePrivateMoment(characterId, { now = getProgramNow(), affinity = 0, schedule = null, tuning = null } = {}) {
  const id = Number(characterId);
  const empty = { row: null, window: null, active: false, probability: 0, reason: '' };
  if (!Number.isFinite(id) || id <= 0) return empty;
  try {
    const dateKey = getProgramDateKey(now);
    const slots = privateSlots(schedule || getTodaySchedule(id, now) || [], { tuning: tuning || PRIVATE_MOMENT_TUNING });
    if (slots.length === 0) return { ...empty, reason: 'no_slot' };

    const sens = getSensitivity(id, { now: now.getTime() });
    // ⚠️ 2026-10-03 复查抓到的洞：**先查库，再掷骰子**。
    //   原来 `if (!decision.fired) return 'not_fired'` 排在查库之前 ⇒ 概率一变（发情开关 ±0.25、
    //   好感变动）就有两种翻车：① 库里明明有今天这一行，界面却"今天没有这件事"；
    //   ② 概率升高后可能改选**更早的另一个槽位** ⇒ 新 slot_key、caught_at 归零 ⇒
    //   「你闯进来了」按"第一次"重演，还再吃一次 self_play 的敏感度。
    //   现在：今天只要有**任何一段**已落库的私密时刻，就以库里的为准（先到的先用）。
    const db = getDb();
    const anyToday = db.prepare(
      'SELECT * FROM character_private_moments WHERE character_id = ? AND slot_date = ? ORDER BY start_minute LIMIT 1'
    ).get(id, dateKey);
    if (anyToday) {
      const win = { startMinute: Number(anyToday.start_minute) || 0, endMinute: Number(anyToday.end_minute) || 0 };
      return {
        row: anyToday,
        window: win,
        active: isMomentNow(win, minuteOfDay(now)),
        probability: Number(anyToday.probability) || 0,
        reason: 'ok',
      };
    }
    const decision = planPrivateMoment(slots, {
      sensitivity: sens.value,
      heat: sens.heat,
      affinity,
      seed: seedOf(id, dateKey),
      dateKey,
      tuning: tuning || PRIVATE_MOMENT_TUNING,
    });
    if (!decision.fired) return { ...empty, probability: decision.probability, reason: 'not_fired' };

    const existing = db.prepare(
      'SELECT * FROM character_private_moments WHERE character_id = ? AND slot_date = ? AND slot_key = ?'
    ).get(id, dateKey, decision.slot.key);
    let row = existing;
    if (!row) {
      db.prepare(
        `INSERT OR IGNORE INTO character_private_moments
         (character_id, kind, slot_date, slot_key, slot_activity, slot_location,
          start_minute, end_minute, probability, roll, sensitivity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, PRIVATE_MOMENT_KINDS.SELF_PLAY, dateKey, decision.slot.key,
        decision.slot.activity, decision.slot.location,
        decision.window.startMinute, decision.window.endMinute,
        decision.probability, decision.roll, Number(sens.value) || 0, toSqlUtc(new Date()),
      );
      row = db.prepare(
        'SELECT * FROM character_private_moments WHERE character_id = ? AND slot_date = ? AND slot_key = ?'
      ).get(id, dateKey, decision.slot.key);
    }
    const window = row
      ? { startMinute: Number(row.start_minute) || 0, endMinute: Number(row.end_minute) || 0 }
      : decision.window;
    return {
      row: row || null,
      window,
      active: isMomentNow(window, minuteOfDay(now)),
      probability: decision.probability,
      reason: row ? 'ok' : 'insert_failed',
    };  } catch (err) {
    console.warn('[privateMoment] 判定失败（不影响聊天）:', err?.message || err);
    return { ...empty, reason: 'error' };
  }
}

/**
 * 聊天链的读入口：她此刻是不是正在自慰 / 是不是已经被你撞见过。
 *
 * @returns {{active:boolean, caught:boolean, firstCatch:boolean, window:object|null,
 *            minutesLeft:number, label:string, row:object|null, probability:number}}
 */
export function privateMomentState(characterId, { now = getProgramNow(), affinity = 0, tuning = null } = {}) {
  const out = { active: false, caught: false, firstCatch: false, window: null, minutesLeft: 0, minutesSinceStart: 0, label: PRIVATE_MOMENT_LABEL, row: null, probability: 0 };
  try {
    const ensured = ensurePrivateMoment(characterId, { now, affinity, tuning });
    if (!ensured.row || !ensured.window) return { ...out, probability: ensured.probability };
    const nowMinute = minuteOfDay(now);
    const at = minuteInWindow(ensured.window, nowMinute);   // 折算进窗口自己的时间轴（跨零点也认）
    return {
      ...out,
      row: ensured.row,
      window: ensured.window,
      probability: ensured.probability,
      active: at !== null,
      caught: Boolean(ensured.row.caught_at),
      // 第一次撞见 = 这一行还没被撞见过
      firstCatch: at !== null && !ensured.row.caught_at,
      minutesLeft: minutesLeft(ensured.window, nowMinute),
      // 「已经过去多久」（提示词要说"大约 N 分钟前开始"，不是剩余时长）
      minutesSinceStart: at === null ? 0 : Math.max(0, Math.round(at - (Number(ensured.window.startMinute) || 0))),
    };
  } catch (err) {
    console.warn('[privateMoment] 读取失败（不影响聊天）:', err?.message || err);
    return out;
  }
}

/**
 * 记一次"被撞见"：落 `caught_at` / `caught_times`，并按自慰的份量给她涨一点敏感度。
 * 只做记录与累加，**文本由 prompt 块与模型负责**。
 */
export function catchPrivateMoment(characterId, { now = getProgramNow(), tuning = null } = {}) {
  try {
    const st = privateMomentState(characterId, { now, tuning });
    if (!st.row || !st.active) return { ok: false, code: 'not_active' };
    const db = getDb();
    db.prepare(
      'UPDATE character_private_moments SET caught_at = COALESCE(caught_at, ?), caught_times = caught_times + 1 WHERE id = ?'
    ).run(toSqlUtc(new Date()), st.row.id);
    // 敏感度：她自己玩一轮的份量（GROWTH.self_play），第一次撞见算满，之后只算半
    addSensitivity(Number(characterId), 'self_play', { weight: st.firstCatch ? 1 : 0.5 });
    return { ok: true, code: st.firstCatch ? 'first' : 'again', minutesLeft: st.minutesLeft, window: st.window, row: st.row };
  } catch (err) {
    console.warn('[privateMoment] 记账失败（不影响这一轮）:', err?.message || err);
    return { ok: false, code: 'error' };
  }
}

// ── prompt 块 / 文案 ─────────────────────────────────────────────────────────

/** 块长上限（照 `<self_toy_play>` 的先例：超长会被上游截断，所以自己钉住） */
export const MAX_PRIVATE_MOMENT_BLOCK_CHARS = 700;

/**
 * 「你闯进来了」注入块。
 *
 * 用户原话：「这个时候再去找角色私聊就会触发事件 玩家闯入角色正在自慰的情况」。
 * 口径：**她正在做这件事**、玩家**刚进来**（不是一个可以随便聊过去的普通时刻）——
 * 所以块里必须写清三件事：①她在做什么 ②门/时间被她自己安排成"没人会来" ③你现在站在她面前了。
 *
 * @param {{active:boolean, firstCatch:boolean, caught:boolean, label?:string,
 *          slotActivity?:string, slotLocation?:string, minutesLeft?:number}} state
 * @param {{userName?:string, characterName?:string, sensitivityLine?:string, toyLine?:string}} [options]
 * @returns {string} 不处于"正在进行"时返回 ''（调用方据此零注入）
 */
export function buildPrivateMomentBlock(state = {}, {
  userName = '用户', characterName = '她', sensitivityLine = '', toyLine = '',
} = {}) {
  if (!state.active) return '';
  const who = str(characterName, 24) || '她';
  const you = str(userName, 24) || '用户';
  const where = str(state.slotLocation || '', 24);
  const doing = str(state.slotActivity || '', 24);
  const lines = [];
  lines.push('<private_moment>');
  lines.push(`【现在这一刻：${you}闯进来了】`);
  if (state.firstCatch) {
    lines.push(
      `你进门的这一下，${who}正一个人在${where || '屋里'}${doing ? `（本来在做的是「${doing}」）` : ''}**自慰**：`
      + '手已经在那儿了、衣服是乱的、呼吸还没压下去。她是**被你撞见的**——没有准备、来不及遮掩。'
    );
    lines.push(
      '【怎么写】先写她被撞破那半秒的真实反应（僵住 / 手忙脚乱往下拉衣服 / 一句话说不完整 / 脸红到脖子），'
      + '再写她怎么面对你：恼羞成怒地赶你出去、嘴硬说"不是你想的那样"、或者干脆破罐子破摔看着你 —— 按她的性格选一种，'
      + '**不要**写成她会若无其事地跟你聊别的事。'
    );
    lines.push(`【别做的事】不要替${you}说话、不要旁白式总结、不要跳过"被撞见"这件事直接进入日常对话。`);
  } else {
    lines.push(
      `${who}还在刚才那件事里没缓过来（${minutesLeftText(state.minutesSinceStart)}）：手已经收了，但身体还没平下来、`
      + '衣服还乱着、说话带一点不自然 —— 她已经知道被你看见了，别再演成"什么都没发生"。'
    );
  }
  if (sensitivityLine) lines.push(sensitivityLine);
  if (toyLine) lines.push(toyLine);
  lines.push('</private_moment>');
  let block = lines.join('\n');
  if (block.length > MAX_PRIVATE_MOMENT_BLOCK_CHARS) block = block.slice(0, MAX_PRIVATE_MOMENT_BLOCK_CHARS);
  return block;
}

/**
 * 「这件事已经过去多久了」的文案。
 * ⚠️ 2026-10-03 复查抓到的洞：这里原来传的是 `minutesLeft`（**剩余**时长）却写成"大约 N 分钟前开始" ——
 *   窗口 15:00~15:35 时，15:05 会对模型说"大约 30 分钟前开始"，15:30 反而说"大约 5 分钟前"（越久越像刚发生）。
 *   现在按**已过去**的分钟数说。
 */
function minutesLeftText(minutesSinceStart) {
  const n = Math.max(0, Math.round(Number(minutesSinceStart) || 0));
  if (n <= 1) return '刚刚才开始';
  return `大约 ${n} 分钟前开始`;
}

/**
 * 日程/面板用的一行文案（给 UI 与提示词共用）。
 * @returns {string} 空串 = 今天没有这件事
 */
export function privateMomentLine(state = {}) {
  if (!state.row || !state.window) return '';
  const span = `${formatHhmm(Number(state.window.startMinute) % 1440)}~${formatHhmm(Number(state.window.endMinute) % 1440)}`;
  if (state.active) return `${span} 一个人在屋里（${PRIVATE_MOMENT_LABEL}）`;
  return `${span} 一个人在屋里`;
}
