/**
 * 程序时间控制（"现实模拟游戏"的世界钟）——**编排层**
 *
 * 用户口径：「可以控制程序里的时间 控制是白天黑夜 是第一天还是第二天…我要完全控制时间…
 * 给我一个按钮 我可以让所有知道角色 过了一天了 或者是很多天 总之就是要让这个程序和游戏一样
 * 现实模拟游戏 我可以控制这一切」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## 事实来源：**只有一口钟**
 * `system_settings` 表里的一行 `program_time_state`（JSON：`{offsetMs, epochDate}`），
 * 由 `src/services/programTime.js` 独占读写：
 *
 *     程序时间 = 真实时间 + offsetMs        「第 N 天」= 程序日期 − epochDate + 1
 *
 * 为什么复用 `system_settings` 而不另开表/列：见 `programTime.js` 文件头。一句话——
 * 它是全库唯一的 key/value 运行时状态表（`last_moments_seen_at` 等 DB-only 键就在这里），
 * 而程序时间是**全局单例**（所有角色共用一口钟），放进 `characters` 必然重复且不一致，
 * 放进 `world_settings` 会污染用户可见的世界观列表。
 *
 * **本模块不新造第二口钟**：所有时钟算术都调 `programTime.js`，
 * 本模块只负责「校验 → 串行化 → 逐天推进 → 让所有角色跟上 → 投影成接口形状」。
 *
 * ## 推进语义（不许跳步）
 * 推进/设定之后必须影响**所有角色**，所以每次提交都做三件事：
 *   1. **逐天**走：`advanceProgramOffsetDays(1)` 一天一天拨，从不一次加 N×24h
 *      （`daily_schedules` 是"某一天"的实例，跳步会让"今天是第几天"和当日快照错位）；
 *   2. 每一天都：给**每个角色**补那一天的日程快照（`ensureScheduleRowForDay`）
 *      + 收掉过期的临时唤醒（`clearTempWake`，5~15 分钟的叫醒窗口跨天必然失效）；
 *   3. 收尾：`refreshAllSleepStates()` 让**每个角色**按新程序钟重算 `is_sleeping` /
 *      `sleep_until`（本该醒着的当场醒，该睡的睡下，小憩写醒来时刻）。
 *
 * 「拨到某个墙上时间」「只切白天/黑夜」同样在提交后跑第 3 步；若跨越了程序日期（跨日），
 * 还会跑第 2 步里的临时唤醒清理。
 *
 * ## 并发与失败
 *   · 所有写操作过 `withTimeLock` 串行化（同一时刻只允许一次推进）：临界区里**故意**
 *     有一次 `await` 让出事件循环（"先算后写"），没有锁的话两个并发请求会读到同一个旧状态，
 *     后写的那个把前一个的天数吃掉（丢更新）。
 *   · 校验全部发生在**第一次写库之前**；提交阶段抛错会把钟**回滚**到推进前的偏移，
 *     不留下"半个世界前进了一半"的状态。
 *
 * ## 仍然只跟真实时间走的东西
 * 见 `REAL_TIME_ONLY` / `TIME_CONTROL_NOTE`（接口 `message` 字段会如实带出去）。
 */

import { getDb } from '../db/index.js';
import {
  MAX_ADVANCE_DAYS,
  PHASE_DEFAULT_TIME,
  advanceProgramOffsetDays,
  getProgramDateKey,
  getProgramNow,
  getProgramState,
  localDateKey,
  parseDateKey,
  parseHhmm,
  readProgramState,
  resetProgramTime,
  setProgramOffsetMs,
} from './programTime.js';
import {
  clearTempWake,
  ensureScheduleRowForDay,
  refreshAllSleepStates,
} from './scheduleManager.js';
import { runProgramDayRollover } from './programDayRollover.js';

// ── 对外口径常量 ────────────────────────────────────────────────────────────

/** 合法时段 */
export const PERIODS = Object.freeze(['day', 'night']);
/** 一次推进的合法天数下界（与 programTime.MAX_ADVANCE_DAYS 一起构成 1~3650） */
export const MIN_ADVANCE_DAYS = 1;
export { MAX_ADVANCE_DAYS };

