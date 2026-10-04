/**
 * 任务 C：完全控制"程序时间"（现实模拟游戏的世界钟）
 *
 * 用户口径：「可以控制程序里的时间 控制是白天黑夜 是第一天还是第二天…我要完全控制时间…
 * 给我一个按钮 我可以让所有知道角色 过了一天了 或者是很多天…让这个程序和游戏一样 现实模拟游戏」。
 *
 * 事实来源：`system_settings` 的 `program_time_state`（JSON：offsetMs + epochDate），
 * 见 `src/services/programTime.js` 文件头（为什么复用 system_settings、为什么不加表/列）。
 *
 * 前端（另一位同事的 `web-ui/src/api/timeControl.js`）期望的挂载是 `/api/time*`；
 * 本轮不允许改 app.js，所以挂在 **`/api/schedule/time*`**（同一个 router，路径与形状完全一致，
 * 在 app.js 里加两行就能平移到 `/api/time`）。本文件同时锁住挂载点。
 *
 * 本文件锁的死东西：
 *   1. 偏移为 0 时**行为与改动前一致**（默认不改变任何既有行为）；
 *   2. 读 / +N 天 / 切白天黑夜 / 设具体日期时间的形状（字段名与前端归一化对齐）；
 *   3. 推进必须影响**所有角色**：重算日程与睡眠（走既有派生链）、清过期临时唤醒、
 *      把本该醒着的唤醒；逐天推进并让每个角色拿到正确的"今天"；
 *   4. 参数边界：days 1~3650、非法输入 400。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`program time fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const timeRoutes = (await import('../src/routes/time.js')).default;
const programTime = await import('../src/services/programTime.js');
const mgr = await import('../src/services/scheduleManager.js');
const timeLight = await import('../src/services/timeLight.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
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

/** 每个测试开始前把钟拨回真实时间，避免用例互相污染（状态落 system_settings） */
function resetClock(t) {
  t.after(() => programTime.resetProgramTime());
  programTime.resetProgramTime();
}

const { localDateKey, addDaysToKey } = programTime;

