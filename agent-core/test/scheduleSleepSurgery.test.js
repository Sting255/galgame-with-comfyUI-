/**
 * 任务 B 补丁：催眠手机「睡眠控制」走日程链路的三个真实缺陷（探针抓到、此处锁死）
 *
 * ① `mainSleepDuration`（scheduleEditor.js）把**跨午夜**主睡眠块的时长算成了 24 小时：
 *    22:00~07:45 被拆成 [22:00,24:00) + [0:00,07:45) 两段，旧实现取 `max(e) - min(s) = 1440`。
 *    → 「立刻入睡」不传 until 时 `endMin = 现在 + 1440`，把**一整天**的日程整块替换成睡眠块
 *      （当天所有安排消失、sleep_until 直接到第二天）。真机表现：点一次入睡，她整天不理人。
 *    正确时长 = 各段之和 = 120 + 465 = 585（= 按日程默认入睡）。
 *
 * ② `forceSleepNow` 不收**临时唤醒窗口**：`syncSleepingState` 在临时唤醒期间直接 return，
 *    于是刚写进去的睡眠块被内存里的旧窗口挡住 —— 接口回 `isSleeping:false`、`is_sleeping` 仍 0、
 *    `sleep_until` 不写（"点了入睡她还是醒着"，最多 15 分钟后才睡）。与 `forceWakeNow` 对称处理。
 *
 * ③ `forceWakeNow` 挖睡块时只看本日 24:00：23:30 叫醒（跨午夜睡块的**前半段**）会留下
 *    `00:00~07:45` 那段，第二天凌晨又按日程睡回去（"叫醒了，过一会又睡了"）。
 *    末尾要向前跨过午夜，算到早上那一段的结束。
 *
 * 三条都只动「当日日程快照 + 派生链」（invalidateCache → syncSleepingState → 广播），
 * 不直接手改 `characters.is_sleeping`。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const mgr = await import('../src/services/scheduleManager.js');
const editor = await import('../src/services/scheduleEditor.js');
const hypnosis = await import('../src/services/hypnosisService.js');
const programTime = await import('../src/services/programTime.js');

after(() => {
  try { programTime.resetProgramTime(); } catch { /* ignore */ }
  closeDb();
});

/** 只有夜间睡眠（22:00~07:45，跨午夜，主睡眠 525 分钟） */
const NIGHT = [
  { startTime: '07:45', endTime: '22:00', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
];

let counter = 0;

function seedChar(template = NIGHT) {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 1)`
  ).run(`surg_${counter}`, `手术${counter}`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(template));
  mgr.ensureTodaySchedule(id);
  return id;
}

/** 把程序钟拨到程序世界「今天」的某个钟点（真实时间不动） */
function setProgramClock(hhmm) {
  const result = programTime.setProgramWallClock({ time: hhmm });
  assert.equal(result.ok, true, `设定程序钟失败：${hhmm}`);
  return programTime.getProgramNow();
}

/** 当日日程快照（按当前程序日期） */
function snapshotOf(id) {
  const row = getDb().prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(id, programTime.getProgramDateKey(programTime.getProgramNow()));
  assert.ok(row, '当日日程快照必须存在');
  return JSON.parse(row.schedule_json);
}

const brief = list => list.map(a => `${a.startTime}-${a.endTime}:${a.activity}`);

function rowOf(id) {
  return getDb().prepare('SELECT is_sleeping, sleep_until, temporary_wake_until FROM characters WHERE id = ?').get(id);
}

/** 某个**真实瞬间**在程序世界的墙上时刻 'YYYY-MM-DD HH:MM'（四舍五入到分：库里的串只到秒） */
function programWallOf(instant) {
  const ms = Math.round(programTime.toProgramTime(instant).getTime() / 60000) * 60000;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${programTime.localDateKey(d)} ${hh}:${mm}`;
}

/** sleep_until 必须落在「程序世界某个日期 + 钟点」对应的真实瞬间上（±1 秒） */
function assertSleepUntilAt(id, dateKey, hhmm) {
  const instant = programTime.parseSqlUtc(rowOf(id).sleep_until);
  assert.ok(instant, `sleep_until 必须能解析：${rowOf(id).sleep_until}`);
  const expected = programTime.programWallClockToReal(dateKey, hhmm);
  assert.ok(expected, `程序墙上时刻非法：${dateKey} ${hhmm}`);
  assert.ok(Math.abs(instant.getTime() - expected.getTime()) <= 1000,
    `sleep_until 应落在程序世界 ${dateKey} ${hhmm}，实际 ${programWallOf(instant)}`);
}

