/**
 * 程序时间控制（`/api/time*`）—— 接口契约 + 推进语义 + 并发串行化
 *
 * 用户口径：「可以控制程序里的时间 控制是白天黑夜 是第一天还是第二天…我要完全控制时间…
 * 给我一个按钮 我可以让所有知道角色 过了一天了 或者是很多天…让这个程序和游戏一样 现实模拟游戏」。
 *
 * 事实来源：`system_settings` 的 `program_time_state`（JSON：offsetMs + epochDate），
 * 由 `src/services/programTime.js` 独占；`src/services/timeControl.js` 是编排层
 * （校验 → 串行化 → 逐天推进 → 让所有角色跟上），`src/routes/time.js` 只是 HTTP 壳。
 *
 * 本文件锁的死东西：
 *   1. `GET /api/time` 的契约形状：{ date, time, period, dayIndex, totalDays } + 兼容字段 + message；
 *   2. `POST /api/time/advance` 的边界（1~3650 合法，其余 400）与逐天语义；
 *   3. `POST /api/time/period`（白天/黑夜）、`POST /api/time/set`（含跨日）；
 *   4. 推进/设定**影响所有角色**：日程快照 + is_sleeping/sleep_until 重算 + 过期临时唤醒清理；
 *   5. 并发调用串行化（同一时刻只允许一次推进，不许丢天数）；
 *   6. 全过程不联网（globalThis.fetch 对外一律抛错）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// ── 夹具：临时库 + 断网 ────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`time control fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const timeRoutes = (await import('../src/routes/time.js')).default;
const control = await import('../src/services/timeControl.js');
const programTime = await import('../src/services/programTime.js');
const mgr = await import('../src/services/scheduleManager.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
// 同一个 router 挂两处：新契约路径 /api/time*，以及历史路径 /api/schedule/time*
app.use('/api/time', wrapRouterAsync(timeRoutes));
app.use('/api/schedule/time', wrapRouterAsync(timeRoutes));
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

const { localDateKey, addDaysToKey, parseSqlUtc } = programTime;

/** 每个用例开始前把钟拨回真实时间（状态落 system_settings，会跨用例残留） */
function resetClock(t) {
  t.after(() => programTime.resetProgramTime());
  programTime.resetProgramTime();
}

// ── 角色夹具 ───────────────────────────────────────────────────────────────

