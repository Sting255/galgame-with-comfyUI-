/**
 * 日程运行时管理器
 *
 * 提供轻量、带缓存的日程查询，用于：
 *   1. chat.js 注入当前状态到 system prompt
 *   2. chat.js 入口判断是否需要延迟回复
 *   3. momentScheduler / eventGenerator 注入日程上下文
 *   4. 调度器过滤睡眠中的角色
 *   5. 前端日程页面 API
 */

import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { snapshotTodaySchedule } from './scheduleGenerator.js';
import { broadcast } from './unifiedStreamBus.js';
import { onCharacterWake } from './dreamService.js';
import {
  MAX_ADVANCE_DAYS,
  addDaysToKey,
  advanceProgramOffsetDays,
  diffDays,
  getProgramDateKey,
  getProgramNow,
  localDateKey,
  parseSqlUtc,
  toRealTime,
  toSqlUtc,
} from './programTime.js';
import { extendEventSchedule, reapplyActiveEventSchedule } from './eventSchedule.js';


// ── 缓存 ──
// key: characterId, value: { activity, expireAt }
const activityCache = new Map();
const groggyShown = new Set();  // 已展示过groggy唤醒提示的角色（key 统一为 Number，每次唤醒周期仅首条消息触发一次）
const CACHE_TTL = 60 * 1000; // 1 分钟

// ── 睡眠块分类（主睡眠 / 小憩）──
//
// 用户口径（2026-09-29）：「白天怎么睡觉上了 这个不对吧」。日程生成 prompt 刻意鼓励
// 「碎片化睡眠→分两段睡」（夜猫子/病人人设），于是会有 15:00~15:45 这种**白天小憩**块。
// 旧实现把**任何** replyDelay=-1 的块都当成"睡觉中"（is_sleeping=1），后果有两个：
//   ① 白天显示"睡觉中"；② 主动聊天/奇遇/朋友圈/催眠触发全被这块挡住（用户：「睡觉怎么就不能直接触发了」）。
// 现在把两件事分开：
//   · **主睡眠**（长睡眠、跨昼夜的补觉、催眠强制入睡）→ `characters.is_sleeping = 1`（全局暂停闸门）
//   · **小憩**（≤90 分钟且整体落在白天窗口内的短睡块）→ 仍然"暂不回复"（replyDelay=-1、
//     写 sleep_until 供聊天排队），但**不占全局闸门**，也不再显示成"睡觉中"
export const SLEEP_KINDS = { MAIN: 'main', NAP: 'nap' };
/** 小憩时长上限（分钟）：超过就算主睡眠（昼伏夜出型一睡 10 小时不会被误判成小憩） */
export const NAP_MAX_MINUTES = 90;
/** 小憩必须整体落在 [07:00, 21:00) 的本地白天窗口内 */
export const NAP_WINDOW_START_MINUTE = 7 * 60;
export const NAP_WINDOW_END_MINUTE = 21 * 60;

// ── 时间工具 ──

function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 日程块的时长（分钟，跨午夜按正向补齐，零长按整天算） */
function blockDurationMinutes(block) {
  if (!block) return 0;
  const start = timeToMinutes(block.startTime);
  const end = timeToMinutes(block.endTime);
  if (end === start) return 24 * 60;
  return end > start ? end - start : end + 24 * 60 - start;
}

/**
 * 判定一个日程块是不是睡眠块、是哪一种（**唯一判定点**，别在调用点复制规则）。
 * @param {object|null} block 日程条目（或 getCurrentActivity 的返回值）
 * @returns {'main'|'nap'|null} null = 不是睡眠块
 */
export function classifySleepBlock(block) {
  if (!block || Number(block.replyDelay) !== -1) return null;
  // 催眠手机「立刻入睡」写进来的强制睡眠块：明确是主睡眠，绝不能被小憩启发式降级
  if (block.forcedSleep === 1 || block.forcedSleep === true) return SLEEP_KINDS.MAIN;

  const duration = blockDurationMinutes(block);
  const sameDay = timeToMinutes(block.endTime) > timeToMinutes(block.startTime);
  const insideDayWindow = sameDay
    && timeToMinutes(block.startTime) >= NAP_WINDOW_START_MINUTE
    && timeToMinutes(block.endTime) <= NAP_WINDOW_END_MINUTE;
  if (duration > 0 && duration <= NAP_MAX_MINUTES && insideDayWindow) return SLEEP_KINDS.NAP;
  return SLEEP_KINDS.MAIN;
}

/** 是否属于「全局睡眠闸门」（主睡眠） */
export function isMainSleepBlock(block) {
  return classifySleepBlock(block) === SLEEP_KINDS.MAIN;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) || typeof parsed === 'string') return normalizeTags(parsed);
    } catch {}
    return trimmed.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 判断当前时间是否在给定的 [startTime, endTime) 区间内
 * 正确处理跨午夜（如 startTime="23:00", endTime="07:00"）
 */
function isInTimeSlot(startTime, endTime, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);

  if (endMin < startMin) {
    // 跨午夜：如 23:00 ~ 07:00
    return nowMin >= startMin || nowMin < endMin;
  }
  // 同日：如 08:00 ~ 12:00
  return nowMin >= startMin && nowMin < endMin;
}

// ── 初始化 ──

/**
 * 启动时调用：从 daily_schedules 恢复睡眠状态
 */
