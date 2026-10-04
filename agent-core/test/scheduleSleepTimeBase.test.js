/**
 * 任务 A 补丁：**「临时唤醒」是真实时间窗口，读路径也必须按真实时间判定**
 *
 * 真机/口径背景：`characters.temporary_wake_until` 存的是**真实瞬间**（无时区 UTC 串，
 * 见 programTime.js 与 scheduleManager.tempWake 的写入口径），而 `isTempWoken(id, now)`
 * 的第二参是**真实时间**。但 `formatScheduleContext()` / `getReplyDelay()` 手上的 `now`
 * 是**程序时间**（`getProgramNow()`，程序钟可以被人为拨到未来/过去）。
 *
 * 拨快程序钟时（时间控制面板「推进 N 天」/「设定钟点」、或跳天之后），
 * `until(真实) > now(程序+偏移)` 恒为假 →
 *   · `formatScheduleContext` 会把"刚被临时唤醒的人"重新写成「你正在睡觉。不要回复任何消息」
 *     —— 正是催眠指令触发前那次临时唤醒（`wakeForForcedTrigger`）要消掉的东西；
 *   · `getReplyDelay` 会把她的回复重新塞进"排队到醒来"。
 * 这与写入口径（tempWake/parseSqlUtc）自相矛盾，所以读路径统一改成按真实时间判定。
 *
 * 本文件锁：
 *   ① 程序钟拨到夜里 + 临时唤醒 → `is_sleeping=0`、秒回、上下文是"被催眠指令从睡眠里拉出来"，
 *      **不再出现**「你正在睡觉」；
 *   ② 反向不修坏：**没有**临时唤醒时，程序钟说了算（夜里睡着、白天醒着）；
 *   ③ 取消临时唤醒后，回落到程序钟的日程结论（睡着）。
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
const programTime = await import('../src/services/programTime.js');

after(() => {
  // 别把程序钟留给同文件后续/其它用例（本文件是独立进程，这里只是收尾干净）
  try { programTime.resetProgramTime(); } catch { /* ignore */ }
  closeDb();
});

/** 只有夜间睡眠（22:00~07:45），白天全是普通活动 */
const NIGHT_ONLY = [
  { startTime: '07:45', endTime: '12:00', activity: '上午工作', location: '事务所', replyDelay: 0, tags: ['工作'], description: '伏案工作。' },
  { startTime: '12:00', endTime: '18:00', activity: '下午外出', location: '街区', replyDelay: 0, tags: ['外出'], description: '外出办事。' },
  { startTime: '18:00', endTime: '22:00', activity: '晚间休闲', location: '公寓', replyDelay: 0, tags: ['休闲'], description: '在家休息。' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '公寓卧室', replyDelay: -1, tags: ['睡眠'], description: '沉入睡眠。' },
];

let counter = 0;

