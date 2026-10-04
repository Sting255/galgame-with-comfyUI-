/**
 * 催眠手机：服务层回归（状态机 / 指令 / 遗忘-恢复 / 门控 / 总开关）
 *
 * 覆盖 task-28 契约里的每条验收点，并固定两处**口径修正**：
 *   1. 归档用 status='archived'（契约原文写 softDeleteMemory，实测它置 'deleted' 且唯一恢复
 *      函数只收 'archived'，照抄会"忘了永远恢复不了"）；
 *   2. forced_climax 的幂等锚点用本次会话 started_at（不是 command_count——后者每点一次就变）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`hypnosis fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb, migrateHypnosisSchema } = await import('../src/db/index.js');
const {
  getHypnosisState, isHypnotized, isBodyControlled, isMindAwake, getPendingDirective,
  consumePendingDirective, hypnotize, wake, issueCommand, forgetWindow,
  listForgottenWindows, restoreForgottenWindow, isRawForgotten, filterForgottenRawIds,
  getHypnosisGate, grantHypnosisPhone,
} = await import('../src/services/hypnosisService.js');
const { saveAffinity, setOath } = await import('../src/services/emotionEngine.js');
const { listIntimateLogs } = await import('../src/services/intimateService.js');

/** 干净库 + 一个角色（角色 id 固定 1） */
function seed(t, { phone = true, affinity = 100, oath = true } = {}) {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(
    `INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'hypno', '催眠测试', '旅客')`
  ).run();
  if (phone) grantHypnosisPhone();
  if (affinity != null) saveAffinity(1, affinity, false);
  if (oath) setOath(1, 1);
  return 1;
}

function seedRaw(conversationId, role, content, createdAt = null) {
  const db = getDb();
  if (createdAt) {
    return Number(db.prepare(
      `INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`
    ).run(conversationId, role, content, createdAt).lastInsertRowid);
  }
  return Number(db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)`
  ).run(conversationId, role, content).lastInsertRowid);
}

function seedMemory({ memoryId, conversationId, startRawId, endRawId, status = 'active' }) {
  getDb().prepare(
    `INSERT INTO memory_fragments
       (memory_id, conversation_id, fragment_type, content, status, memory_type, subject, judgment,
        source_raw_start_id, source_raw_end_id)
     VALUES (?, ?, 'fact', ?, ?, 'knowledge', 'user', ?, ?, ?)`
  ).run(memoryId, conversationId, `记忆 ${memoryId}`, status, `记忆内容 ${memoryId}`, startRawId, endRawId);
}

const pastTime = () => getDb().prepare(`SELECT datetime('now', '-2 hours') AS t`).get().t;

// ──────────────── 迁移 ────────────────

test('迁移幂等：连调两次不报错，两张表与索引就位', async t => {
  const db = getDb();
  t.after(() => closeDb());
  migrateHypnosisSchema(db);
  migrateHypnosisSchema(db);

  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  assert.ok(tables.includes('character_hypnosis'));
  assert.ok(tables.includes('hypnosis_forgotten_windows'));
  const index = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map(r => r.name);
  assert.ok(index.includes('idx_hypnosis_forgotten'));
  const cols = db.prepare('PRAGMA table_info(hypnosis_forgotten_windows)').all().map(c => c.name);
  assert.ok(cols.includes('memory_ids'), '窗口表必须有 memory_ids（精确撤销用）');
});

test('迁移兼容老库：已建过 character_hypnosis（缺 session_start_raw_id）时幂等补列', async t => {
  const db = getDb();
  t.after(() => closeDb());
  // 模拟 v3.7.0 首版建的表：没有 session_start_raw_id 这一列
  db.exec('DROP TABLE character_hypnosis');
  db.exec(`CREATE TABLE character_hypnosis (
    character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    body_controlled INTEGER NOT NULL DEFAULT 0,
    mind_awake INTEGER NOT NULL DEFAULT 0,
    active_until DATETIME,
    started_at DATETIME,
    pending_directive TEXT NOT NULL DEFAULT '',
    pending_at DATETIME,
    command_count INTEGER NOT NULL DEFAULT 0,
    last_command TEXT NOT NULL DEFAULT '',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(`INSERT INTO character_hypnosis (character_id, body_controlled, mind_awake) VALUES (1, 1, 0)`).run();

  migrateHypnosisSchema(db); // 第一次：ALTER 补列（存量行默认 0）
  migrateHypnosisSchema(db); // 第二次：必须幂等、不重复 ALTER

  const cols = db.prepare('PRAGMA table_info(character_hypnosis)').all().map(c => c.name);
  assert.ok(cols.includes('session_start_raw_id'), '老库必须补上这一列（否则 hypnotize 会 500）');
  assert.equal(
    db.prepare('SELECT session_start_raw_id FROM character_hypnosis WHERE character_id = 1').get().session_start_raw_id,
    0,
    '存量行默认 0 → forgetWindow 走时间回退分支',
  );
  assert.equal(db.prepare('SELECT body_controlled FROM character_hypnosis WHERE character_id = 1').get().body_controlled, 1, '补列不动存量数据');
});