export function initialize() {
  const db = getDb();
  const now = getProgramNow();
  const today = getProgramDateKey(now);

  // 全量清理超过 2 天的旧日程快照（按**程序日期**算，跳天之后不会误删）
  db.prepare(`DELETE FROM daily_schedules WHERE schedule_date < date(?, '-2 days')`).run(today);

  // 检查所有启用日程的角色
  const chars = db.prepare(`
    SELECT id, display_name FROM characters
    WHERE schedule_enabled = 1 OR schedule_enabled IS NULL
  `).all();

  let sleepers = 0;
  for (const char of chars) {
    const block = currentSleepBlock(char.id, now);
    if (block.kind === SLEEP_KINDS.MAIN) {
      // 正在主睡眠时段
      db.prepare('UPDATE characters SET is_sleeping = 1, sleep_until = ? WHERE id = ?')
        .run(block.sleepUntil, char.id);
      sleepers++;
    } else if (block.kind === SLEEP_KINDS.NAP) {
      // 白天小憩：写 sleep_until（聊天排队要用它算醒来时刻）但不占全局睡眠闸门
      db.prepare('UPDATE characters SET is_sleeping = 0, sleep_until = ? WHERE id = ?')
        .run(block.sleepUntil, char.id);
    } else {
      // 确保非睡眠状态（sleep_until 一并清掉，避免残留的旧值被下一条消息当成醒来时刻）
      db.prepare('UPDATE characters SET is_sleeping = 0, sleep_until = NULL WHERE id = ? AND (is_sleeping = 1 OR sleep_until IS NOT NULL)')
        .run(char.id);
    }
  }

  if (sleepers > 0) {
    console.log(`[scheduleMgr] Initialized: ${sleepers} character(s) currently sleeping`);
  }

  // 恢复临时唤醒定时器
  restoreTempWakeTimers();

  // 启动睡眠状态定时同步（时间边界兜底）
  startSleepingStateCron();
}

/**
 * 定时同步所有角色的 is_sleeping / sleep_until。
 *
 * 在入睡/起床高峰期（21:00-02:00 / 06:00-09:00）每 15 分钟跑一次，
 * 其他时段每小时兜底一次。使用自调整 setTimeout 链，不用 setInterval。
 */
function startSleepingStateCron() {
  let running = false;

  async function tick() {
    const db = getDb();
    const chars = db.prepare(
      'SELECT id FROM characters WHERE schedule_enabled = 1 OR schedule_enabled IS NULL'
    ).all();

    for (const char of chars) {
      syncSleepingState(char.id);
    }
  }

  function scheduleNext() {
    const now = getProgramNow();
    const hour = now.getHours();
    const sleepPeak = hour >= 21 || hour < 2;
    const wakePeak = hour >= 6 && hour < 9;
    const intervalMs = (sleepPeak || wakePeak) ? 15 * 60 * 1000 : 60 * 60 * 1000;

    const tag = (sleepPeak || wakePeak)
      ? `peak(${intervalMs / 60000}min)`
      : `off(${intervalMs / 3600000}h)`;
    console.log(`[scheduleMgr] Next sleeping-state sync in ${tag}`);

    setTimeout(async () => {
      if (running) return; // 上一轮还没跑完，跳过
      running = true;
      try {
        await tick();
      } catch (err) {
        console.error('[scheduleMgr] Sleeping-state sync error:', err.message);
      } finally {
        running = false;
        scheduleNext();
      }
    }, intervalMs).unref();
  }

  // 启动时不立即跑（initialize 里已经跑过了），直接排下一轮
  scheduleNext();
}

/**
 * 计算睡眠结束的**真实瞬间**（写成 SQLite 无时区 UTC 串）。
 *
 * 口径（这里以前是最容易踩坑的地方，改动请连同测试一起看）：
 *   · `now` 是**程序时间**（`getProgramNow()`，其本地钟点 = 世界钟点）；
 *   · 日程模板里的 `startTime/endTime` 是**世界墙上时刻**（LLM 按 24 小时制写的）；
 *   · 落库的 `sleep_until` 必须是**真实瞬间**的无时区 UTC 串 —— 它要和
 *     `datetime('now')`（UTC）比、还会被 chat.js 抄进 `reply_queue.scheduled_reply_at`。
 *   于是：先按世界钟点算出"当地 09-29 07:45"，再减掉程序时间偏移得到真实瞬间。
 *   （偏移为 0 时与改动前逐字节一致：`new Date(local 07:45).toISOString()`。）
 */
function calcSleepUntil(endTime, now = getProgramNow()) {
  const endMin = timeToMinutes(endTime);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const result = new Date(now);
  result.setHours(0, 0, 0, 0);
  result.setMinutes(result.getMinutes() + endMin);

  // 如果结束时间在今天之前（即在明天），加一天
  if (endMin <= nowMin) {
    result.setDate(result.getDate() + 1);
  }

  return toSqlUtc(toRealTime(result));
}

/**
 * 当前时段的睡眠块（**唯一睡眠判定点**）：主睡眠 / 小憩 / 不睡。
 * 顺带给出该块结束的真实瞬间（UTC 无时区串），供写库与前端展示。
 * @returns {{kind:'main'|'nap'|null, block:object|null, sleepUntil:string|null, programDateKey:string}}
 */
export function currentSleepBlock(characterId, programNow = getProgramNow()) {
  const activity = getCurrentActivity(characterId, programNow);
  const kind = classifySleepBlock(activity);
  return {
    kind,
    block: kind ? activity : null,
    sleepUntil: kind ? calcSleepUntil(activity.endTime, programNow) : null,
    programDateKey: getProgramDateKey(programNow),
  };
}

// ── 日程获取 ──

/**
 * 获取角色今日日程的原始 JSON（优先 daily_schedules，fallback template）
 * 「今日」= **程序日期**（跳天之后取到的是那一天的快照）
 */