function seedChar() {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 1)`
  ).run(`tb_${counter}`, `时基${counter}`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(NIGHT_ONLY));
  mgr.ensureTodaySchedule(id);
  return id;
}

function rowOf(id) {
  return getDb().prepare('SELECT is_sleeping, sleep_until, temporary_wake_until, wake_mode FROM characters WHERE id = ?').get(id);
}

/** 把程序钟拨到程序世界「今天」的某个钟点（真实时间不受影响） */
function setProgramClock(hhmm) {
  const result = programTime.setProgramWallClock({ time: hhmm });
  assert.equal(result.ok, true, `设定程序钟失败：${hhmm}`);
  return programTime.getProgramNow();
}

// ── ① 程序钟在夜里 + 临时唤醒 → 读路径必须认"被叫醒了" ──

test('① 程序钟拨到夜里后临时唤醒：is_sleeping=0、秒回，上下文不再写「你正在睡觉」', () => {
  const id = seedChar();

  // 程序世界 02:15（夜里睡块内），真实时间仍是"现在"
  const programNow = setProgramClock('02:15');
  assert.equal(programNow.getHours(), 2);
  assert.equal(programNow.getMinutes(), 15);

  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1, '程序钟 02:15 在夜间睡块内 → 睡着');

  // 没有临时唤醒时，程序时间说了算：上下文如实写"你正在睡觉"
  assert.ok(mgr.formatScheduleContext(id).includes('你正在睡觉'), '临时唤醒之前应当是"睡觉中"的上下文');

  // 催眠指令触发前的那次临时唤醒（真实时间窗口）
  const wake = mgr.tempWake(id, { minutes: 5, mode: 'hypnosis' });
  assert.equal(wake.ok, true);
  const until = programTime.parseSqlUtc(wake.temporaryWakeUntil);
  assert.ok(until, '临时唤醒窗口必须能解析');
  assert.ok(Math.abs((until.getTime() - Date.now()) / 60000 - 5) < 1,
    '临时唤醒窗口是**真实** 5 分钟（程序钟偏移不算进去）');

  const row = rowOf(id);
  assert.equal(row.is_sleeping, 0, '临时唤醒期间全局睡眠闸门要让开');
  assert.equal(row.wake_mode, 'hypnosis');

  // 睡眠状态视图（催眠面板/睡眠控制返回形状的来源）：按真实时间
  const status = mgr.getSleepStatus(id);
  assert.equal(status.isSleeping, false);
  assert.equal(status.temporaryWakeUntil, wake.temporaryWakeUntil);
  assert.equal(mgr.isSleeping(id).sleeping, false, '临时唤醒期间不算睡着');
  assert.equal(mgr.isTempWoken(id), true);

  // 读路径（chat.js 用的两个入口）也必须是"刚被叫醒"，而不是"还在睡"
  assert.equal(mgr.getReplyDelay(id).delay, 0, '被临时唤醒的人必须秒回，不能重新排队到醒来');
  const ctx = mgr.formatScheduleContext(id);
  assert.ok(ctx.includes('催眠指令从睡眠中拉了出来'), `唤醒措辞必须生效（程序钟偏移不为 0 时也一样）：${ctx}`);
  assert.ok(!ctx.includes('你正在睡觉'), `临时唤醒后不能再出现「你正在睡觉」：${ctx}`);

  // 同步一次不会把她翻回睡眠（临时唤醒期间 syncSleepingState 必须跳过）
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 0, '临时唤醒期间同步不能翻回睡着');
});

// ── ② 反向不修坏：没有临时唤醒时，程序钟的日程结论说了算 ──

test('② 没有临时唤醒时：程序钟白天 → 醒着；程序钟夜里 → 睡着（不许被这条口径改坏）', () => {
  const id = seedChar();

  const day = setProgramClock('15:21');
  assert.equal(day.getHours(), 15);
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 0, '程序世界白天必须醒着');
  assert.equal(mgr.isTempWoken(id), false);
  assert.equal(mgr.getReplyDelay(id).delay, 0);
  assert.ok(!mgr.formatScheduleContext(id).includes('你正在睡觉'));

  const night = setProgramClock('03:40');
  assert.equal(night.getHours(), 3);
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1, '程序世界深夜必须睡着');
  assert.equal(mgr.getReplyDelay(id).delay, -1);
  assert.equal(mgr.getReplyDelay(id).sleepKind, 'main');
  const ctx = mgr.formatScheduleContext(id);
  assert.ok(ctx.includes('你正在睡觉'), `夜里必须保留原口径：${ctx}`);
});

// ── ③ 取消临时唤醒 → 回落到程序钟的日程结论 ──

test('③ 取消临时唤醒（立刻唤醒的收尾）→ 按程序钟的日程定她该睡该醒', () => {
  const id = seedChar();
  setProgramClock('02:30');
  mgr.invalidateCache(id);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1);

  mgr.tempWake(id, { minutes: 5, mode: 'hypnosis' });
  assert.equal(mgr.isTempWoken(id), true);

  // clearTempWake 只清窗口与定时器，不自己下结论 —— 之后由 syncSleepingState 按日程定
  mgr.clearTempWake(id);
  assert.equal(mgr.isTempWoken(id), false);
  assert.equal(rowOf(id).temporary_wake_until, null);
  mgr.syncSleepingState(id);
  assert.equal(rowOf(id).is_sleeping, 1, '程序钟仍在夜里睡块内 → 窗口收掉后应当睡着');
  assert.ok(rowOf(id).sleep_until, '睡着时 sleep_until 必须如实写');
});
