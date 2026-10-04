/**
 * 任务 A：「白天被标成睡觉中」——时间基准 + 主睡眠/小憩的判定回归
 *
 * 真机证据（用户日志，本地 15:21 / 日志时间戳是 UTC 07:21）：
 *   [scheduleMgr] Initialized: 1 character(s) currently sleeping
 *   [scheduleMgr] Temp wake expired for 36, back to sleep until 2026-09-29 07:45:00
 *   ⚡ force: 纳西妲 not eligible (is_sleeping=1)
 *
 * 查证结论（临时库 + 真库副本 + 固定时区复现，见交付报告）：
 *   · `07:45:00` 是**无时区 UTC 串**（= 本地 15:45），不是"本地 07:45"；那条日志来自角色的
 *     **白天小憩块**（15:00~15:45「午后小憩——碎片补眠」，日程生成 prompt 明确鼓励"碎片化睡眠"）。
 *   · 真正的缺陷有两个：
 *       ① 任何 `replyDelay=-1` 的块都写 `characters.is_sleeping = 1`（含白天小憩），
 *          于是白天显示"睡觉中"，主动聊天/奇遇/朋友圈/催眠触发全被这块挡住；
 *       ② 只在整点 cron 里纠正，**读路径不纠正"该醒了"的方向** —— 睡块一结束（例：10:30）
 *          到下一次 cron（最多 1 小时后）之间，白天会一直挂着 `is_sleeping=1`。
 *
 * 本文件锁三件事（任务书要求的三条测试）：
 *   ① 本地白天 + 日程只有夜间睡眠 → `is_sleeping` 必须为 0（含"残留标志"的读路径纠正）；
 *   ② 跨日 / 跨时区边界各一条（由瞬间算，不由字符串拼）；
 *   ③ 既定行为不能坏：真在睡眠时段内 → 睡着。
 * 外加白天小憩与"催眠强制睡眠"的判定口径（推翻①的启发式不能被误用）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const mgr = await import('../src/services/scheduleManager.js');
const { parseSqlUtc, localDateKey } = await import('../src/services/programTime.js');

after(() => closeDb());

// ── 夹具 ──

/** 只有夜间睡眠的日程（22:00~07:45），白天全是普通活动 */
const NIGHT_ONLY = [
  { startTime: '07:45', endTime: '12:00', activity: '上午工作', location: '事务所', replyDelay: 0, tags: ['工作'], description: '伏案工作。' },
  { startTime: '12:00', endTime: '18:00', activity: '下午外出', location: '街区', replyDelay: 0, tags: ['外出'], description: '外出办事。' },
  { startTime: '18:00', endTime: '22:00', activity: '晚间休闲', location: '公寓', replyDelay: 0, tags: ['休闲'], description: '在家休息。' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '公寓卧室', replyDelay: -1, tags: ['睡眠'], description: '沉入睡眠。' },
];

/** 真机同款：夜间主睡眠 03:00~10:30 + 白天 15:00~15:45 的碎片补眠 */
const NIGHT_PLUS_NAP = [
  { startTime: '00:00', endTime: '03:00', activity: '深夜抄录', location: '塔', replyDelay: 0, tags: [], description: '誊抄残页。' },
  { startTime: '03:00', endTime: '10:30', activity: '沉眠——梦境花园深处', location: '吊床', replyDelay: -1, tags: ['睡眠'], description: '缩成一团睡去。' },
  { startTime: '10:30', endTime: '15:00', activity: '讲学', location: '讲堂', replyDelay: 0, tags: [], description: '用谜语作答。' },
  { startTime: '15:00', endTime: '15:45', activity: '午后小憩——碎片补眠', location: '书堆角落', replyDelay: -1, tags: ['睡眠', '碎片化'], description: '枕着书册闭眼。' },
  { startTime: '15:45', endTime: '21:30', activity: '巡视', location: '集市', replyDelay: 0, tags: [], description: '沿街慢走。' },
  { startTime: '21:30', endTime: '23:00', activity: '自检', location: '静室', replyDelay: 0, tags: [], description: '记录侵蚀度。' },
  { startTime: '23:00', endTime: '00:00', activity: '夜读', location: '书房', replyDelay: 0, tags: [], description: '翻书。' },
];