function getTodayScheduleRaw(characterId, programNow = getProgramNow()) {
  const db = getDb();
  const today = getProgramDateKey(programNow);

  // 优先查 daily_schedules
  let row = db.prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(characterId, today);

  if (!row) {
    // fallback: 从 template 快照一条
    const template = db.prepare(
      'SELECT schedule_json FROM schedule_templates WHERE character_id = ?'
    ).get(characterId);

    if (template) {
      db.prepare(`
        INSERT OR REPLACE INTO daily_schedules (character_id, schedule_date, schedule_json)
        VALUES (?, ?, ?)
      `).run(characterId, today, template.schedule_json);
      reapplyActiveEventSchedule(characterId, db);
      // 清理超过 2 天的旧快照
      db.prepare(
        `DELETE FROM daily_schedules WHERE character_id = ? AND schedule_date < date(?, '-2 days')`
      ).run(characterId, today);
      row = db.prepare('SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?')
        .get(characterId, today);
    }
  }

  if (!row) return null;

  try {
    return JSON.parse(row.schedule_json);
  } catch {
    return null;
  }
}

/**
 * 获取角色今日完整日程（公开 API）
 */
export function getTodaySchedule(characterId, programNow = getProgramNow()) {
  const schedule = getTodayScheduleRaw(characterId, programNow);
  if (!schedule) return null;

  const enriched = schedule.map(act => ({
    ...act,
    tags: normalizeTags(act.tags),
    isCurrent: isInTimeSlot(act.startTime, act.endTime, programNow),
    sleepKind: classifySleepBlock(act),
  }));

  return enriched;
}

// ── 当前活动查询 ──

/**
 * 缓存键 = 角色 + **程序分钟**。
 *
 * 旧实现只按角色缓存（TTL 60s），于是"同一个角色、不同时刻"的查询会互相串味：
 * 注入时间/跳天/回放历史时拿到的是上一个时刻的活动（真机也踩过：睡块刚结束的一分钟里
 * 读到的仍是"睡觉"）。按分钟分桶等价于原来的 60s TTL，但**同一分钟内的多次调用仍然复用**。
 */
function activityCacheKey(characterId, now) {
  return `${Number(characterId)}|${Math.floor(now.getTime() / 60000)}`;
}

/**
 * 获取角色当前活动（带缓存）
 * @returns {object|null} { activity, location, replyDelay, snapshotPrompt, description, startTime, endTime, forcedSleep }
 */
export function getCurrentActivity(characterId, now = getProgramNow()) {
  const key = activityCacheKey(characterId, now);
  // 检查缓存
  const cached = activityCache.get(key);
  if (cached && cached.expireAt > Date.now()) {
    return cached.activity;
  }

  const schedule = getTodayScheduleRaw(characterId, now);
  if (!schedule) {
    // 无日程模板 → 缓存 null（短 TTL，因为可能正在生成中）
    activityCache.set(key, { activity: null, expireAt: Date.now() + 10000 });
    return null;
  }

  for (const act of schedule) {
    if (isInTimeSlot(act.startTime, act.endTime, now)) {
      const result = {
        activity: act.activity,
        location: act.location,
        replyDelay: act.replyDelay,
        snapshotPrompt: act.snapshotPrompt || '',
        description: act.description || '',
        startTime: act.startTime,
        endTime: act.endTime,
        // 催眠手机「立刻入睡」打的主睡眠标记（classifySleepBlock 依赖它，别在投影里丢掉）
        forcedSleep: act.forcedSleep === 1 || act.forcedSleep === true ? 1 : 0,
        tags: normalizeTags(act.tags),
      };
      activityCache.set(key, { activity: result, expireAt: Date.now() + CACHE_TTL });
      return result;
    }
  }

  // 当前时间不在任何活动中 → 空闲状态
  const idleResult = {
    activity: '自由时间',
    location: '未知',
    replyDelay: 0,
    snapshotPrompt: '',
    description: '没有特定安排，自由支配时间',
    startTime: '',
    endTime: '',
    forcedSleep: 0,
    tags: ['idle'],
  };
  activityCache.set(key, { activity: idleResult, expireAt: Date.now() + CACHE_TTL });
  return idleResult;
}

// ── Prompt 注入 ──

/**
 * 为 chat.js / momentScheduler / eventGenerator 生成日程上下文
 * @returns {string|null} 适合拼入 system prompt 的文字
 */
export function formatScheduleContext(characterId, now = getProgramNow(), { consumeGroggy = true } = {}) {
  characterId = Number(characterId);
  // 临时唤醒期间 → 覆盖睡眠提示。
  // ⚠️ 这里**不能**把 `now`（程序时间）传给 isTempWoken：临时唤醒是真实时间的交互窗口
  // （`temporary_wake_until` 存真实瞬间）。程序钟被拨到未来时，`until > 程序now` 恒为假，
  // 于是"刚被临时唤醒"会被当成"仍在睡觉"，prompt 里的「你正在睡觉。不要回复任何消息」
  // 又回来了 —— 正是催眠指令触发前那次临时唤醒要消掉的东西。与写入口径（tempWake）保持一致。
  if (isTempWoken(characterId)) {
    // 非聊天调用方（如 mailboxScheduler）不消费一次性标记，避免偷走聊天首条的 groggy 提示
    if (!consumeGroggy) return null;
    if (groggyShown.has(characterId)) return null;
    groggyShown.add(characterId);
    const db = getDb();
    const char = db.prepare('SELECT wake_mode, wake_attempts FROM characters WHERE id = ?').get(characterId);
    const mode = char?.wake_mode || 'unknown';
    const attempts = char?.wake_attempts || 1;
    const wakeMsgs = {
      phone:   `被${config.user.nickname || '用户'}打来的${attempts}个电话吵醒`,
      door:    `被${config.user.nickname || '用户'}上门从床上摇醒`,
      shake:   `被${config.user.nickname || '用户'}又跑到床边晃醒`,
      // 催眠手机下发指令前的"临时唤醒"：身体被唤醒、意志归对方管 —— 与 <hypnosis_state> 口径一致，
      // 不能写成"迷迷糊糊"（那会和"完全控制"的高潮指令打架）
      hypnosis: `被${config.user.nickname || '用户'}的催眠指令从睡眠中拉了出来`,
    };
    const wakeDesc = wakeMsgs[mode] || `被${config.user.nickname || '用户'}叫醒`;
    if (mode === 'hypnosis') {
      return `【当前状态】${wakeDesc}——身体已经醒了，意识却被对方牢牢压着。`;
    }
    return `【当前状态】${wakeDesc}，脑袋还迷迷糊糊的。`;
  }

  const activity = getCurrentActivity(characterId, now);
  if (!activity) return null;

  const lines = [`【当前状态】你正在【${activity.location}】${activity.activity}。`];

  if (activity.description && activity.description.trim()) {
    lines.push(activity.description.trim());
  }

  const sleepKind = classifySleepBlock(activity);
  if (sleepKind === SLEEP_KINDS.MAIN) {
    lines.push('你正在睡觉。不要回复任何消息，直到自然醒来。');
  } else if (sleepKind === SLEEP_KINDS.NAP) {
    // 小憩：仍然"暂不回复"（消息会排队到她醒），但不是整段睡眠，措辞不能再写"你正在睡觉"
    lines.push('你正在小憩（打盹），没有睡熟；此刻不会立刻回复消息，迷糊着醒过来之后再看。');
  } else if (activity.replyDelay > 0) {
    lines.push(`当前活动需要一定专注度，约 ${activity.replyDelay} 分钟后才能腾出手来回复消息。回复时自然提及刚才在${activity.location}的处境。`);
  } else {
    lines.push('你的言行举止应与当前场景自然衔接。');
  }

  return lines.join(' ');
}