// ──────────────── 门控 ────────────────

test('门控只剩一态：无道具 → 拒绝且状态零改动；好感度与誓约都不参与门控', async t => {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'hypno', '催眠测试', '旅客')`).run();

  // ① 无道具（但好感/誓约都够）
  saveAffinity(1, 100, false);
  setOath(1, 1);
  let gate = getHypnosisGate(1);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'no_phone');
  assert.equal(gate.reason, '背包里没有催眠手机');
  assert.throws(() => hypnotize(1, { minutes: 30 }), /hypnosis gate not met/);
  assert.equal(getHypnosisState(1).active, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_hypnosis').get().n, 0, '被拒时不该写状态行');

  // ② 有道具就放行：未誓约 + 好感度只有 5 也不再拦
  //    （好感度 2026-09-28 按用户要求移除；誓约同日按用户口径「契约也不用 直接就用催眠手机 直接强制使用」移除）
  grantHypnosisPhone();
  saveAffinity(1, 5, false);
  setOath(1, 0);
  gate = getHypnosisGate(1);
  assert.equal(gate.code, 'ok', '誓约已不参与门控');
  assert.equal(gate.allowed, gate.code === 'ok');
  assert.equal(gate.reason, '');
  assert.deepEqual({ allowed: gate.allowed, affinity: gate.affinity, isOath: gate.isOath, hasPhone: gate.hasPhone },
    { allowed: true, affinity: 5, isOath: false, hasPhone: true }, 'affinity / isOath 只作展示，不参与判定');

  // ③ 补上誓约后同样放行（isOath 只是展示字段，有没有都不影响判定）
  setOath(1, 1);
  gate = getHypnosisGate(1);
  assert.equal(gate.code, 'ok', '有誓约也走同一条路');
  assert.equal(gate.isOath, true, 'isOath 仍是展示字段');
  const state = hypnotize(1, { minutes: 30 });
  assert.equal(state.active, true);
  assert.equal(state.bodyControlled, true);
  assert.equal(state.mindAwake, false);
  assert.equal(state.gate.code, 'ok', 'state.gate 也要带机器码');
});

test('门控 reason 只报第一个未满足项（差在哪说得清）', async t => {
  seed(t, { phone: false, affinity: 10, oath: false });
  const gate = getHypnosisGate(1);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, '背包里没有催眠手机');
});

// ──────────────── 时长 clamp / 再次催眠 ────────────────

test('催眠时长 clamp：0/1/720/9999/非数字', async t => {
  seed(t);
  const cases = [
    [0, 1], [1, 1], [720, 720], [9999, 720], [null, 30], ['abc', 30], [undefined, 30], [12.9, 12],
  ];
  for (const [input, expected] of cases) {
    const state = hypnotize(1, { minutes: input });
    const minutes = getDb().prepare(
      `SELECT CAST(ROUND((julianday(active_until) - julianday('now')) * 24 * 60) AS INTEGER) AS m FROM character_hypnosis WHERE character_id = 1`
    ).get().m;
    assert.equal(minutes, expected, `minutes=${JSON.stringify(input)} 应 clamp 到 ${expected}（实际 ${minutes}）`);
    assert.equal(state.active, true);
  }
});

test('再次催眠 = 重新开始：started_at 刷新、意志归零、计数递增', async t => {
  seed(t);
  const first = hypnotize(1, { minutes: 30 });
  // 手动把 started_at 拨到过去 + 意志唤醒，模拟"催眠中只唤醒意志"后再催眠
  getDb().prepare(`UPDATE character_hypnosis SET started_at = datetime('now','-90 minutes'), mind_awake = 1 WHERE character_id = 1`).run();
  const before = getDb().prepare('SELECT started_at, command_count FROM character_hypnosis WHERE character_id = 1').get();

  const second = hypnotize(1, { minutes: 45 });
  assert.equal(second.mindAwake, false, '再次催眠必须重置意志状态');
  assert.equal(second.bodyControlled, true);
  assert.notEqual(second.startedAt, before.started_at, 'started_at 应刷新为本次开始时间');
  assert.equal(second.commandCount, Number(before.command_count) + 1);
  assert.equal(second.lastCommand, 'hypnotize');
  assert.ok(second.activeUntil > first.activeUntil || second.activeUntil !== first.activeUntil);
});

// ──────────────── 唤醒（正交） ────────────────

test('wake：只唤醒意志 ≠ 全醒（body_controlled 与 mind_awake 正交）', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });

  // 只唤醒意志：身体仍受控、意志清醒
  const mind = wake(1, { mode: 'mind' });
  assert.equal(mind.mindAwake, true);
  assert.equal(mind.bodyControlled, true, '「只唤醒意志」必须保留身体受控');
  assert.equal(mind.active, true);
  assert.equal(mind.lastCommand, 'wake:mind');
  assert.equal(isMindAwake(1), true);
  assert.equal(isBodyControlled(1), true);
  assert.equal(isHypnotized(1), true);

  // 全醒：两者归零、active_until 清空，但 started_at 保留（遗忘窗口还要用）
  const full = wake(1, { mode: 'full' });
  assert.equal(full.bodyControlled, false);
  assert.equal(full.mindAwake, false);
  assert.equal(full.active, false);
  assert.equal(full.activeUntil, null);
  assert.equal(full.startedAt, mind.startedAt, '全醒不该丢掉 started_at');
  assert.equal(full.lastCommand, 'wake:full');
  assert.equal(isHypnotized(1), false);
});

test('wake(mode=mind) 在未催眠时 409 语义；full 是幂等空操作', async t => {
  seed(t);
  assert.throws(() => wake(1, { mode: 'mind' }), err => err.code === 'NOT_HYPNOTIZED');
  // full 在未催眠时也允许（幂等），不抛
  const state = wake(1, { mode: 'full' });
  assert.equal(state.active, false);
  assert.equal(state.bodyControlled, false);
});

test('唤醒反应：真的从"受控/被压制"变成"醒着"的那一次挂 wake_reaction，幂等唤醒不重复挂', async t => {
  seed(t);
  // 未催眠（幂等空唤醒）→ 不是"刚醒"，不挂
  wake(1, { mode: 'full' });
  assert.equal(getPendingDirective(1), '', '没真的醒过来就不该挂');

  // 深度催眠 → 全醒：挂
  hypnotize(1, { minutes: 30 });
  const full = wake(1, { mode: 'full' });
  assert.equal(full.pendingDirective, 'wake_reaction');
  assert.equal(consumePendingDirective(1), 'wake_reaction', '一次性：下一轮注入后清空');
  assert.equal(consumePendingDirective(1), '');

  // 会话已过期（本次 active=false）不算"被唤醒"，不挂
  hypnotize(1, { minutes: 30 });
  getDb().prepare(`UPDATE character_hypnosis SET active_until = datetime('now', '-1 minutes') WHERE character_id = 1`).run();
  assert.equal(wake(1, { mode: 'full' }).pendingDirective, '', '过期清状态不是"刚被唤醒"');

  // 只唤醒意志：意志从"被压制"变成"清醒" → 挂；已经是清醒意志再点不重复挂
  hypnotize(1, { minutes: 30 });
  const mind = wake(1, { mode: 'mind' });
  assert.equal(mind.pendingDirective, 'wake_reaction');
  assert.equal(mind.bodyControlled, true, '只唤醒意志仍保持身体受控');
  assert.equal(consumePendingDirective(1), 'wake_reaction');
  assert.equal(wake(1, { mode: 'mind' }).pendingDirective, '', '意志已经清醒 → 不是新的转变');

  // 从"只唤醒意志"直接全醒：也是一次真实的醒来
  assert.equal(wake(1, { mode: 'full' }).pendingDirective, 'wake_reaction');
  // 已经全醒后再点：不挂（UPDATE 顺带清掉上一条未消费的指令，这是既有语义）
  assert.equal(wake(1, { mode: 'full' }).pendingDirective, '');
});

test('惰性过期：active_until 过去后读 state 自动归零并落库', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  getDb().prepare(`UPDATE character_hypnosis SET active_until = datetime('now', '-1 minutes') WHERE character_id = 1`).run();

  const state = getHypnosisState(1);
  assert.equal(state.active, false, '过期即视为未催眠');
  assert.equal(state.bodyControlled, false);
  assert.equal(state.mindAwake, false);
  const row = getDb().prepare('SELECT * FROM character_hypnosis WHERE character_id = 1').get();
  assert.equal(row.body_controlled, 0, '惰性过期必须落库归零');
  assert.equal(row.mind_awake, 0);
  assert.equal(row.active_until, null);
  assert.equal(row.last_command, 'expired');
  assert.ok(row.started_at, '过期不影响 started_at（遗忘窗口左端）');
});

// ──────────────── 指令 ────────────────

test('指令：body_control 未催眠仍拒绝；forced_climax 非催眠态放行（只记指令、不写催眠状态）', async t => {
  seed(t);
  // task-42 口径修订（用户原话「再加一个 强制高潮不需要催眠 随时都能触发」）：
  // forced_climax 不再要求催眠；body_control 保持"必须催眠中"。
  assert.throws(() => issueCommand(1, 'body_control'), err => err.code === 'NOT_HYPNOTIZED');
  assert.throws(() => issueCommand(1, 'nope'), err => err.code === 'INVALID');

  // ① 从没被催眠过：连状态行都没有 → upsert 只写指令列，催眠状态一个都不许写
  const awake = issueCommand(1, 'forced_climax');
  assert.equal(awake.pendingDirective, 'forced_climax', '非催眠态也要能下发指令');
  assert.equal(awake.active, false, '不得假装被催眠');
  assert.equal(awake.bodyControlled, false);
  assert.equal(awake.mindAwake, false);
  const awakeRow = getDb().prepare('SELECT * FROM character_hypnosis WHERE character_id = 1').get();
  assert.equal(awakeRow.body_controlled, 0, '不写催眠状态');
  assert.equal(awakeRow.mind_awake, 0);
  assert.equal(awakeRow.active_until, null, 'active_until 必须保持 NULL（否则下一轮会被当成催眠中）');
  assert.equal(awakeRow.pending_directive, 'forced_climax');
  assert.equal(awake.intimate?.inserted, 1, '非催眠态照样计入亲密看板');
  assert.equal(consumePendingDirective(1), 'forced_climax', '仍旧是一次性指令，消费即清空');

  // ② 会话已过期（started_at 残留）同样按非催眠处理，且不得复活会话
  hypnotize(1, { minutes: 30 });
  getDb().prepare(`UPDATE character_hypnosis SET active_until = datetime('now', '-1 minutes') WHERE character_id = 1`).run();
  const expired = issueCommand(1, 'forced_climax');
  assert.equal(expired.active, false, '过期会话不得被指令复活');
  assert.equal(expired.pendingDirective, 'forced_climax');
  assert.throws(() => issueCommand(1, 'body_control'), err => err.code === 'NOT_HYPNOTIZED', '过期后 body_control 仍拒绝');
});

test('指令：催眠中的 body_control / forced_climax 既有语义（同一会话重复点不重复计数）', async t => {
  seed(t);
  hypnotize(1, { minutes: 60 });

  // body_control：只置一次性指令
  const body = issueCommand(1, 'body_control');
  assert.equal(body.pendingDirective, 'body_control');
  assert.equal(getPendingDirective(1), 'body_control');
  // 取走即清空（一次性）
  assert.equal(consumePendingDirective(1), 'body_control');
  assert.equal(consumePendingDirective(1), '');

  // forced_climax：看板落 1 行
  const first = issueCommand(1, 'forced_climax');
  assert.equal(first.pendingDirective, 'forced_climax');
  assert.equal(first.intimate?.inserted, 1, '应记 1 笔');
  let logs = listIntimateLogs(1, { partnerKinds: 'all' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actKey, 'climax');
  assert.equal(logs[0].scene, 'hypnosis', 'scene 必须是 hypnosis（SCENES 已扩）');
  // 面板「高潮次数」读 SUM(climax_count)，只写 count 不写 climax_count 会恒为 0（真机诊断）
  assert.equal(logs[0].climaxCount, 1, '每一笔强制高潮都要有 climaxCount=1');

  // 同一次催眠内再点：不重复计数
  const second = issueCommand(1, 'forced_climax');
  assert.equal(second.intimate?.inserted, 0);
  assert.equal(second.intimate?.skipped, 1);
  logs = listIntimateLogs(1, { partnerKinds: 'all' });
  assert.equal(logs.length, 1, '同一会话内重复点击不得重复计数');

  // 重新催眠 = 新会话 → 可以再记一笔
  hypnotize(1, { minutes: 60 });
  const third = issueCommand(1, 'forced_climax');
  assert.equal(third.intimate?.inserted, 1);
  assert.equal(listIntimateLogs(1, { partnerKinds: 'all' }).length, 2);
});

test('强制高潮记账：一次点击只落一笔；非催眠态每次点击各记一笔（无会话锚点）', async t => {
  seed(t);
  const logs = () => listIntimateLogs(1, { partnerKinds: 'all' });

  // ① 一次点击 = 恰好一笔；消费指令（= 紧随那一轮的表演）**不会**再记一笔
  issueCommand(1, 'forced_climax');
  assert.equal(logs().length, 1);
  assert.equal(consumePendingDirective(1), 'forced_climax');
  assert.equal(logs().length, 1, '表演轮消费指令不得重复记账');

  // ② 非催眠态没有"会话"可复用 → 每次点击各记一笔；锚点带进程内自增序号，同一毫秒连点也不撞
  issueCommand(1, 'forced_climax');
  issueCommand(1, 'forced_climax');
  assert.equal(logs().length, 3, '非催眠态每次点击都要在看板落一笔（否则一辈子只 1 笔）');
  assert.equal(logs().reduce((n, row) => n + Number(row.climaxCount || 0), 0), 3, 'SUM(climax_count) 要跟着每次点击涨');

  // ③ 催眠中仍按会话锚点：同一场里重复点只 1 笔
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'forced_climax');
  issueCommand(1, 'forced_climax');
  assert.equal(logs().length, 4, '同一场催眠只加 1 笔');
});

test('记账入口唯一：recordForcedClimax 只被 issueCommand 调用（表演轮不重复记同一笔）', async () => {
  const source = await readFile(new URL('../src/services/hypnosisService.js', import.meta.url), 'utf8');
  assert.equal((source.match(/recordForcedClimax\(/g) || []).length, 2, '一次定义 + 一次调用，不允许第二个调用点');
  assert.ok(source.includes('result.intimate = recordForcedClimax(id, state, inHypnosis);'));
  const scheduler = await readFile(new URL('../src/services/proactiveChatScheduler.js', import.meta.url), 'utf8');
  assert.ok(!scheduler.includes('recordForcedClimax'), '强制高潮轮（主动聊天）不得再记一笔');
  const chat = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(!chat.includes('recordForcedClimax'), '私聊回复轮不得再记一笔');
});

// ──────────────── 遗忘 / 恢复 ────────────────

test('遗忘：窗口内记忆归档、窗口外不动；恢复按 memory_ids 精确还原且不误伤 T3 归档', async t => {
  seed(t);
  const conv = 'char_1';
  // 窗口左端按 raw id 判定：催眠前先有一条 raw，催眠之后发的 r2/r3 才落在窗口内
  const r1 = seedRaw(conv, 'user', '催眠前的一轮');
  hypnotize(1, { minutes: 60 });
  const r2 = seedRaw(conv, 'assistant', '第二轮');
  const r3 = seedRaw(conv, 'user', '第三轮');
  // 窗口内一条、窗口外一条、以及一条被 T3 自动归档（status='archived'，不在 memory_ids 里）
  seedMemory({ memoryId: 'm_in', conversationId: conv, startRawId: r2, endRawId: r3 });
  seedMemory({ memoryId: 'm_out', conversationId: conv, startRawId: r1, endRawId: r1 });
  seedMemory({ memoryId: 'm_t3', conversationId: conv, startRawId: r2, endRawId: r3, status: 'archived' });

  const forgotten = forgetWindow(1);
  assert.equal(forgotten.fromRawId, r2);
  assert.equal(forgotten.toRawId, r3);
  assert.equal(forgotten.archived, 1, '只归档窗口内的活跃记忆');

  const db = getDb();
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_in'`).get().status, 'archived');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_out'`).get().status, 'active', '窗口外记忆不受影响');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_t3'`).get().status, 'archived');

  // 窗口行
  const win = db.prepare('SELECT * FROM hypnosis_forgotten_windows WHERE id = ?').get(forgotten.windowId);
  assert.equal(win.status, 'active');
  assert.equal(win.memories_archived, 1);
  assert.deepEqual(JSON.parse(win.memory_ids), ['m_in']);
  // 遗忘即结束控制
  assert.equal(getHypnosisState(1).active, false);

  // 上下文屏蔽用
  assert.equal(isRawForgotten(1, r2), true);
  assert.equal(isRawForgotten(1, r3), true);
  assert.equal(isRawForgotten(1, r1), false);
  assert.deepEqual(filterForgottenRawIds(1, [r1, r2, r3]), [r1]);

  // 恢复：精确还原 + 窗口转 restored + 留下一次性叙事指令
  const restoredResult = restoreForgottenWindow(forgotten.windowId);
  assert.equal(restoredResult.restored, 1);
  assert.equal(restoredResult.pendingDirective, 'memory_restore');
  assert.equal(restoredResult.window.status, 'restored');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_in'`).get().status, 'active');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_t3'`).get().status, 'archived',
    'T3 自动归档的记忆不该被误还原（memory_ids 精确还原的价值）');
  assert.equal(consumePendingDirective(1), 'memory_restore', '恢复后下一轮要能注入"记忆涌回"叙事');

  // 默认列表只看 active
  assert.deepEqual(listForgottenWindows(1).map(w => w.id), []);
  assert.deepEqual(listForgottenWindows(1, { status: 'restored' }).map(w => w.id), [forgotten.windowId]);
});

