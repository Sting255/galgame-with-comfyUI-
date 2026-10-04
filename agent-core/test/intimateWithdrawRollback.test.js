/**
 * 亲密看板 × 聊天「撤回上一轮」回滚（P1 回归）
 *
 * 背景（真 bug，task-6 对抗式验收最小复现）：
 *   自动记账的锚点是**本轮 assistant raw** —— chat.js 先 INSERT assistant raw，
 *   紧接着 recordIntimateFromTail 取"会话尾部带 prompt 的 assistant raw"去记账；
 *   而「撤回上一轮」删除的是 `id >= lastUserRawId` 的整段 raw。
 *   原先该分支只按 `rollbackIntimateByRawId(lastUserRawId)` **等值**回滚：
 *   user raw（55）≠ assistant raw（56）→ 命中 0 行，而 raw 照删 →
 *   流水变孤儿（raw_id 指向已删 raw）、totalActs 不回落，且此后无法再按 raw 回滚。
 *
 * 修复口径（chat.js）：有 user 消息的分支改成
 *   1) 先取该会话 `MAX(id)`；
 *   2) `rollbackIntimateByRawIdRange(lastUserRawId, maxRawId, { conversationId })`。
 *
 * 本文件锁四件事（任何一条被改回去都会红）：
 *   1. 撤回一轮后本轮流水清零、统计回落、derived 里程碑跟着清；
 *   2. **区间内别的会话（char_<other>）的流水与 raw 不被误删** —— 这就是必须传
 *      conversationId 的理由（raw_messages.id 全库自增，不同会话的 raw 会互相穿插）；
 *   3. raw_id=0 的无锚点行（人工补录 / 事件流水）不受撤回路经影响；
 *   4. 源码级护栏：user 分支必须用区间回滚且带 conversationId，且在回滚前查过会话内 MAX(id)。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络；
 * 直接驱动 express router（不起服务、不发请求），手法与 test/intimateGroupRollback.test.js 一致。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate withdraw rollback fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  getIntimateStats,
  listFirsts,
  listIntimateLogs,
  recordIntimateActs,
} = await import('../src/services/intimateService.js');
const chatRouter = (await import('../src/routes/chat.js')).default;

function seedDb(t) {
  const db = getDb();
  t.after(() => closeDb());
  return db;
}

function seedCharacter(db, name) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
  ).run(name, name);
  return Number(lastInsertRowid);
}

/** 造一条 raw，返回 id；conversationId 用来把不同会话的 raw 交叉插进同一段 id 区间 */
function insertRaw(db, conversationId, role, { prompt = null } = {}) {
  return Number(db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, ?, ?, ?)`
  ).run(conversationId, role, prompt ? `(图片) {"prompt":"${prompt}"}` : '正文', prompt).lastInsertRowid);
}

function insertMessage(db, conversationId, rawId, role) {
  db.prepare(
    `INSERT INTO messages (conversation_id, raw_id, role, content) VALUES (?, ?, ?, '正文')`
  ).run(conversationId, rawId, role);
}

/** 直接驱动 chat 路由的 DELETE /characters/:id/messages/last-round（不起服务、不发请求） */
function callLastRound(characterId) {
  return new Promise((resolve, reject) => {
    const req = { method: 'DELETE', url: `/characters/${characterId}/messages/last-round`, params: { id: String(characterId) } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    chatRouter.handle(req, res, err => (err ? reject(err) : resolve(null)));
  });
}

const countLogs = characterId => listIntimateLogs(characterId, { partnerKinds: 'all' }).length;
const rawsOf = (db, conversationId) => db.prepare(
  'SELECT id FROM raw_messages WHERE conversation_id = ? ORDER BY id'
).all(conversationId).map(row => row.id);

/**
 * 造出"真实一轮"的形状：user raw + assistant raw（带 prompt）+ messages 两行，
 * 并按**真实锚点口径**（assistant raw）记账 —— 这正是 chat.js 的自动记账形状。
 */
function seedRound(db, characterId, { prompt = 'creampie, missionary', acts } = {}) {
  const conversationId = `char_${characterId}`;
  const userRawId = insertRaw(db, conversationId, 'user');
  const assistantRawId = insertRaw(db, conversationId, 'assistant', { prompt });
  insertMessage(db, conversationId, userRawId, 'user');
  insertMessage(db, conversationId, assistantRawId, 'assistant');
  recordIntimateActs(characterId, {
    scene: 'chat',
    partnerKind: 'user',
    rawId: assistantRawId, // ← 真实锚点：assistant raw
    acts: acts || [{ actKey: 'vaginal', positionKey: 'missionary' }],
  });
  return { conversationId, userRawId, assistantRawId };
}

// ──────────────── 1. P1 主路径 ────────────────

test('撤回上一轮：按 assistant 锚点记账的流水必须被回滚（P1 回归）', async t => {
  const db = seedDb(t);
  const charId = seedCharacter(db, 'withdraw_main');
  const { conversationId, userRawId, assistantRawId } = seedRound(db, charId);

  assert.notEqual(assistantRawId, userRawId, '本轮 assistant raw 与 user raw 必须是不同 id（bug 的前提）');
  assert.equal(getIntimateStats(charId, { partnerKinds: 'all' }).totalActs, 1, '撤回前应有 1 笔');
  assert.equal(countLogs(charId), 1);
  assert.ok(listFirsts(charId).some(f => f.actKey === 'vaginal' && f.source === 'derived'), '撤回前有 derived 里程碑');

  const res = await callLastRound(charId);
  assert.equal(res.status, 200);
  assert.ok(res.payload.deleted > 0, '应删除 raw + messages');

  assert.equal(countLogs(charId), 0, '撤回后本轮流水必须清零（修复前会残留 raw_id=assistant raw 的孤儿行）');
  assert.equal(getIntimateStats(charId, { partnerKinds: 'all' }).totalActs, 0, '撤回后 totalActs 必须回落 0');
  assert.deepEqual(listFirsts(charId), [], 'derived 里程碑要随流水一起消失');
  assert.deepEqual(rawsOf(db, conversationId), [], '本轮 raw 已被整段删除');
});

// ──────────────── 2. 区间收敛护栏 ────────────────

test('撤回一轮不误删区间内别的会话的流水与 raw（conversationId 收敛）', async t => {
  const db = seedDb(t);
  const charA = seedCharacter(db, 'withdraw_a');
  const charB = seedCharacter(db, 'withdraw_b');
  const convA = `char_${charA}`;
  const convB = `char_${charB}`;

  // 布局：A 的 user raw < B 的 assistant raw < A 的 assistant raw
  // → B 的 raw_id 落在 A 的 [lastUserRawId, MAX(id)] 区间内
  const userRawA = insertRaw(db, convA, 'user');
  const assistantRawB = insertRaw(db, convB, 'assistant', { prompt: 'doggystyle, vaginal' });
  const assistantRawA = insertRaw(db, convA, 'assistant', { prompt: 'creampie' });
  insertMessage(db, convA, userRawA, 'user');
  insertMessage(db, convA, assistantRawA, 'assistant');
  assert.ok(userRawA < assistantRawB && assistantRawB < assistantRawA, 'B 的 raw 必须夹在 A 的区间中间');

  recordIntimateActs(charA, { scene: 'chat', partnerKind: 'user', rawId: assistantRawA, acts: [{ actKey: 'vaginal' }] });
  recordIntimateActs(charB, { scene: 'chat', partnerKind: 'user', rawId: assistantRawB, acts: [{ actKey: 'vaginal' }] });
  assert.equal(countLogs(charB), 1, 'B 的流水已写入');

  const res = await callLastRound(charA);
  assert.equal(res.status, 200);

  assert.equal(countLogs(charA), 0, 'A 本轮流水被回滚');
  assert.equal(countLogs(charB), 1, 'B 的流水不能被 A 的撤回误删（裸 BETWEEN 就会误删）');
  assert.equal(listIntimateLogs(charB, { partnerKinds: 'all' })[0].rawId, assistantRawB);
  assert.ok(rawsOf(db, convB).includes(assistantRawB), 'B 的 raw 也不能被删');
});

// ──────────────── 3. 无锚点行护栏 ────────────────

test('撤回一轮不影响 raw_id=0 的无锚点行（人工补录 / 事件流水）', async t => {
  const db = seedDb(t);
  const charId = seedCharacter(db, 'withdraw_manual');
  const { conversationId } = seedRound(db, charId);

  // 人工补录：source='manual'、raw_id=0
  recordIntimateActs(charId, {
    scene: 'manual',
    partnerKind: 'user',
    source: 'manual',
    acts: [{ actKey: 'climax' }],
  });
  assert.equal(countLogs(charId), 2, '1 笔自动 + 1 笔人工');

  const res = await callLastRound(charId);
  assert.equal(res.status, 200);

  const left = listIntimateLogs(charId, { partnerKinds: 'all' });
  assert.equal(left.length, 1, '只应剩下无锚点的人工行');
  assert.equal(left[0].rawId, 0);
  assert.equal(left[0].scene, 'manual');
  assert.deepEqual(rawsOf(db, conversationId), []);
});

// ──────────────── 4. 源码级护栏（防改回等值回滚） ────────────────

test('chat.js 的 user 分支必须用区间回滚 + conversationId（防改回等值删）', async () => {
  const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.match(source, /rollbackIntimateByRawIdRange\(lastUserRawId, maxRawId, \{ conversationId \}\)/,
    'user 分支必须按区间回滚并传 conversationId（等值回滚会让 assistant 锚点的流水变孤儿）');
  assert.match(source, /SELECT MAX\(id\) AS id FROM raw_messages WHERE conversation_id = \?/,
    '区间上界必须先查该会话的 MAX(id)');
  // agent-only 分支仍然用等值回滚：那里撤回的就是最后一条 assistant raw，锚点天然一致
  assert.match(source, /rollbackIntimateByRawId\(lastRawId\)/,
    '无 user 消息的 agent-only 分支保持等值回滚');
  assert.ok(!/rollbackIntimateByRawId\(lastUserRawId\)/.test(source),
    '不允许再出现 rollbackIntimateByRawId(lastUserRawId) 这种等值回滚');
});