// ── 回复延迟 ──

/**
 * 获取角色当前的回复延迟信息
 * @returns {{ delay: number, activity: string, location: string, sleepKind: 'main'|'nap'|null }}
 *   delay: 0=秒回, >0=延迟分钟, -1=暂停(睡觉/小憩)
 */
export function getReplyDelay(characterId, now = getProgramNow()) {
  // 临时唤醒期间：秒回（覆盖日程中的睡眠状态）。
  // 同上：临时唤醒按**真实时间**判定（`now` 是程序时间，不能拿来比 —— 程序钟一被拨快就会
  // 把"刚被叫醒的人"重新塞回"睡觉排队"，真机表现就是"叫醒了还是不理我、消息一直排到醒来"）。
  const tempWoken = isTempWoken(characterId);
  if (tempWoken) {
    return { delay: 0, activity: '被叫醒了', location: '', sleepKind: null };
  }

  const activity = getCurrentActivity(characterId, now);
  if (!activity) return { delay: 0, activity: '未知', location: '', sleepKind: null };

  const sleepKind = classifySleepBlock(activity);

  // 日程显示睡眠 but DB 中 is_sleeping=0 → 区分两种情况：
  //   a. 曾被叫醒（temporary_wake_until 有值，可能是过期残留）→ 视为清醒，秒回
  //   b. 睡眠时段刚开始、cron 尚未同步 → 立即同步并按睡眠拦截
  if (sleepKind) {
    const db = getDb();
    const char = db.prepare('SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?').get(characterId);
    // 主睡眠时 is_sleeping 必须是 1；小憩只写 sleep_until、不占闸门 → 两种都要跑同步
    const needsSync = sleepKind === SLEEP_KINDS.NAP
      ? char && (char.is_sleeping === 1)
      : char && char.is_sleeping === 0;
    if (needsSync) {
      if (char.temporary_wake_until) {
        return { delay: 0, activity: '被叫醒了', location: '', sleepKind: null };
      }
      syncSleepingState(characterId, now);
      return { delay: -1, activity: activity.activity, location: activity.location, sleepKind };
    }
  } else {
    // 反向纠正（真机踩到过）：睡块 10:30 结束，整点 cron 到 11:xx 才清 →
    // 白天整整一小时被标成"睡觉中"，主动聊天/奇遇/催眠触发全被拦。
    // 这里在**读路径**当场纠正，不再把正确性押在 cron 的钟点上。
    const db = getDb();
    const char = db.prepare('SELECT is_sleeping FROM characters WHERE id = ?').get(characterId);
    if (char && char.is_sleeping === 1) syncSleepingState(characterId, now);
  }

  return {
    delay: activity.replyDelay,
    activity: activity.activity,
    location: activity.location,
    sleepKind,
  };
}

// ── 临时唤醒状态管理 ──

const tempWakeTimers = new Map(); // characterId → setTimeout

/**
 * 检查角色是否处于临时唤醒期
 *
 * ⚠️ 口径：临时唤醒是**真实时间**的交互窗口（5~15 分钟），不是世界时间 ——
 * `temporary_wake_until` 存的是真实瞬间的无时区 UTC 串，所以 `now` 必须是**真实时间**
 * （默认 `new Date()`）。手上有程序时间时不要直接传进来（偏移不为 0 会误判）。
 */
export function isTempWoken(characterId, now = new Date()) {
  const db = getDb();
  const char = db.prepare('SELECT temporary_wake_until, is_sleeping FROM characters WHERE id = ?').get(characterId);
  if (!char || !char.temporary_wake_until) return false;
  const until = parseSqlUtc(char.temporary_wake_until);
  return until !== null && until > now;
}

/**
 * 获取临时唤醒到期时间，未唤醒返回 null
 */
export function getTempWakeUntil(characterId) {
  const db = getDb();
  const char = db.prepare('SELECT temporary_wake_until FROM characters WHERE id = ?').get(characterId);
  if (!char || !char.temporary_wake_until) return null;
  return char.temporary_wake_until;
}

/**
 * 设置临时唤醒定时器
 */