/** 夜间睡眠：22:00~07:45 睡，白天醒 */
const NIGHT = [
  { startTime: '07:45', endTime: '22:00', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
];
/** 凌晨睡眠：03:00~10:30 睡 */
const DAWN = [
  { startTime: '00:00', endTime: '03:00', activity: '深夜抄录', location: '塔', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '03:00', endTime: '10:30', activity: '沉眠', location: '吊床', replyDelay: -1, tags: ['睡眠'], description: 'x' },
  { startTime: '10:30', endTime: '00:00', activity: '白天活动', location: '讲堂', replyDelay: 0, tags: [], description: 'x' },
];
/** 夜睡 + 午后小憩：小憩不占全局睡眠闸门，但要写 sleep_until */
const NAP = [
  { startTime: '07:00', endTime: '15:00', activity: '上午工作', location: '工坊', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '15:00', endTime: '15:45', activity: '午后小憩', location: '躺椅', replyDelay: -1, tags: ['睡眠', '碎片化'], description: 'x' },
  { startTime: '15:45', endTime: '23:00', activity: '傍晚散步', location: '河堤', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '23:00', endTime: '07:00', activity: '就寝', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
];

let counter = 0;
function seedCharacter(activities, label) {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, ?, 1)`
  ).run(`tc_${counter}`, label || `钟${counter}`, '旅客');
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(activities));
  mgr.ensureTodaySchedule(id);
  return id;
}

function rowOf(id) {
  return getDb().prepare('SELECT is_sleeping, sleep_until, temporary_wake_until FROM characters WHERE id = ?').get(id);
}

function snapshotDays(id) {
  return getDb().prepare(
    'SELECT schedule_date FROM daily_schedules WHERE character_id = ? ORDER BY schedule_date'
  ).all(id).map(r => r.schedule_date);
}

const hm = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

// ── 1. 契约形状 / 空态 ─────────────────────────────────────────────────────

test('GET /api/time 空态：偏移 0、第 1 天、契约字段齐全、message 说明真实时间清单', async t => {
  resetClock(t);
  const res = await api('GET', '/api/time');
  assert.equal(res.status, 200);

  // 任务书定死的五个字段
  assert.equal(res.json.date, localDateKey(new Date()));
  assert.match(res.json.time, /^\d{2}:\d{2}$/);
  assert.ok(['day', 'night'].includes(res.json.period), `period 必须是 day/night：${res.json.period}`);
  assert.equal(res.json.dayIndex, 1, '第 1 天 = epochDate 当天');
  assert.equal(res.json.totalDays, 0);
  assert.equal(typeof res.json.dayIndex, 'number');
  assert.equal(typeof res.json.totalDays, 'number');

  // 兼容字段（前端已按这些接）
  for (const key of ['phase', 'datetime', 'stamp', 'weekday', 'minuteOfDay', 'epochDate',
    'offsetMs', 'offsetDays', 'offsetHours', 'offsetMinutes', 'real']) {
    assert.ok(Object.hasOwn(res.json, key), `状态缺少兼容字段 ${key}`);
  }
  assert.equal(res.json.period, res.json.phase, 'period 与 phase 必须同值');
  assert.equal(res.json.dayIndex, res.json.totalDays + 1, 'dayIndex = totalDays + 1');
  assert.equal(res.json.offsetMs, 0);
  assert.ok(res.json.real && res.json.real.date === localDateKey(new Date()));

  // message 必须如实列"仍只跟真实时间走"的模块
  assert.equal(typeof res.json.message, 'string');
  assert.ok(res.json.message.includes('next_proactive_at'), res.json.message);
  assert.ok(res.json.message.includes('next_schedule_refresh_at'), res.json.message);
  assert.ok(res.json.message.includes('scheduled_reply_at'), res.json.message);
  assert.ok(res.json.message.includes('sleep_until'), res.json.message);
});

test('全程断网：夹具里对外的 globalThis.fetch 一律抛错', async () => {
  await assert.rejects(() => fetch('https://example.com/any'), /forbids network/);
});

// ── 2. advance：边界 + 语义 ────────────────────────────────────────────────

test('advance 边界：1 与 3650 合法；3651/0/-1/非数字/空 → 400 invalid days', async t => {
  resetClock(t);
  const one = await api('POST', '/api/time/advance', { days: 1 });
  assert.equal(one.status, 200);
  assert.equal(one.json.dayIndex, 2);

  const max = await api('POST', '/api/time/advance', { days: 3650 });
  assert.equal(max.status, 200, '3650 是合法上界');
  assert.equal(max.json.offsetDays, 1 + 3650);

  for (const bad of [3651, 0, -1, 1.5e9, 'x', null, '', true, undefined, {}]) {
    const res = await api('POST', '/api/time/advance', { days: bad });
    assert.equal(res.status, 400, `days=${JSON.stringify(bad)} 应当 400`);
    assert.equal(res.json.error, 'invalid days');
  }
});

test('advance N 天：日期 / 第几天 / 总天数 / 偏移全部跟着走', async t => {
  resetClock(t);
  const start = localDateKey(new Date());
  const res = await api('POST', '/api/time/advance', { days: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.json.date, addDaysToKey(start, 3));
  assert.equal(res.json.dayIndex, 4);
  assert.equal(res.json.totalDays, 3);
  assert.equal(res.json.offsetDays, 3);
  assert.equal(res.json.offsetMs, 3 * 86400000);
  assert.equal(res.json.applied.days, 3);
  assert.deepEqual(res.json.applied.dayKeys, [1, 2, 3].map(i => addDaysToKey(start, i)));
});

// ── 3. period / set ────────────────────────────────────────────────────────

test('period：切白天 08:00 / 切黑夜 22:00，日期与天数不动', async t => {
  resetClock(t);
  await api('POST', '/api/time/advance', { days: 2 });
  const before = (await api('GET', '/api/time')).json;

  const day = await api('POST', '/api/time/period', { period: 'day' });
  assert.equal(day.status, 200);
  assert.equal(day.json.period, 'day');
  assert.equal(day.json.phase, 'day');
  assert.equal(day.json.time, '08:00');
  assert.equal(day.json.date, before.date, '切时段不能改日期');
  assert.equal(day.json.dayIndex, before.dayIndex);

  const night = await api('POST', '/api/time/period', { period: 'night' });
  assert.equal(night.status, 200);
  assert.equal(night.json.period, 'night');
  assert.equal(night.json.time, '22:00');
  assert.equal(night.json.date, before.date);

  const bad = await api('POST', '/api/time/period', { period: 'dusk' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid period');
});

test('set：设定具体墙上时间（含跨日 / ISO 带时区）', async t => {
  resetClock(t);
  const res = await api('POST', '/api/time/set', { datetime: '2030-05-01 14:20' });
  assert.equal(res.status, 200);
  assert.equal(res.json.date, '2030-05-01');
  assert.equal(res.json.time, '14:20');
  assert.equal(res.json.period, 'day');
  assert.equal(res.json.weekday, '周三');
  assert.equal(res.json.epochDate, localDateKey(new Date()), '第 1 天锚点不变');
  assert.equal(res.json.dayIndex, programTime.diffDays(localDateKey(new Date()), '2030-05-01') + 1);

  // 跨日（往回拨）：日期真正变了
  const back = await api('POST', '/api/time/set', { datetime: '2030-04-28 23:10' });
  assert.equal(back.json.date, '2030-04-28');
  assert.equal(back.json.time, '23:10');
  assert.equal(back.json.period, 'night');
  assert.equal(back.json.applied.crossDay, true, '跨日要在 applied 里标出来');

  // ISO 带时区：按绝对瞬间折算成本地墙上时间
  const iso = new Date(2031, 0, 2, 9, 5, 0).toISOString();
  const isoRes = await api('POST', '/api/time/set', { datetime: iso });
  assert.equal(isoRes.status, 200);
  assert.equal(isoRes.json.date, '2031-01-02');
  assert.equal(isoRes.json.time, '09:05');
});

test('set 非法输入 → 400（invalid datetime / invalid date / invalid time）', async t => {
  resetClock(t);
  const cases = [
    [{ datetime: '不是时间' }, 'invalid datetime'],
    [{ datetime: '2030-02-31 08:00' }, 'invalid datetime'],
    [{ datetime: '2030-05-01 25:00' }, 'invalid datetime'],
    [{ date: '2030-13-99', time: '08:00' }, 'invalid date'],
    [{ time: '25:00' }, 'invalid time'],
    [{}, 'invalid datetime'],
  ];
  for (const [body, code] of cases) {
    const res = await api('POST', '/api/time/set', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应当 400`);
    assert.equal(res.json.error, code);
  }
});

