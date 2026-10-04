/**
 * 任务 B：催眠手机的「睡眠控制」（立刻入睡 / 立刻唤醒）
 *
 * 用户口径：
 *   「睡觉怎么就不能直接触发了 催眠手机是全覆盖的」
 *   「再加单独一个选项 可以控制角色睡眠」
 *
 * 契约（前端 `web-ui/src/api/hypnosis.js` + `components/hypnosisLogic.js` 已按此实现）：
 *   POST /api/characters/:id/hypnosis/sleep   body { until?: 'HH:mm' | ISO }
 *   POST /api/characters/:id/hypnosis/wake    **不带 mode**（带 mode = 既有的催眠唤醒）
 *   两者都返回 **统一形状**：{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }
 *
 * 本文件锁的死东西：
 *   1. 两个端点都**走日程链路**（写 daily_schedules 当日快照 → syncSleepingState），
 *      所以再跑一次日程同步**不会翻回去**（只改 characters.is_sleeping 的写法过不了这条）；
 *   2. `/hypnosis/wake` 一个路径两种语义：不带 mode = 睡眠唤醒（新形状），
 *      带 mode = 既有催眠唤醒（老形状，逐字段还在）；
 *   3. 触发催眠指令一轮之前先临时唤醒她（`wakeForForcedTrigger`）：
 *      睡着才唤醒、用 `wake_mode='hypnosis'`、日程上下文换成"被从睡眠里拉出来"的措辞；
 *   4. 边界：非法 id 400 / 角色不存在 404 / 总开关关闭 409 且**零写入** / 幂等。
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
  throw new Error(`hypnosis sleep fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const hypnosisRoutes = (await import('../src/routes/hypnosis.js')).default;
const mgr = await import('../src/services/scheduleManager.js');
const hypnosis = await import('../src/services/hypnosisService.js');
const { parseSqlUtc, localDateKey, getProgramNow } = await import('../src/services/programTime.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/characters', wrapRouterAsync(hypnosisRoutes));
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

// 全天清醒夹具：**不依赖当前钟点**。
// 背景：下面的「醒着时不唤醒」用例原先用 NIGHT_ONLY（睡眠块 22:00–07:45），
// 结果测试在 22:00 之后跑时新角色本来就是睡着的 ⇒ 断言必红（真实踩到过）。
// 需要「睡着」的场景一律走 POST /hypnosis/sleep 显式造，不依赖日程。
const DAY_ONLY = [
  { startTime: '00:00', endTime: '23:59', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
];

const NIGHT_ONLY = [
  { startTime: '07:45', endTime: '22:00', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
];

let counter = 0;

/** 建一个"有日程 + 背包里有催眠手机"的角色 */
function seedCharacter(activities = NIGHT_ONLY) {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 1)`
  ).run(`sleep_${counter}`, `睡控${counter}`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(activities));
  mgr.ensureTodaySchedule(id);
  db.prepare(
    `INSERT INTO backpack_items (effect_key, name, description, status, owner_key, source_type, collected_at)
     VALUES ('hypnosis_phone', '催眠手机', '测试用', 'ready', 'me', 'grant', datetime('now'))`
  ).run();
  return id;
}

function rowOf(id) {
  return getDb().prepare('SELECT is_sleeping, sleep_until, temporary_wake_until, wake_mode FROM characters WHERE id = ?').get(id);
}

function todaySchedule(id) {
  const row = getDb().prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(id, localDateKey(new Date()));
  return row ? JSON.parse(row.schedule_json) : null;
}

/** 真实瞬间在指定时区的墙上时刻 'YYYY-MM-DD HH:MM' */
function wallClockIn(instantMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instantMs)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const SLEEP_SHAPE = ['characterId', 'isSleeping', 'sleepUntil', 'temporaryWakeUntil'];

// ── 立刻入睡 ──

test('POST /sleep：返回冻结形状，并真的写进日程链路（不是只改 characters）', async () => {
  const id = seedCharacter();
  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), [...SLEEP_SHAPE].sort(), '必须恰好是冻结的四个字段');
  assert.equal(res.json.characterId, id);
  assert.equal(res.json.isSleeping, true, '立刻入睡后必须判定为睡着');
  assert.ok(res.json.sleepUntil, '必须给出醒来时刻');
  assert.equal(res.json.temporaryWakeUntil, null);

  // 库里的全局睡眠闸门
  const row = rowOf(id);
  assert.equal(row.is_sleeping, 1);
  assert.equal(row.sleep_until, res.json.sleepUntil);

  // **日程链路**：当日快照里出现 replyDelay=-1 + forcedSleep=1 的块，覆盖当前时刻
  const schedule = todaySchedule(id);
  assert.ok(Array.isArray(schedule), '当日日程快照必须还在');
  const forced = schedule.find(a => a.replyDelay === -1 && a.forcedSleep === 1);
  assert.ok(forced, '立刻入睡必须写进当日日程（forceSleepNow），否则下一次同步会翻回去');
  assert.equal(forced.activity.includes('催眠入睡'), true);

  // 不翻回去：再跑一次日程同步必须仍是睡着
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1, '再同步一次不能被日程翻回清醒');
  assert.equal(mgr.getReplyDelay(id).delay, -1);
  assert.equal(mgr.isSleeping(id).sleeping, true);
});

test("POST /sleep 带 until='HH:mm'：醒来时刻就是那个钟点（已过则顺延到明天）", async () => {
  const id = seedCharacter();
  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep`, { until: '06:30' });
  assert.equal(res.status, 200);
  assert.equal(res.json.isSleeping, true);
  const instant = parseSqlUtc(res.json.sleepUntil);
  assert.ok(instant, `sleepUntil 必须能解析：${res.json.sleepUntil}`);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 06:30 已过 → 明天 06:30；没过 → 今天 06:30（测试不受运行时刻影响）
  //
  // ⚠️ 2026-10-03 修：这里的"现在"必须用**程序时间**（`getProgramNow()`），不能用 `new Date()`。
  //    服务端全程按程序时间算（`resolveSleepUntil` 的第一个参数就是 getProgramNow()），
  //    而程序时间可能被时控/跳天改过 —— 两个钟混用会在"真时间 06:15~06:30 之间"随机变红
  //    （实测：真时间 06:28 时服务端把 06:30 解析成"今天 06:30"，而用例按真时间算成"明天 06:30"）。
  const now = getProgramNow();
  const expectedDay = (6 * 60 + 30) > (now.getHours() * 60 + now.getMinutes())
    ? localDateKey(now)
    : localDateKey(new Date(now.getTime() + 86400000));
  assert.equal(wallClockIn(instant.getTime(), tz), `${expectedDay} 06:30`);
});