export function scheduleTempWakeExpiry(characterId, tempWakeUntil) {
  characterId = Number(characterId);
  clearTempWakeTimer(characterId);

  const until = parseSqlUtc(tempWakeUntil);
  if (!until) {
    tempWakeTimers.delete(characterId);
    return;
  }
  const delayMs = until.getTime() - Date.now();
  if (delayMs <= 0) {
    revertTempWake(characterId);
    return;
  }

  const timer = setTimeout(() => {
    revertTempWake(characterId);
    tempWakeTimers.delete(characterId);
  }, delayMs);
  timer.unref?.();
  tempWakeTimers.set(characterId, timer);
  console.log(`[scheduleMgr] Temp wake expiry scheduled in ${Math.round(delayMs / 60000)}min for ${characterId}`);
}

/**
 * 延长临时唤醒计时器 — 每次用户互动时重置倒计时为 5~15 分钟
 * 角色在聊天中保持活跃时不会被强制入睡，仅在无互动到期后才回退睡眠
 */
export function extendTempWake(characterId) {
  characterId = Number(characterId);
  if (!isTempWoken(characterId)) return false;

  const db = getDb();
  const minutes = 5 + Math.floor(Math.random() * 11);
  const newUntil = toSqlUtc(new Date(Date.now() + minutes * 60000));

  db.prepare('UPDATE characters SET temporary_wake_until = ? WHERE id = ?')
    .run(newUntil, characterId);

  console.log(`[scheduleMgr] Temp wake extended for ${characterId}, new expiry in ${minutes}min`);
  scheduleTempWakeExpiry(characterId, newUntil);

  // 通知前端临时唤醒时间已续期，避免过期显示
  const char = db.prepare('SELECT sleep_until, wake_mode FROM characters WHERE id = ?').get(characterId);
  broadcast('schedule_state_change', {
    character_id: characterId,
    is_sleeping: false,
    sleep_until: char?.sleep_until || null,
    temporary_wake_until: newUntil,
    wake_mode: char?.wake_mode || null,
  });
  return true;
}

/**
 * 重置 groggy 一次性提示标记
 * 每次叫醒成功时由 wake 端点调用，保证"每次被唤醒都注入一次"的语义，
 * 不依赖上一轮 revertTempWake 是否正常执行
 */
export function resetGroggyShown(characterId) {
  groggyShown.delete(Number(characterId));
}

function clearTempWakeTimer(characterId) {
  characterId = Number(characterId);
  const existing = tempWakeTimers.get(characterId);
  if (existing) { clearTimeout(existing); tempWakeTimers.delete(characterId); }
}

/**
 * 立刻进入「临时唤醒」状态（真实时间 5~15 分钟窗口）。
 *
 * 这是全仓「把她从睡眠里拉起来」的**唯一写入口**（电话叫醒 / 上门摇醒 / 催眠指令触发前都用它），
 * 走既有链路，所以内存定时器与库状态永远一致：
 *   原子写库（`is_sleeping=0` + `temporary_wake_until` + `wake_mode`）→ `scheduleTempWakeExpiry`
 *   注册到期定时器（覆盖旧定时器）→ `resetGroggyShown` → 广播 `schedule_state_change`。
 * 到期由 `revertTempWake` 按**日程**决定回睡还是保持清醒 —— 催眠手机不需要自己维护"睡到几点"。
 *
 * @param {number} characterId
 * @param {{minutes?:number, mode?:'phone'|'door'|'shake'|'hypnosis', force?:boolean}} [options]
 *   `force`（默认 true）：已处于临时唤醒中时也重设到期时间。催眠触发前必须 force，
 *   否则"刚好剩 3 秒到期"会把这一轮立刻打回睡眠。
 * @returns {{ok:boolean, temporaryWakeUntil:string|null, minutes:number, reason?:string}}
 */
export function tempWake(characterId, { minutes, mode = 'phone', force = true } = {}) {
  characterId = Number(characterId);
  const db = getDb();
  const char = db.prepare('SELECT id, temporary_wake_until FROM characters WHERE id = ?').get(characterId);
  if (!char) return { ok: false, temporaryWakeUntil: null, minutes: 0, reason: 'not_found' };

  if (!force && isTempWoken(characterId)) {
    return { ok: false, temporaryWakeUntil: char.temporary_wake_until, minutes: 0, reason: 'already_awake' };
  }

  const wanted = Number.isFinite(Number(minutes)) && Number(minutes) > 0
    ? Math.min(24 * 60, Math.round(Number(minutes)))
    : 5 + Math.floor(Math.random() * 11);
  const tempWakeUntil = toSqlUtc(new Date(Date.now() + wanted * 60000));

  db.prepare(
    `UPDATE characters SET is_sleeping = 0, temporary_wake_until = ?, wake_mode = ? WHERE id = ?`
  ).run(tempWakeUntil, String(mode || 'phone'), characterId);

  scheduleTempWakeExpiry(characterId, tempWakeUntil);
  resetGroggyShown(characterId);

  const after = db.prepare('SELECT sleep_until FROM characters WHERE id = ?').get(characterId);
  broadcast('schedule_state_change', {
    character_id: characterId,
    is_sleeping: false,
    sleep_until: after?.sleep_until || null,
    temporary_wake_until: tempWakeUntil,
    wake_mode: String(mode || 'phone'),
  });

  console.log(`[scheduleMgr] Temp wake (${mode}) for ${characterId} until ${tempWakeUntil} (${wanted}min)`);
  return { ok: true, temporaryWakeUntil: tempWakeUntil, minutes: wanted };
}

/**
 * 立刻取消临时唤醒（清库 + 清定时器），**不**改变日程派生的睡眠结论 ——
 * 之后由 `syncSleepingState` 按日程定她该睡该醒。催眠手机「立刻唤醒」走这一条。
 */
export function clearTempWake(characterId) {
  characterId = Number(characterId);
  clearTempWakeTimer(characterId);
  groggyShown.delete(characterId);
  getDb().prepare(
    `UPDATE characters SET temporary_wake_until = NULL, wake_mode = NULL WHERE id = ?`
  ).run(characterId);
}

/**
 * 临时唤醒到期 → 回退到睡眠或正常清醒（按**程序时间**的日程判定）
 */