// ── 4. 推进/设定影响所有角色 ───────────────────────────────────────────────

test('set 后所有角色（3 个）的 is_sleeping / 日程快照被重算', async t => {
  resetClock(t);
  const night = seedCharacter(NIGHT, '夜型');
  const dawn = seedCharacter(DAWN, '晨型');
  const nap = seedCharacter(NAP, '小憩型');
  const today = localDateKey(new Date());

  // 世界 08:00：夜型醒、晨型睡（03:00~10:30）、小憩型醒
  const at8 = await api('POST', '/api/time/set', { datetime: `${today} 08:00` });
  assert.equal(at8.status, 200);
  assert.equal(rowOf(night).is_sleeping, 0, '夜型 08:00 必须醒着');
  assert.equal(rowOf(dawn).is_sleeping, 1, '晨型 08:00 必须睡着');
  assert.equal(rowOf(nap).is_sleeping, 0, '小憩型 08:00 必须醒着');
  assert.ok(rowOf(dawn).sleep_until, '睡着必须给出醒来时刻（真实瞬间）');
  assert.ok(parseSqlUtc(rowOf(dawn).sleep_until).getTime() > Date.now(), 'sleep_until 必须是未来');
  const ids = at8.json.applied.characters.map(c => c.id);
  for (const id of [night, dawn, nap]) assert.ok(ids.includes(id), `applied.characters 缺少角色 ${id}`);

  // 世界 15:30：小憩型小憩（不占全局闸门，但要写 sleep_until = 真实瞬间的世界 15:45）
  await api('POST', '/api/time/set', { datetime: `${today} 15:30` });
  assert.equal(rowOf(nap).is_sleeping, 0, '小憩不占全局睡眠闸门');
  const napUntil = parseSqlUtc(rowOf(nap).sleep_until);
  assert.ok(napUntil, '小憩也要写醒来时刻');
  // 世界 15:45 − 世界 15:30 = 真实 15 分钟后（偏移不是整天的倍数，这里按差值断言）
  assert.ok(Math.abs((napUntil.getTime() - Date.now()) / 60000 - 15) < 2,
    `小憩醒来应距真实现在约 15 分钟，实际 ${((napUntil.getTime() - Date.now()) / 60000).toFixed(1)} 分钟`);

  // 世界 23:30：夜型睡、晨型醒、小憩型睡
  await api('POST', '/api/time/set', { datetime: `${today} 23:30` });
  assert.equal(rowOf(night).is_sleeping, 1);
  assert.equal(rowOf(dawn).is_sleeping, 0);
  assert.equal(rowOf(nap).is_sleeping, 1);
});

