/**
 * 单条日程编辑器
 *
 * 日程模板/快照都是整包 JSON，本模块提供「按条」修改能力：
 *   1. updateScheduleActivity  — 手动编辑单条（前端日程抽屉点击条目）
 *   2. applyScheduleChange     — 聊天约定检测命中后，把 LLM 返回的单条日程合并进当日日程
 *
 * 被编辑过的条目打上 edited 标记（specialMomentStatus: pending），进入当天特殊朋友圈队列
 * （pending → generating → sent / expired，扫描逻辑见 scheduleSpecialMoment.js）。
 * 标记只写 daily_schedules 当日快照，次日从模板重新派生时自然消失，不污染模板。
 */

import { getDb } from '../db/index.js';
import { ensureTodaySchedule, invalidateCache, syncSleepingState, classifySleepBlock, SLEEP_KINDS, clearTempWake, getSleepStatus } from './scheduleManager.js';
import { broadcast } from './unifiedStreamBus.js';
import {
  MAX_SLEEP_MINUTES,
  diffDays,
  getProgramDateKey,
  getProgramNow,
  parseDateKey,
  parseHhmm,
  toProgramTime,
} from './programTime.js';

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 聊天约定的最长时长（分钟）：LLM 偶尔输出「00:57~23:59」这类霸占全天的时段，必须封顶 */
const MAX_APPOINTMENT_MINUTES = 360;
/** 「立刻入睡」最短（分钟）：给 0 或负数会让日程算出零长块 */
const MIN_FORCED_SLEEP_MINUTES = 15;
/** 没找到主睡眠块时的兜底睡眠时长（分钟） */
const DEFAULT_SLEEP_MINUTES = 8 * 60;