let seedCounter = 0;

function seedChar(activities) {
  const db = getDb();
  seedCounter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 1)`
  ).run(`c_${seedCounter}`, `角色${seedCounter}`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(activities));
  mgr.ensureTodaySchedule(id); // 派生当日快照（与线上同源）
  return id;
}

/** 今天（程序日期 = 真实今天，偏移为 0）的固定钟点 */
function at(h, m = 0, addDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  d.setHours(h, m, 0, 0);
  return d;
}

function rowOf(id) {
  return getDb().prepare('SELECT is_sleeping, sleep_until, temporary_wake_until FROM characters WHERE id = ?').get(id);
}

/** 某个真实瞬间在指定时区的墙上钟点 'YYYY-MM-DD HH:MM' */
function wallClockIn(instantMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instantMs)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// ── ① 本地白天 + 只有夜间睡眠 → is_sleeping 必须为 0 ──

test('① 本地白天 + 日程只有夜间睡眠：is_sleeping 必须为 0，且残留的"睡觉中"当场被纠正', () => {
  const id = seedChar(NIGHT_ONLY);
  // 起点刻意写成"旧的残留值"：睡块已结束（旧实现要等整点 cron 或重启才清）
  getDb().prepare('UPDATE characters SET is_sleeping = 1, sleep_until = ? WHERE id = ?')
    .run('2026-09-29 23:45:00', id);

  const daytime = at(15, 21); // 真机日志时刻（本地 15:21）
  const sleep = mgr.isSleeping(id, daytime);
  assert.equal(sleep.sleeping, false, '本地白天不该判成睡眠');
  assert.equal(sleep.kind, null);

  const row = rowOf(id);
  assert.equal(row.is_sleeping, 0, '读路径必须当场清掉白天的残留睡眠标志（不能等整点 cron）');
  assert.equal(row.sleep_until, null);

  const delay = mgr.getReplyDelay(id, daytime);
  assert.equal(delay.delay, 0, '白天必须秒回，不该被当成睡觉排队');
  assert.equal(delay.sleepKind, null);

  const ctx = mgr.formatScheduleContext(id, daytime);
  assert.ok(!ctx.includes('你正在睡觉'), `日程上下文不该出现"你正在睡觉"：${ctx}`);

  const overview = mgr.getAllOverview(daytime).find(c => c.id === id);
  assert.equal(overview.is_sleeping, false);
  assert.equal(overview.sleep_kind, null);
});

test('① 同一天里"睡块刚结束"（10:31，主睡眠 03:00~10:30）也必须立刻是清醒', () => {
  const id = seedChar(NIGHT_PLUS_NAP);
  // 先让她按日程睡下（03:30）
  mgr.syncSleepingState(id, at(3, 30));
  assert.equal(rowOf(id).is_sleeping, 1, '03:30 应该在主睡眠里');

  // 10:31：睡块已结束 → 读一次就必须翻成清醒，并触发自然醒路径
  const sleep = mgr.isSleeping(id, at(10, 31));
  assert.equal(sleep.sleeping, false);
  assert.equal(rowOf(id).is_sleeping, 0, '睡块结束后不能再挂 is_sleeping=1');
  assert.equal(rowOf(id).sleep_until, null);
});

// ── ② 跨日 / 跨时区边界 ──

test('② 跨日边界：22:00~07:45 的睡块，23:30 的 sleep_until 必须落在**次日** 07:45', () => {
  const id = seedChar(NIGHT_ONLY);
  const night = at(23, 30);
  mgr.syncSleepingState(id, night);

  const row = rowOf(id);
  assert.equal(row.is_sleeping, 1, '23:30 在夜间睡块内');
  const instant = parseSqlUtc(row.sleep_until);
  assert.ok(instant, `sleep_until 必须能被解析：${row.sleep_until}`);

  // 受本机时区影响的地方一律用显式时区断言：写进去的瞬间 = "本机时区的那天 07:45"
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wall = wallClockIn(instant.getTime(), tz);
  assert.equal(wall, `${localDateKey(at(0, 0, 1))} 07:45`, `sleep_until 应落在次日 07:45（本机 ${tz}），实际 ${wall}`);
  assert.notEqual(wallClockIn(instant.getTime(), 'UTC').slice(0, 10), localDateKey(at(0, 0, 1)),
    '这是一个"本地日期与 UTC 日期不同"的瞬间，说明落库的是瞬间而不是本地字符串拼接');
});

test('② 跨日边界：00:30（睡块后半段）的 sleep_until 必须是**当天** 07:45，而不是再顺延一天', () => {
  const id = seedChar(NIGHT_ONLY);
  const earlyMorning = at(0, 30);
  mgr.syncSleepingState(id, earlyMorning);
  const row = rowOf(id);
  assert.equal(row.is_sleeping, 1);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(wallClockIn(parseSqlUtc(row.sleep_until).getTime(), tz), `${localDateKey(at(0, 0))} 07:45`);
});

test('② 跨时区口径：落库的 sleep_until 是"UTC 无时区串"，UTC 墙上钟点必须与串逐字相同', () => {
  const id = seedChar(NIGHT_ONLY);
  mgr.syncSleepingState(id, at(23, 30));
  const row = rowOf(id);
  // 串本身 = UTC 墙上时刻（不改口径的前提下，这是全库 `datetime('now')` 比较能对上的前提）
  const utcWall = wallClockIn(parseSqlUtc(row.sleep_until).getTime(), 'UTC');
  assert.equal(`${utcWall}:00`, String(row.sleep_until).slice(0, 19),
    `落库串必须是 UTC 无时区串：${row.sleep_until}`);

  // 反例锁：把它当本地时间解析（历史 bug 的形态）会得到另一个瞬间 ——
  // 只有本机时区不是 UTC 时这条才有意义
  const offsetMinutes = -new Date().getTimezoneOffset();
  if (offsetMinutes !== 0) {
    const naiveLocal = new Date(row.sleep_until.replace(' ', 'T')).getTime();
    assert.notEqual(naiveLocal, parseSqlUtc(row.sleep_until).getTime(),
      '裸串与"本地解析"必须不是同一瞬间：这正是"把 UTC 当本地"会整体偏移一个时区的证据');
  }
});

test('② 跨日边界：跨午夜块的时长与结束时刻由分钟算术得出（00:00 收尾写法不算跨天）', () => {
  const id = seedChar([
    { startTime: '00:00', endTime: '06:00', activity: '通宵后补觉', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
    { startTime: '06:00', endTime: '00:00', activity: '白天活动', location: '街', replyDelay: 0, tags: [], description: 'x' },
  ]);
  // 00:30 在 00:00~06:00 的睡块里；endTime '00:00' 是"当天午夜收尾"，不是跨天
  const row = (mgr.syncSleepingState(id, at(0, 30)), rowOf(id));
  assert.equal(row.is_sleeping, 1);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(wallClockIn(parseSqlUtc(row.sleep_until).getTime(), tz), `${localDateKey(at(0, 0))} 06:00`);
});

// ── ③ 既定行为：真在睡眠时段内 → 睡着 ──

test('③ 既定行为：夜间睡块内 → is_sleeping=1 / isSleeping().sleeping / 回复延迟 -1 / 上下文写"睡觉"', () => {
  const id = seedChar(NIGHT_ONLY);
  const lateNight = at(2, 0);
  mgr.syncSleepingState(id, lateNight);

  const row = rowOf(id);
  assert.equal(row.is_sleeping, 1, '02:00 必须睡着');
  assert.ok(row.sleep_until, '必须写入醒来时刻');

  const sleep = mgr.isSleeping(id, lateNight);
  assert.equal(sleep.sleeping, true);
  assert.equal(sleep.kind, 'main');
  assert.equal(sleep.sleepUntil, row.sleep_until);

  const delay = mgr.getReplyDelay(id, lateNight);
  assert.equal(delay.delay, -1, '睡觉时必须暂停回复');
  assert.equal(delay.sleepKind, 'main');

  const ctx = mgr.formatScheduleContext(id, lateNight);
  assert.ok(ctx.includes('你正在睡觉'), `睡觉时的日程上下文必须保留原口径：${ctx}`);

  const overview = mgr.getAllOverview(lateNight).find(c => c.id === id);
  assert.equal(overview.is_sleeping, true);
  assert.equal(overview.sleep_kind, 'main');
});

// ── 白天小憩：不再算"睡觉中"，但仍按"暂不回复"排队 ──

test('白天小憩（15:00~15:45 碎片补眠）不算"睡觉中"，但 sleep_until 仍写（聊天排队要用）', () => {
  const id = seedChar(NIGHT_PLUS_NAP);
  const napTime = at(15, 21); // 真机日志时刻

  mgr.syncSleepingState(id, napTime);
  const row = rowOf(id);
  assert.equal(row.is_sleeping, 0, '白天小憩不占全局睡眠闸门（用户：白天怎么睡觉上了）');

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(wallClockIn(parseSqlUtc(row.sleep_until).getTime(), tz), `${localDateKey(at(0, 0))} 15:45`,
    'sleep_until 仍要如实写：chat.js 的睡觉路径拿它当"醒来时刻"');

  const sleep = mgr.isSleeping(id, napTime);
  assert.equal(sleep.sleeping, true, '小憩仍算"在打盹"（叫醒端点、朋友互动仍要不打扰）');
  assert.equal(sleep.kind, 'nap');

  const delay = mgr.getReplyDelay(id, napTime);
  assert.equal(delay.delay, -1, '小憩期间消息照旧排队到她醒');
  assert.equal(delay.sleepKind, 'nap');

  const ctx = mgr.formatScheduleContext(id, napTime);
  assert.ok(ctx.includes('小憩'), `小憩要用小憩的措辞：${ctx}`);
  assert.ok(!ctx.includes('你正在睡觉'), `小憩不能写"你正在睡觉"：${ctx}`);

  const overview = mgr.getAllOverview(napTime).find(c => c.id === id);
  assert.equal(overview.is_sleeping, false, '概览（前端列表）也不能显示"睡觉中"');
  assert.equal(overview.sleep_kind, 'nap');
  assert.equal(overview.reply_delay, -1);
});

test('催眠手机写入的强制睡眠块（forcedSleep=1）不受小憩启发式影响：一律主睡眠', () => {
  assert.equal(mgr.classifySleepBlock({ startTime: '15:00', endTime: '15:45', replyDelay: -1 }), 'nap');
  assert.equal(mgr.classifySleepBlock({ startTime: '15:00', endTime: '15:45', replyDelay: -1, forcedSleep: 1 }), 'main');
  assert.equal(mgr.classifySleepBlock({ startTime: '03:00', endTime: '10:30', replyDelay: -1 }), 'main');
  assert.equal(mgr.classifySleepBlock({ startTime: '06:00', endTime: '16:00', replyDelay: -1 }), 'main', '昼伏夜出型长睡眠仍是主睡眠');
  assert.equal(mgr.classifySleepBlock({ startTime: '07:00', endTime: '12:00', replyDelay: 0 }), null, '非睡眠块 → null');
  assert.equal(mgr.classifySleepBlock(null), null);
});