// ── ① 立刻入睡（不传 until）＝ 按日程默认时长，不能吞掉一整天 ──

test('① 立刻入睡不传 until：只覆盖 [现在, 现在+主睡眠时长]，当天其它安排必须还在', () => {
  const now = setProgramClock('15:20');
  const id = seedChar();
  mgr.invalidateCache(id);

  const before = snapshotOf(id);
  assert.deepEqual(brief(before), ['07:45-22:00:白天活动', '22:00-07:45:就寝安眠'], '夹具基线');

  const result = editor.forceSleepNow(id, {});
  assert.equal(result.ok, true);

  // 15:20 + 585 分钟（22:00~07:45 的真实时长 = 9h45）= 次日 01:05，而不是 +1440（整天）
  const after = snapshotOf(id);
  assert.deepEqual(brief(after), [
    '01:05-07:45:就寝安眠',
    '07:45-15:20:白天活动',
    '15:20-01:05:催眠入睡——被无形的手按进睡眠',
  ], `立刻入睡不许吞掉一整天（实际：${JSON.stringify(brief(after))}）`);

  const forced = after.find(a => a.forcedSleep === 1);
  assert.equal(forced.replyDelay, -1, '强制睡眠块必须暂不回复');
  assert.equal(forced.startTime, '15:20');
  assert.equal(forced.endTime, '01:05', '结束时刻 = 现在 + 主睡眠时长（585 分钟）');

  // sleep_until 与日程同口径：程序世界「次日 01:05」的真实瞬间
  assert.equal(rowOf(id).is_sleeping, 1);
  assertSleepUntilAt(id, programTime.addDaysToKey(programTime.localDateKey(now), 1), '01:05');

  // 再同步一次不翻回去，当前活动就是这条强制睡眠块
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1);
  assert.equal(mgr.getCurrentActivity(id).forcedSleep, 1);
});

test('① 白天小憩型日程（无主睡眠块）：立刻入睡回落 8 小时兜底，不吞掉一整天', () => {
  const now = setProgramClock('10:00');
  const id = seedChar([
    { startTime: '00:00', endTime: '08:00', activity: '夜间安眠', location: '卧室', replyDelay: -1, tags: ['睡眠', '碎片化'], description: 'x' },
    { startTime: '08:00', endTime: '13:00', activity: '上午工作', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
    { startTime: '13:00', endTime: '13:40', activity: '午睡', location: '沙发', replyDelay: -1, tags: ['小憩'], description: 'x' },
    { startTime: '13:40', endTime: '00:00', activity: '下午与夜里', location: '街区', replyDelay: 0, tags: [], description: 'x' },
  ]);
  mgr.invalidateCache(id);
  const result = editor.forceSleepNow(id, {});
  assert.equal(result.ok, true);
  const after = snapshotOf(id);
  const forced = after.find(a => a.forcedSleep === 1);
  assert.equal(forced.startTime, '10:00');
  assert.equal(forced.endTime, '18:00', '兜底 8 小时（DEFAULT_SLEEP_MINUTES），不是整天');
  assert.ok(after.length >= 3, `其它安排必须保留：${JSON.stringify(brief(after))}`);
  assert.equal(rowOf(id).is_sleeping, 1);
  assertSleepUntilAt(id, programTime.localDateKey(now), '18:00');
});

// ── ② 立刻入睡要把临时唤醒窗口收掉（否则新写的睡眠块被旧窗口挡住）──

test('② 临时唤醒窗口开着时点立刻入睡：窗口先收掉，当场就是睡着（接口形状也不许说"醒着"）', () => {
  setProgramClock('15:20');
  const id = seedChar();
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);

  // 先造一个开着的临时唤醒窗口（= 刚点过强制高潮 / 刚被叫醒）
  const wake = mgr.tempWake(id, { minutes: 10, mode: 'hypnosis' });
  assert.equal(wake.ok, true);
  assert.equal(mgr.isTempWoken(id), true);
  assert.equal(rowOf(id).is_sleeping, 0);

  const state = hypnosis.sleepNow(id);
  assert.deepEqual(Object.keys(state).sort(), ['characterId', 'isSleeping', 'sleepUntil', 'temporaryWakeUntil']);
  assert.equal(state.isSleeping, true, '点了「立刻入睡」就必须是睡着（旧实现被临时唤醒窗口挡住 → false）');
  assert.ok(state.sleepUntil, '睡着的醒来时刻必须写出');
  assert.equal(state.temporaryWakeUntil, null, '旧窗口必须被收掉');

  const row = rowOf(id);
  assert.equal(row.is_sleeping, 1);
  assert.equal(row.temporary_wake_until, null);
  assert.equal(mgr.isTempWoken(id), false);
  assert.equal(mgr.getCurrentActivity(id).forcedSleep, 1, '日程链路里确实是强制睡眠块');

  // 后续同步不会把结论翻回去
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1);
});