test('advance 1 天：过期临时唤醒被清掉，每个角色拿到新一天的快照并重算睡眠', async t => {
  resetClock(t);
  const night = seedCharacter(NIGHT, '夜型');
  const dawn = seedCharacter(DAWN, '晨型');
  const today = localDateKey(new Date());

  await api('POST', '/api/time/set', { datetime: `${today} 08:00` });   // 晨型睡下
  assert.equal(rowOf(dawn).is_sleeping, 1);
  // 挂一个"临时唤醒"（模拟刚被叫醒过，真实时间 10 分钟）
  getDb().prepare(`UPDATE characters SET temporary_wake_until = datetime('now', '+10 minutes'), wake_mode = 'phone' WHERE id = ?`).run(dawn);
  assert.equal(mgr.isTempWoken(dawn), true);

  const res = await api('POST', '/api/time/advance', { days: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.applied.skippedTempWakes.includes(dawn), true, '跳天必须收掉临时唤醒');
  assert.equal(rowOf(dawn).temporary_wake_until, null);
  assert.equal(mgr.isTempWoken(dawn), false);

  // 新的一天同一钟点（08:00）：晨型仍该睡、夜型仍该醒
  assert.equal(hm(new Date(res.json.stamp)), '08:00');
  assert.equal(rowOf(dawn).is_sleeping, 1, '跳天后按新一天的日程重算');
  assert.equal(rowOf(night).is_sleeping, 0);

  // 每个角色都在新程序日期上有当日快照
  assert.ok(snapshotDays(dawn).includes(res.json.date));
  assert.ok(snapshotDays(night).includes(res.json.date));
});

test('逐天推进：+3 天时中间每一天都有快照（不跳步）', async t => {
  resetClock(t);
  const night = seedCharacter(NIGHT, '夜型');
  const start = localDateKey(new Date());
  const res = await api('POST', '/api/time/advance', { days: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.json.dayIndex, 4);

  const days = snapshotDays(night);
  for (let i = 1; i <= 3; i++) {
    const key = addDaysToKey(start, i);
    assert.ok(days.includes(key), `第 +${i} 天（${key}）必须有快照（实际 ${days.join(',')}）`);
  }
  // 快照只在最后 3 天（scheduleManager 只保留近 2 天的旧快照）—— 但每天都被走过
  assert.deepEqual(res.json.applied.dayKeys, [1, 2, 3].map(i => addDaysToKey(start, i)));

  // 最后一天的睡眠结论按那一天的世界钟点算
  const expected = (() => {
    const m = res.json.minuteOfDay;
    return (m >= 22 * 60 || m < 7 * 60 + 45) ? 1 : 0;
  })();
  assert.equal(rowOf(night).is_sleeping, expected, `世界钟 ${res.json.time} 的睡眠结论不对`);

  // 偏移是整 24h 的倍数 → sleep_until 的本地钟点必须等于日程睡块的 endTime
  const block = mgr.currentSleepBlock(night);
  if (block.kind) {
    assert.equal(hm(parseSqlUtc(block.sleepUntil)), block.block.endTime);
  }
});

// ── 5. 并发串行化 ─────────────────────────────────────────────────────────

test('并发串行化：8 个并发 +1 天 = 恰好 +8 天，且同时只跑一次推进', async t => {
  resetClock(t);
  seedCharacter(NIGHT, '夜型');
  const before = control.getTimeControlStats();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => api('POST', '/api/time/advance', { days: 1 }))
  );
  for (const r of results) assert.equal(r.status, 200);

  const state = (await api('GET', '/api/time')).json;
  assert.equal(state.offsetDays, 8, '并发推进不能丢天数（丢更新说明串行化失效）');

  const stats = control.getTimeControlStats();
  assert.equal(stats.runs - before.runs, 8);
  assert.equal(stats.maxConcurrent, 1, '同一时刻只允许一次推进');
  assert.equal(stats.active, 0);
});