function toMin(hhmm) {
  if (!TIME_RE.test(String(hhmm || ''))) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function minToTime(min) {
  // 1440（当天最后一分钟）落到 23:59，保证 HH:MM 24 小时制合法
  const clamped = Math.max(0, Math.min(1439, min));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 把 LLM/前端传入的单条日程补丁清洗成合法的活动对象，失败返回 null
 * @param {object} patch
 * @param {object} opts
 * @param {boolean} opts.clampCrossMidnight - 聊天约定路径：结束时间落在凌晨（如 23:47~00:40）
 *   视为跨天，截至当天 23:59；关闭时保留原样（手动编辑沿用原条目的跨天时段，如睡眠 22:00~07:00）
 */
export function sanitizeActivityInput(patch = {}, { clampCrossMidnight = false } = {}) {
  const startMin = toMin(patch.startTime);
  let endMin = toMin(patch.endTime);
  if (startMin === null || endMin === null) return null;
  if (endMin <= startMin) {
    if (!clampCrossMidnight) {
      // 保留跨天时段原样（睡眠等条目合法地跨午夜）
    } else if (endMin <= 240) {
      endMin = 1439; // 跨零点的约定截至当天 23:59
    } else {
      return null; // 结束不在凌晨（如 19:00~18:00）属于 LLM 输出错乱，拒绝
    }
  }

  const startTime = minToTime(startMin);
  const endTime = minToTime(endMin);
  if (startTime === null || endTime === null) return null;

  const activity = String(patch.activity || '').trim();
  if (!activity) return null;

  const replyDelayRaw = Number(patch.replyDelay);
  const replyDelay = patch.replyDelay === undefined || Number.isNaN(replyDelayRaw)
    ? 0
    : (replyDelayRaw === -1 ? -1 : Math.max(0, Math.round(replyDelayRaw)));

  const tags = Array.isArray(patch.tags)
    ? patch.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];

  return {
    startTime,
    endTime,
    activity: activity.slice(0, 60),
    location: String(patch.location || '').trim().slice(0, 60) || '未知',
    replyDelay,
    tags,
    description: String(patch.description || '').trim().slice(0, 200),
  };
}

function saveTodaySchedule(characterId, schedule) {
  const db = getDb();
  db.prepare(`
    UPDATE daily_schedules
    SET schedule_json = ?, generated_at = CURRENT_TIMESTAMP
    WHERE character_id = ? AND schedule_date = ?
  `).run(JSON.stringify(schedule), characterId, getProgramDateKey(getProgramNow()));
}

/** 载入今日日程（ensureTodaySchedule 首次派生快照时返回的是 JSON 字符串，统一成数组） */
function loadTodaySchedule(characterId) {
  const raw = ensureTodaySchedule(characterId);
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function finishEdit(characterId) {
  invalidateCache(characterId);
  syncSleepingState(characterId);
}

/** 日程更改成功 → 广播给前端（右上角 toast） */
function broadcastScheduleChanged(characterId, activity, targetDate = null) {
  try {
    const row = getDb().prepare('SELECT display_name FROM characters WHERE id = ?').get(characterId);
    broadcast('schedule_changed', {
      character_id: characterId,
      display_name: row?.display_name || '',
      activity: activity.activity,
      start_time: activity.startTime,
      end_time: activity.endTime,
      target_date: targetDate,
    });
  } catch (err) {
    console.warn('[scheduleEditor] schedule_changed broadcast failed:', err.message);
  }
}

/** 给条目打上「已编辑」标记并排入当天特殊朋友圈队列 */
function markEdited(activity, source) {
  activity.edited = 1;
  activity.editedSource = source === 'chat' ? 'chat' : 'manual';
  activity.specialMomentStatus = 'pending';
}

/**
 * 手动编辑单条日程
 * @param {number} characterId
 * @param {number} index - 今日日程数组下标
 * @param {object} patch - { startTime, endTime, activity, location, description }
 * @returns {{ ok: boolean, error?: string, activities?: array }}
 */
export function updateScheduleActivity(characterId, index, patch = {}) {
  const schedule = loadTodaySchedule(characterId);
  if (!schedule || !Array.isArray(schedule) || !schedule[index]) {
    return { ok: false, error: '日程条目不存在' };
  }

  // 手动编辑只改内容，不改时间：未传或传空时沿用原条目的时间段
  const base = schedule[index];
  const clean = sanitizeActivityInput({
    ...patch,
    startTime: patch.startTime || base.startTime,
    endTime: patch.endTime || base.endTime,
  });
  if (!clean) {
    return { ok: false, error: '字段不合法：活动名不能为空' };
  }

  const updated = [...schedule];
  updated[index] = { ...updated[index], ...clean };
  markEdited(updated[index], 'manual');

  saveTodaySchedule(characterId, updated);
  finishEdit(characterId);
  console.log(`[scheduleEditor] Manual edit char ${characterId} #${index}: ${clean.startTime}-${clean.endTime} ${clean.activity}`);
  broadcastScheduleChanged(characterId, clean);
  return { ok: true, activities: updated };
}

/**
 * 把聊天约定检测产出的单条日程合并进当日日程：
 * 覆盖与新时间段重叠的条目（跨午夜条目按需拆分），修剪相邻条目保持 24 小时无空档。
 * @returns {{ ok: boolean, reason?: string, activity?: object }}
 */
export function applyScheduleChange(characterId, newActivity, now = getProgramNow()) {
  const schedule = loadTodaySchedule(characterId);
  if (!schedule || !Array.isArray(schedule)) {
    return { ok: false, reason: 'no_schedule' };
  }

  const clean = sanitizeActivityInput(newActivity, { clampCrossMidnight: true });
  if (!clean) return { ok: false, reason: 'invalid_activity' };

  // 约定时长封顶：LLM 偶尔把 endTime 写成 23:59 表达「到天亮/一整天」，
  // 不封顶会把当天日程几乎整包替换掉
  let newS = toMin(clean.startTime);
  let newE = toMin(clean.endTime);
  if (newE - newS > MAX_APPOINTMENT_MINUTES) {
    newE = newS + MAX_APPOINTMENT_MINUTES;
    clean.endTime = minToTime(newE);
    console.log(`[scheduleEditor] Appointment duration capped to ${MAX_APPOINTMENT_MINUTES} min: ${clean.startTime}-${clean.endTime}`);
  }

  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (newE <= nowMin) {
    return { ok: false, reason: 'expired' }; // 约定时段已经过去了，插入没有意义
  }

  // 保留未被覆盖的条目；与 [newS, newE) 重叠的条目裁掉重叠段（跨午夜条目拆成两段处理）
  const kept = [];
  for (const act of schedule) {
    const s = toMin(act.startTime);
    let e = toMin(act.endTime);
    if (s === null || e === null) continue; // 脏数据丢弃
    if (e === s) continue; // 零长度脏条目丢弃
    if (e === 0 && s > 0) e = 1440; // endTime 00:00 是 LLM 的「当天午夜收尾」写法，不是跨天

    if (e > s) {
      if (s < newE && newS < e) {
        if (s < newS) kept.push({ ...act, startTime: minToTime(s), endTime: minToTime(newS) });
        if (newE < e) kept.push({ ...act, startTime: minToTime(newE), endTime: minToTime(e) });
      } else {
        kept.push(act);
      }
    } else {
      // 跨午夜条目（如睡眠 22:00~07:00）：上半段 [s,1440)、下半段 [0,e)
      if (s < newE) {
        if (s < newS) kept.push({ ...act, startTime: minToTime(s), endTime: minToTime(newS) });
        // else 上半段完全被覆盖
      } else {
        kept.push({ ...act, startTime: minToTime(s), endTime: '23:59' });
      }
      if (newS < e) {
        if (newE < e) kept.push({ ...act, startTime: minToTime(newE), endTime: minToTime(e) });
        // else 下半段完全被覆盖
      } else {
        kept.push({ ...act, startTime: '00:00', endTime: minToTime(e) });
      }
    }
  }

  const marked = { ...clean };
  markEdited(marked, 'chat');
  kept.push(marked);

  // 过滤裁剪产生的零长度残块（如 [23:59,23:59]），再排序并补空档（优先拉伸原有条目，不改约定时长）
  const merged = kept.filter(a => toMin(a.startTime) !== toMin(a.endTime));
  merged.sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  if (toMin(merged[0].startTime) > 0) merged[0].startTime = '00:00';
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    if (toMin(prev.endTime) < toMin(cur.startTime)) {
      if (prev.edited) cur.startTime = prev.endTime;
      else prev.endTime = cur.startTime;
    }
  }
  const last = merged[merged.length - 1];
  // endTime 00:00 是「当天午夜收尾」写法，等同于 23:59，不需要也不应该改写
  if (toMin(last.endTime) < 1439 && last.endTime !== '00:00') last.endTime = '23:59';

  saveTodaySchedule(characterId, merged);
  finishEdit(characterId);
  console.log(`[scheduleEditor] Applied schedule change char ${characterId}: ${marked.startTime}-${marked.endTime} ${marked.activity} (${merged.length} activities now)`);
  broadcastScheduleChanged(characterId, marked);
  return { ok: true, activity: marked };
}

/** 更新某条已编辑日程的特殊朋友圈状态（sent / expired / pending …） */
export function updateSpecialMomentStatus(characterId, startTime, status) {
  const db = getDb();
  const row = db.prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(characterId, getProgramDateKey(getProgramNow()));
  if (!row) return false;

  let schedule;
  try { schedule = JSON.parse(row.schedule_json); } catch { return false; }
  if (!Array.isArray(schedule)) return false;

  // edited 条目在同一角色同一天内以 startTime 唯一（日程本身不允许时间重叠）
  const act = schedule.find(a => a && a.edited && a.startTime === startTime);
  if (!act) return false;

  act.specialMomentStatus = status;
  saveTodaySchedule(characterId, schedule);
  return true;
}

// ── 待应用日程变更队列（约定的是未来某天）──

/**
 * 未来某天的约定先入队，到 target_date 当天由 ensurePendingScheduleChanges
 * 合并进当日日程（合并后照常进入当天的特殊朋友圈队列）
 */
export function queueScheduleChange(characterId, targetDate, activity, source = 'chat') {
  const db = getDb();
  db.prepare(`
    INSERT INTO pending_schedule_changes (character_id, target_date, activity_json, status, source)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(characterId, targetDate, JSON.stringify(activity), source);
  console.log(`[scheduleEditor] Queued schedule change char ${characterId} for ${targetDate}: ${activity.startTime}-${activity.endTime} ${activity.activity}`);
  broadcastScheduleChanged(characterId, activity, targetDate);
}

/**
 * 应用到期的待应用队列（特殊朋友圈扫描前调用）：
 * - target_date < 今天 → 标记 expired（过时不候）
 * - target_date == 今天 → 合并进当日日程并打 edited 标记
 * - 已 applied 但当日快照被夜间日程刷新整包覆盖 → 重新合并回去（幂等）
 */
export function ensurePendingScheduleChanges(now = getProgramNow()) {
  const db = getDb();
  const today = getProgramDateKey(now);

  const due = db.prepare(
    `SELECT id, character_id, activity_json, target_date FROM pending_schedule_changes
     WHERE status = 'pending' AND target_date <= ?`
  ).all(today);
  for (const row of due) {
    let activity = null;
    try { activity = JSON.parse(row.activity_json); } catch { /* 脏数据按过期处理 */ }

    let status = 'expired';
    if (activity && row.target_date === today) {
      const result = applyScheduleChange(row.character_id, activity, now);
      status = result.ok ? 'applied' : 'expired'; // expired / no_schedule / invalid 均不再重试
      console.log(`[scheduleEditor] Pending change ${result.ok ? 'applied' : `dropped (${result.reason})`} char ${row.character_id}: ${activity.startTime}-${activity.endTime} ${activity.activity}`);
    } else if (row.target_date < today) {
      console.log(`[scheduleEditor] Pending change expired (过时不候) char ${row.character_id} for ${row.target_date}`);
    }
    db.prepare('UPDATE pending_schedule_changes SET status = ? WHERE id = ?').run(status, row.id);
  }

  // 当日已应用的约定被夜间日程刷新（00:00~04:00 整包重写快照）覆盖时，重新合并回去
  const appliedToday = db.prepare(
    `SELECT id, character_id, activity_json FROM pending_schedule_changes
     WHERE status = 'applied' AND target_date = ?`
  ).all(today);
  for (const row of appliedToday) {
    let activity;
    try { activity = JSON.parse(row.activity_json); } catch { continue; }
    const schedule = loadTodaySchedule(row.character_id);
    const stillThere = Array.isArray(schedule) && schedule.some(a =>
      a && a.edited && a.startTime === activity.startTime && a.activity === activity.activity);
    if (!stillThere) {
      const result = applyScheduleChange(row.character_id, activity, now);
      if (result.ok) {
        console.log(`[scheduleEditor] Re-applied wiped appointment char ${row.character_id}: ${activity.startTime} ${activity.activity}`);
      }
    }
  }
}

// ── 睡眠控制：立刻入睡 / 立刻唤醒（催眠手机「睡眠控制」）──────────────────────
//
// **为什么改日程而不是改 characters.is_sleeping**：
// 睡眠状态的唯一事实来源是「当日日程 + scheduleManager 的派生链」。只改
// `characters.is_sleeping/sleep_until` 的话，下一次 `syncSleepingState`（整点 cron、
// 聊天读路径、日程刷新）会按日程把结论**翻回去** —— 内存说醒着、库里说睡着。
// 所以这里动的是 `daily_schedules` 当日快照：把 [现在, 结束) 这一段**替换**成睡眠/清醒块，
// 之后 `invalidateCache` + `syncSleepingState` 让缓存、定时器、库三者立刻一致。
// 这些改动只落在"今天"的快照上，次日从模板重新派生时自然消失（不需要额外的清理逻辑）。

/** 活动 → [0,1440) 内的半开区间（跨午夜拆两段；'00:00' 收尾按当天午夜算） */
function toHalfOpenIntervals(act) {
  const s = toMin(act?.startTime);
  let e = toMin(act?.endTime);
  if (s === null || e === null || s === e) return [];
  if (e === 0 && s > 0) e = 1440;
  if (e < s) {
    const halves = [{ s, e: 1440, act }];
    if (e > 0) halves.push({ s: 0, e, act });
    return halves;
  }
  return [{ s, e, act }];
}

/** 从区间集合里挖掉 [cutS, cutE) */
function cutIntervals(intervals, cutS, cutE) {
  const out = [];
  for (const iv of intervals) {
    if (iv.e <= cutS || iv.s >= cutE) { out.push(iv); continue; }
    if (iv.s < cutS) out.push({ ...iv, e: cutS });
    if (cutE < iv.e) out.push({ ...iv, s: cutE });
  }
  return out;
}

/**
 * 区间集合 → 活动数组。
 * 顺序很重要：先在**线性 [0,1440)** 上做规范化（合并同源相邻段、补齐空档），
 * **最后**才把"首段 [0,a) 与末段 [b,1440) 同源"的两段合回一条跨午夜活动。
 * 反过来的话，跨午夜合回会把一个 s 很大的区间放到数组开头，后面的排序/补空档
 * 会把它当成首段（`s > 0 → s = 0`），直接把整块睡眠挪到凌晨 —— 真机表现就是
 * "点了立刻入睡她还醒着"（本条曾被自己的测试抓到）。
 * 与 `applyScheduleChange` 同口径：24 小时全覆盖、endTime 用 '23:59' 收尾。
 */
function intervalsToActivities(intervals) {
  const list = intervals.slice().sort((a, b) => a.s - b.s);

  // 1) 合并同源相邻段
  const merged = [];
  for (const iv of list) {
    const prev = merged[merged.length - 1];
    if (prev && prev.act === iv.act && prev.e === iv.s) { prev.e = iv.e; continue; }
    merged.push({ ...iv });
  }
  // 2) 补齐空档（优先延长上一条）+ 保证首尾顶到 0 / 1440
  for (let i = 1; i < merged.length; i++) {
    if (merged[i - 1].e < merged[i].s) merged[i - 1].e = merged[i].s;
  }
  if (merged.length && merged[0].s > 0) merged[0].s = 0;
  if (merged.length && merged[merged.length - 1].e < 1440) merged[merged.length - 1].e = 1440;

  // 3) 跨午夜合回：首段 [0,a) 与末段 [b,1440) 同源 → 一条 startTime=b, endTime=a
  if (merged.length > 1) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    if (first.act === last.act && first.s === 0 && last.e === 1440) {
      const joined = { ...first.act, startTime: minToTime(last.s), endTime: minToTime(first.e) };
      merged.splice(merged.length - 1, 1);
      merged.splice(0, 1, { s: last.s, e: 1440 + first.e, act: joined });
      merged.sort((a, b) => a.s - b.s);
    }
  }

  return merged.map(iv => {
    const e = iv.e > 1440 ? iv.e - 1440 : iv.e;
    return { ...iv.act, startTime: minToTime(iv.s), endTime: e === 1440 ? '23:59' : minToTime(e) };
  });
}

/**
 * 用一条新活动替换当日日程里的 [startMin, endMin)（endMin 可 >1440 表示跨午夜）。
 * @returns {Array} 新日程数组（24 小时无空档）
 */
function replaceRange(schedule, startMin, endMin, makeBlock) {
  let remaining = [];
  for (const act of schedule || []) {
    const halves = toHalfOpenIntervals(act);
    if (halves.length === 0) continue;
    remaining.push(...halves);
  }
  const cuts = endMin <= 1440 ? [[startMin, endMin]] : [[startMin, 1440], [0, endMin - 1440]];
  for (const [s, e] of cuts) remaining = cutIntervals(remaining, s, e);

  const block = makeBlock(
    minToTime(startMin),
    minToTime(endMin > 1440 ? endMin - 1440 : endMin),
  );
  if (endMin <= 1440) remaining.push({ s: startMin, e: endMin, act: block });
  else {
    remaining.push({ s: startMin, e: 1440, act: block });
    remaining.push({ s: 0, e: endMin - 1440, act: block });
  }
  return intervalsToActivities(remaining);
}

/** 当前时刻落在哪个日程块里 */
function findBlockAt(schedule, nowMin) {
  for (const act of schedule || []) {
    for (const iv of toHalfOpenIntervals(act)) {
      if (iv.s <= nowMin && nowMin < iv.e) return act;
    }
  }
  return null;
}

/** 取当日日程里主睡眠块的时长（分钟），找不到返回 null */
function mainSleepDuration(schedule) {
  for (const act of schedule || []) {
    if (classifySleepBlock(act) !== SLEEP_KINDS.MAIN) continue;
    const halves = toHalfOpenIntervals(act);
    if (!halves.length) continue;
    // 跨午夜的睡块（如 22:00~07:45）会被 toHalfOpenIntervals 拆成两段 [22:00,24:00) + [0:00,07:45)。
    // 时长必须是**两段之和 = 120 + 465 = 585 分钟**，绝不能用 max(e) - min(s)：那是 1440（整天），
    // 于是「立刻入睡」不传 until 时会把 `endMin` 算到 24 小时后，
    // 把**一整天**的日程整块替换成睡眠块（真机表现：点一次立刻入睡，当天所有安排全没了、
    // sleep_until 直接到第二天）。这是本条曾被自己的探针抓到的原因。
    const total = halves.reduce((sum, h) => sum + (h.e - h.s), 0);
    if (total > 0) return total;
  }
  return null;
}

/**
 * `until` 解析：
 *   · 'HH:mm'                          → 程序世界墙上钟点（已过则顺延到明天）
 *   · 'YYYY-MM-DD HH:mm[:ss]'          → 程序世界墙上时刻
 *   · 带时区的 ISO（…Z / +08:00）       → 真实瞬间（换算回程序墙上时刻做日程手术）
 * @returns {{ok:true, endMin:number}|{ok:false, error:string}} endMin 是相对"程序今天 00:00"的分钟数
 */
export function resolveSleepUntil(until, programNow = getProgramNow()) {
  const nowMin = programNow.getHours() * 60 + programNow.getMinutes();
  const text = String(until).trim();

  const hhmm = parseHhmm(text);
  if (hhmm !== null) {
    return { ok: true, endMin: hhmm > nowMin ? hhmm : hhmm + 1440 };
  }

  const absolute = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (absolute) {
    const [, y, mo, d, hh = '0', mi = '0', , zone] = absolute;
    const minute = Number(hh) * 60 + Number(mi);
    let programDate = parseDateKey(`${y}-${mo}-${d}`);
    if (!programDate) return { ok: false, error: 'invalid until' };
    programDate.setMinutes(programDate.getMinutes() + minute);
    if (zone) {
      // 带时区 → 先当真实瞬间解析再换算成程序墙上时刻
      const realMs = Date.parse(text.replace(' ', 'T'));
      if (Number.isNaN(realMs)) return { ok: false, error: 'invalid until' };
      const programMs = toProgramTime(new Date(realMs)).getTime();
      const shifted = new Date(programMs);
      return {
        ok: true,
        endMin: diffDays(getProgramDateKey(programNow), getProgramDateKey(shifted)) * 1440
          + shifted.getHours() * 60 + shifted.getMinutes(),
      };
    }
    return {
      ok: true,
      endMin: diffDays(getProgramDateKey(programNow), getProgramDateKey(programDate)) * 1440 + minute,
    };
  }

  return { ok: false, error: 'invalid until' };
}

/**
 * **立刻入睡**：把 [现在, until) 写进当日日程（`replyDelay=-1` + `forcedSleep=1`），
 * 然后走既有派生链（invalidateCache → syncSleepingState）把状态同步到定时器与库。
 *
 * @param {number} characterId
 * @param {{until?: string}} [options] 不传＝按日程默认（用当日主睡眠块的时长；没有则 8 小时）
 * @returns {{ok:boolean, reason?:string, status?:object}}
 */
export function forceSleepNow(characterId, { until } = {}) {
  const id = Number(characterId);
  const db = getDb();
  const character = db.prepare('SELECT id, display_name FROM characters WHERE id = ?').get(id);
  if (!character) return { ok: false, reason: 'not_found' };

  const programNow = getProgramNow();
  const nowMin = programNow.getHours() * 60 + programNow.getMinutes();
  const schedule = loadTodaySchedule(id);
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return { ok: false, reason: 'no_schedule' };
  }

  let endMin;
  if (until !== undefined && until !== null && String(until).trim() !== '') {
    const parsed = resolveSleepUntil(until, programNow);
    if (!parsed.ok) return { ok: false, reason: parsed.error };
    endMin = parsed.endMin;
  } else {
    endMin = nowMin + (mainSleepDuration(schedule) || DEFAULT_SLEEP_MINUTES);
  }
  // 时长夹紧：最多 24 小时（避免 until 写飞导致她永远不醒）。
  // ⚠️ 2026-10-03 修正「最短 15 分钟」的适用条件：原来是无条件夹，
  //    于是 `until='06:30'` 在 06:28 调用时会被**悄悄改写成 06:43**（用户看到的与自己写的不一致）。
  //    现在只在"解析出来的时刻**不在现在之后**"时才给最短时长（那是真正的异常输入：过去时间 ⇒ 她会立刻醒），
  //    未来的时刻一律**照用户说的**办。抓到它的是 `hypnosisSleepControl.test.js` 那条用例（真时间落在 06:15~06:30 时才红）。
  if (!(endMin > nowMin)) endMin = nowMin + MIN_FORCED_SLEEP_MINUTES;
  if (endMin - nowMin > MAX_SLEEP_MINUTES) endMin = nowMin + MAX_SLEEP_MINUTES;

  const current = findBlockAt(schedule, nowMin);
  const sleepBlock = {
    activity: '催眠入睡——被无形的手按进睡眠',
    location: current?.location && current.location !== '未知' ? current.location : '卧室',
    replyDelay: -1,
    forcedSleep: 1,
    tags: ['睡眠', '催眠'],
    description: `${character.display_name}的眼皮忽然沉下来，身体被按进一片柔软的黑里，呼吸渐渐放慢。`,
  };
  const next = replaceRange(schedule, nowMin, endMin, (startTime, endTime) => ({ ...sleepBlock, startTime, endTime }));

  // 临时唤醒窗口先收掉（与 forceWakeNow 对称）：`syncSleepingState` 在临时唤醒期间**直接 return**，
  // 不收窗口的话刚写进去的睡眠块会被内存里的旧窗口挡住 —— 「立刻入睡」接口回 isSleeping:false、
  // is_sleeping 仍为 0、sleep_until 不写（真机表现：点了入睡她还是醒着，最多 15 分钟后才睡）。
  // 次序：放在参数校验/夹紧**之后**，非法 until 仍然零写入。
  clearTempWake(id);
  saveTodaySchedule(id, next);
  invalidateCache(id);
  syncSleepingState(id, getProgramNow());
  broadcastScheduleChanged(id, { ...sleepBlock, startTime: minToTime(nowMin), endTime: minToTime(endMin > 1440 ? endMin - 1440 : endMin) });
  console.log(`[scheduleEditor] Forced sleep char ${id}: ${minToTime(nowMin)} → +${endMin - nowMin}min (until ${getProgramDateKey(programNow)} ${minToTime(endMin > 1440 ? endMin - 1440 : endMin)})`);
  return { ok: true, status: getSleepStatus(id) };
}

/**
 * **立刻唤醒**：把「当前睡眠块剩下的部分」在当日日程里替换成清醒块，
 * 并清掉临时唤醒窗口，最后走既有派生链同步（自然醒路径 → 会触发梦境系统的 onCharacterWake）。
 *
 * @returns {{ok:boolean, reason?:string, status?:object}}
 */
export function forceWakeNow(characterId) {
  const id = Number(characterId);
  const db = getDb();
  const character = db.prepare('SELECT id, display_name FROM characters WHERE id = ?').get(id);
  if (!character) return { ok: false, reason: 'not_found' };

  const programNow = getProgramNow();
  const nowMin = programNow.getHours() * 60 + programNow.getMinutes();
  const schedule = loadTodaySchedule(id);

  // 临时唤醒窗口先收掉：否则 syncSleepingState 会跳过，state 看着醒了但库里的窗口还在
  clearTempWake(id);

  if (Array.isArray(schedule) && schedule.length) {
    const current = findBlockAt(schedule, nowMin);
    if (current && Number(current.replyDelay) === -1) {
      const halves = toHalfOpenIntervals(current);
      // 挖到**整个睡眠块的末尾**（不是"当前那半段"）：否则跨午夜的睡块会留下后半段，
      // 把刚被叫醒的人几十分钟后又按回睡着（真机表现："叫醒了，过一会又睡了"）。
      // 跨午夜的前半段（如 22:00~07:45 里 23:30 那一段）后半段在"明天早上"，
      // 所以末尾要**向前跨过午夜**算到早上那段的结束（1440 + 465），只取 max(e) 会停在本日 24:00。
      const nowHalf = halves.find(h => h.s <= nowMin && nowMin < h.e) || null;
      const tailHalf = halves.find(h => h.s === 0 && h.e > 0 && h.e < 1440) || null;
      let endMin = nowMin + 30;
      if (nowHalf) {
        endMin = nowHalf.e;
        if (nowHalf.e === 1440 && tailHalf) endMin = 1440 + tailHalf.e;
      }

      const awakeBlock = {
        activity: '被唤醒——睡意散去',
        location: current.location || '卧室',
        replyDelay: 0,
        forcedWake: 1,
        tags: ['清醒'],
        description: `${character.display_name}猛地睁开眼，睡意被抽走，意识回到身体里。`,
      };
      const next = replaceRange(schedule, nowMin, endMin, (startTime, endTime) => ({ ...awakeBlock, startTime, endTime }));
      saveTodaySchedule(id, next);
      console.log(`[scheduleEditor] Forced wake char ${id}: cut sleep ${minToTime(nowMin)} → ${minToTime(endMin > 1440 ? endMin - 1440 : endMin)}`);
    }
  }

  invalidateCache(id);
  // 不手动写 is_sleeping：交给派生链判断（它能顺带重置叫醒列、广播、触发 onCharacterWake）
  syncSleepingState(id, getProgramNow());
  db.prepare('UPDATE characters SET is_sleeping = 0, sleep_until = NULL WHERE id = ?').run(id);
  return { ok: true, status: getSleepStatus(id) };
}
