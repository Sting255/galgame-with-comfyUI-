/**
 * 嵌入输入长度上限（task-43）
 *
 * 真机：`完整/新建文件夹/新建文件夹/backend-2026-09-29.log:147` 那一轮 RAG 查询里被塞进了整段群聊记录，
 * 内置嵌入服务直接报 `The parameter is invalid`（`fallback="embedding: 系统内置嵌入服务失败 (1/5)"`），
 * 该轮降级成纯文字检索（`retrieval=文字检索(text) rerank=失败`）。
 *
 * 口径：只截断**送给嵌入**的输入；textSearch / entitySearch / rerank 仍用完整 query。
 * （与 memorySearchQueryTokenLimit.test.js 同类守卫：长度类改动必须有回归。）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { EMBED_INPUT_MAX_CHARS, QUERY_TOKEN_LIMIT_DEFAULT } = await import('../src/services/memorySearch.js');

test('上限常量：是正整数，且不至于把私聊短查询切成两半', () => {
  assert.ok(Number.isInteger(EMBED_INPUT_MAX_CHARS) && EMBED_INPUT_MAX_CHARS > 0, '必须是正整数');
  assert.ok(EMBED_INPUT_MAX_CHARS >= 256, '太小的上限会破坏长查询的语义指纹');
  assert.equal(QUERY_TOKEN_LIMIT_DEFAULT, 24, '分词上限口径不受本次改动影响');
});

test('挂点：只有送进 embedMemoryText 的输入被 slice，其余通道仍用完整 query', async () => {
  const source = await readFile(new URL('../src/services/memorySearch.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes("await embedMemoryText(String(query ?? '').slice(0, EMBED_INPUT_MAX_CHARS), settings)"),
    '嵌入调用必须截断到 EMBED_INPUT_MAX_CHARS',
  );
  assert.ok(source.includes('textSearch(query, conversationIds, textLimit'), '文本检索仍用完整 query');
  assert.ok(source.includes('entitySearch(query, conversationIds, textLimit'), '实体通道仍用完整 query');
});

test('行为：超长查询被截断，短查询逐字节不变', () => {
  const cut = s => String(s ?? '').slice(0, EMBED_INPUT_MAX_CHARS);
  const short = '[Tester] 你昨天说的那个';
  assert.equal(cut(short), short, '短查询必须原样送出');
  const long = '[Tester] 开始 ' + '[群聊记录] '.repeat(500);
  assert.equal(cut(long).length, EMBED_INPUT_MAX_CHARS, '超长查询必须被截断到上限');
  assert.ok(cut(long).startsWith('[Tester] 开始'), '截断保留前缀（语义指纹来自开头）');
});