// ── 6. 挂载与形状一致性 ────────────────────────────────────────────────────

test('旧路径 /api/schedule/time 与新契约路径 /api/time 是同一个 router、同一份形状', async t => {
  resetClock(t);
  const viaNew = await api('GET', '/api/time');
  const viaOld = await api('GET', '/api/schedule/time');
  assert.equal(viaNew.status, 200);
  assert.equal(viaOld.status, 200);
  assert.deepEqual(Object.keys(viaOld.json).sort(), Object.keys(viaNew.json).sort());

  const adv = await api('POST', '/api/schedule/time/advance', { days: 1 });
  assert.equal(adv.status, 200);
  assert.equal(adv.json.period, adv.json.phase);
  assert.equal((await api('GET', '/api/time')).json.dayIndex, 2);
});

test('reset：把钟拨回真实时间（偏移归零，第 1 天重锚今天）', async t => {
  resetClock(t);
  await api('POST', '/api/time/advance', { days: 5 });
  const res = await api('POST', '/api/time/reset', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.offsetMs, 0);
  assert.equal(res.json.date, localDateKey(new Date()));
  assert.equal(res.json.dayIndex, 1);
});

test('失败不写坏状态：非法参数一个字节都不改程序钟', async t => {
  resetClock(t);
  await api('POST', '/api/time/set', { datetime: `${localDateKey(new Date())} 09:15` });
  const before = (await api('GET', '/api/time')).json;

  const badCalls = [
    ['POST', '/api/time/advance', { days: 4000 }],
    ['POST', '/api/time/advance', { days: 'x' }],
    ['POST', '/api/time/period', { period: 'dusk' }],
    ['POST', '/api/time/set', { datetime: '不是时间' }],
    ['POST', '/api/time/set', { date: '2030-02-31', time: '08:00' }],
    ['POST', '/api/time/set', { time: '99:99' }],
  ];
  for (const [method, path, body] of badCalls) {
    const res = await api(method, path, body);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} 应当 400`);
  }

  const after = (await api('GET', '/api/time')).json;
  assert.equal(after.date, before.date);
  assert.equal(after.time, before.time);
  assert.equal(after.offsetMs, before.offsetMs);
  assert.equal(after.dayIndex, before.dayIndex);
  assert.equal(after.epochDate, before.epochDate);
});

test('REAL_TIME_ONLY 清单与 message 一致（不糊弄：清单非空且都在 message 里）', async () => {
  assert.ok(control.REAL_TIME_ONLY.length >= 5);
  assert.ok(control.TIME_CONTROL_NOTE.includes('仍按真实时间走'));
  assert.equal(control.MAX_ADVANCE_DAYS, 3650);
  assert.equal(control.MIN_ADVANCE_DAYS, 1);
});