function revertTempWake(characterId) {
  groggyShown.delete(Number(characterId));
  const db = getDb();
  const char = db.prepare('SELECT id, sleep_until FROM characters WHERE id = ?').get(characterId);
  if (!char) return;

  const now = getProgramNow();
  const block = currentSleepBlock(characterId, now);

  // 仍在睡眠/小憩时间块内 → 回退到睡眠状态
  if (block.kind) {
    const sleepUntil = block.sleepUntil;
    db.prepare(`UPDATE characters SET is_sleeping = ?, sleep_until = ?, temporary_wake_until = NULL, wake_mode = NULL, wake_attempts = 0 WHERE id = ?`)
      .run(block.kind === SLEEP_KINDS.MAIN ? 1 : 0, sleepUntil, characterId);
    console.log(`[scheduleMgr] Temp wake expired for ${characterId}, back to ${block.kind} until ${sleepUntil}`);

    broadcast('schedule_state_change', {
      character_id: characterId,
      is_sleeping: block.kind === SLEEP_KINDS.MAIN,
      sleep_until: sleepUntil,
      temporary_wake_until: null,
      wake_mode: null,
    });
    return;
  }

  // 睡眠时间块已结束 → 直接转入正常清醒
  db.prepare(`UPDATE characters SET is_sleeping = 0, sleep_until = NULL, temporary_wake_until = NULL, wake_mode = NULL, wake_attempts = 0, was_door_woken = 0 WHERE id = ?`)
    .run(characterId);
  console.log(`[scheduleMgr] Temp wake expired for ${characterId}, sleep block ended → staying awake`);

  broadcast('schedule_state_change', {
    character_id: characterId,
    is_sleeping: false,
    sleep_until: null,
    temporary_wake_until: null,
    wake_mode: null,
  });
}

/**
 * 服务重启时恢复临时唤醒定时器（时间口径 = 真实时间）
 */
function restoreTempWakeTimers() {
  const db = getDb();
  const now = new Date();
  const chars = db.prepare(`SELECT id, temporary_wake_until FROM characters WHERE temporary_wake_until IS NOT NULL`).all();
  for (const char of chars) {
    const until = parseSqlUtc(char.temporary_wake_until);
    if (!until || until <= now) {
      revertTempWake(char.id);
    } else {
      scheduleTempWakeExpiry(char.id, char.temporary_wake_until);
    }
  }
  if (chars.length > 0) {
    console.log(`[scheduleMgr] Restored ${chars.length} temp wake timer(s)`);
  }
}

// ── 睡眠状态 ──

/**
 * 检查角色是否正在睡觉（**含小憩**）。
 *
 * 两个概念的边界（别再合并）：
 *   · `isSleeping()`     —— "她现在是睡/打盹中吗"：叫醒端点、朋友互动、朋友圈发帖用它（小憩也要别打扰）
 *   · `characters.is_sleeping` —— "全局睡眠闸门"（主动聊天/奇遇/朋友圈排期按 SQL 直读它）：只有主睡眠才置位
 * 读路径会**双向纠正**库里的旧值（睡块结束的当天白天必须当场醒，不能等整点 cron）。
 *
 * @returns {{sleeping:boolean, sleepUntil:string|null, kind:'main'|'nap'|null}}
 */
export function isSleeping(characterId, now = getProgramNow()) {
  // 临时唤醒期间 → 不视为睡眠
  if (isTempWoken(characterId)) {
    return { sleeping: false, sleepUntil: null, kind: null };
  }

  const db = getDb();
  const char = db.prepare('SELECT is_sleeping, sleep_until FROM characters WHERE id = ?').get(characterId);
  const block = currentSleepBlock(characterId, now);

  if (block.kind) {
    // DB 缓存与日程不一致（例如睡块刚开始、或主睡眠残留成小憩）→ 顺手同步
    const stale = block.kind === SLEEP_KINDS.MAIN ? char && char.is_sleeping !== 1 : char && char.is_sleeping === 1;
    if (stale) syncSleepingState(characterId, now);
    return { sleeping: true, sleepUntil: block.sleepUntil, kind: block.kind };
  }

  // 清醒：把残留的睡眠标志当场纠正（真机踩到过：睡块 10:30 结束，整点 cron 到 11:xx 才清
  // → 白天整整一小时"睡觉中"，主动聊天/奇遇/催眠触发全被拦）
  if (char && char.is_sleeping === 1) syncSleepingState(characterId, now);
  return { sleeping: false, sleepUntil: null, kind: null };
}

// ── 睡眠状态同步 ──

/**
 * 根据当前日程同步角色的 is_sleeping / sleep_until 到 characters 表
 * 应在日程生成/刷新后调用，确保其他 SQL 直读 is_sleeping 的模块拿到正确状态。
 *
 * **两个方向都会纠正**（不只是"到点睡下"）：
 *   · 日程说主睡眠 → `is_sleeping = 1`（全局闸门）
 *   · 日程说小憩   → `is_sleeping = 0` + 写 `sleep_until`（聊天仍排队到醒来，但不占闸门）
 *   · 日程说清醒   → 清 `is_sleeping` / `sleep_until`（睡块已结束的**当天白天**必须当场纠正）
 */
