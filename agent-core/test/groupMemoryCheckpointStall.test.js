/**
 * 群聊记忆整理：本批 raw 不足阈值时**不得**被当成错误（task-43）
 *
 * 真机证据：`完整/新建文件夹/新建文件夹/backend-2026-09-29.log`
 *   · `[error] [group] memory checkpoint did not advance for group 2: status=idle, raw=1535` 连报 12 次（14:31～14:41）；
 *   · 该日志最后一行是 `[memoryExtractor] skip curation: 34 条 < 40 条阈值，继续累积`。
 *
 * 根因：群聊按**轮数**触发（`getGroupSummaryInterval()` = 2~6，默认 4），而 `curateChatMemories`
 * 内部按 **raw 条数**（`CURATE_EVERY_N_MESSAGES = 40`）决定是否真的整理。4 轮群聊大约只产生 34 条 raw，
 * 于是：curation 直接 skip → checkpoint 不推进 → 调用方按「没推进＝失败」报 error 并 break
 * → pending 永不扣减 → 每一轮都重刷同一条 error（功能上群聊记忆也永远不整理）。
 *
 * 修法：调用方先自己数一次本批条数，不足阈值就安静地让 pending 继续累积（攒够自动整理）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`group memory fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.features.memory = true;
config.groupChat = { ...(config.groupChat || {}), summaryInterval: 4 };
const { getDb, closeDb } = await import('../src/db/index.js');
const { maybeExtractGroupMemory, getGroupSummaryInterval } = await import('../src/services/groupChatEngine.js');
const { getCheckpoint } = await import('../src/services/memory/memoryRepository.js');

function seedGroup(db, rawCount) {
  const gid = Number(db.prepare('INSERT INTO group_chats (name) VALUES (?)').run('测试群').lastInsertRowid);
  const convId = `group_${gid}`;
  const ins = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  for (let i = 0; i < rawCount; i += 1) ins.run(convId, i % 2 === 0 ? 'user' : 'assistant', `第${i}条`);
  return { gid, convId };
}

async function runCapture(groupId) {
  const errors = []; const logs = [];
  const origErr = console.error; const origLog = console.log;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  console.log = (...a) => logs.push(a.map(String).join(' '));
  try {
    await maybeExtractGroupMemory({ id: groupId }, { incrementRound: false });
  } finally {
    console.error = origErr; console.log = origLog;
  }
  return { errors, logs };
}

test('A 本批 raw 不足 40 条：不报错、pending 不扣减、checkpoint 不动', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const interval = getGroupSummaryInterval();
  const { gid, convId } = seedGroup(db, 34);   // 真机原样：4 轮 ≈ 34 条
  db.prepare('UPDATE group_chats SET rag_user_rounds_pending = ? WHERE id = ?').run(interval, gid);
  const before = getCheckpoint(convId).last_raw_msg_id;

  const { errors, logs } = await runCapture(gid);

  assert.equal(errors.filter(e => e.includes('did not advance')).length, 0,
    '不足阈值不是错误，不得刷 memory checkpoint did not advance');
  assert.equal(errors.filter(e => e.includes('curation failed')).length, 0, '也不该走失败分支（根本没触发）');
  assert.ok(logs.some(l => l.includes('继续累积')), '应打出「继续累积」说明');
  assert.equal(db.prepare('SELECT rag_user_rounds_pending AS p FROM group_chats WHERE id = ?').get(gid).p, interval,
    'pending 不扣减，等攒够再整理');
  assert.equal(getCheckpoint(convId).last_raw_msg_id, before, 'checkpoint 不得改动');
});

test('B 本批 raw 达到 40 条：越过预检（不再走「继续累积」）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const interval = getGroupSummaryInterval();
  const { gid } = seedGroup(db, 40);
  db.prepare('UPDATE group_chats SET rag_user_rounds_pending = ? WHERE id = ?').run(interval, gid);

  const { logs } = await runCapture(gid);
  assert.ok(logs.some(l => l.includes('batch=40')), '达到阈值应真的进入整理路径');
  assert.ok(!logs.some(l => l.includes('继续累积')), '达到阈值不得再走累积分支');
});

test('C pending 不足 summaryInterval：直接返回，什么都不做', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const { gid } = seedGroup(db, 34);
  db.prepare('UPDATE group_chats SET rag_user_rounds_pending = 0 WHERE id = ?').run(gid);
  const { errors, logs } = await runCapture(gid);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 0, '不满足轮数门槛时不该有任何日志');
});

test('D 挂点：预检用 CURATE_EVERY_N_MESSAGES，且与整理器共用同一阈值', async () => {
  const source = await readFile(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  assert.ok(source.includes('curateChatMemories, CURATE_EVERY_N_MESSAGES'), '必须导入整理器的阈值常量');
  assert.ok(source.includes('if (batchCount < CURATE_EVERY_N_MESSAGES) {'), '预检必须用同一个阈值');
  const extractor = await readFile(new URL('../src/services/memoryExtractor.js', import.meta.url), 'utf8');
  assert.ok(extractor.includes('export const CURATE_EVERY_N_MESSAGES = 40;'), '整理器阈值保持 40');
});