test('遗忘边界：没有催眠会话 → 拒绝；窗口内无 raw → 空区间仍留审计行', async t => {
  seed(t);
  assert.throws(() => forgetWindow(1), err => err.code === 'NO_SESSION');

  hypnotize(1, { minutes: 30 });
  const result = forgetWindow(1); // 该会话没有任何 raw
  assert.equal(result.archived, 0);
  assert.equal(result.fromRawId, 1, '空区间用 maxId+1（maxId=0）表示，不覆盖任何 raw');
  assert.equal(result.toRawId, 0);
  const win = listForgottenWindows(1)[0];
  assert.ok(win, '即使没忘掉任何东西也要留一条可审计窗口');
});

test('isRawForgotten / filterForgottenRawIds 边界与零开销', async t => {  seed(t);
  // 无窗口：原样返回（不查库也该一致）
  assert.equal(isRawForgotten(1, 5), false);
  assert.deepEqual(filterForgottenRawIds(1, [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(filterForgottenRawIds(1, []), []);
  assert.deepEqual(filterForgottenRawIds(1, null), []);

  getDb().prepare(
    `INSERT INTO hypnosis_forgotten_windows (character_id, from_raw_id, to_raw_id, status) VALUES (1, 10, 20, 'active')`
  ).run();
  assert.equal(isRawForgotten(1, 9), false, '左边界外');
  assert.equal(isRawForgotten(1, 10), true, '左边界含');
  assert.equal(isRawForgotten(1, 15), true);
  assert.equal(isRawForgotten(1, 20), true, '右边界含');
  assert.equal(isRawForgotten(1, 21), false, '右边界外');
  assert.deepEqual(filterForgottenRawIds(1, [9, 10, 20, 21]), [9, 21]);

  // restored 窗口不再屏蔽
  getDb().prepare(`UPDATE hypnosis_forgotten_windows SET status = 'restored'`).run();
  assert.equal(isRawForgotten(1, 15), false, '已撤销的窗口不再屏蔽');
});

// ──────────────── 总开关 / 道具 ────────────────

test('总开关关闭：写操作被拒（含道具无效），读 state 不拦', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  const saved = config.features.hypnosis;
  t.after(() => { config.features.hypnosis = saved; });

  config.features.hypnosis = false;
  assert.throws(() => hypnotize(1, { minutes: 30 }), err => err.code === 'DISABLED');
  assert.throws(() => wake(1, { mode: 'full' }), err => err.code === 'DISABLED');
  assert.throws(() => issueCommand(1, 'body_control'), err => err.code === 'DISABLED');
  assert.throws(() => forgetWindow(1), err => err.code === 'DISABLED');
  const state = getHypnosisState(1); // 读不拦
  assert.equal(state.characterId, 1);
  assert.equal(state.active, true, '总开关不应偷偷改状态');
});

test('grantHypnosisPhone：幂等（已有一台未使用就不重复塞）；useItem 不消耗；可丢弃', async t => {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'hypno', '催眠测试', '旅客')`).run();

  const first = grantHypnosisPhone();
  assert.equal(first.item.effect_key, 'hypnosis_phone');
  assert.equal(first.item.effect_name, '催眠手机');
  assert.equal(first.item.kind, 'special');
  const second = grantHypnosisPhone();
  assert.equal(second.item.id, first.item.id, '第二次领取应复用同一台');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM backpack_items WHERE effect_key = 'hypnosis_phone'`).get().n, 1);

  const { useItem, discardItem, listBackpack } = await import('../src/services/itemService.js');
  const used = useItem(first.item.id, 1);
  assert.equal(used.ok, true);
  assert.equal(used.permanent, true, '永久道具：使用不消耗');
  assert.equal(db.prepare('SELECT status FROM backpack_items WHERE id = ?').get(first.item.id).status, 'ready');
  assert.equal(listBackpack().items.length, 1, '手机仍在背包列表里');

  // 未使用的手机也算持有（门控通过）
  assert.equal(getHypnosisGate(1).hasPhone, true);

  // 可以主动丢弃
  assert.equal(discardItem(first.item.id).ok, true);
  assert.equal(getHypnosisGate(1).hasPhone, false, '丢弃后门控不再认可');
  assert.equal(listBackpack().items.length, 0);
});

