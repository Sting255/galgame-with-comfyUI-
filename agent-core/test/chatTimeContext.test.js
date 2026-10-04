/**
 * 主聊天 `<time_context>` 的口径回归（规划-代码审查改进 §2.1 / §2.2）
 *
 * 两件事各一条「先红后绿」：
 *   §2.2 **时间上下文吃程序时间**（用户裁决 2026-09-30）——
 *        用户把程序时间拨到夜里，`<time_context>` 里的"现在"必须也是夜里；
 *        改动前 chat.js 用 `new Date()`（靠 timeLight 内部隐式加偏移），gap 用真实钟。
 *   §2.1 **`prevUserMsg` 的 OFFSET 1 语义**——"距上次聊天间隔"引用的必须是**上一条** user 消息，
 *        不是上上条，也不是当前这条。当前行为是否错位靠本文件裁定（证实则修，证伪则留作前提测试）。
 *
 * 环境：`:memory:` 库、禁网、程序时间偏移可注入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`chat time context fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { toSqlUtc, setProgramOffsetMs, resetProgramTime, invalidateProgramTimeCache, getProgramNow } = await import('../src/services/programTime.js');
const { getTimeTag } = await import('../src/services/timeLight.js');
const { buildTimeContextBlock, loadPreviousUserMessageAt, TIME_CONTEXT_GAP_MINUTES } = await import('../src/services/chatTimeContext.js');

test.after(() => closeDb());

const CONV = 'char_time_ctx';
const HOUR_MS = 3600000;

function seedConversation(rows) {
  const db = getDb();
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(CONV);
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  const ids = [];
  for (const row of rows) {
    ids.push(Number(insert.run(CONV, row.role, row.content || row.role, row.createdAt ? toSqlUtc(new Date(row.createdAt)) : toSqlUtc(new Date())).lastInsertRowid));
  }
  return ids;
}

// ── §2.2 程序时间（红→绿） ──

test('§2.2 【红】time_context 必须吃程序时间：偏移 +10 天后块里的"现在"不是真实钟', async () => {
  try {
    setProgramOffsetMs(10 * 24 * HOUR_MS);
    invalidateProgramTimeCache();
    const real = new Date();
    const program = getProgramNow();
    // 前提：程序时间确实被拨远了（否则本用例无意义）
    assert.ok((program.getTime() - real.getTime()) > 9 * 24 * HOUR_MS, '程序时间应比真实时间快约 10 天');

    // 两对问答：上一条 user 在 3 小时前，"当前这条"在 1 分钟前（模拟真实时序）
    seedConversation([
      { role: 'user', createdAt: real.getTime() - 3 * HOUR_MS },
      { role: 'assistant', createdAt: real.getTime() - 3 * HOUR_MS + 1000 },
      { role: 'user', createdAt: real.getTime() - 60 * 1000 },
    ]);

    const block = buildTimeContextBlock(getDb(), CONV);
    // 程序时间的日期串必须出现在块里
    const programDateStr = `${program.getFullYear()}-${String(program.getMonth() + 1).padStart(2, '0')}-${String(program.getDate()).padStart(2, '0')}`;
    assert.ok(block.includes(programDateStr), `块里应是程序日期 ${programDateStr}，实际=${block}`);
    // 【2026-10-01 收紧】**只认第一行**，且必须逐字等于 getTimeTag()（= 程序时间的「现在」）。
    // 原来只断言 `includes(日期串)` + `includes(getTimeTag(program))`，有两个洞：
    //   · `includes(日期串)` 会被第二行「上次对话」的日期串**蒙对** —— 偏移 +10 天时，
    //     `created_at - 3 小时` 换算到程序时间正好落在程序日期上，于是**块里「现在」明明是
    //     +20 天（双倍偏移的 bug），用例照样绿**。这也解释了它为什么时红时绿：
    //     只有本地时刻 < 03:00（real-3h 跨到前一天）时才会红。
    //   · `includes(getTimeTag(program))` 断言的是**双倍偏移**的结果，等于把 bug 钉成契约。
    const nowLine = block.split('\n')[1];
    assert.equal(nowLine, getTimeTag(), `块的「现在」行必须逐字等于 getTimeTag()（程序时间）：实际=${nowLine}`);
  } finally {
    resetProgramTime();
    invalidateProgramTimeCache();
  }
});

test('§2.2 gap 两端都用程序时间：偏移把"3 小时前"推成"10 天前的 3 小时"', async () => {
  try {
    setProgramOffsetMs(10 * 24 * HOUR_MS);
    invalidateProgramTimeCache();
    const real = new Date();
    seedConversation([
      { role: 'user', createdAt: real.getTime() - 3 * HOUR_MS },
      { role: 'assistant', createdAt: real.getTime() - 3 * HOUR_MS + 1000 },
      { role: 'user', createdAt: real.getTime() - 60 * 1000 },
    ]);

    const block = buildTimeContextBlock(getDb(), CONV);
    // 程序时间 ≈ 真实 + 10 天；上一条 user 在真实 3 小时前 ⇒ 程序时间轴上也是约 3 小时前
    const gapLine = block.split('\n').find(line => line.startsWith('[上次对话'));
    assert.ok(gapLine, `应写出上次对话行：${block}`);
    const programPrev = new Date(real.getTime() - 3 * HOUR_MS + 10 * 24 * HOUR_MS);
    const expectDate = `${programPrev.getFullYear()}-${String(programPrev.getMonth() + 1).padStart(2, '0')}-${String(programPrev.getDate()).padStart(2, '0')}`;
    assert.ok(gapLine.includes(expectDate), `gap 行应按程序时间轴算，实际=${gapLine}`);
  } finally {
    resetProgramTime();
    invalidateProgramTimeCache();
  }
});

test('§2.2 偏移为 0（默认）：与真实钟逐字节一致（零行为变化）', () => {
  const real = new Date();
  seedConversation([
    { role: 'user', createdAt: real.getTime() - 3 * HOUR_MS },
    { role: 'assistant', createdAt: real.getTime() - 3 * HOUR_MS + 1000 },
    { role: 'user', createdAt: real.getTime() - 60 * 1000 },
  ]);
  const block = buildTimeContextBlock(getDb(), CONV);
  const lines = block.split('\n');
  assert.ok(lines[0].startsWith('<time_context>'));
  assert.ok(lines[1].includes(getTimeTag(new Date())), '偏移 0 时当前时间行 = 真实钟的时间标签');
  assert.ok(lines.some(line => line.startsWith('[上次对话')), '超过 10 分钟 ⇒ 仍写上次对话行');
});

test('§2.2 距上次不足 10 分钟 ⇒ 不写上次对话行（原有阈值不变）', () => {
  const real = new Date();
  seedConversation([
    { role: 'user', createdAt: real.getTime() - 2 * 60 * 1000 },
    { role: 'assistant', createdAt: real.getTime() - 2 * 60 * 1000 + 1000 },
    { role: 'user', createdAt: real.getTime() - 30 * 1000 },
  ]);
  const block = buildTimeContextBlock(getDb(), CONV);
  assert.ok(!block.includes('[上次对话'), `间隔小于 ${TIME_CONTEXT_GAP_MINUTES} 分钟不该写该行：${block}`);
  assert.ok(block.includes('<time_context>'));
});

test('§2.2 没有历史消息（首轮）⇒ 只有当前时间行，不抛错', () => {
  seedConversation([{ role: 'user' }]);
  const block = buildTimeContextBlock(getDb(), CONV);
  assert.ok(block.includes('<time_context>'));
  assert.ok(!block.includes('[上次对话'), '当前这条是第一条 user，没有"上次"');
});

// ── §2.1 prevUserMsg：OFFSET 1 的语义裁定 ──

test('§2.1 prevUserMsg 取的是"上一条 user"（不是当前这条、也不是上上条）', () => {
  const now = Date.now();
  // u1(3h前) / a1 / u2(2h前) / a2 / u3(当前这条，1 分钟前) —— 模拟"当前消息已落库"的真实时序
  const ids = seedConversation([
    { role: 'user', content: 'u1', createdAt: now - 3 * HOUR_MS },
    { role: 'assistant', content: 'a1', createdAt: now - 3 * HOUR_MS + 1000 },
    { role: 'user', content: 'u2', createdAt: now - 2 * HOUR_MS },
    { role: 'assistant', content: 'a2', createdAt: now - 2 * HOUR_MS + 1000 },
    { role: 'user', content: 'u3(当前)', createdAt: now - 60 * 1000 },
  ]);
  assert.equal(ids.length, 5);

  const prevAt = loadPreviousUserMessageAt(getDb(), CONV);
  assert.ok(prevAt, '应能取到"上次对话"时间');
  const minutesFromU2 = Math.abs(prevAt.getTime() - (now - 2 * HOUR_MS)) / 60000;
  const minutesFromU1 = Math.abs(prevAt.getTime() - (now - 3 * HOUR_MS)) / 60000;
  const minutesFromU3 = Math.abs(prevAt.getTime() - (now - 60 * 1000)) / 60000;
  assert.ok(minutesFromU2 < 1, `应取 u2（上一条 user），实际距 u2 ${minutesFromU2.toFixed(1)} 分钟`);
  assert.ok(minutesFromU1 > 30, '不得取 u1（上上条）');
  assert.ok(minutesFromU3 > 30, '不得把当前这条 user 当成"上次对话"');

  // 块里的时间行也必须落在 u2 的钟点上（行为级复核）
  const block = buildTimeContextBlock(getDb(), CONV);
  const u2 = new Date(now - 2 * HOUR_MS);
  const u2Date = `${u2.getFullYear()}-${String(u2.getMonth() + 1).padStart(2, '0')}-${String(u2.getDate()).padStart(2, '0')}`;
  const gapLine = block.split('\n').find(line => line.startsWith('[上次对话'));
  assert.ok(gapLine?.includes(u2Date), `gap 行应为 u2 的日期，实际=${gapLine}`);
});

test('§2.1 只有一条 user（没有"上次"）⇒ 返回 null，不误取当前这条', () => {
  seedConversation([{ role: 'user', content: 'only', createdAt: Date.now() - 60 * 1000 }]);
  assert.equal(loadPreviousUserMessageAt(getDb(), CONV), null);
});

// ── 源码级：chat.js 的接线（防有人改回内联 new Date()） ──

test('源码级：chat.js 的 <time_context> 已改走 chatTimeContext（不再内联 new Date() 算时间）', async () => {
  const src = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from '../services/chatTimeContext.js'"), 'chat.js 应 import 抽出的时间上下文模块');
  assert.ok(src.includes('buildTimeContextBlock(db, conversationId)'), '应调用 buildTimeContextBlock');
  // 时间上下文那一小段（注释锚点 → buildTimeContextBlock 推入）不得再出现内联真实钟。
  // 注意：锚点只取到注释块**之后**的代码行（注释里会提到 new Date() 作为历史说明）。
  const anchor = src.indexOf('14. 时间上下文');
  assert.ok(anchor > 0, '找不到 14. 时间上下文 注释锚点');
  const codeAt = src.indexOf('dynamicBlocks.push(buildTimeContextBlock', anchor);
  assert.ok(codeAt > anchor, 'buildTimeContextBlock 必须紧跟在该段注释之后');
  const region = src.slice(codeAt, src.indexOf('\n', codeAt) + 1);
  assert.ok(!/new Date\(\)/.test(region), '时间上下文段不得再用 new Date()：' + region);
  assert.ok(!/Date\.now\(\)/.test(region), '时间上下文段不得再用 Date.now()（真实钟）：' + region);
  // 旧的"倒数第二条 user"内联 SQL 已抽走，chat.js 里不该再有副本
  assert.ok(!/ORDER BY id DESC LIMIT 1 OFFSET 1/.test(src), 'OFFSET 1 的 prevUserMsg SQL 已抽到 chatTimeContext.js');
});
