/**
 * 问题 3 复现：群聊 RAG 的查询词被截断到 24 个 token，导致群 RAG 近乎空转。
 *
 * 真机实测：话题「大家说说自己养过的猫、怕黑的事、收藏的东西吧，顺便聊聊上次群里说的露营。」
 * 分词后「露营」落在被 `.slice(0, 24)` 截掉的部分 → 群里含"露营"的记忆一条都没召回，第 2/3 轮 `hits=0`。
 *
 * 这里用**真实 `hybridSearch`/`textSearch`（DB_PATH=:memory:）**证明：
 *   · 默认（不传 `queryTokenLimit`）查不到那条记忆 —— 历史行为不变；
 *   · 传 64 就能查到；
 *   · 上限仍然有界（第 65 个之后的 token 依旧被截掉，不会变成"不截断"）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 一律抛错挡网络
 *（hybridSearch 会尝试系统内置嵌入，本文件要证明纯离线也能召回）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
let networkAttempts = 0;
globalThis.fetch = async url => {
  networkAttempts += 1;
  throw new Error(`queryTokenLimit fixture forbids network: ${url}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { hybridSearch, textSearch, queryTokens, QUERY_TOKEN_LIMIT_DEFAULT } =
  await import('../src/services/memorySearch.js');

const GROUP_CONV = 'group_4242';
const KEYWORD = '露营';

/**
 * 30 个互不相同的两字词（每个恰好贡献 1 个 token，且都不含关键词）：
 * 分词正则按 `[\p{Script=Han}]{2,}` 切，所以用空格隔开即可逐词成 token。
 * 用"生僻字对"是为了保证它们绝不会出现在任何记忆正文里 —— 默认口径下必须是 0 命中。
 */
const FILLER_WORDS = [
  '氢氦', '锂铍', '硼碳', '氮氧', '氟氖', '钠镁', '铝硅', '磷硫', '氯氩', '钾钙',
  '钪钛', '钒铬', '锰铁', '钴镍', '铜锌', '镓锗', '砷硒', '溴氪', '铷锶', '钇锆',
  '铌钼', '锝钌', '铑钯', '银镉', '铟锡', '锑碲', '碘氙', '铯钡', '镧铈', '镨钕',
];

/** 30 个填充词 + 关键词：关键词落在第 31 个 token（默认 24 个就是被截掉的那部分） */
const HARD_QUERY = `${FILLER_WORDS.join(' ')} ${KEYWORD}`;
/**
 * 70 个填充词 + 关键词：即使放宽到 64，关键词（第 71 个 token）也还是够不着 —— 证明上限依旧有界。
 * 70 = 30 原词 + 30 倒序词 + 10 个新组合（全部互不相同）。
 */
const OVERFLOW_FILLERS = [
  ...FILLER_WORDS,
  ...FILLER_WORDS.map(word => word[1] + word[0]),
  '氢锂', '硼氮', '氟钠', '铝磷', '氯钾', '钪钒', '锰钴', '铜镓', '砷溴', '铷钇',
];
const OVERFLOW_QUERY = `${OVERFLOW_FILLERS.join(' ')} ${KEYWORD}`;

let memorySeq = 0;
function seedMemory(db, { conversationId, judgment, importance = 4 }) {
  memorySeq += 1;
  const memoryId = `mem_qlimit_${memorySeq}`;
  const now = '2026-08-01 10:00:00';
  db.prepare(`
    INSERT INTO memory_fragments
      (conversation_id, fragment_type, content, memory_id, memory_type, subject, judgment, tags, status,
       importance, updated_at, created_at, valid_from, keywords, perspectives, semantic_note, episodic_note)
    VALUES (?, 'fact', ?, ?, 'knowledge', 'user', ?, '["测试"]', 'active', ?, ?, ?, ?, '[]', '[]', '', '')
  `).run(conversationId, judgment, memoryId, judgment, importance, now, now, now);
  return memoryId;
}

function useMemDb(t) {
  const db = getDb();
  t.after(() => closeDb());
  return db;
}