/** 夜间睡眠型日程（22:00~07:45） */
const NIGHT = [
  { startTime: '07:45', endTime: '22:00', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
];

/** 凌晨睡眠型日程（03:00~10:30） */
const DAWN = [
  { startTime: '00:00', endTime: '03:00', activity: '深夜抄录', location: '塔', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '03:00', endTime: '10:30', activity: '沉眠', location: '吊床', replyDelay: -1, tags: ['睡眠'], description: 'x' },
  { startTime: '10:30', endTime: '00:00', activity: '白天活动', location: '讲堂', replyDelay: 0, tags: [], description: 'x' },
];

let counter = 0;

function seedCharacter(activities) {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 1)`
  ).run(`pt_${counter}`, `钟${counter}`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(activities));
  mgr.ensureTodaySchedule(id);
  return id;
}

function rowOf(id) {
  return getDb().prepare('SELECT is_sleeping, sleep_until, temporary_wake_until FROM characters WHERE id = ?').get(id);
}

// ── 纯时钟 ──

test('默认状态：偏移为 0，程序时间 = 真实时间（改动前行为不变）', async t => {
  resetClock(t);
  const state = programTime.getProgramState();
  assert.equal(state.offsetMs, 0);
  assert.equal(state.date, localDateKey(new Date()));
  assert.equal(state.dayIndex, 1, '第 1 天 = epochDate 当天');
  assert.equal(state.totalDays, 0);
  // 偏移为 0 时 timeLight 与改动前逐字节一致（传 real Date 与不传都必须一致）
  const real = new Date();
  assert.equal(timeLight.getTimeTag(real), timeLight.getTimeTag());
  assert.equal(timeLight.getTimeLightInline(real), timeLight.getTimeLightInline());
});

test('+N 天：日期/第几天/偏移都跟着走；推进天数被夹在 1~3650', async t => {
  resetClock(t);
  await api('POST', '/api/schedule/time/advance', { days: 3 });
  const state = programTime.getProgramState();
  assert.equal(state.date, addDaysToKey(localDateKey(new Date()), 3));
  assert.equal(state.dayIndex, 4, '第 1 天 + 3 天 = 第 4 天');
  assert.equal(state.totalDays, 3);
  assert.equal(state.offsetDays, 3);
  assert.equal(state.offsetMs, 3 * 86400000);

  // 上限：3650 天可以，3651 / 0 / 负数 / 非数字 → 400
  const ok = await api('POST', '/api/schedule/time/advance', { days: 3650 });
  assert.equal(ok.status, 200);
  for (const bad of [3651, 0, -1, 'x', null]) {
    const res = await api('POST', '/api/schedule/time/advance', { days: bad });
    assert.equal(res.status, 400, `days=${JSON.stringify(bad)} 应当 400`);
    assert.equal(res.json.error, 'invalid days');
  }
});

test('切白天 / 黑夜：日期与第几天不动，只改钟点（默认 08:00 / 22:00）', async t => {
  resetClock(t);
  await api('POST', '/api/schedule/time/advance', { days: 2 });
  const before = programTime.getProgramState();

  const day = await api('POST', '/api/schedule/time/period', { period: 'day' });
  assert.equal(day.status, 200);
  assert.equal(day.json.time, '08:00');
  assert.equal(day.json.phase, 'day');
  assert.equal(day.json.date, before.date, '切时段不能改日期');
  assert.equal(day.json.dayIndex, before.dayIndex);

  const night = await api('POST', '/api/schedule/time/period', { period: 'night', phase: 'night' });
  assert.equal(night.status, 200);
  assert.equal(night.json.time, '22:00');
  assert.equal(night.json.phase, 'night');
  assert.equal(night.json.date, before.date);

  // 中文与自定义钟点也认
  const custom = await api('POST', '/api/schedule/time/period', { period: '白天', time: '09:30' });
  assert.equal(custom.status, 200);
  assert.equal(custom.json.time, '09:30');
  assert.equal(custom.json.phase, 'day');

  const bad = await api('POST', '/api/schedule/time/period', { period: 'dusk' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid period');
});

test('设定具体日期时间：按程序世界的墙上时间解释', async t => {
  resetClock(t);
  const res = await api('POST', '/api/schedule/time/set', { datetime: '2030-05-01 14:20:00' });
  assert.equal(res.status, 200);
  assert.equal(res.json.date, '2030-05-01');
  assert.equal(res.json.time, '14:20');
  assert.equal(res.json.phase, 'day');
  assert.equal(res.json.weekday, '周三');
  assert.equal(res.json.epochDate, localDateKey(new Date()), '第 1 天锚点不变');

  const { date, time } = await api('POST', '/api/schedule/time/set', { date: '2030-05-02', time: '23:10' }).then(r => r.json);
  assert.equal(date, '2030-05-02');
  assert.equal(time, '23:10');

  for (const bad of [{ datetime: '不是时间' }, { date: '2030-13-99', time: '08:00' }, { time: '25:00' }]) {
    const badRes = await api('POST', '/api/schedule/time/set', bad);
    assert.equal(badRes.status, 400, `${JSON.stringify(bad)} 应当 400`);
  }
});

test('返回形状与前端归一化对齐（裸状态对象 + phase/第几天/现实时间）', async t => {
  resetClock(t);
  const res = await api('GET', '/api/schedule/time');
  assert.equal(res.status, 200);
  for (const key of ['date', 'time', 'datetime', 'stamp', 'weekday', 'minuteOfDay', 'phase',
    'dayIndex', 'totalDays', 'epochDate', 'offsetMs', 'offsetDays', 'offsetHours', 'offsetMinutes', 'real']) {
    assert.ok(Object.hasOwn(res.json, key), `程序时间状态缺少 ${key}`);
  }
  assert.ok(['day', 'night'].includes(res.json.phase));
  assert.ok(res.json.real && res.json.real.date, 'real 字段要如实给出"现实世界现在几点"');
});

// ── 推进影响所有角色 ──

test('推进/设定程序时间：所有角色的睡眠状态按新日程重算（走既有派生链）', async t => {
  resetClock(t);
  const night = seedCharacter(NIGHT);   // 22:00~07:45 睡
  const dawn = seedCharacter(DAWN);     // 03:00~10:30 睡

  // 拨到上午 08:00：dawn（03:00~10:30 睡）在睡，night（22:00~07:45 睡）醒着
  const res = await api('POST', '/api/schedule/time/set', { date: localDateKey(new Date()), time: '08:00' });
  assert.equal(res.status, 200);
  assert.equal(rowOf(dawn).is_sleeping, 1, 'dawn 型角色 08:00 必须睡着');
  assert.equal(rowOf(night).is_sleeping, 0, 'night 型角色 08:00 必须醒着');
  assert.equal(res.json.applied.characters.length >= 2, true, '返回体要带每个角色的重算结果');
  assert.ok(rowOf(dawn).sleep_until, '睡着必须给出醒来时刻');

  // 拨到 15:00：两边都醒着（dawn 的睡块 10:30 结束）
  await api('POST', '/api/schedule/time/set', { date: localDateKey(new Date()), time: '15:00' });
  assert.equal(rowOf(dawn).is_sleeping, 0, '睡块结束后必须翻成清醒');
  assert.equal(rowOf(night).is_sleeping, 0);

  // 拨到 23:00：night 型睡着
  await api('POST', '/api/schedule/time/set', { date: localDateKey(new Date()), time: '23:00' });
  assert.equal(rowOf(night).is_sleeping, 1);
  assert.equal(rowOf(dawn).is_sleeping, 0);
});

test('推进 1 天：日期快照补到"今天"，睡眠按新的一天重算，过期临时唤醒被清掉', async t => {
  resetClock(t);
  const night = seedCharacter(NIGHT);
  const dawn = seedCharacter(DAWN);

  // 先让她按 08:00 睡下（dawn），并挂一个"临时唤醒"（模拟刚被叫醒过）
  await api('POST', '/api/schedule/time/set', { date: localDateKey(new Date()), time: '08:00' });
  getDb().prepare(`UPDATE characters SET temporary_wake_until = datetime('now', '+10 minutes'), wake_mode = 'phone' WHERE id = ?`).run(dawn);
  assert.equal(mgr.isTempWoken(dawn), true);

  const res = await api('POST', '/api/schedule/time/advance', { days: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.json.applied.days, 1);
  assert.deepEqual(res.json.applied.skippedTempWakes, [dawn], '跳天之后过期的临时唤醒必须被清掉');
  assert.equal(rowOf(dawn).temporary_wake_until, null);
  assert.equal(mgr.isTempWoken(dawn), false);

  // 新的一天：同样是上午 08:00 的钟点 → dawn 仍该睡着，night 仍该醒着
  assert.equal(rowOf(dawn).is_sleeping, 1, '跳天后按新日期的日程重算');
  assert.equal(rowOf(night).is_sleeping, 0);

  // 当日快照已经落到新的程序日期上
  const todayRow = getDb().prepare(
    'SELECT schedule_date FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(dawn, res.json.date);
  assert.ok(todayRow, '新程序日期必须有当日日程快照');
});

test('推进多天：逐天补齐快照（不跳步），每个角色都拿到正确的"今天是第几天"', async t => {
  resetClock(t);
  const night = seedCharacter(NIGHT);
  const start = localDateKey(new Date());
  const res = await api('POST', '/api/schedule/time/advance', { days: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.json.dayIndex, 4);

  // 中间三天都有快照（逐天推进的痕迹）
  for (let i = 1; i <= 3; i++) {
    const key = addDaysToKey(start, i);
    const row = getDb().prepare(
      'SELECT schedule_date FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
    ).get(night, key);
    assert.ok(row, `第 +${i} 天（${key}）必须有快照`);
  }
  // 最后一天的睡眠状态按那一天的钟点算（这里是 15:00 左右 → 醒着）
  const state = programTime.getProgramState();
  const expectedSleeping = (() => {
    const m = state.minuteOfDay;
    return (m >= 22 * 60 || m < 7 * 60 + 45) ? 1 : 0;
  })();
  assert.equal(rowOf(night).is_sleeping, expectedSleeping, `程序钟 ${state.time} 的睡眠结论不对`);
});

test('复位：把钟拨回真实时间（偏移归零）', async t => {
  resetClock(t);
  await api('POST', '/api/schedule/time/advance', { days: 5 });
  assert.notEqual(programTime.getProgramState().offsetMs, 0);
  const res = await api('POST', '/api/schedule/time/reset', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.offsetMs, 0);
  assert.equal(res.json.date, localDateKey(new Date()));
});

test('日程快照的日期键跟程序日期走（snapshotTodaySchedule 不能写死真实今天）', async t => {
  resetClock(t);
  await api('POST', '/api/schedule/time/advance', { days: 2 });
  const programDate = programTime.getProgramState().date;
  assert.notEqual(programDate, localDateKey(new Date()), '前提：程序日期已经和真实日期不同');

  // 快进之后再建角色：快照应当落在程序日期上
  const id = seedCharacter(NIGHT);
  const generator = await import('../src/services/scheduleGenerator.js');
  assert.ok(generator.snapshotTodaySchedule(id), '应当派生出一份快照');

  const rows = getDb().prepare(
    'SELECT schedule_date FROM daily_schedules WHERE character_id = ? ORDER BY schedule_date'
  ).all(id).map(r => r.schedule_date);
  assert.ok(rows.includes(programDate), `快照必须落在程序日期 ${programDate} 上（实际 ${rows.join(',')}）`);
  assert.ok(!rows.includes(localDateKey(new Date())), '不该再写到真实今天上');
});

// ── 与 prompt 时间标签的一致性 ──

test('timeLight 跟着程序钟走：快进 1 天后 prompt 的时间标签也是新日期', async t => {
  resetClock(t);
  const before = timeLight.getTimeTag();
  assert.ok(before.includes(localDateKey(new Date())), before);

  await api('POST', '/api/schedule/time/advance', { days: 1 });
  const after = timeLight.getTimeTag();
  assert.ok(after.includes(addDaysToKey(localDateKey(new Date()), 1)), `时间标签必须跟着程序钟：${after}`);
  assert.ok(!after.includes(`[${localDateKey(new Date())} `), '不能还显示现实世界的日期');

  // 显式传真实 Date 的调用方（chat.js / 朋友圈 / 事件）也要被偏移
  const explicit = timeLight.getTimeTag(new Date());
  assert.equal(explicit, after);
});

// ── 挂载与"仍只跟真实时间走"的口径 ──

test('挂载点：routes/schedule.js 把 time 子路由挂在 /time（最终 /api/schedule/time*）', async () => {
  const source = await readFile(new URL('../src/routes/schedule.js', import.meta.url), 'utf8');
  assert.ok(source.includes("import timeRoutes from './time.js';"), '未 import 时间子路由');
  assert.ok(source.includes("router.use('/time', timeRoutes);"), '未挂在 /time 上');
  assert.ok(source.includes('program_time: getProgramState()'), '日程概览应附带当前程序时间');
});

test('日报口径：程序钟不影响"真实时间定时器"的写入口径（temporary_wake_until 仍是真实瞬间）', async t => {
  resetClock(t);
  const id = seedCharacter(NIGHT);
  await api('POST', '/api/schedule/time/advance', { days: 2 });
  // 临时唤醒窗口是真实时间（5~15 分钟），跳天之后重新设置时不能把偏移算进去
  const wake = mgr.tempWake(id, { minutes: 5, mode: 'phone' });
  assert.equal(wake.ok, true);
  const until = programTime.parseSqlUtc(wake.temporaryWakeUntil);
  const diffMinutes = (until.getTime() - Date.now()) / 60000;
  assert.ok(Math.abs(diffMinutes - 5) < 1, `临时唤醒必须是真实 5 分钟（实际 ${diffMinutes.toFixed(2)}）`);
});