test('★ POST /sleep 带 until=「十分钟后」：照用户说的办，不许被"最短 15 分钟"悄悄改写', async () => {
  const id = seedCharacter();
  // 真机/单测都踩过：`until` 只比现在晚几分钟时，旧的"最短 15 分钟"夹取会**改写用户的输入**
  //（06:28 传 06:30 → 落库成 06:43）。现在只在"未来时刻"之外才夹。
  const programNow = getProgramNow();
  const target = new Date(programNow.getTime() + 10 * 60000);
  const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep`, { until: hhmm });
  assert.equal(res.status, 200);
  const instant = parseSqlUtc(res.json.sleepUntil);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(wallClockIn(instant.getTime(), tz), `${localDateKey(target)} ${hhmm}`,
    '十分钟后的时刻必须原样落库（除非它跨天，跨天时按程序日期算）');
});

test('POST /sleep 是幂等的：连点两次仍是"睡着"，不会报错', async () => {
  const id = seedCharacter();
  const first = await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  const second = await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, '重复点"睡觉"不该变成错误（前端按钮可能连点）');
  assert.equal(second.json.isSleeping, true);
});

test('POST /sleep 非法 until → 400，且不写任何睡眠状态', async () => {
  const id = seedCharacter();
  const before = rowOf(id);
  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep`, { until: '不是时间' });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid argument');
  assert.deepEqual({ ...rowOf(id) }, { ...before }, '非法参数不能有任何写入');
});

// ── 立刻唤醒 ──

test('POST /wake（不带 mode）：返回冻结形状，醒过来且日程链路同步', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  const res = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), [...SLEEP_SHAPE].sort());
  assert.equal(res.json.isSleeping, false, '唤醒后必须不是睡着');
  assert.equal(res.json.sleepUntil, null);
  assert.equal(res.json.temporaryWakeUntil, null);

  const row = rowOf(id);
  assert.equal(row.is_sleeping, 0);
  assert.equal(row.sleep_until, null);

  // 不翻回去：日程链路也认为她醒着（当前块已被替换成清醒块）
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 0, '再同步一次不能被日程翻回睡眠');
  assert.equal(mgr.isSleeping(id).sleeping, false);
  const schedule = todaySchedule(id);
  // 强制睡眠块已被"清醒块"顶掉（被叫醒后不会在几十分钟后又被按回睡着）
  assert.ok(schedule.some(a => a.forcedWake === 1 && a.replyDelay === 0), '必须写入清醒块');
  const current = mgr.getCurrentActivity(id);
  assert.equal(current.replyDelay, 0, '当前活动必须是清醒块');
});

