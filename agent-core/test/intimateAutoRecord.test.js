/**
 * 亲密看板 · 自动记账入口单测
 *
 * 覆盖 recordFromPrompt / recordFromConversationTail 的幂等、场景与伙伴归因、
 * 总开关与权限闸门、以及"没有可归类 tag 时绝不猜测"的兜底语义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate auto-record fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';

const { getDb, closeDb } = await import('../src/db/index.js');
const intimate = await import('../src/services/intimateService.js');
const { recordFromPrompt, recordFromConversationTail, detectExplicitReply, ACT_UNSPECIFIED } =
  await import('../src/services/intimateAutoRecord.js');

/** 建一个角色 + 返回 id */
function seedCharacter(t, { name = 'kiana' } = {}) {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`)
    .run(name, name);
  return db.prepare('SELECT max(id) AS id FROM characters').get().id;
}

const PROMPT = '1girl, solo, sex from behind, arms grab, cum';

test('recordFromPrompt：空 prompt / 空 tags 直接返回零写入', t => {
  const characterId = seedCharacter(t);
  assert.deepEqual(recordFromPrompt({ characterId, prompt: '' }).acts, []);
  assert.equal(recordFromPrompt({ characterId, prompt: '' }).inserted, 0);
  assert.equal(recordFromPrompt({ characterId, tags: [] }).inserted, 0);
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);
});

test('recordFromPrompt：按 prompt 串归类并落库，rawId 相同则幂等', t => {
  const characterId = seedCharacter(t, { name: 'kiana2' });
  const first = recordFromPrompt({ characterId, prompt: PROMPT, rawId: 101 });
  assert.ok(first.acts.some(a => a.actKey === 'vaginal'), `应归类出 vaginal，实际 ${JSON.stringify(first.acts)}`);
  assert.equal(first.inserted, first.acts.length);

  // 同一个 rawId 再记一次：source_uid 相同 → 全部跳过
  const second = recordFromPrompt({ characterId, prompt: PROMPT, rawId: 101 });
  assert.equal(second.inserted, 0);
  assert.ok(second.skipped > 0);

  // 换一个 rawId：算新的一笔
  const third = recordFromPrompt({ characterId, prompt: PROMPT, rawId: 102 });
  assert.equal(third.inserted, third.acts.length);

  const stats = intimate.getIntimateStats(characterId);
  assert.ok(stats.totalActs >= 2, `totalActs 应累加，实际 ${stats.totalActs}`);
  assert.ok(stats.byAct.some(a => a.actKey === 'vaginal'));
});

test('recordFromPrompt：没有可归类 tag 时默认零猜测，allowUnspecified 才落兜底行', t => {
  const characterId = seedCharacter(t, { name: 'kiana3' });
  const plain = recordFromPrompt({ characterId, prompt: '1girl, solo, indoors', rawId: 201 });
  assert.equal(plain.inserted, 0);
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);

  const named = recordFromPrompt({
    characterId, prompt: 'nude, on bed', rawId: 202, allowUnspecified: true,
  });
  assert.equal(named.inserted, 1);
  assert.equal(named.acts[0].actKey, ACT_UNSPECIFIED);
});

test('recordFromPrompt：features.intimate=false 时仍可写（开关消费点在调用方），但权限闸门生效', t => {
  const characterId = seedCharacter(t, { name: 'kiana4' });
  // 关掉 stats 授权 → 自动记账被 blocked
  intimate.upsertBodyProfile(characterId, { aiEditFields: ['body'] });
  const blocked = recordFromPrompt({ characterId, prompt: PROMPT, rawId: 301 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.inserted, 0);
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);

  // 人工路径不受限
  const manual = intimate.recordIntimateActs(characterId, {
    source: 'manual', scene: 'manual', acts: [{ actKey: 'vaginal' }],
  });
  assert.equal(manual.inserted, 1);
});

test('recordFromConversationTail：按会话尾部带 prompt 的 assistant raw 记账，重复调用幂等', t => {
  const characterId = seedCharacter(t, { name: 'kiana5' });
  const db = getDb();
  const conversationId = `char_${characterId}`;
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'user', '你好')`)
    .run(conversationId);
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, 'assistant', '(图片)', ?)`)
    .run(conversationId, PROMPT);
  const rawId = db.prepare('SELECT max(id) AS id FROM raw_messages').get().id;

  const first = recordFromConversationTail({ characterId, conversationId });
  assert.equal(first.rawId, rawId);
  assert.ok(first.inserted > 0);

  const second = recordFromConversationTail({ characterId, conversationId });
  assert.equal(second.inserted, 0);
  assert.ok(second.skipped > 0);
});

test('recordFromConversationTail：尾部是纯文本时，命中的仍是"最近一条带 prompt 的 raw"（调用方须按本轮是否有 prompt 把关）', t => {
  const characterId = seedCharacter(t, { name: 'kiana6' });
  const db = getDb();
  const conversationId = `char_${characterId}`;
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, 'assistant', '(图片)', ?)`)
    .run(conversationId, PROMPT);
  const promptRawId = db.prepare('SELECT max(id) AS id FROM raw_messages').get().id;
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '纯文本回复')`)
    .run(conversationId);

  const result = recordFromConversationTail({ characterId, conversationId });
  // 这是刻意的语义：prompt 可能被合并进更早的 raw，所以查"最近一条带 prompt 的 raw"
  assert.equal(result.rawId, promptRawId);
  assert.ok(result.inserted > 0);
  // 幂等：重复调用不再计数
  assert.equal(recordFromConversationTail({ characterId, conversationId }).inserted, 0);
});

test('recordFromConversationTail：整个会话都没有带 prompt 的 raw 时不记账', t => {
  const characterId = seedCharacter(t, { name: 'kiana7' });
  const db = getDb();
  const conversationId = `char_${characterId}`;
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '纯文本回复')`)
    .run(conversationId);

  const result = recordFromConversationTail({ characterId, conversationId });
  assert.equal(result.inserted, 0);
  assert.equal(result.rawId, 0);
  assert.equal(result.acts.length, 0);
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);
});

test('detectExplicitReply：成人内容判定（供调用方决定要不要处理这一轮）', () => {
  assert.equal(detectExplicitReply('今天天气不错'), false);
  assert.equal(detectExplicitReply('她轻轻喘息着，ahegao'), true);
});

test('recordFromPrompt：非法 characterId 不抛异常到聊天主流程之外（抛错由调用方兜）', async t => {
  // 服务层语义：非法 id 抛 invalid character id；chat.js 侧用 try/catch 包住
  assert.throws(() => recordFromPrompt({ characterId: 0, prompt: PROMPT, rawId: 1 }), /invalid character id/);
});
