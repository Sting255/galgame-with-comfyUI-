/**
 * 程序时间（世界时间）——「现实模拟游戏」里的那口钟
 *
 * ## 为什么要有这一层
 * 全仓所有时间判断（日程、睡眠、光线、prompt 里的时间标签）原本都直接吃
 * `new Date()` / `datetime('now')`，用户没法让世界前进一天。本模块提供一个
 * **显式偏移量**：`程序时间 = 真实时间 + offsetMs`。
 *
 * ## 单一事实来源
 * `system_settings` 表的一行（`program_time_state`，JSON）：
 *   { "offsetMs": 86400000, "epochDate": "2026-09-28" }
 *   · `offsetMs`  ：程序时间相对真实时间的偏移（毫秒，可正可负）
 *   · `epochDate` ：程序世界「第 1 天」的日期（本地口径 YYYY-MM-DD），
 *                   「第几天」= 程序日期 - epochDate + 1
 *
 * 选 `system_settings` 而不是新表/新列的理由：
 *   1. 它是全库唯一的 key/value 运行时状态表（`last_moments_seen_at` 等 DB-only 键就存在这里），
 *      不引入迁移、不动真实库结构；
 *   2. 程序时间是**全局单例**（所有角色共用一口钟），放 `characters` 上会重复且必然不一致，
 *      放 `world_settings` 会污染用户可见的世界观列表；
 *   3. 读路径带内存缓存（写时失效），`getProgramNow()` 可以被热路径随便调。
 *
 * ## 口径（改动前请先读完）
 *   · **偏移量为 0 时全仓行为逐字节不变**（默认值就是 0）。
 *   · 程序时间只影响「世界钟」：日程/睡眠判定、时段描述、prompt 时间标签、
 *     日程日期键（`daily_schedules.schedule_date`）。
 *   · **不动**任何真实时间的定时器：`setTimeout` 心跳、临时唤醒 5~15 分钟窗口、
 *     `next_proactive_at`、`next_schedule_refresh_at`、邮件/朋友圈排期都仍按真实时间走
 *     （见交付报告里「仍只跟真实时间走」清单）。
 *   · 「写入数据库的时间戳」（sleep_until / temporary_wake_until / reply_queue.scheduled_reply_at）
 *     一律仍是**真实瞬间**的无时区 UTC 串 —— 见 `toSqlUtc` / `parseSqlUtc` 的说明。
 *
 * 边界：本模块只做时钟算术与持久化，不做任何日程/睡眠副作用（避免与 scheduleManager 循环依赖）。
 */

import { getDb } from '../db/index.js';

/** system_settings 里的存储键（DB-only，不参与 config 装载） */
export const PROGRAM_TIME_SETTING_KEY = 'program_time_state';
/** 一次最多推进多少天（接口层与这里都夹一遍） */
export const MAX_ADVANCE_DAYS = 3650;
/** 「白天」的本地钟点区间 [06:00, 18:00)，其余算黑夜 */
export const DAY_START_MINUTE = 6 * 60;
export const DAY_END_MINUTE = 18 * 60;
/** 「切到白天 / 切到黑夜」的默认钟点 */
export const PHASE_DEFAULT_TIME = { day: '08:00', night: '22:00' };
/** 一次「立刻入睡」最长睡多久（分钟）：防止 until 写飞导致她永远不醒 */
export const MAX_SLEEP_MINUTES = 24 * 60;

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ── SQL 时间戳口径（无时区 UTC 串）────────────────────────────────────────────
// 全库（SQLite）的时间比较都是 `datetime('now')`（UTC）与裸串比较，所以写进库的
// 时间戳必须是 **UTC 的无时区串**：`YYYY-MM-DD HH:MM:SS`，没有 'Z'。
// 读的时候必须自己补 'Z'（V8 对 'YYYY-MM-DD HH:MM:SS' 的解析是**本地时间**，直接
// `new Date(str)` 会整体偏移一个时区 —— 这就是历史上「白天被当成睡觉」的藏身处）。

/** Date（真实瞬间）→ SQLite 无时区 UTC 串 */
export function toSqlUtc(date) {
  return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
}

