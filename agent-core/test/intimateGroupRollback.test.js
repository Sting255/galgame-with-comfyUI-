/**
 * 亲密看板 × 群聊回滚（撤回一轮 / 解散群）
 *
 * 背景（真 bug）：群聊侧已经会记账（scene:'group'、partnerKind:'character'、raw_id 锚点），
 * 但删除/重建 raw_messages 的路径原先没有回滚看板流水 —— 被打回或已解散群的群聊行为会永久残留在
 * character_intimate_log 里：默认口径 viewScope=['user'] 看不见，用户一勾选「角色↔角色」就看到脏计数。
 *
 * 本文件锁三件事：
 *   1. 两条删除 raw 的路径（groupRoundUndo / groups.js 解散群）都在删 raw **之前**回滚本会话区间的流水；
 *   2. **同一角色在私聊（char_<id>）的流水不被误伤** —— 这是不能用 clearIntimateData 的理由，
 *      也是 rollbackIntimateByRawIdRange 必须收敛 conversationId 的理由（raw_messages.id 全库自增，
 *      一个群的 raw 不是连续段，私聊 raw 的 id 完全可能夹在群的区间里）；
 *   3. raw_id 区间回滚的边界语义（min>max / raw_id=0 无锚点行 / 无匹配 / 部分匹配 / 幂等）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络
 * （本文件直接驱动 express router，不起服务、不发请求）。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate group rollback fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  getIntimateStats,
  listFirsts,
  listIntimateLogs,
  recordIntimateActs,
  rollbackIntimateByRawIdRange,
} = await import('../src/services/intimateService.js');
const { undoLastGroupRound } = await import('../src/services/groupRoundUndo.js');
const groupsRouter = (await import('../src/routes/groups.js')).default;

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

function seedGroup(db, name = '测试群') {
  return Number(db.prepare(`INSERT INTO group_chats (name) VALUES (?)`).run(name).lastInsertRowid);
}

/** 造一条 raw，返回 id。conversationId 可指定：用来把不同会话的 raw 交叉插进同一段 id 区间 */
function insertRaw(db, conversationId, role, { prompt = null } = {}) {
  return Number(db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, ?, ?, ?)`
  ).run(conversationId, role, prompt ? `(图片) {"prompt":"${prompt}"}` : '正文', prompt).lastInsertRowid);
}

/** 直接驱动 groups 路由（与 test/groupAvatarRoute.test.js 同一手法：不起服务、不发网络请求） */
function callDelete(url, params) {
  return new Promise((resolve, reject) => {
    const req = { method: 'DELETE', url, params };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    groupsRouter.handle(req, res, err => (err ? reject(err) : resolve(null)));
  });
}

const countLogs = (characterId) => listIntimateLogs(characterId, { partnerKinds: 'all' }).length;

// ──────────────── 撤回一轮 ────────────────

test('群聊撤回一轮：本轮群流水清零、统计回落、derived 里程碑跟着清', async t => {
  const db = seedDb(t);
  const charId = seedCharacter(db, 'lin');
  const groupId = seedGroup(db);
  const conversationId = `group_${groupId}`;

  insertRaw(db, conversationId, 'user');
  const assistantRawId = insertRaw(db, conversationId, 'assistant', { prompt: 'creampie' });
  recordIntimateActs(charId, {
    scene: 'group', partnerKind: 'character', rawId: assistantRawId,
    acts: [{ actKey: 'vaginal', positionKey: '69', count: 2 }],
  });
  assert.equal(getIntimateStats(charId, { partnerKinds: ['character'] }).totalActs, 2, '回滚前');
  assert.ok(listFirsts(charId).some(f => f.actKey === 'vaginal' && f.source === 'derived'));

  const result = await undoLastGroupRound(groupId);
  assert.equal(result.ok, true);
  assert.equal(result.deleted.intimate, 1, '撤回必须同步回滚看板流水');

  assert.equal(getIntimateStats(charId, { partnerKinds: ['character'] }).totalActs, 0, '回滚后');
  assert.equal(countLogs(charId), 0);
  assert.deepEqual(listFirsts(charId), [], 'derived 里程碑要随流水一起消失');

  // 幂等：raw 已删空 → 再撤一次报"没有可撤回的"，且不会多删
  const again = await undoLastGroupRound(groupId);
  assert.equal(again.deleted, null);
  assert.equal(countLogs(charId), 0);
});

test('DELETE /api/groups/:id/messages/last-round 走完整路由也能回滚（挂点在服务里）', async t => {
  const db = seedDb(t);
  const charId = seedCharacter(db, 'lin');
  const groupId = seedGroup(db, '路由撤回群');
  const conversationId = `group_${groupId}`;

  insertRaw(db, conversationId, 'user');
  const assistantRawId = insertRaw(db, conversationId, 'assistant', { prompt: 'fellatio' });
  recordIntimateActs(charId, {
    scene: 'group', partnerKind: 'character', rawId: assistantRawId, acts: [{ actKey: 'oral' }],
  });

  const res = await callDelete(`/${groupId}/messages/last-round`, { id: String(groupId) });
  assert.equal(res.status, 200);
  assert.equal(res.payload.deleted.intimate, 1);
  assert.equal(getIntimateStats(charId, { partnerKinds: ['character'] }).totalActs, 0);
});

// ──────────────── 解散群（核心：私聊不误伤） ────────────────

test('解散群：清掉本群区间流水，且同一角色在私聊的流水毫发无损', async t => {
  const db = seedDb(t);
  const charId = seedCharacter(db, 'lin');
  const groupId = seedGroup(db, '将解散的群');
  const conversationId = `group_${groupId}`;
  const privateConversationId = `char_${charId}`;

  // 刻意交叉落库：私聊 raw 的 id 正好夹在本群两条 raw 之间（raw_messages.id 全库自增）
  const groupUserRawId = insertRaw(db, conversationId, 'user');
  const privateRawId = insertRaw(db, privateConversationId, 'assistant', { prompt: 'fellatio' });
  const groupAssistantRawId = insertRaw(db, conversationId, 'assistant', { prompt: 'creampie' });
  assert.ok(privateRawId > groupUserRawId && privateRawId < groupAssistantRawId,
    '构造前提：私聊 raw 的 id 必须夹在本群 raw 区间内，否则这条测试证明不了跨会话隔离');

  recordIntimateActs(charId, {
    scene: 'group', partnerKind: 'character', rawId: groupAssistantRawId, acts: [{ actKey: 'vaginal' }],
  });
  recordIntimateActs(charId, {
    scene: 'chat', partnerKind: 'user', rawId: privateRawId, acts: [{ actKey: 'oral' }],
  });
  assert.equal(getIntimateStats(charId, { partnerKinds: 'all' }).totalActs, 2, '回滚前：群 1 + 私聊 1');

  const res = await callDelete(`/${groupId}`, { id: String(groupId) });
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.intimate.deleted, 1, '只该删掉本群那一条');
  assert.deepEqual(res.payload.intimate.characters, [charId]);

  const rows = listIntimateLogs(charId, { partnerKinds: 'all' });
  assert.equal(rows.length, 1, '私聊流水必须还在（这条失败通常意味着用了按角色清空或裸 BETWEEN）');
  assert.equal(rows[0].rawId, privateRawId);
  assert.equal(rows[0].scene, 'chat');
  assert.equal(rows[0].partnerKind, 'user');
  // 口径分开看：角色↔角色 归零，用户↔角色 仍为 1
  assert.equal(getIntimateStats(charId, { partnerKinds: ['character'] }).totalActs, 0);
  assert.equal(getIntimateStats(charId, { partnerKinds: ['user'] }).totalActs, 1);
  // 群本体与 raw 都清干净了
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(conversationId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_chats WHERE id = ?').get(groupId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(privateConversationId).n, 1);
});

// ──────────────── 区间回滚的边界 ────────────────

test('rollbackIntimateByRawIdRange 边界：min>max / 无匹配 / raw_id=0 无锚点行 / 部分匹配 / 幂等', async t => {
  const db = seedDb(t);
  const charId = seedCharacter(db, 'lin');

  recordIntimateActs(charId, { scene: 'chat', partnerKind: 'user', rawId: 10, acts: [{ actKey: 'vaginal' }] });
  recordIntimateActs(charId, { scene: 'chat', partnerKind: 'user', rawId: 20, acts: [{ actKey: 'oral' }] });
  recordIntimateActs(charId, { scene: 'chat', partnerKind: 'user', rawId: 30, acts: [{ actKey: 'anal' }] });
  // 无 raw 锚点的行：人工补录（raw_id=0）与奇遇事件流水（显式 sourceUid + raw_id=0）
  recordIntimateActs(charId, { scene: 'manual', source: 'manual', acts: [{ actKey: 'breast' }] });
  recordIntimateActs(charId, { scene: 'event', partnerKind: 'user', acts: [{ actKey: 'thigh' }] });
  assert.equal(countLogs(charId), 5);

  // 空区间 / 非法区间 / 覆盖到 raw_id=0 的区间：一律 no-op（raw 维度的回滚永远不许碰无锚点行）
  assert.deepEqual(rollbackIntimateByRawIdRange(30, 10), { deleted: 0, characters: [] });
  assert.deepEqual(rollbackIntimateByRawIdRange(0, 100), { deleted: 0, characters: [] });
  assert.deepEqual(rollbackIntimateByRawIdRange(-5, -1), { deleted: 0, characters: [] });
  assert.deepEqual(rollbackIntimateByRawIdRange(40, 50), { deleted: 0, characters: [] });
  assert.equal(countLogs(charId), 5, '上面四次都必须是空操作');

  // 部分匹配：只删 id ∈ [15,25] 那条
  const partial = rollbackIntimateByRawIdRange(15, 25);
  assert.equal(partial.deleted, 1);
  assert.deepEqual(partial.characters, [charId]);
  const left = listIntimateLogs(charId, { partnerKinds: 'all' }).map(r => r.rawId).sort((a, b) => a - b);
  assert.deepEqual(left, [0, 0, 10, 30], '三条有锚点行只该少一条，两条无锚点行必须原样保留');

  // 幂等：同一区间再删一次不报错、不多删
  assert.deepEqual(rollbackIntimateByRawIdRange(15, 25), { deleted: 0, characters: [] });
  assert.equal(countLogs(charId), 4);
});

test('rollbackIntimateByRawIdRange：传 conversationId 时只收敛该会话的 raw，未传则退化为纯区间', async t => {
  const db = seedDb(t);
  const charA = seedCharacter(db, 'lin');
  const charB = seedCharacter(db, 'shu');
  const groupId = seedGroup(db, '隔离群');
  const groupConv = `group_${groupId}`;
  const privateConv = `char_${charA}`;

  // 交叉：群 1 / 私聊 2 / 群 3 / 私聊 4
  const g1 = insertRaw(db, groupConv, 'user');
  const p1 = insertRaw(db, privateConv, 'assistant', { prompt: 'fellatio' });
  const g2 = insertRaw(db, groupConv, 'assistant', { prompt: 'creampie' });
  const p2 = insertRaw(db, privateConv, 'assistant', { prompt: 'anal' });
  recordIntimateActs(charB, { scene: 'group', partnerKind: 'character', rawId: g2, acts: [{ actKey: 'vaginal' }] });
  recordIntimateActs(charA, { scene: 'chat', partnerKind: 'user', rawId: p1, acts: [{ actKey: 'oral' }] });
  recordIntimateActs(charA, { scene: 'chat', partnerKind: 'user', rawId: p2, acts: [{ actKey: 'anal' }] });

  // 传 conversationId：区间 [g1, p2] 里只删本群那一条，两条私聊流水不动
  const scoped = rollbackIntimateByRawIdRange(g1, p2, { conversationId: groupConv });
  assert.equal(scoped.deleted, 1);
  assert.deepEqual(scoped.characters, [charB]);
  assert.equal(countLogs(charA), 2, '私聊两条都必须还在');
  assert.equal(countLogs(charB), 0);

  // 未传 conversationId：退化为纯区间语义（会把区间内所有会话的行都算进去）——
  // 这正是所有调用点都必须传 conversationId 的原因
  const naive = rollbackIntimateByRawIdRange(g1, p2);
  assert.equal(naive.deleted, 2, '纯区间语义会连私聊一起删（调用点的反例）');
  assert.equal(countLogs(charA), 0);
});

// ──────────────── 挂点契约（源码级） ────────────────

test('源码契约：两处回滚都在删 raw 之前，且都没有用 clearIntimateData', async () => {
  const undoSource = await readFile(new URL('../src/services/groupRoundUndo.js', import.meta.url), 'utf8');
  const groupsSource = await readFile(new URL('../src/routes/groups.js', import.meta.url), 'utf8');

  // groupRoundUndo：回滚必须排在 DELETE raw_messages 之前
  const undoRollbackAt = undoSource.indexOf('rollbackIntimateByRawIdRange(round.startRawId, round.endRawId, { conversationId })');
  const undoDeleteAt = undoSource.indexOf('DELETE FROM raw_messages WHERE conversation_id = ? AND id BETWEEN ? AND ?');
  assert.ok(undoRollbackAt >= 0, 'groupRoundUndo.js 缺少区间回滚挂点');
  assert.ok(undoDeleteAt >= 0, 'groupRoundUndo.js 的 raw 删除语句变了，请同步本断言');
  assert.ok(undoRollbackAt < undoDeleteAt, '回滚必须在删 raw 之前（删完就分不清哪些流水属于本会话）');
  assert.match(undoSource, /^import \{[^}]*\brollbackIntimateByRawIdRange\b[^}]*\} from '\.\/intimateService\.js';$/m);

  // groups.js 解散群：同样先回滚再删 raw；删 raw 的语句在本文件只应有一处，避免断言选错
  const deleteNeedle = 'DELETE FROM raw_messages WHERE conversation_id = ?`';
  assert.equal(groupsSource.split(deleteNeedle).length - 1, 1, 'groups.js 的 raw 删除语句应只有一处（解散群）');
  const groupsRollbackAt = groupsSource.indexOf('rollbackIntimateByRawIdRange(rawBounds?.minId, rawBounds?.maxId, { conversationId })');
  const groupsDeleteAt = groupsSource.indexOf(deleteNeedle);
  assert.ok(groupsRollbackAt >= 0, 'groups.js 解散群缺少区间回滚挂点');
  assert.ok(groupsRollbackAt < groupsDeleteAt, '解散群必须先回滚流水再删 raw');
  assert.match(groupsSource, /^import \{[^}]*\brollbackIntimateByRawIdRange\b[^}]*\} from '\.\.\/services\/intimateService\.js';$/m);

  // 两条路径都不许用按角色清空（会连私聊统计一起清掉）。
  // 先剥注释再查：注释里会写"不能用 clearIntimateData"解释理由，不该被当成调用点。
  const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!stripComments(undoSource).includes('clearIntimateData'), 'groupRoundUndo.js 不能用 clearIntimateData');
  assert.ok(!stripComments(groupsSource).includes('clearIntimateData'), 'groups.js 解散群不能用 clearIntimateData');
});