test('撤销遗忘的归属校验：跨角色请求零副作用（不许"先恢复再回 404"）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'a', '角色A', '旅客')`).run();
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (2, 'b', '角色B', '旅客')`).run();

  seedMemory({ memoryId: 'm_b', conversationId: 'char_2', startRawId: 1, endRawId: 2 });
  db.prepare(`UPDATE memory_fragments SET status = 'archived' WHERE memory_id = 'm_b'`).run();
  const wid = Number(db.prepare(
    `INSERT INTO hypnosis_forgotten_windows (character_id, from_raw_id, to_raw_id, memory_ids, memories_archived, status)
     VALUES (2, 1, 2, '["m_b"]', 1, 'active')`
  ).run().lastInsertRowid);

  // 用 A 的身份撤销 B 的窗口：必须拒绝，且什么都不许改
  assert.throws(() => restoreForgottenWindow(wid, { characterId: 1 }), err => err.code === 'NOT_FOUND');
  assert.equal(db.prepare('SELECT status FROM hypnosis_forgotten_windows WHERE id = ?').get(wid).status, 'active', '窗口状态必须原样');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_b'`).get().status, 'archived', '记忆必须仍是归档');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_hypnosis WHERE character_id = 2').get().n, 0, 'B 的一次性指令不该被写入');

  // 归属正确时才真的撤销
  const owned = restoreForgottenWindow(wid, { characterId: 2 });
  assert.equal(owned.restored, 1);
  assert.equal(owned.pendingDirective, 'memory_restore');
  assert.equal(db.prepare('SELECT status FROM hypnosis_forgotten_windows WHERE id = ?').get(wid).status, 'restored');
});