export function syncSleepingState(characterId, now = getProgramNow()) {
  const db = getDb();

  // 临时唤醒期间 → 跳过同步，保持 is_sleeping = 0，不覆盖 sleep_until
  if (isTempWoken(characterId)) return;

  const block = currentSleepBlock(characterId, now);
  const prev = db.prepare('SELECT is_sleeping, sleep_until FROM characters WHERE id = ?').get(characterId);
  const wasSleeping = !!(prev && prev.is_sleeping === 1);

  if (block.kind === SLEEP_KINDS.MAIN) {
    const sleepUntil = block.sleepUntil;
    db.prepare('UPDATE characters SET is_sleeping = 1, sleep_until = ? WHERE id = ?')
      .run(sleepUntil, characterId);

    // 新睡眠周期 → 重置所有叫醒相关列
    if (!wasSleeping) {
      db.prepare(`UPDATE characters SET wake_attempts = 0, was_door_woken = 0, temporary_wake_until = NULL, wake_mode = NULL WHERE id = ?`)
        .run(characterId);

      broadcast('schedule_state_change', {
        character_id: characterId,
        is_sleeping: true,
        sleep_until: sleepUntil,
        temporary_wake_until: null,
        wake_mode: null,
      });
    }
    return;
  }

  if (block.kind === SLEEP_KINDS.NAP) {
    // 小憩：不占全局闸门，但 sleep_until 要如实写（chat.js 睡觉路径拿它当"醒来时刻"）
    db.prepare('UPDATE characters SET is_sleeping = 0, sleep_until = ? WHERE id = ?')
      .run(block.sleepUntil, characterId);
    if (wasSleeping) {
      db.prepare(`UPDATE characters SET wake_attempts = 0, was_door_woken = 0, temporary_wake_until = NULL, wake_mode = NULL WHERE id = ?`)
        .run(characterId);
      broadcast('schedule_state_change', {
        character_id: characterId,
        is_sleeping: false,
        sleep_until: block.sleepUntil,
        temporary_wake_until: null,
        wake_mode: null,
      });
    }
    return;
  }

  // 清醒：清 sleep 状态，不清叫醒列（让自然醒后重置）
  db.prepare('UPDATE characters SET is_sleeping = 0, sleep_until = NULL WHERE id = ? AND is_sleeping = 1')
    .run(characterId);
  // 自然醒来 → 重置所有叫醒列
  if (wasSleeping) {
    db.prepare(`UPDATE characters SET wake_attempts = 0, was_door_woken = 0, temporary_wake_until = NULL, wake_mode = NULL WHERE id = ?`)
      .run(characterId);

    broadcast('schedule_state_change', {
      character_id: characterId,
      is_sleeping: false,
      sleep_until: null,
      temporary_wake_until: null,
      wake_mode: null,
    });

    // 梦境系统：自然醒 → 清理剩余梦话定时器 + 醒后加速主动推送
    try {
      onCharacterWake(characterId);
    } catch (err) {
      console.warn(`[scheduleMgr] onCharacterWake failed for ${characterId}:`, err.message);
    }
  }
}

/**
 * 统一的睡眠状态视图（催眠手机「睡眠控制」的冻结返回形状）。
 *
 * ⚠️ `isSleeping` 取的是**全局睡眠闸门**含义（主睡眠 / 临时唤醒都已算进去），
 * 与 `characters.is_sleeping` 一致；小憩不算睡觉中（见 SLEEP_KINDS 的注释）。
 * `sleepUntil` / `temporaryWakeUntil` 原样回库里的无时区 UTC 串（真实瞬间）。
 */
export function getSleepStatus(characterId) {
  const id = Number(characterId);
  const db = getDb();
  const char = db.prepare('SELECT is_sleeping, sleep_until, temporary_wake_until FROM characters WHERE id = ?').get(id);
  if (!char) return { characterId: id, isSleeping: false, sleepUntil: null, temporaryWakeUntil: null };
  const tempWoken = isTempWoken(id);
  return {
    characterId: id,
    isSleeping: !tempWoken && char.is_sleeping === 1,
    sleepUntil: char.sleep_until || null,
    temporaryWakeUntil: char.temporary_wake_until || null,
  };
}

/**
 * 重算**所有**角色的日程快照 + 睡眠状态（推进程序时间后调用）。
 * @param {Date} [programNow]
 * @param {{dayKeys?: string[]}} [options] 需要确保快照存在的程序日期（逐天推进时传入）
 */
export function refreshAllSleepStates(programNow = getProgramNow(), { dayKeys = [] } = {}) {
  const db = getDb();
  const chars = db.prepare(
    'SELECT id, display_name FROM characters WHERE schedule_enabled = 1 OR schedule_enabled IS NULL'
  ).all();

  invalidateAllCache();
  const result = [];
  for (const key of dayKeys) {
    for (const char of chars) ensureScheduleRowForDay(char.id, key);
  }
  for (const char of chars) {
    syncSleepingState(char.id, programNow);
    const status = getSleepStatus(char.id);
    result.push({ id: char.id, displayName: char.display_name, ...status });
  }
  return result;
}

/**
 * 推进程序时间 N 天（逐天），并让**所有角色**跟上：
 *
 *   1. 先把钟拨过去（`programTime.advanceProgramOffsetDays`，一次性加 N×24h）；
 *   2. **逐天**给每个角色补当日日程快照（`daily_schedules` 是"某天"的实例，
 *      跳步会让"今天是第几天/今天的日程"错位）；每一天还顺带清掉那天之前过期的临时唤醒残留；
 *   3. 最后一天做重推进：清所有缓存 → 每个角色 `syncSleepingState`（按新日程定睡眠/小憩，
 *      本该醒着的当场醒，并触发梦境系统的 onCharacterWake）→ 广播。
 *
 * 说明（别以为是偷懒）：中间那些天**没有可观测状态**（每天的日程都从同一份模板派生，
 * 而模板刷新有 LLM 成本、仍按真实时间由 replyQueueScheduler 每次一个地做），
 * 所以逐天循环只做"日期快照 + 过期清理"，真正影响角色的是最后一天。
 *
 * @param {number} days 1..3650
 * @param {{programNow?:Date}} [options]
 * @returns {{days:number, skippedTempWakes:number[], characters:Array}}
 */