/**
 * **仍然只跟真实时间走**的模块清单（推进程序钟不会影响它们）。
 * 这份清单同时会出现在接口返回的 `message` 里 —— 不糊弄用户。
 */
export const REAL_TIME_ONLY = Object.freeze([
  'setTimeout / setInterval 定时器：睡眠状态兜底 cron（scheduleManager.startSleepingStateCron）、临时唤醒 5~15 分钟窗口（scheduleManager.scheduleTempWakeExpiry）',
  '主动聊天心跳 characters.next_proactive_at（proactiveChatScheduler）',
  '日程模板刷新 characters.next_schedule_refresh_at（replyQueueScheduler，每次只刷 1 个角色）',
  '回复队列排期 reply_queue.scheduled_reply_at（chat.js 排队、wakeService 让醒、replyQueueScheduler 出队）',
  '朋友圈排期 momentScheduler / 朋友圈未读水位 system_settings.last_moments_seen_at',
  '邮件排期 mailboxScheduler、天气小时缓存 weatherService',
  '小镇与后台排期：townService、townNpcStockScheduler、itemScheduler、groupIdleScheduler、eventScheduler、disturbModeScheduler、imageCompressor、imagePromptKnowledge、memory consolidationScheduler',
  '所有落库时间戳：sleep_until / temporary_wake_until 仍是**真实瞬间**的无时区 UTC 串（它们要和 SQLite 的 datetime(\'now\') 比）',
]);

/** 接口 `message` 字段：说清"生效了什么"和"什么仍跟真实时间走" */
export const TIME_CONTROL_NOTE = [
  '程序钟已生效：日程、睡眠状态（is_sleeping/sleep_until）、白天黑夜、时间标签与 prompt 时间口径都按新的世界时间重算。',
  `仍按真实时间走的模块（${REAL_TIME_ONLY.length} 类）：${REAL_TIME_ONLY.join('；')}。`,
].join(' ');

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 参数非法（接口层翻成 400，`code` 就是响应里的 error 值） */
export class TimeControlError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'TimeControlError';
    this.code = code;
  }
}

// ── 串行化（同一时刻只允许一次推进）────────────────────────────────────────

const lockStats = {
  /** 当前在临界区里的调用数（不变式：≤ 1） */
  active: 0,
  /** 历史峰值（不变式：≤ 1；> 1 就是锁漏了） */
  maxConcurrent: 0,
  /** 已经提交的次数 */
  runs: 0,
  /** 当前排队等待的次数 */
  queued: 0,
  /** 上一次动作 { action, days, at } */
  lastAction: null,
  /** 上一次失败信息 */
  lastError: null,
};

/** 只给测试/诊断用：串行化与提交统计的快照 */
export function getTimeControlStats() {
  return { ...lockStats, lastAction: lockStats.lastAction ? { ...lockStats.lastAction } : null };
}

/** 让出事件循环：制造"先算后写"的窗口，也是并发用例里丢更新的暴露点 */
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

let lockTail = Promise.resolve();

/**
 * 把 `fn` 排进全局时间锁：同一时刻只有一个临界区在跑，其余 FIFO 排队。
 * 抛错不会打断队列（队列尾部永远被吞掉成 resolved）。
 * @template T
 * @param {string} action 动作名（写进 lastAction）
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTimeLock(action, fn) {
  lockStats.queued += 1;
  const run = lockTail.then(async () => {
    lockStats.queued -= 1;
    lockStats.active += 1;
    if (lockStats.active > lockStats.maxConcurrent) lockStats.maxConcurrent = lockStats.active;
    try {
      return await fn();
    } finally {
      lockStats.active -= 1;
    }
  });
  lockTail = run.then(
    () => { lockStats.runs += 1; lockStats.lastAction = { action, at: Date.now() }; lockStats.lastError = null; },
    err => { lockStats.lastError = `${action}: ${err?.message || err}`; },
  );
  return run;
}

// ── 输入校验（全部发生在第一次写库之前）─────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 带时区的 ISO（`...Z` / `...+08:00`）：按绝对瞬间解释，再折算成本地墙上时间 */
const ZONED_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;
/** 裸的墙上时间（本项目 SQLite 口径：`YYYY-MM-DD HH:MM[:SS]`，无时区） */
const WALL_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** 推进天数：必须是 1~3650 的整数（非法 → TimeControlError('invalid days')） */
export function parseAdvanceDays(raw) {
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') {
    throw new TimeControlError('invalid days');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new TimeControlError('invalid days');
  const days = Math.trunc(n);
  if (days < MIN_ADVANCE_DAYS || days > MAX_ADVANCE_DAYS) throw new TimeControlError('invalid days');
  return days;
}