// ──────────────── 遗忘窗口左端 = raw id（task-35 回归） ────────────────

test('同秒回归：催眠后同一秒内发的消息必须落在遗忘窗口内（左端按 raw id）', async t => {
  seed(t);
  const before = seedRaw('char_1', 'user', '催眠前的一轮');
  hypnotize(1, { minutes: 30 });
  // 不传 created_at → CURRENT_TIMESTAMP，与催眠同一秒；旧实现（按时间比）会把它漏在窗口外
  const markUser = seedRaw('char_1', 'user', 'ZZZ_FORGOTTEN_MARKER_ZZZ');
  const markAssistant = seedRaw('char_1', 'assistant', '呜……我怎么了');
  seedMemory({ memoryId: 'm_same_sec', conversationId: 'char_1', startRawId: markUser, endRawId: markAssistant });

  const result = forgetWindow(1);
  assert.equal(result.fromRawId, markUser, '左端必须是催眠后的第一条 raw（不是下一条）');
  assert.equal(result.toRawId, markAssistant);
  assert.equal(result.archived, 1, '同秒写入的记忆也要被归档');
  assert.equal(isRawForgotten(1, markUser), true);
  assert.equal(isRawForgotten(1, markAssistant), true);
  assert.equal(isRawForgotten(1, before), false, '催眠前的 raw 不在窗口内');
  assert.equal(
    getDb().prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_same_sec'`).get().status,
    'archived',
  );
});