export function advanceProgramDays(days, { programNow } = {}) {
  const requested = Math.trunc(Number(days) || 0);
  const clamped = Math.max(1, Math.min(MAX_ADVANCE_DAYS, Number.isFinite(requested) ? requested : 1));
  const before = getProgramDateKey(getProgramNow());

  advanceProgramOffsetDays(clamped);
  const now = programNow || getProgramNow();

  // 逐天：补每一天的日期快照（idempotent，存在即跳过内容不动）
  const dayKeys = [];
  for (let i = 1; i <= clamped; i++) {
    const key = addDaysToKey(before, i);
    if (!key) break;
    dayKeys.push(key);
  }

  invalidateAllCache();

  // 跳天之后"5~15 分钟互动窗口"不可能还有效 → 一律收掉（连带清定时器，防止它稍后把人按回睡眠）
  const db = getDb();
  const skippedTempWakes = [];
  const tempWokenChars = db.prepare(
    'SELECT id, temporary_wake_until FROM characters WHERE temporary_wake_until IS NOT NULL'
  ).all();
  for (const char of tempWokenChars) {
    const until = parseSqlUtc(char.temporary_wake_until);
    if (!until || until <= now || diffDays(localDateKey(until), getProgramDateKey(now)) !== 0) {
      clearTempWake(char.id);
      skippedTempWakes.push(char.id);
    }
  }

  const characters = refreshAllSleepStates(now, { dayKeys });

  console.log(`[scheduleMgr] Program time advanced ${clamped} day(s) → ${getProgramDateKey(now)}; ${characters.length} character(s) resynced`);
  return { days: clamped, skippedTempWakes, characters };
}

/** 确保某个角色在指定程序日期有一份日程快照（从模板派生；已有则不动） */
export function ensureScheduleRowForDay(characterId, dayKey) {
  if (!dayKey) return null;
  const db = getDb();
  const existing = db.prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(characterId, dayKey);
  if (existing) return existing.schedule_json;
  const template = db.prepare('SELECT schedule_json FROM schedule_templates WHERE character_id = ?').get(characterId);
  if (!template) return null;
  db.prepare(`
    INSERT OR REPLACE INTO daily_schedules (character_id, schedule_date, schedule_json)
    VALUES (?, ?, ?)
  `).run(characterId, dayKey, template.schedule_json);
  return template.schedule_json;
}

// ── 全局概览 ──

/**
 * 获取所有启用日程的角色的当前活动概览（供前端 ScheduleView 使用）
 * @param {Date} [programNow] 程序时间（默认取当前程序时间；注入用于测试与回放）
 */
export function getAllOverview(programNow = getProgramNow()) {
  const db = getDb();
  const now = programNow;

  const chars = db.prepare(`
    SELECT id, display_name, avatar_path, is_sleeping, sleep_until, wake_attempts, was_door_woken, temporary_wake_until, wake_mode, pinned
    FROM characters
    ORDER BY display_name ASC
  `).all();

  return chars.map(char => {
    const activity = getCurrentActivity(char.id, now);
    // 动态计算睡眠状态（不依赖 characters 表中的缓存值，日程更新后该缓存可能过期）
    const kind = classifySleepBlock(activity);
    const isMainSleep = kind === SLEEP_KINDS.MAIN;
    const sleepUntil = kind ? calcSleepUntil(activity.endTime, now) : null;
    const tempWoken = isTempWoken(char.id);
    return {
      id: char.id,
      display_name: char.display_name,
      avatar_path: char.avatar_path,
      current_activity: activity ? `${activity.activity} · ${activity.location}` : '未设置日程',
      reply_delay: activity ? activity.replyDelay : 0,
      // is_sleeping 只表示「主睡眠」：白天小憩不再显示成"睡觉中"（sleep_kind='nap' 供前端标注「小憩」）
      is_sleeping: isMainSleep && !tempWoken,
      sleep_kind: kind,
      sleep_until: sleepUntil,
      _desc: activity?.description || '',
      tags: normalizeTags(activity?.tags),
      wake_attempts: char.wake_attempts,
      was_door_woken: char.was_door_woken,
      temporary_wake_until: char.temporary_wake_until,
      wake_mode: char.wake_mode,
      is_temp_woken: tempWoken,
      pinned: char.pinned ? 1 : 0,
    };
  });
}

/**
 * 确保某个角色今日有日程快照（「今日」= 程序日期）
 */
export function ensureTodaySchedule(characterId) {
  const existing = getTodayScheduleRaw(characterId);
  if (!existing) {
    return snapshotTodaySchedule(characterId);
  }
  return existing;
}

/**
 * 清除指定角色的活动缓存（日程更新后调用）
 * 缓存键是「角色|程序分钟」，所以要按前缀清掉该角色的所有分钟桶
 */
export function invalidateCache(characterId) {
  const prefix = `${Number(characterId)}|`;
  for (const key of [...activityCache.keys()]) {
    if (key.startsWith(prefix)) activityCache.delete(key);
  }
}

/** 奇遇时间优先于日程；修改快照后立即同步私聊缓存、睡眠状态及日程通知。 */
export function syncEventSchedule(event) {
  const changes = extendEventSchedule(event);
  if (!changes.length) return;
  invalidateCache(event.character_id);
  syncSleepingState(event.character_id);
  const name = getDb().prepare('SELECT display_name FROM characters WHERE id = ?').get(event.character_id)?.display_name || '';
  // 与 extendEventSchedule 返回的 changes[].date 同源（都是程序日期键），
  // 别改成 utils/localDate.js 的 getLocalDateKey —— 跳天后两者会差好几天，匹配必然落空。
  const today = getProgramDateKey();
  const change = changes.find(item => item.date === today) || changes[0];
  broadcast('schedule_changed', {
    character_id: event.character_id,
    display_name: name,
    activity: change.activity.activity,
    start_time: change.activity.startTime,
    end_time: change.activity.endTime,
    target_date: change.date,
    source: 'event',
  });
}

/**
 * 清除所有缓存
 */
export function invalidateAllCache() {
  activityCache.clear();
}