/** 时段：'day'/'白天' → day；'night'/'黑夜'/'夜晚' → night；其余 invalid period */
export function parsePeriod(raw) {
  const wanted = String(raw ?? '').trim().toLowerCase();
  if (wanted === 'day' || raw === '白天') return 'day';
  if (wanted === 'night' || raw === '黑夜' || raw === '夜晚') return 'night';
  throw new TimeControlError('invalid period');
}

/**
 * 解析「拨钟」入参，**只解析不写库**。
 * 支持 `{ datetime }`（`YYYY-MM-DD HH:mm[:ss]` 裸墙上时间，或带 Z/偏移的 ISO）、
 * `{ date, time }`、`{ time }`（只改钟点，日期用当前程序日期）。
 * @returns {{dateKey:string, minute:number|null, hasDate:boolean}}
 */
export function parseWallClockInput({ datetime, date, time } = {}) {
  if (datetime !== undefined && datetime !== null && String(datetime).trim() !== '') {
    const text = String(datetime).trim();
    if (ZONED_RE.test(text)) {
      // 带时区 → 绝对瞬间 → 折算成本地墙上时间（前端传 new Date().toISOString() 时走这条）
      const instant = new Date(text.replace(' ', 'T'));
      if (Number.isNaN(instant.getTime())) throw new TimeControlError('invalid datetime');
      return {
        dateKey: localDateKey(instant),
        minute: instant.getHours() * 60 + instant.getMinutes(),
        hasDate: true,
      };
    }
    const m = WALL_RE.exec(text);
    if (!m) throw new TimeControlError('invalid datetime');
    const dateKey = m[1];
    if (!parseDateKey(dateKey)) throw new TimeControlError('invalid datetime'); // 挡住 2030-02-31
    if (m[2] === undefined) return { dateKey, minute: 0, hasDate: true };
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) throw new TimeControlError('invalid datetime');
    return { dateKey, minute: hour * 60 + minute, hasDate: true };
  }

  let dateKey = null;
  let minute = null;
  if (date !== undefined && date !== null && String(date).trim() !== '') {
    const key = String(date).trim();
    if (!DATE_RE.test(key) || !parseDateKey(key)) throw new TimeControlError('invalid date');
    dateKey = key;
  }
  if (time !== undefined && time !== null && String(time).trim() !== '') {
    const parsed = parseHhmm(time);
    if (parsed === null) throw new TimeControlError('invalid time');
    minute = parsed;
  }
  if (dateKey === null && minute === null) throw new TimeControlError('invalid datetime');
  return { dateKey, minute, hasDate: dateKey !== null };
}

// ── 投影（接口形状）────────────────────────────────────────────────────────

/**
 * 程序时间 → 接口形状（**前端契约**，只加不减）：
 *   { date:'YYYY-MM-DD', time:'HH:mm', period:'day'|'night', dayIndex:number, totalDays:number, … }
 *
 * `dayIndex` 与 `totalDays` **不是**同义词，两者都给：
 *   · `totalDays` = 程序日期 − epochDate（推进了多少天，初始 0）
 *   · `dayIndex`  = totalDays + 1（"今天是第几天"，epochDate 当天 = 第 1 天）
 * `period` 与 `phase` 同值（前端两个都收，历史字段 `phase` 保留）。
 */
export function projectTimeState(extra = {}) {
  const s = getProgramState();
  return {
    date: s.date,
    time: s.time,
    period: s.phase,
    dayIndex: s.dayIndex,
    totalDays: s.totalDays,
    // —— 兼容字段（前端已按这些接，不能删）——
    phase: s.phase,
    datetime: s.datetime,
    stamp: s.stamp,
    weekday: s.weekday,
    minuteOfDay: s.minuteOfDay,
    epochDate: s.epochDate,
    offsetMs: s.offsetMs,
    offsetDays: s.offsetDays,
    offsetHours: s.offsetHours,
    offsetMinutes: s.offsetMinutes,
    real: s.real,
    message: TIME_CONTROL_NOTE,
    ...extra,
  };
}