test('同秒连点两次催眠：之后发的消息仍被覆盖（不再受 started_at +1 秒影响）', async t => {
  seed(t);
  const before = seedRaw('char_1', 'user', '催眠前的一轮');
  hypnotize(1, { minutes: 30 });
  hypnotize(1, { minutes: 0 }); // 同一秒第二次：started_at 会被推后 1 秒（仅展示/幂等身份）
  const row = getDb().prepare('SELECT started_at, session_start_raw_id FROM character_hypnosis WHERE character_id = 1').get();
  assert.equal(row.session_start_raw_id, before, '会话起点仍是"催眠前最后一条 raw"');

  const after = seedRaw('char_1', 'assistant', '第二次催眠之后立刻说的话');
  const result = forgetWindow(1);
  assert.equal(result.fromRawId, after, '窗口左端不受 started_at 被推后影响');
  assert.equal(isRawForgotten(1, after), true);
});

test('created_at 为 NULL 的 raw 也在窗口内（证明已不依赖时间字段）', async t => {
  seed(t);
  const before = seedRaw('char_1', 'user', '催眠前的一轮');
  hypnotize(1, { minutes: 30 });
  const nullRaw = Number(getDb().prepare(
    `INSERT INTO raw_messages (conversation_id, role, content, created_at)
     VALUES ('char_1', 'assistant', '没有时间戳的一轮', NULL)`
  ).run().lastInsertRowid);

  const result = forgetWindow(1);
  assert.equal(result.fromRawId, before + 1);
  assert.equal(result.toRawId, nullRaw);
  assert.equal(isRawForgotten(1, nullRaw), true);
});