test('POST /wake：跨午夜睡块被叫醒后**不会**在几十分钟后又睡着（后半段一起挖掉）', async () => {
  const id = seedCharacter();
  // 造一个必然跨午夜的强制睡眠：睡到"明天的 06:00"
  const tomorrow = localDateKey(new Date(Date.now() + 86400000));
  const slept = await api('POST', `/api/characters/${id}/hypnosis/sleep`, { until: `${tomorrow} 06:00` });
  assert.equal(slept.status, 200);
  assert.equal(slept.json.isSleeping, true);

  const woken = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(woken.status, 200);
  assert.equal(woken.json.isSleeping, false);
  assert.equal(mgr.getCurrentActivity(id).replyDelay, 0, '当前活动必须是清醒块');
  // 同步若干次都不能翻回睡眠（否则说明跨午夜块的后半段还留着）
  for (let i = 0; i < 3; i++) {
    mgr.syncSleepingState(id);
    assert.equal(rowOf(id).is_sleeping, 0, `第 ${i + 1} 次同步不该翻回睡眠`);
  }
});

test('睡眠唤醒：真的从睡着变成醒着才挂 wake_reaction（幂等唤醒不挂、也不写催眠状态）', async () => {
  // 用全天清醒夹具：'她本来就醒着' 这一条不能受运行钟点影响（夜里跑 NIGHT_ONLY 会真的是睡着）
  const id = seedCharacter(DAY_ONLY);
  const pendingOf = () => getDb()
    .prepare('SELECT pending_directive FROM character_hypnosis WHERE character_id = ?')
    .get(id)?.pending_directive ?? null;

  // ① 本来就醒着（幂等调用）→ 不是"刚醒"：连状态行都不该建
  assert.equal((await api('POST', `/api/characters/${id}/hypnosis/wake`, {})).status, 200);
  assert.equal(pendingOf(), null, '没真的醒来就不该建状态行 / 挂指令');

  // ② 睡着 → 唤醒：挂 wake_reaction，且只写指令列（这是"睡眠 ≠ 催眠"的交叉点）
  await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  assert.equal((await api('POST', `/api/characters/${id}/hypnosis/wake`, {})).json.isSleeping, false);
  assert.equal(pendingOf(), 'wake_reaction', '睡眠唤醒也要有"刚被唤醒"的反应');
  const row = getDb().prepare(
    'SELECT body_controlled, mind_awake, active_until FROM character_hypnosis WHERE character_id = ?'
  ).get(id);
  assert.deepEqual({ ...row }, { body_controlled: 0, mind_awake: 0, active_until: null }, '睡眠唤醒不得顺手写催眠状态');
  assert.equal(hypnosis.consumePendingDirective(id), 'wake_reaction', '一次性：下一轮注入后清空');
  assert.equal(pendingOf(), '');

  // ③ 已经醒着再点「唤醒」→ 不重复挂
  await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(pendingOf(), '', '重复唤醒不重复挂');
});

test('POST /wake 带 mode：仍是既有的"催眠唤醒"语义与形状（向后兼容）', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/hypnotize`, { minutes: 30 });
  const res = await api('POST', `/api/characters/${id}/hypnosis/wake`, { mode: 'full' });
  assert.equal(res.status, 200);
  // 老形状：催眠状态字段还在（并且新增了三个睡眠字段）
  for (const key of ['characterId', 'bodyControlled', 'mindAwake', 'active', 'pendingDirective', 'gate']) {
    assert.ok(Object.hasOwn(res.json, key), `老形状缺少 ${key}`);
  }
  assert.equal(res.json.bodyControlled, false);
  assert.equal(res.json.active, false);

  const mind = await api('POST', `/api/characters/${id}/hypnosis/hypnotize`, { minutes: 30 });
  assert.equal(mind.status, 200);
  const mindWake = await api('POST', `/api/characters/${id}/hypnosis/wake`, { mode: 'mind' });
  assert.equal(mindWake.status, 200);
  assert.equal(mindWake.json.mindAwake, true, 'mode=mind 必须走"只唤醒意志"');
  assert.equal(mindWake.json.bodyControlled, true);
});

test('POST /wake 幂等：本来醒着也返回成功（不会 409）', async () => {
  const id = seedCharacter();
  const res = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(res.status, 200);
  assert.equal(res.json.isSleeping, false);
});

// ── 边界 ──

test('非法 id 400 / 角色不存在 404', async () => {
  const bad = await api('POST', '/api/characters/abc/hypnosis/sleep', {});
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid character id');
  const missing = await api('POST', '/api/characters/99999/hypnosis/sleep', {});
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'character not found');
  const missingWake = await api('POST', '/api/characters/99999/hypnosis/wake', {});
  assert.equal(missingWake.status, 404);
});

test('没有日程的角色：睡觉 → 409 cannot sleep（前端翻译成"她现在不能睡"），零写入', async () => {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 0)`
  ).run(`nosched_${counter}`, `无日程${counter}`);
  const id = Number(info.lastInsertRowid);
  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'cannot sleep');
  assert.equal(rowOf(id).is_sleeping, 0, '失败路径不能写任何状态');
});