/**
 * 调时之后打一行**可追溯的状态快照**（2026-10-01 补，日志取证的要求）。
 *
 * 为什么要有它：第八轮对 10.6 MB 真机日志做取证时，用户报的"调时开关没什么作用"
 * **无法定罪** —— 全文 `timeOffset`/`timeScale`/`程序时间`/`OFFSET` **0 命中**，
 * `[timeControl]` 只有 3 行（且全在同 1.2 秒里，只有"设到几点"，没有"偏移多少/第几天"）。
 * ⇒ 判定是"观测盲区"而不是"功能坏了"。这一行补上：以后任何人调时，日志里都能直接读出
 * 程序日期 / 时刻 / 第几天 / **偏移量** / 触发来源，不必再猜开关有没有生效。
 */
function logTimeStateChange(reason, applied) {
  try {
    const s = getProgramState();
    const sign = s.offsetMs >= 0 ? '+' : '-';
    const abs = Math.abs(Number(s.offsetMs) || 0);
    const hh = Math.floor(abs / 3600000);
    const mm = Math.round((abs % 3600000) / 60000);
    // ⚠️ `applied.characters` 是**数组**（每个被同步的角色一条记录），不是数字。
    // 第一版直接拼进模板 ⇒ 日志里打出 `同步 [object Object],[object Object]…`（真链路验证时抓到）。
    const synced = Array.isArray(applied?.characters) ? applied.characters.length
      : (typeof applied?.characters === 'number' ? applied.characters : null);
    console.log(
      `[timeControl] ${reason} → 程序时间 ${s.date} ${s.weekday} ${s.time}（第 ${s.dayIndex} 天，${s.phase === 'day' ? '白天' : '黑夜'}）` +
      ` | 偏移 ${sign}${hh}h${String(mm).padStart(2, '0')}m` +
      (applied?.days ? ` | 推进 ${applied.days} 天` : '') +
      (synced !== null ? ` | 同步 ${synced} 个角色` : '')
    );
  } catch (err) {
    console.warn('[timeControl] 状态快照日志失败（不影响调时）:', err?.message || err);
  }
}

/** 读当前程序时间（无副作用） */
export function getTimeState(extra = {}) {
  return projectTimeState(extra);
}

// ── 内部：让所有角色跟上新的世界时间 ───────────────────────────────────────

/** 启用日程的角色（与 refreshAllSleepStates 的筛选口径一致） */
function listScheduleCharacters() {
  return getDb().prepare(
    'SELECT id FROM characters WHERE schedule_enabled = 1 OR schedule_enabled IS NULL'
  ).all().map(row => row.id);
}

/** 挂着"临时唤醒"的角色 id（5~15 分钟窗口，跨天/跨日必然失效） */
function listTempWokenCharacters() {
  return getDb().prepare(
    'SELECT id FROM characters WHERE temporary_wake_until IS NOT NULL'
  ).all().map(row => row.id);
}

/** 逐个收掉临时唤醒（走 scheduleManager 已导出的清理函数，连带清掉它的 setTimeout） */
function clearTempWakes(ids) {
  const cleared = [];
  for (const id of ids) {
    try {
      clearTempWake(id);
      cleared.push(id);
    } catch (err) {
      console.warn(`[timeControl] clearTempWake(${id}) failed: ${err.message}`);
    }
  }
  return cleared;
}

/**
 * **逐天**推进 clock 并把每一天都落到角色身上。全程同步执行（调用方持锁）。
 * @param {number} days 已校验的 1~3650
 * @returns {{days:number, dayKeys:string[], skippedTempWakes:number[], characters:Array}}
 */