test('老库兼容：session_start_raw_id 为 0 时走时间回退分支，不报错且行为可解释', async t => {
  seed(t);
  const before = seedRaw('char_1', 'user', '催眠前的一轮');
  hypnotize(1, { minutes: 30 });
  // 模拟首版存量行（该列由 ALTER 补上、默认 0）
  getDb().prepare('UPDATE character_hypnosis SET session_start_raw_id = 0 WHERE character_id = 1').run();

  const result = forgetWindow(1);
  // 回退分支按时间找：同秒写入的历史 raw 也会被算进来 —— 这正是老库的已知不精确，
  // 所以新库/新会话一律走 id 分支（上面几条用例）。
  assert.equal(result.fromRawId, before);
  assert.equal(result.archived, 0);
  assert.equal(listForgottenWindows(1).length, 1, '回退分支也要留下审计行');
  assert.equal(isRawForgotten(1, before), true);
});

test('修复前后对照（确定性复现 lead e2e 的 FAIL）：同秒连点两次催眠 + 紧接一条 raw', async t => {
  seed(t);
  const db = getDb();
  // 历史 raw 在催眠前 10 秒（跨过秒边界，与 lead 的 e2e 形状一致）
  const oldRaw = seedRaw('char_1', 'user', '催眠前的历史消息',
    db.prepare(`SELECT datetime('now', '-10 seconds') AS t`).get().t);
  hypnotize(1, { minutes: 30 });
  hypnotize(1, { minutes: 0 }); // 同一秒第二次 → started_at 被推到 now+1 秒（旧实现的时间左端就在这里翻车）
  const marker = seedRaw('char_1', 'user', 'ZZZ_FORGOTTEN_MARKER_ZZZ'); // created_at = now < started_at

  // ① 旧口径（把会话起点列置 0 → 走时间回退分支，等价于修复前的行为）：标记消息被漏掉
  db.prepare('UPDATE character_hypnosis SET session_start_raw_id = 0 WHERE character_id = 1').run();
  const legacy = forgetWindow(1);
  assert.equal(legacy.fromRawId, marker + 1, '旧口径：时间左端落在未来 1 秒 → 窗口直接空了');
  assert.equal(isRawForgotten(1, marker), false, '旧口径漏掉催眠后这条 raw（= lead e2e 的 FAIL）');

  // ② 新口径：催眠后第一条 raw 必须被覆盖
  db.prepare('DELETE FROM hypnosis_forgotten_windows').run();
  db.prepare(
    `UPDATE character_hypnosis SET body_controlled = 1, mind_awake = 0, started_at = datetime('now'),
       session_start_raw_id = ? WHERE character_id = 1`
  ).run(oldRaw);
  const fixed = forgetWindow(1);
  assert.equal(fixed.fromRawId, marker, '新口径：左端 = 会话起点 + 1 = 标记消息本身');
  assert.equal(fixed.toRawId, marker);
  assert.equal(isRawForgotten(1, marker), true);
  assert.equal(isRawForgotten(1, oldRaw), false, '催眠前的历史 raw 不该被卷入');
});
