import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { captureEventSchedule, extendEventSchedule } = await import('../src/services/eventSchedule.js');
const manager = await import('../src/services/scheduleManager.js');
const generator = await import('../src/services/eventGenerator.js');
const { snapshotTodaySchedule } = await import('../src/services/scheduleGenerator.js');
const bus = await import('../src/services/unifiedStreamBus.js');
const { getLocalDateKey } = await import('../src/utils/localDate.js');

const activity = (startTime, endTime, name, extra = {}) => ({
  startTime, endTime, activity: name, location: '教室', description: '原始描述', replyDelay: 10,
  snapshotPrompt: '原始配图', tags: ['日常'], ...extra,
});
const daySchedule = [activity('00:00', '02:00', '休息'), activity('02:00', '04:00', '上课'),
  activity('04:00', '06:00', '吃饭'), activity('06:00', '08:00', '散步'), activity('08:00', '24:00', '工作')];
const at = (h, m = 0, date = '2026-10-02') => new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
const sqliteTime = date => date.toISOString().replace('T', ' ').slice(0, 19);
const read = (db, id, date = '2026-10-02') => JSON.parse(db.prepare(
  'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?').get(id, date).schedule_json);

function setup(t, schedule = daySchedule, now = at(3)) {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  config.dbPath = ':memory:';
  config.features.schedule = true;
  const db = getDb();
  t.after(() => { manager.invalidateAllCache(); closeDb(); });
  const id = Number(db.prepare("INSERT INTO characters(name, display_name, base_prompt) VALUES ('student', '学生', '认真上课。')").run().lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates(character_id, schedule_json) VALUES (?, ?)').run(id, JSON.stringify(schedule));
  manager.ensureTodaySchedule(id);
  return { db, id, character: db.prepare('SELECT * FROM characters WHERE id = ?').get(id) };
}

function insertEvent(db, id, end, binding = captureEventSchedule(id)) {
  const history = [{ branch: 0, choice_label: '事件开始', summary: '开场', scheduleBinding: binding }];
  const eventId = Number(db.prepare(`INSERT INTO character_events(character_id, event_type_key, status, title,
    description, choice_history, expires_at, created_at) VALUES (?, 'custom', 'open', '上课奇遇', '开场', ?, ?, ?)`)
    .run(id, JSON.stringify(history), sqliteTime(end), sqliteTime(new Date())).lastInsertRowid);
  return db.prepare('SELECT * FROM character_events WHERE id = ?').get(eventId);
}

const llm = payload => ({ chatSync: async () => JSON.stringify(payload) });
const noImage = { generateImageRaw: async () => ({ success: false, images: [] }) };
const opening = { title: '上课奇遇', description: '老师讲课', prompt: '画面', choiceA: '继续听课', choiceB: '举手提问' };
const branch = { description: '继续上课', prompt: '新画面', choiceA: '记笔记', choiceB: '继续提问' };

test('initial generation reserves its entire duration and keeps the opening activity after a slow generation crosses the boundary', async t => {
  const { db, id, character } = setup(t);
  const type = db.prepare('SELECT key FROM event_types LIMIT 1').get().key;
  db.prepare('UPDATE event_types SET duration_min = 120 WHERE key = ?').run(type);
  const event = await generator.generateEvent(character, { eventTypeKey: type, manual: true, llm: llm(opening),
    image: { generateImageRaw: async () => { t.mock.timers.setTime(at(4, 30).getTime()); return { success: false, images: [] }; } } });
  assert.equal(JSON.parse(event.choice_history)[0].scheduleBinding.activity.activity, '上课');
  // ── TTL 锚点：本地与上游的**有意分歧**，这里按本地口径改断言（不是为了让测试变绿）──
  //
  // 上游 3.6.3 的原始断言是 '05:00'，即**按函数开头的 `now` ** 起算 TTL；
  // 本地在 2026-10-01 按真机日志把锚点改成了「**写库时刻**」（见 eventGenerator.js
  // 写库前那段注释）：那次实测出图队列被堵，`Generating` 到 `Event created` 隔了 32 分钟，
  // 而 expires 的秒/毫秒与「任务开始时刻」逐位相同 ⇒ **落库 1.5 秒后即过期**，
  // 玩家一眼都没看到事件就没了（"死胎"）。
  //
  // 所以本用例的期望值是「写库时刻(04:30) + 120 分钟 = 06:30」，日程也相应占到 06:30。
  // 同时**加强**两条不变式（比原断言更强，任何一侧回退都会红）：
  //   ① TTL 必须**满额**：expires_at − created_at === duration
  //   ② **慢生成不许产出"落库即过期"的死胎**：expires_at 必须晚于此刻
  const schedule = read(db, id);
  assert.equal(schedule[1].endTime, '06:30');
  assert.equal(schedule[2].startTime, '06:30');
  assert.equal(schedule[2].endTime, '08:00');
  // ⚠️ 别拿 `event.created_at` 来算 TTL：那一列是 SQLite 的 `CURRENT_TIMESTAMP`，
  //    走的是**真实钟**，而本用例把 JS 的 Date 用 mock 拨到了 2026-10-02 03:00→04:30。
  //    两口钟对不上，相减必然是负数（且随本机当天日期漂移）。
  //    锚点要跟 **JS 侧被 mock 的写库时刻**比 —— 那正是 eventGenerator 用的 `Date.now()`。
  const parseTs = v => new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z');
  const expiresAt = parseTs(event.expires_at);
  assert.equal(expiresAt.toISOString(), at(6, 30).toISOString(),
    `TTL 锚点必须是「写库时刻(被 mock 到 04:30) + 120 分钟」，实际 expires=${event.expires_at}`);
  assert.ok(expiresAt.getTime() > Date.now(),
    '慢生成不许产出"落库即过期"的死胎（2026-10-01 真机事故的回归守卫）');
  assert.equal(manager.getCurrentActivity(id).activity, '上课');
  assert.deepEqual(JSON.parse(db.prepare('SELECT schedule_json FROM schedule_templates WHERE character_id=?').get(id).schedule_json), daySchedule);
});

test('every branch extension reserves the opening schedule and invalidates private-chat activity immediately', async t => {
  const { db, id, character } = setup(t, daySchedule, at(3, 59));
  let event = insertEvent(db, id, at(4, 2));
  manager.getCurrentActivity(id); // 填充私聊缓存
  t.mock.timers.setTime(at(4, 1).getTime());
  manager.invalidateCache(id);
  assert.equal(manager.getCurrentActivity(id).activity, '吃饭');
  const writes = [];
  const client = { write: value => writes.push(value) };
  bus.addClient(client);
  t.after(() => bus.removeClient(client));
  event = await generator.generateNextBranch(character, event, { choice: 'A', label: '继续听课' }, { llm: llm(branch), image: noImage });
  assert.equal(read(db, id)[1].endTime, '04:07');
  assert.equal(read(db, id)[2].startTime, '04:07');
  assert.equal(manager.getCurrentActivity(id).activity, '上课');
  event = await generator.generateNextBranch(character, event, { choice: 'B', label: '继续提问' }, { llm: llm(branch), image: noImage });
  assert.equal(read(db, id)[1].endTime, '04:12');
  assert.equal(read(db, id)[2].startTime, '04:12');
  assert.equal(event.current_branch, 2);
  assert.ok(writes.some(value => value.includes('event: schedule_changed')));
  assert.match(manager.formatScheduleContext(id), /上课/);
  assert.doesNotMatch(manager.formatScheduleContext(id), /吃饭/);
});

test('full coverage removes multiple later activities, preserving the remaining activity metadata and exact endpoints', t => {
  const { db, id } = setup(t);
  const event = insertEvent(db, id, at(7, 30));
  extendEventSchedule(event);
  const schedule = read(db, id);
  assert.deepEqual(schedule.map(item => [item.startTime, item.endTime, item.activity]), [
    ['00:00', '02:00', '休息'], ['02:00', '07:30', '上课'], ['07:30', '08:00', '散步'], ['08:00', '24:00', '工作'],
  ]);
  assert.deepEqual(schedule[1], { ...daySchedule[1], endTime: '07:30' });
  assert.deepEqual(schedule[2], { ...daySchedule[3], startTime: '07:30' });
  assert.deepEqual(extendEventSchedule(event), [], '重复同步幂等');
  event.expires_at = sqliteTime(at(8));
  extendEventSchedule(event);
  assert.ok(!read(db, id).some(item => item.activity === '散步'));
});

test('an event within its original activity leaves schedules unchanged, and expiry rounds up to minute precision', t => {
  const { db, id } = setup(t);
  const event = insertEvent(db, id, at(3, 30));
  assert.deepEqual(extendEventSchedule(event), []);
  assert.deepEqual(read(db, id), daySchedule);
  const end = at(4, 30); end.setSeconds(1);
  event.expires_at = sqliteTime(end);
  extendEventSchedule(event);
  assert.equal(read(db, id)[1].endTime, '04:31');
});

test('cross-midnight extension updates both daily snapshots without altering the earlier morning sleep', t => {
  const schedule = [activity('07:00', '22:00', '工作'), activity('22:00', '23:00', '上课'),
    activity('23:00', '07:00', '睡眠', { replyDelay: -1 })];
  const { db, id } = setup(t, schedule, at(22, 30));
  const event = insertEvent(db, id, at(1, 30, '2026-10-03'));
  extendEventSchedule(event);
  assert.equal(read(db, id).find(item => item.activity === '上课').endTime, '00:00');
  assert.ok(read(db, id).some(item => item.activity === '睡眠' && item.startTime === '00:00' && item.endTime === '07:00'));
  const tomorrow = read(db, id, '2026-10-03');
  assert.ok(tomorrow.some(item => item.activity === '上课' && item.startTime === '00:00' && item.endTime === '01:30'));
  assert.ok(tomorrow.some(item => item.activity === '睡眠' && item.startTime === '01:30' && item.endTime === '07:00'));
});

test('an opening activity already crossing midnight has an absolute end on the following day', t => {
  const { db, id } = setup(t, [activity('07:00', '22:00', '工作'), activity('22:00', '07:00', '夜班')], at(1));
  const binding = captureEventSchedule(id);
  assert.equal(getLocalDateKey(new Date(binding.startAt)), '2026-10-01');
  assert.equal(new Date(binding.endAt).getTime(), at(7).getTime());
  const event = insertEvent(db, id, at(8), binding);
  extendEventSchedule(event);
  assert.ok(read(db, id).some(item => item.activity === '夜班' && item.startTime === '00:00' && item.endTime === '08:00'));
  assert.ok(read(db, id).some(item => item.activity === '工作' && item.startTime === '08:00'));
});

test('no schedule, disabled schedules and openings in schedule gaps do not claim a later activity', t => {
  const { db, id } = setup(t, [activity('04:00', '06:00', '吃饭')]);
  assert.equal(captureEventSchedule(id), null);
  const event = insertEvent(db, id, at(5));
  assert.deepEqual(extendEventSchedule(event), []);
  assert.equal(read(db, id)[0].startTime, '04:00');
  db.prepare('UPDATE characters SET schedule_enabled = 0 WHERE id = ?').run(id);
  assert.equal(captureEventSchedule(id, at(4)), null);
  config.features.schedule = false;
  assert.deepEqual(extendEventSchedule(event), []);
  config.features.schedule = true;
});

test('legacy active encounters bind to their original creation time, not the next current activity', t => {
  const { db, id } = setup(t);
  const event = insertEvent(db, id, at(4, 30));
  event.choice_history = JSON.stringify([{ branch: 0, summary: '旧事件' }]);
  db.prepare('UPDATE character_events SET choice_history=? WHERE id=?').run(event.choice_history, event.id);
  t.mock.timers.setTime(at(4, 15).getTime());
  manager.syncEventSchedule(event);
  assert.equal(read(db, id)[1].endTime, '04:30');
  const stored = db.prepare('SELECT choice_history FROM character_events WHERE id = ?').get(event.id);
  assert.equal(JSON.parse(stored.choice_history)[0].scheduleBinding.activity.activity, '上课');
});

test('branch generation failure retains the existing five-minute extension and keeps its schedule consistent', async t => {
  const { db, id, character } = setup(t, daySchedule, at(3, 59));
  const event = insertEvent(db, id, at(4));
  const result = await generator.generateNextBranch(character, event, { choice: 'A', label: '继续听课' }, {
    llm: { chatSync: async () => 'invalid json' }, image: noImage,
  });
  assert.equal(result.processing, 0);
  assert.equal(result.current_branch, 0);
  assert.equal(result.expires_at, sqliteTime(at(4, 5)));
  assert.equal(read(db, id)[1].endTime, '04:05');
});

test('branch submission updates schedules before the asynchronous narrative starts and clears an obsolete sleeping state', async t => {
  const schedule = [activity('02:00', '04:00', '上课'), activity('04:00', '06:00', '睡眠', { replyDelay: -1 })];
  const { db, id, character } = setup(t, schedule, at(3, 59));
  const event = insertEvent(db, id, at(4, 2));
  t.mock.timers.setTime(at(4, 1).getTime());
  manager.syncSleepingState(id);
  assert.equal(db.prepare('SELECT is_sleeping FROM characters WHERE id=?').get(id).is_sleeping, 1);
  await generator.generateNextBranch(character, event, { choice: 'A', label: '继续听课' }, {
    llm: { chatSync: async () => {
      assert.equal(read(db, id)[0].endTime, '04:07');
      assert.equal(manager.getCurrentActivity(id).activity, '上课');
      assert.equal(db.prepare('SELECT is_sleeping FROM characters WHERE id=?').get(id).is_sleeping, 0);
      return JSON.stringify(branch);
    } }, image: noImage,
  });
});

test('daily refresh and next-day snapshot fallback preserve active event reservations', t => {
  const { db, id } = setup(t, [activity('07:00', '22:00', '工作'), activity('22:00', '23:00', '上课'),
    activity('23:00', '07:00', '睡眠', { replyDelay: -1 })], at(22, 30));
  const event = insertEvent(db, id, at(1, 30, '2026-10-03'));
  extendEventSchedule(event);
  const refreshed = JSON.parse(snapshotTodaySchedule(id));
  assert.equal(refreshed.find(item => item.activity === '上课').endTime, '00:00');
  t.mock.timers.setTime(at(0, 30, '2026-10-03').getTime());
  db.prepare('DELETE FROM daily_schedules WHERE character_id=? AND schedule_date=?').run(id, '2026-10-03');
  manager.invalidateCache(id);
  assert.equal(manager.getCurrentActivity(id).activity, '上课');
  assert.equal(manager.getCurrentActivity(id).endTime, '01:30');
  assert.equal(JSON.parse(snapshotTodaySchedule(id))[0].activity, '上课');
});

test('later branches preserve already-sent special moment status rather than queueing the opening schedule again', t => {
  const editedSchedule = structuredClone(daySchedule);
  Object.assign(editedSchedule[1], { edited: 1, editedSource: 'chat', specialMomentStatus: 'pending' });
  const { db, id } = setup(t, editedSchedule);
  const event = insertEvent(db, id, at(4, 30));
  extendEventSchedule(event);
  const updated = read(db, id);
  updated[1].specialMomentStatus = 'sent';
  db.prepare('UPDATE daily_schedules SET schedule_json=? WHERE character_id=?').run(JSON.stringify(updated), id);
  event.expires_at = sqliteTime(at(5));
  extendEventSchedule(event);
  assert.equal(read(db, id)[1].specialMomentStatus, 'sent');
  assert.equal(read(db, id)[1].endTime, '05:00');
});

test('failed initial narrative generation does not modify schedules or create an encounter', async t => {
  const { db, id, character } = setup(t);
  await assert.rejects(generator.generateEvent(character, {
    customPrompt: '上课', manual: true, llm: { chatSync: async () => 'invalid json' }, image: noImage,
  }));
  assert.deepEqual(read(db, id), daySchedule);
  assert.equal(db.prepare('SELECT count(*) n FROM character_events WHERE character_id=?').get(id).n, 0);
});

test('an encounter occupying a complete future day keeps valid, nonempty time slots', t => {
  const { db, id } = setup(t);
  const event = insertEvent(db, id, at(0, 0, '2026-10-04'));
  extendEventSchedule(event);
  const tomorrow = read(db, id, '2026-10-03');
  assert.deepEqual(tomorrow.map(item => [item.startTime, item.endTime, item.activity]), [
    ['00:00', '12:00', '上课'], ['12:00', '00:00', '上课'],
  ]);
  assert.deepEqual(extendEventSchedule(event), []);
  t.mock.timers.setTime(at(23, 59, '2026-10-03').getTime());
  manager.invalidateCache(id);
  assert.equal(manager.getCurrentActivity(id).activity, '上课');
});