function commitAdvanceDays(days) {
  const characterIds = listScheduleCharacters();
  const pendingTempWakes = listTempWokenCharacters();
  const skippedTempWakes = [];
  const dayKeys = [];
  let tempWakesCleared = false;

  for (let i = 1; i <= days; i++) {
    // ① 一天一天地拨钟（绝不一次加 N×24h：跳步就没法给每一天补快照）
    advanceProgramOffsetDays(1);
    const now = getProgramNow();
    const dayKey = getProgramDateKey(now);
    dayKeys.push(dayKey);

    // ② 跨天之后"5~15 分钟叫醒窗口"不可能还有意义 → 第一天就全部收掉
    if (!tempWakesCleared && pendingTempWakes.length > 0) {
      skippedTempWakes.push(...clearTempWakes(pendingTempWakes));
      tempWakesCleared = true;
    }

    // ③ 每个角色都要有"这一天"的日程快照（逐天，不跳步）
    for (const id of characterIds) {
      ensureScheduleRowForDay(id, dayKey);
    }
  }

  // ④ 收尾：每个角色按新的程序钟重算 is_sleeping / sleep_until（该醒的当场醒）
  const characters = refreshAllSleepStates(getProgramNow());

  console.log(
    `[timeControl] advanced ${days} day(s) → ${getProgramDateKey(getProgramNow())}; ` +
    `${characters.length} character(s) resynced, ${skippedTempWakes.length} temp wake(s) cleared`
  );

  return { days, dayKeys, skippedTempWakes, characters };
}

// ── 对外写操作 ─────────────────────────────────────────────────────────────

/**
 * 调时之后立即触发「世界翻篇」（fire-and-forget）。
 *
 * 为什么不等 tick：用户点了"推进一天"，期待的是**世界当场翻篇**（新一天的日报就位），
 * 而 tick 周期是分钟级、观感上就是"调时没什么作用"。
 * 为什么不能 await：翻篇任务含 LLM 生成与逐张配图（十几秒起）——接口必须立刻返回，
 * 前端靠 `program_day_rollover` 广播 / 自身轮询拿到新一期报纸。
 */
function scheduleDayRollover(reason) {
  try {
    runProgramDayRollover({ reason }).catch(err => {
      console.warn(`[timeControl] 世界翻篇触发失败（已忽略，tick 会再试）: ${err?.message || err}`);
    });
  } catch (err) {
    console.warn(`[timeControl] 世界翻篇触发异常（已忽略）: ${err?.message || err}`);
  }
}

/**
 * `POST /api/time/advance` —— 快进 N 天（1~3650）。
 * 逐天推进 + 每一天补快照 + 清过期临时唤醒 + 全角色重算睡眠状态。
 * @param {unknown} rawDays
 * @returns {Promise<object>} 接口形状 + `applied`
 */
export function advanceTimeDays(rawDays) {
  const days = parseAdvanceDays(rawDays); // 校验在锁外、写库前
  return withTimeLock('advance', async () => {
    const startOffsetMs = readProgramState().offsetMs;
    const beforeKey = getProgramDateKey(getProgramNow());
    await yieldToEventLoop(); // 先算后写：让出事件循环（锁外会丢更新，见 getTimeControlStats）
    try {
      const applied = commitAdvanceDays(days);
      logTimeStateChange(`快进 ${days} 天`, applied);
      scheduleDayRollover('advance');
      return projectTimeState({
        applied: {
          days: applied.days,
          dayKeys: applied.dayKeys,
          skippedTempWakes: applied.skippedTempWakes,
          characters: applied.characters,
        },
      });
    } catch (err) {
      // 失败不要写坏状态：把钟拨回推进前（说明：已补的日程快照是幂等派生数据，留着无害）
      try { setProgramOffsetMs(startOffsetMs); } catch (rollbackErr) {
        console.error(`[timeControl] rollback failed: ${rollbackErr.message}`);
      }
      console.error(`[timeControl] advance ${days} day(s) from ${beforeKey} failed, clock rolled back: ${err.message}`);
      throw err;
    }
  });
}

/**
 * `POST /api/time/period` —— 只切白天 / 黑夜（日期与第几天不动）。
 * @param {unknown} rawPeriod 'day'|'night'|'白天'|'黑夜'
 * @param {{time?:string}} [options] 自定义钟点（默认白天 08:00 / 黑夜 22:00）
 */