test('总开关关闭：sleep / wake 都 409 且零写入', async () => {
  const id = seedCharacter();
  const before = rowOf(id);
  config.features.hypnosis = false;
  try {
    const sleep = await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
    assert.equal(sleep.status, 409);
    assert.equal(sleep.json.error, 'hypnosis feature disabled');
    const wake = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
    assert.equal(wake.status, 409);
    assert.deepEqual({ ...rowOf(id) }, { ...before }, '总开关关闭时必须零写入');
  } finally {
    config.features.hypnosis = true;
  }
});

// ── 触发一轮之前的临时唤醒 ──

test('wakeForForcedTrigger：睡着才唤醒，wake_mode=hypnosis，日程上下文换成"被从睡眠里拉出来"', async () => {
  const id = seedCharacter(DAY_ONLY);
  // 醒着时不唤醒（免得白占窗口、把后续消息的日程上下文一直换成"刚被叫醒"）
  const awake = hypnosis.wakeForForcedTrigger(id);
  assert.equal(awake.woken, false);
  assert.equal(awake.reason, 'awake');
  assert.equal(rowOf(id).temporary_wake_until, null);

  // 先让她睡下，再触发
  await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  assert.equal(rowOf(id).is_sleeping, 1);

  const woken = hypnosis.wakeForForcedTrigger(id);
  assert.equal(woken.woken, true, '睡着时必须先临时唤醒');
  assert.ok(woken.minutes > 0);

  const row = rowOf(id);
  assert.ok(row.temporary_wake_until, '必须写入临时唤醒窗口（走既有链路，带定时器）');
  assert.equal(row.wake_mode, 'hypnosis');
  assert.equal(row.is_sleeping, 0, '临时唤醒期间全局闸门要让开（这正是"睡觉也能触发"的前提）');
  assert.equal(mgr.isTempWoken(id), true);

  const ctx = mgr.formatScheduleContext(id);
  assert.ok(ctx.includes('催眠指令从睡眠中拉了出来'), `唤醒措辞要带上"被催眠指令拉起"：${ctx}`);
  assert.ok(!ctx.includes('你正在睡觉'), `临时唤醒后不能再说"你正在睡觉"：${ctx}`);

  // 已经临时唤醒中 → 不重复开窗
  assert.equal(hypnosis.wakeForForcedTrigger(id).reason, 'already_temp_woken');
});

test('routes/hypnosis.js 挂点：强制高潮先临时唤醒、再触发一轮；/wake 按 mode 分流', async () => {
  const source = await readFile(new URL('../src/routes/hypnosis.js', import.meta.url), 'utf8');
  const preWakeAt = source.indexOf('wakeForForcedTrigger(id)');
  // task-41 起多传 forcedClimax（那一轮要按「高潮轮」组装：注入指令块 + 强制配图）
  const forceAt = source.indexOf('forceProactiveNow(id, { bypassGuards: true, forcedClimax: true })');
  assert.ok(preWakeAt > 0, '缺少触发前的临时唤醒挂点');
  assert.ok(forceAt > preWakeAt, '临时唤醒必须在 forceProactiveNow 之前（先唤醒，再触发）');
  assert.ok(source.includes("if (wakeInfo.woken)"), '临时唤醒的结果应当被记录（日志/返回体）');
  assert.ok(source.includes('res.json({ ...result, triggered: true, preWake: wakeInfo })'), '返回体应带上 preWake 诊断信息');

  // 一个路径两种语义：不带 mode = 睡眠唤醒
  assert.ok(/const sleepControl = rawMode === undefined/.test(source), '/hypnosis/wake 必须按 body.mode 分流');
  assert.ok(source.includes('return res.json(wakeFromSleep(id));'), '不带 mode 时走睡眠唤醒');
  assert.ok(source.includes("return res.json(wake(id, { mode: rawMode }));"), '带 mode 时保持既有催眠唤醒');
});

test('hypnosis 状态里带上睡眠字段（面板睡眠区直接读，省一次请求）', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep`, {});
  const res = await api('GET', `/api/characters/${id}/hypnosis`);
  assert.equal(res.status, 200);
  assert.equal(res.json.isSleeping, true);
  assert.ok(res.json.sleepUntil);
  assert.equal(res.json.temporaryWakeUntil, null);
});
