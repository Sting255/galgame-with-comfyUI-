/**
 * 记忆整理「空 judgment 整批失败」的回归（真机 E2E 抓到的既有故障）
 *
 * 故障原文：`[memoryExtractor] curation failed: judgment 不能为空`
 *
 * 根因：`applyMemoryActions` 是**整批先校验再开事务**（memoryRepository.js:143），
 * 只要模型输出里有一条动作的 memory.judgment 为空 —— 常见于 v3 提示词要求的
 * `{"action":"create","memory":{...}}` 被模型**拍平**成同级字段 —— 整批 curation 就全挂，
 * checkpoint 原地不动，下一轮再烧一次 LLM 又同样失败（聊天里表现为记忆永远不更新）。
 *
 * 修法：memoryExtractor 侧加一层「形态修复 + 逐条筛查 + 逐条落库」，
 * 坏的那条只丢自己。本文件盯住这四条口径：
 *   1. 扁平形态能救回来（修前必抛 judgment 不能为空）；
 *   2. 真·空 judgment 只丢那一条，同批其他条目照常可用；
 *   3. 逐条落库：坏条目不再连坐（DB 断言 + 旧行为对照）；
 *   4. 全部不可用时返回空、不抛（调用方据此正常推进 checkpoint，不再死循环）。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`memory salvage fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { normalizeMemoryActionShape, planMemoryActionApply } = await import('../src/services/memoryExtractor.js');
const { applyMemoryActions } = await import('../src/services/memory/memoryRepository.js');

after(() => closeDb());

const wrapped = (judgment, extra = {}) => ({
  action: 'create',
  sourceMemoryIds: [],
  memory: { memoryType: 'knowledge', subject: 'user', judgment, reasoning: '她亲口说的', tags: ['测试'], ...extra },
});

test('① 包裹形态原样通过（回归：不能改坏正常输出）', () => {
  const shape = normalizeMemoryActionShape(wrapped('她养了一只猫叫团子'));
  assert.equal(shape.action, 'create');
  assert.deepEqual(shape.sourceMemoryIds, []);
  assert.equal(shape.memory.judgment, '她养了一只猫叫团子');
  assert.equal(shape.memory.memoryType, 'knowledge');
});

test('② 扁平 v3 形态能救回来（修前 → judgment 不能为空）', () => {
  const flat = { action: 'create', sourceMemoryIds: [], memoryType: 'event', subject: 'user', judgment: '她上周去看了海', reasoning: '对话里提到', tags: ['旅行'] };
  const shape = normalizeMemoryActionShape(flat);
  assert.ok(shape, '扁平形态不该被判为不可用');
  assert.equal(shape.memory.memoryType, 'event');
  assert.equal(shape.memory.judgment, '她上周去看了海');
  // 救回来之后再走真实校验器也不该抛
  const plan = planMemoryActionApply([flat]);
  assert.equal(plan.applicable.length, 1);
  assert.equal(plan.skipped.length, 0);
});

test('③ action 缺失按引用条数推断；judgement 拼写变体归一', () => {
  const one = normalizeMemoryActionShape({ sourceMemoryIds: ['mem_a'], judgment: '改口径' });
  assert.equal(one.action, 'update');
  const many = normalizeMemoryActionShape({ sourceMemoryIds: ['mem_a', 'mem_b'], judgment: '合并口径' });
  assert.equal(many.action, 'merge');
  assert.equal(normalizeMemoryActionShape(null), null);
  assert.equal(normalizeMemoryActionShape('不是对象'), null);
  assert.equal(normalizeMemoryActionShape({}), null);
  const variant = normalizeMemoryActionShape({ action: 'create', judgement: '英式拼写也要能救' });
  assert.equal(variant.memory.judgment, '英式拼写也要能救');
});

test('④ 真·空 judgment 只丢那一条，同批其他条目照常可用', () => {
  const actions = [
    wrapped(''),
    wrapped('她讨厌香菜'),
    { action: 'create', sourceMemoryIds: [], memory: { memoryType: 'emotion', subject: 'user', reasoning: '忘了写判断句', tags: ['情绪'] } },
  ];
  const plan = planMemoryActionApply(actions);
  assert.equal(plan.applicable.length, 1, '只有一条是好的');
  assert.equal(plan.skipped.length, 2);
  assert.deepEqual(plan.skipped.map(s => s.reason), ['judgment_empty', 'judgment_empty']);
});

test('⑤ 非法 memoryType / 逐条校验失败 → 归到 invalid，不连坐', () => {
  const plan = planMemoryActionApply([wrapped('正常一条'), wrapped('类型写歪了', { memoryType: '心情' })]);
  assert.equal(plan.applicable.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'invalid');
  assert.match(plan.skipped[0].detail, /memoryType/);
});

test('⑥ 全部不可用 → 返回空且不抛（调用方据此推进 checkpoint，不再死循环）', () => {
  const plan = planMemoryActionApply([wrapped(''), null, 'junk']);
  assert.deepEqual(plan.applicable, []);
  assert.equal(plan.skipped.length, 3);
  assert.deepEqual(planMemoryActionApply(undefined), { applicable: [], skipped: [] });
});

test('⑦ 逐条落库：坏条目不再连坐（DB 断言 + 旧行为对照）', () => {
  const conversationId = 'char_salvage';
  const good = wrapped('她养了一只猫叫团子', { tags: ['生活'] });
  const bad = wrapped('', { tags: ['生活'] });

  // 旧行为对照：整批交给 applyMemoryActions 会直接抛，一条都存不下
  assert.throws(
    () => applyMemoryActions({ conversationId, sourceRawStartId: 1, sourceRawEndId: 2, actions: [bad, good], eventTime: '2026-09-30 10:00:00' }),
    /judgment 不能为空/,
  );

  // 新行为：先筛查，再逐条落库
  const plan = planMemoryActionApply([bad, good]);
  assert.equal(plan.applicable.length, 1);
  const saved = [];
  for (const item of plan.applicable) {
    saved.push(...applyMemoryActions({
      conversationId, sourceRawStartId: 1, sourceRawEndId: 2, sourceMessageId: null, actions: [item], eventTime: '2026-09-30 10:00:00',
    }));
  }
  assert.equal(saved.length, 1, '好的那条必须落库');
  const row = getDb().prepare('SELECT memory_id, judgment, status FROM memory_fragments WHERE conversation_id = ?').all(conversationId);
  assert.equal(row.length, 1);
  assert.equal(row[0].judgment, '她养了一只猫叫团子');
  assert.equal(row[0].status, 'active');
});