test('② 非法 until：400 语义且**零写入**（临时唤醒窗口也必须原样留着）', () => {
  setProgramClock('15:20');
  const id = seedChar();
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  const wake = mgr.tempWake(id, { minutes: 10, mode: 'hypnosis' });
  assert.equal(wake.ok, true);

  const before = { ...rowOf(id) };
  const beforeSchedule = JSON.stringify(snapshotOf(id));
  assert.throws(() => hypnosis.sleepNow(id, { until: '不是时间' }), err => err.code === 'INVALID');

  assert.deepEqual({ ...rowOf(id) }, before, '非法参数不能有任何写入');
  assert.equal(JSON.stringify(snapshotOf(id)), beforeSchedule, '日程也不许被改');
  assert.equal(mgr.isTempWoken(id), true, '校验失败时不能顺手把临时唤醒窗口收掉');
});

// ── ③ 跨午夜睡块：两个半段被叫醒都要挖干净 ──

test('③ 跨午夜睡块**前半段**（23:30）被叫醒：00:00~07:45 那段也要一起挖掉', () => {
  setProgramClock('23:30');
  const id = seedChar();
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1, '23:30 在 22:00~07:45 内');

  editor.forceWakeNow(id);
  const after = snapshotOf(id);
  // 剩下的睡块只能在叫醒时刻收尾；`00:00~07:45` 那段（明天早上）必须一起被挖掉
  assert.ok(!after.some(a => a.replyDelay === -1 && a.startTime === '00:00'),
    `叫醒后不许留下 00:00 之后的睡块（实际：${JSON.stringify(brief(after))}）`);
  const leftSleep = after.filter(a => a.replyDelay === -1);
  assert.equal(leftSleep.length, 1, `只应剩"今天已睡过的那一段"：${JSON.stringify(brief(after))}`);
  assert.equal(leftSleep[0].startTime, '22:00');
  assert.equal(leftSleep[0].endTime, '23:30', '剩下的睡块必须在叫醒时刻收尾（不是 07:45）');
  const wakeBlock = after.find(a => a.forcedWake === 1);
  assert.ok(wakeBlock, '必须写入清醒块');
  assert.equal(wakeBlock.startTime, '23:30');
  assert.equal(wakeBlock.endTime, '07:45', '清醒块要一路顶到早上');
  assert.equal(mgr.getCurrentActivity(id).replyDelay, 0);
  assert.equal(rowOf(id).is_sleeping, 0);
});

test('③ 跨午夜睡块**后半段**（00:30）被叫醒：白天与今晚的睡眠都不许被弄坏', () => {
  setProgramClock('00:30');
  const id = seedChar();
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1, '00:30 在 22:00~07:45 的后半段内');

  editor.forceWakeNow(id);
  const after = snapshotOf(id);
  const nowActivity = mgr.getCurrentActivity(id);
  assert.equal(nowActivity.replyDelay, 0, '00:30 必须是清醒块（不是把当前那段留在睡眠里）');
  assert.equal(rowOf(id).is_sleeping, 0);
  assert.ok(after.some(a => a.replyDelay === -1 && a.startTime === '22:00'),
    `今晚仍要按日程睡下（别把"叫醒"做成"再也不睡"）：${JSON.stringify(brief(after))}`);
  assert.ok(after.some(a => a.replyDelay === 0 && a.startTime === '07:45'),
    `白天依旧清醒：${JSON.stringify(brief(after))}`);
  assert.equal(mgr.getAllOverview(programTime.getProgramNow()).find(c => c.id === id).is_sleeping, false);
});