/** SQLite 无时区 UTC 串 → Date（真实瞬间）；非法输入返回 null */
export function parseSqlUtc(value) {
  if (!value) return null;
  const text = String(value);
  // 已经带时区（ISO/Z）的原样解析；裸串按 UTC 解析
  const iso = /[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(text)
    ? text.replace(' ', 'T')
    : `${text.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── 本地日期算术（不依赖库）──────────────────────────────────────────────────

/** 本地口径日期键 'YYYY-MM-DD' */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' → 本地 00:00 的 Date；非法（含 13 月 / 99 日这类"格式对但日期不存在"）返回 null */
export function parseDateKey(key) {
  const m = DATE_RE.exec(String(key || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  // 回读校验：JS 会把 2030-02-31 静默进位成 3 月，这里必须挡住
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** 'HH:mm' → 当天分钟数；非法返回 null */
export function parseHhmm(value) {
  const m = TIME_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分钟数 → 'HH:mm'（0..1439，越界夹紧） */
export function formatHhmm(minuteOfDay) {
  const clamped = Math.max(0, Math.min(1439, Math.trunc(Number(minuteOfDay) || 0)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** 两个日期键相差的天数（b - a），本地口径 */
export function diffDays(aKey, bKey) {
  const a = parseDateKey(aKey);
  const b = parseDateKey(bKey);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** 日期键 + N 天 */
export function addDaysToKey(key, days) {
  const base = parseDateKey(key);
  if (!base) return null;
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + Math.trunc(Number(days) || 0));
  return localDateKey(next);
}

// ── 状态读写（带内存缓存）──────────────────────────────────────────────────

let _cache = null; // { offsetMs, epochDate }

function normalizeOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function normalizeEpochDate(value) {
  const key = String(value || '');
  return DATE_RE.test(key) ? key : null;
}

/**
 * 读状态（含内存缓存）。库还没初始化时按「未偏移」处理 —— 模块被提前 import 也不会炸。
 * @returns {{offsetMs:number, epochDate:string}}
 */
export function readProgramState() {
  if (_cache) return { ..._cache };
  let raw = null;
  try {
    raw = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
      .pluck().get(PROGRAM_TIME_SETTING_KEY) ?? null;
  } catch {
    raw = null;
  }
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  _cache = {
    offsetMs: normalizeOffset(parsed?.offsetMs),
    epochDate: normalizeEpochDate(parsed?.epochDate) || localDateKey(new Date()),
  };
  return { ..._cache };
}

function writeProgramState(next) {
  const state = {
    offsetMs: normalizeOffset(next.offsetMs),
    epochDate: normalizeEpochDate(next.epochDate) || readProgramState().epochDate,
  };
  // 直接用 SQL 写：`db/settings.js` 的 SETTING_TO_CONFIG 是「DB → config 装载表」，
  // 本键是纯运行时状态、不需要进 config；走 setSetting 只会换来一条"重启会丢"的误报 warn。
  getDb().prepare(
    `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(PROGRAM_TIME_SETTING_KEY, JSON.stringify(state));
  _cache = state;
  return { ...state };
}

/** 只给测试用：丢掉内存缓存，强制回库读 */
export function invalidateProgramTimeCache() {
  _cache = null;
}

// ── 时钟 ────────────────────────────────────────────────────────────────────

/** 程序时间（Date）。热路径友好：偏移为 0 时等价于 new Date() 的新对象 */
export function getProgramNow() {
  const { offsetMs } = readProgramState();
  const ms = Date.now();
  return new Date(offsetMs === 0 ? ms : ms + offsetMs);
}

/** 真实时间 → 程序时间 */
export function toProgramTime(date = new Date()) {
  const { offsetMs } = readProgramState();
  return new Date(new Date(date).getTime() + offsetMs);
}

/** 程序时间 → 真实时间 */
export function toRealTime(programDate) {
  const { offsetMs } = readProgramState();
  return new Date(new Date(programDate).getTime() - offsetMs);
}

/** 程序日期键（`daily_schedules.schedule_date` 用它） */
export function getProgramDateKey(programDate = getProgramNow()) {
  return localDateKey(programDate);
}

/** 当前时段：白天 / 黑夜（本地钟点 [06:00, 18:00) 为白天） */
export function getProgramPhase(programDate = getProgramNow()) {
  const minute = programDate.getHours() * 60 + programDate.getMinutes();
  return minute >= DAY_START_MINUTE && minute < DAY_END_MINUTE ? 'day' : 'night';
}

/**
 * 把「程序世界的某个墙上时刻」换算成**真实瞬间**。
 * 睡眠/队列等落库时间戳必须是真实瞬间（它们要和 `datetime('now')` 比）。
 * @param {string} dateKey 程序日期键
 * @param {string|number} hhmm 'HH:mm' 或当天分钟数
 */
export function programWallClockToReal(dateKey, hhmm) {
  const base = parseDateKey(dateKey);
  if (!base) return null;
  const minute = typeof hhmm === 'number' ? hhmm : parseHhmm(hhmm);
  if (minute === null) return null;
  base.setMinutes(base.getMinutes() + minute);
  return toRealTime(base);
}

/** 程序世界「今天/明天」的某个钟点 → 真实瞬间（'HH:mm' 已过则顺延到明天） */
export function resolveProgramHhmmToReal(hhmm, programDate = getProgramNow()) {
  const minute = parseHhmm(hhmm);
  if (minute === null) return null;
  const nowMinute = programDate.getHours() * 60 + programDate.getMinutes();
  const key = getProgramDateKey(programDate);
  return programWallClockToReal(minute > nowMinute ? key : addDaysToKey(key, 1), minute);
}

/** 程序时间 → prompt / 前端友好的结构化快照 */
export function getProgramState(programDate = getProgramNow()) {
  const state = readProgramState();
  const realNow = new Date();
  const date = localDateKey(programDate);
  const minuteOfDay = programDate.getHours() * 60 + programDate.getMinutes();
  const epochDate = state.epochDate;
  const totalDays = diffDays(epochDate, date); // 相对「第 1 天」推进了多少天
  return {
    date,
    time: formatHhmm(minuteOfDay),
    datetime: `${date} ${String(programDate.getHours()).padStart(2, '0')}:${String(programDate.getMinutes()).padStart(2, '0')}:${String(programDate.getSeconds()).padStart(2, '0')}`,
    timeSqlUtc: toSqlUtc(programDate),
    stamp: programDate.getTime(),
    weekday: WEEKDAYS[programDate.getDay()],
    minuteOfDay,
    phase: getProgramPhase(programDate),
    dayIndex: totalDays + 1, // 「第几天」：epochDate 当天 = 第 1 天
    totalDays,
    epochDate,
    offsetMs: state.offsetMs,
    offsetDays: Math.trunc(state.offsetMs / DAY_MS),
    offsetHours: Number((state.offsetMs / 3600000).toFixed(2)),
    offsetMinutes: Math.trunc(state.offsetMs / 60000),
    real: {
      date: localDateKey(realNow),
      time: `${String(realNow.getHours()).padStart(2, '0')}:${String(realNow.getMinutes()).padStart(2, '0')}`,
      datetime: `${localDateKey(realNow)} ${String(realNow.getHours()).padStart(2, '0')}:${String(realNow.getMinutes()).padStart(2, '0')}:${String(realNow.getSeconds()).padStart(2, '0')}`,
      stamp: realNow.getTime(),
    },
  };
}

// ── 修改时钟（只动钟，不做日程副作用）──────────────────────────────────────

/** 直接设偏移（毫秒） */
export function setProgramOffsetMs(offsetMs, { epochDate } = {}) {
  const state = readProgramState();
  return writeProgramState({
    offsetMs: normalizeOffset(offsetMs),
    epochDate: epochDate || state.epochDate,
  });
}

/** 回到真实时间（偏移归零），「第 1 天」重锚到今天 */
export function resetProgramTime() {
  return writeProgramState({ offsetMs: 0, epochDate: localDateKey(new Date()) });
}

/**
 * 推进 N 天：偏移加 N×24h。
 * 注意这里**只动钟**；「重算所有角色日程/睡眠」由 scheduleManager.advanceProgramDays 负责。
 */
export function advanceProgramOffsetDays(days) {
  const n = Math.trunc(Number(days) || 0);
  if (!Number.isFinite(n) || n === 0) return readProgramState();
  const state = readProgramState();
  return writeProgramState({ offsetMs: state.offsetMs + n * DAY_MS, epochDate: state.epochDate });
}

/**
 * 把程序钟表拨到「某个日期 + 某个钟点」。
 * 支持 `{ datetime }` / `{ date, time }` / `{ time }`（只改钟点，日期用程序日期）。
 * 日期时间按**程序世界墙上时间**解释。
 */
export function setProgramWallClock({ datetime, date, time } = {}) {
  let targetDateKey = null;
  let targetMinute = null;

  if (datetime) {
    const text = String(datetime).trim();
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
    if (!m) return { ok: false, error: 'invalid datetime' };
    targetDateKey = m[1];
    targetMinute = m[2] === undefined ? 0 : Number(m[2]) * 60 + Number(m[3]);
  } else {
    if (date !== undefined) {
      const key = String(date).trim();
      if (!DATE_RE.test(key)) return { ok: false, error: 'invalid date' };
      targetDateKey = key;
    }
    if (time !== undefined) {
      const minute = parseHhmm(time);
      if (minute === null) return { ok: false, error: 'invalid time' };
      targetMinute = minute;
    }
  }

  const current = getProgramNow();
  if (targetDateKey === null) {
    if (targetMinute === null) return { ok: false, error: 'nothing to set' };
    targetDateKey = localDateKey(current);
  }
  if (targetMinute === null) targetMinute = current.getHours() * 60 + current.getMinutes();

  const wall = parseDateKey(targetDateKey);
  if (!wall) return { ok: false, error: 'invalid date' };
  wall.setMinutes(wall.getMinutes() + targetMinute);

  writeProgramState({ offsetMs: wall.getTime() - Date.now(), epochDate: readProgramState().epochDate });
  return { ok: true, ...getProgramState() };
}

/**
 * 切到白天 / 黑夜：保留程序日期，只把钟点设成给定时刻（默认 08:00 / 22:00）。
 * @param {'day'|'night'} phase
 * @param {{time?: string}} [options]
 */
export function setProgramPhase(phase, { time } = {}) {
  const wanted = phase === 'night' ? 'night' : 'day';
  const hhmm = time === undefined || time === null || time === '' ? PHASE_DEFAULT_TIME[wanted] : String(time);
  const minute = parseHhmm(hhmm);
  if (minute === null) return { ok: false, error: 'invalid time' };
  const result = setProgramWallClock({ date: getProgramDateKey(getProgramNow()), time: formatHhmm(minute) });
  if (!result.ok) return result;
  return { ...result, phaseTarget: wanted };
}