export function setTimePeriod(rawPeriod, { time } = {}) {
  const period = parsePeriod(rawPeriod);          // 校验在写库前
  let minute = null;
  if (time !== undefined && time !== null && String(time).trim() !== '') {
    minute = parseHhmm(time);
    if (minute === null) throw new TimeControlError('invalid time');
  }
  return withTimeLock('period', async () => {
    const beforeKey = getProgramDateKey(getProgramNow());
    await yieldToEventLoop();
    // 默认钟点：白天 08:00 / 黑夜 22:00（与 programTime.PHASE_DEFAULT_TIME 同一份）
    const targetMinute = minute === null ? parseHhmm(PHASE_DEFAULT_TIME[period]) : minute;
    applyWallClock(getProgramDateKey(getProgramNow()), targetMinute);
    const applied = afterWallClockChange(beforeKey, { period, days: 0 });
    logTimeStateChange(period === 'day' ? '切到白天' : '切到黑夜', applied);
    scheduleDayRollover('period');
    return projectTimeState({ applied });
  });
}

/**
 * `POST /api/time/set` —— 把程序钟拨到指定的世界墙上时间。
 * @param {{datetime?:string, date?:string, time?:string}} body
 */
export function setTimeDateTime(body = {}) {
  const parsed = parseWallClockInput(body); // 先算：解析 + 校验，全部在写库前
  return withTimeLock('set', async () => {
    const beforeKey = getProgramDateKey(getProgramNow());
    await yieldToEventLoop();
    const current = getProgramNow();
    const dateKey = parsed.dateKey === null ? getProgramDateKey(current) : parsed.dateKey;
    const minute = parsed.minute === null
      ? current.getHours() * 60 + current.getMinutes()
      : parsed.minute;
    applyWallClock(dateKey, minute);
    const applied = afterWallClockChange(beforeKey, { days: 0 });
    logTimeStateChange(`设到 ${dateKey} ${formatMinute(minute)}`, applied);
    scheduleDayRollover('set');
    return projectTimeState({ applied });
  });
}

/** `POST /api/time/reset` —— 回到真实时间（偏移归零，"第 1 天"重锚到今天） */
export function resetTime() {
  return withTimeLock('reset', async () => {
    const beforeKey = getProgramDateKey(getProgramNow());
    await yieldToEventLoop();
    resetProgramTime();
    const applied = afterWallClockChange(beforeKey, { days: 0 });
    logTimeStateChange('重置回真实时间', applied);
    scheduleDayRollover('reset');
    return projectTimeState({ applied });
  });
}

// ── 内部：拨钟 + 拨完之后的角色同步 ────────────────────────────────────────

/** 分钟数 → 'HH:mm'（不依赖 programTime 的导出，避免把内部格式散落各处） */
function formatMinute(minuteOfDay) {
  const clamped = Math.max(0, Math.min(1439, Math.trunc(Number(minuteOfDay) || 0)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/**
 * 把程序钟拨到「某个程序日期 + 某个钟点」。**offsetMs 只写一次**（先算目标瞬间再写）。
 * @param {string} dateKey 程序世界日期
 * @param {number} minute 当天分钟数 0..1439
 */
function applyWallClock(dateKey, minute) {
  const base = parseDateKey(dateKey);
  if (!base) throw new TimeControlError('invalid date');
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439) {
    throw new TimeControlError('invalid time');
  }
  const target = new Date(base.getTime());
  target.setMinutes(target.getMinutes() + minute);
  const nowMs = Date.now();
  setProgramOffsetMs(target.getTime() - nowMs);
  return target;
}

/**
 * 拨完钟（set / period / reset）之后让所有角色跟上：
 *   · 跨了程序日期 → 顺手收掉过期的临时唤醒（别的日子里的叫醒窗口不属于今天）；
 *   · 无论如何都要让每个角色按新程序钟重算 is_sleeping / sleep_until。
 */
function afterWallClockChange(beforeKey, { period } = {}) {
  const now = getProgramNow();
  const afterKey = getProgramDateKey(now);
  const skippedTempWakes = afterKey === beforeKey ? [] : clearTempWakes(listTempWokenCharacters());
  const characters = refreshAllSleepStates(now);
  console.log(
    `[timeControl] clock set to ${getProgramDateKey(now)} ${formatMinute(now.getHours() * 60 + now.getMinutes())}` +
    `${afterKey === beforeKey ? '' : ' (cross-day)'}; ${characters.length} character(s) resynced`
  );
  return { period, days: 0, crossDay: afterKey !== beforeKey, skippedTempWakes, characters };
}