test('分词口径：默认仍是 24 个 token，关键词落在第 25 个之后就被截掉', () => {
  assert.equal(QUERY_TOKEN_LIMIT_DEFAULT, 24, '默认值必须保持 24（私聊召回共用同一处分词）');

  const byDefault = queryTokens(HARD_QUERY);
  assert.equal(byDefault.length, QUERY_TOKEN_LIMIT_DEFAULT);
  assert.equal(byDefault.includes(KEYWORD), false, `默认口径下「${KEYWORD}」被截掉`);
  // 70 个填充词 + 关键词：关键词在第 71 个 token
  assert.equal(queryTokens(OVERFLOW_QUERY).includes(KEYWORD), false);

  const wide = queryTokens(HARD_QUERY, 64);
  assert.equal(wide.length, FILLER_WORDS.length + 1);
  assert.equal(wide.indexOf(KEYWORD), FILLER_WORDS.length, `「${KEYWORD}」排在第 ${FILLER_WORDS.length + 1} 个 token`);
  // 上限仍然有界：放宽到 64 也够不着第 61 个之后的词
  assert.equal(queryTokens(OVERFLOW_QUERY, 64).includes(KEYWORD), false, '64 不是"不截断"');
  // 非法值回退默认，避免变成"全文全 token"
  assert.equal(queryTokens(HARD_QUERY, 0).length, QUERY_TOKEN_LIMIT_DEFAULT);
  assert.equal(queryTokens(HARD_QUERY, -5).length, QUERY_TOKEN_LIMIT_DEFAULT);
  assert.equal(queryTokens(HARD_QUERY, 'x').length, QUERY_TOKEN_LIMIT_DEFAULT);
  assert.equal(queryTokens(HARD_QUERY, null).length, QUERY_TOKEN_LIMIT_DEFAULT);
});

test('问题 3 端到端：默认 limit 下群记忆查不到，传 64 就能查到（真实 hybridSearch，离线）', async t => {
  const db = useMemDb(t);
  seedMemory(db, { conversationId: GROUP_CONV, judgment: `上次群里说的${KEYWORD}：大家约好国庆去山里住两晚。` });

  // ① 默认口径（= 私聊现状）：关键词被截掉 → 一条都召回不到
  const byDefault = await hybridSearch(HARD_QUERY, { conversationIds: [GROUP_CONV], topK: 5, timeoutMs: 8000 });
  assert.deepEqual(byDefault, [], `默认 limit 下不该有命中（这就是真机 hits=0 的复现）`);

  // ② 显式放宽（群聊轮的调用口径）：论文关键词进 token 列表 → 群记忆被召回
  const widened = await hybridSearch(HARD_QUERY, {
    conversationIds: [GROUP_CONV], topK: 5, timeoutMs: 8000, queryTokenLimit: 64,
  });
  assert.equal(widened.length, 1, `传 64 应召回那条群记忆：${JSON.stringify(widened.map(h => h.judgment))}`);
  assert.equal(widened[0].conversation_id, GROUP_CONV);
  assert.ok(widened[0].judgment.includes(KEYWORD));

  // ③ 上限依旧有界：关键词在第 61 个 token 之后，64 也查不到
  const overflow = await hybridSearch(OVERFLOW_QUERY, {
    conversationIds: [GROUP_CONV], topK: 5, timeoutMs: 8000, queryTokenLimit: 64,
  });
  assert.deepEqual(overflow, [], '放宽到 64 仍然是有界截断');

  assert.ok(networkAttempts > 0, '嵌入通道被本文件的 fetch 桩挡下，召回完全靠文本通道');
});

test('问题 3 文本通道同口径：textSearch 默认查不到，传 queryTokenLimit 才命中', async t => {
  const db = useMemDb(t);
  seedMemory(db, { conversationId: GROUP_CONV, judgment: `${KEYWORD}用的帐篷是她自己挑的。` });

  assert.deepEqual(textSearch(HARD_QUERY, [GROUP_CONV], 5), [], '默认 24 个 token 里没有关键词');
  const widened = textSearch(HARD_QUERY, [GROUP_CONV], 5, { queryTokenLimit: 64 });
  assert.equal(widened.length, 1);
  assert.equal(widened[0].conversation_id, GROUP_CONV);
  // 不传时与显式传默认值逐字节一致（证明"默认行为不变"）
  assert.deepEqual(textSearch(HARD_QUERY, [GROUP_CONV], 5), textSearch(HARD_QUERY, [GROUP_CONV], 5, { queryTokenLimit: QUERY_TOKEN_LIMIT_DEFAULT }));
});
