/**
 * 亲密看板「AI 判断行为」（task-32）
 *
 * 核心口径（用户裁决：加「AI 判断行为」按钮 + 「是否默认开启 AI 判断」开关 + 异步）：
 *   - 只补两类轮次：一条流水都没有 / 只有「未归类」；已有具体行为的轮次不参与（**不重复计数**）；
 *   - 判定出 ≥1 条具体行为时，撤掉该轮的「未归类」，避免同一次发生被算两遍；
 *   - 行为白名单过滤 + 数值夹取；LLM 输出不是 JSON / 调用失败 → 只报错、不写脏数据；
 *   - 总开关 config.features.intimate=false 时 blocked（与 /record、/backfill 同口径）；
 *   - 群聊 raw 是"多角色剧本"：只挑**她自己**的台词送去判定。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；LLM 用可注入的假调用（不打网络）。
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimateAiJudge fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  setAiJudgeEnabled, getBodyProfile, recordIntimateActs,
} = await import('../src/services/intimateService.js');
const {
  __setLlmCallForTest, buildJudgePrompt, parseJudgeOutput, needsAiJudge,
  existingActsForRaw, listJudgeCandidates, judgeRound, judgeRecentRounds,
} = await import('../src/services/intimateAiJudge.js');

/** 造角色 + 私聊会话里的若干 raw；返回 id 与 raw ids */
function seed(t, { displayName = '甲', rounds = 1, conversationId = null } = {}) {
  const db = getDb();
  t.after(() => { closeDb(); __setLlmCallForTest(null); });
  const id = Number(db.prepare(
    'INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)'
  ).run(`ai_${displayName}`, displayName, `你是${displayName}。`).lastInsertRowid);
  // 会话名必须按角色 id 生成：`:memory:` 库在用例之间是共享的，角色 id 会递增
  const conv = conversationId || `char_${id}`;
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  const rawIds = [];
  for (let i = 0; i < rounds; i += 1) {
    insert.run(conv, 'user', `[u${i + 1}] 用户第 ${i + 1} 句`);
    rawIds.push(Number(insert.run(conv, 'assistant', `[a${i + 1}] 她的第 ${i + 1} 句`).lastInsertRowid));
  }
  return { db, id, rawIds, conversationId: conv };
}

const fakeLlm = payload => __setLlmCallForTest(async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)));

// ──────────────── 1. 解析 ────────────────

test('parseJudgeOutput：裸 JSON / ```json 包裹 / 前后带话 都能解', () => {
  const body = '{"acts":[{"act_key":"hand","partner":"user","confidence":0.8,"count":2,"climax_count":1}],"reason":"她用手"}';
  const a = parseJudgeOutput(body);
  assert.equal(a.ok, true);
  assert.deepEqual(a.acts, [{ actKey: 'hand', partnerKind: 'user', confidence: 0.8, count: 2, climaxCount: 1 }]);
  assert.equal(a.reason, '她用手');

  const fenced = parseJudgeOutput('```json\n' + body + '\n```');
  assert.deepEqual(fenced.acts, a.acts);

  const chatty = parseJudgeOutput('好的，结果如下：\n' + body + '\n希望有帮助');
  assert.deepEqual(chatty.acts, a.acts);
});

test('parseJudgeOutput：非 JSON → ok:false；白名单外 / unspecified 被过滤；数值夹取', () => {
  assert.equal(parseJudgeOutput('完全不是 JSON').ok, false);
  assert.equal(parseJudgeOutput('').ok, false);
  assert.equal(parseJudgeOutput(null).ok, false);

  const res = parseJudgeOutput(JSON.stringify({
    acts: [
      { act_key: 'not_a_real_act', partner: 'user', confidence: 1 },
      { act_key: 'unspecified', partner: 'user', confidence: 1 },
      { act_key: 'oral', partner: 'character', confidence: 9, count: 999, climax_count: -3 },
      { act_key: 'climax', partner: '怪东西', confidence: -1, count: 0 },
    ],
  }));
  assert.deepEqual(res.acts.map(x => x.actKey), ['oral', 'climax']);
  assert.equal(res.acts[0].partnerKind, 'character');
  assert.equal(res.acts[0].confidence, 1, 'confidence 要夹到 1');
  assert.equal(res.acts[0].count, 99, 'count 夹到上限');
  assert.equal(res.acts[0].climaxCount, 0, '负数高潮次数归 0');
  assert.equal(res.acts[1].partnerKind, 'user', '未知 partner 回落 user');
  assert.equal(res.acts[1].confidence, 0);
  assert.equal(res.acts[1].count, 1, 'count=0 归 1');
});

test('buildJudgePrompt：给出完整 JSON 示例与字段约束（AGENTS.md 口径）', () => {
  const prompt = buildJudgePrompt({ characterName: '甲', userName: '阿远', lines: ['用户：摸我', '甲：好'], scene: 'chat' });
  assert.match(prompt, /```json/);
  assert.match(prompt, /"act_key": "hand"/);
  assert.match(prompt, /"partner": "user"/);
  assert.match(prompt, /"confidence": 0\.9/);
  assert.match(prompt, /"count": 1/, '示例里要有 count');
  assert.match(prompt, /"climax_count": 0/, '示例里要有 climax_count');
  assert.match(prompt, /"reason"/);
  assert.match(prompt, /阿远/, '要把用户称呼写进约束');
  assert.match(prompt, /甲/);
  assert.ok(prompt.includes('用户：摸我') && prompt.includes('甲：好'));
  assert.ok(!prompt.includes('unspecified'), '判定白名单里不该出现未归类');
});

// ──────────────── 2. 补判门槛 ────────────────

test('needsAiJudge：没流水 / 只有未归类才补判；有具体行为就不判', () => {
  assert.equal(needsAiJudge([]), true);
  assert.equal(needsAiJudge(null), true);
  assert.equal(needsAiJudge([{ act_key: 'unspecified' }]), true);
  assert.equal(needsAiJudge([{ act_key: 'unspecified' }, { act_key: 'unspecified' }]), true);
  assert.equal(needsAiJudge([{ act_key: 'vaginal' }]), false);
  assert.equal(needsAiJudge([{ act_key: 'unspecified' }, { act_key: 'oral' }]), false);
});

// ──────────────── 3. judgeRound ────────────────

test('judgeRound：记入具体行为（source=llm）并撤掉该轮的未归类', async t => {
  const { db, id, rawIds } = seed(t, { rounds: 1 });
  const rawId = rawIds[0];
  // 先有一条"未归类"（模拟正文兜底）
  recordIntimateActs(id, { scene: 'chat', rawId, acts: [{ actKey: 'unspecified', sourceUid: `auto:chat:raw${rawId}:unspecified` }] });
  assert.equal(existingActsForRaw(id, rawId).length, 1);

  fakeLlm({ acts: [{ act_key: 'hand', partner: 'user', confidence: 0.9 }], reason: '她握住' });
  const res = await judgeRound({ characterId: id, rawId, scene: 'chat', lines: ['用户：握住我', '甲：嗯'] });

  assert.equal(res.ok, true);
  assert.equal(res.recorded, 1);
  assert.equal(res.superseded, 1, '应撤掉 1 条未归类');
  const rows = db.prepare('SELECT act_key, source FROM character_intimate_log WHERE character_id = ? ORDER BY id').all(id);
  assert.deepEqual(rows, [{ act_key: 'hand', source: 'llm' }], '未归类被换成具体行为');
});

test('judgeRound：已有具体行为的轮次直接跳过（不重复计数）', async t => {
  const { id, rawIds } = seed(t, { rounds: 1 });
  const rawId = rawIds[0];
  recordIntimateActs(id, { scene: 'chat', rawId, acts: [{ actKey: 'vaginal', sourceUid: `auto:chat:raw${rawId}:vaginal` }] });
  let called = 0;
  __setLlmCallForTest(async () => { called += 1; return '{"acts":[]}'; });

  const res = await judgeRound({ characterId: id, rawId, scene: 'chat', lines: ['x'] });
  assert.equal(res.reason, 'already-recorded');
  assert.equal(called, 0, '不该调用模型');
  assert.equal(existingActsForRaw(id, rawId).length, 1);
});

test('judgeRound：模型说没有亲密行为 → 什么都不写，未归类保留', async t => {
  const { db, id, rawIds } = seed(t, { rounds: 1 });
  const rawId = rawIds[0];
  recordIntimateActs(id, { scene: 'chat', rawId, acts: [{ actKey: 'unspecified', sourceUid: `auto:chat:raw${rawId}:unspecified` }] });

  fakeLlm({ acts: [], reason: '只是聊天' });
  const res = await judgeRound({ characterId: id, rawId, scene: 'chat', lines: ['今天天气不错'] });
  assert.equal(res.ok, true);
  assert.equal(res.recorded, 0);
  assert.equal(res.superseded, 0);
  assert.deepEqual(db.prepare('SELECT act_key FROM character_intimate_log WHERE character_id = ?').all(id), [{ act_key: 'unspecified' }]);
});

test('judgeRound：模型抛错 / 输出不是 JSON → 只报错，不写任何流水', async t => {
  const { db, id, rawIds } = seed(t, { rounds: 1 });
  const rawId = rawIds[0];
  __setLlmCallForTest(async () => { throw new Error('上游 500'); });
  const res = await judgeRound({ characterId: id, rawId, scene: 'chat', lines: ['x'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /上游 500/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM character_intimate_log').get().c, 0);

  __setLlmCallForTest(async () => '这不是 JSON');
  const res2 = await judgeRound({ characterId: id, rawId, scene: 'chat', lines: ['x'] });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /不是合法 JSON/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM character_intimate_log').get().c, 0);
});

test('judgeRound：总开关关闭 → blocked，不调模型', async t => {
  const { id, rawIds } = seed(t, { rounds: 1 });
  let called = 0;
  __setLlmCallForTest(async () => { called += 1; return '{"acts":[]}'; });
  const prev = config.features;
  config.features = { ...prev, intimate: false };
  try {
    const res = await judgeRound({ characterId: id, rawId: rawIds[0], scene: 'chat', lines: ['x'] });
    assert.equal(res.blocked, true);
    assert.equal(called, 0);
  } finally {
    config.features = prev;
  }
});

// ──────────────── 4. 候选轮次（含群聊只挑自己的台词） ────────────────

test('listJudgeCandidates：私聊"无流水"轮入选、"已有具体行为"轮落选', async t => {
  const { id, rawIds, conversationId } = seed(t, { rounds: 2 });
  recordIntimateActs(id, { scene: 'chat', rawId: rawIds[1], acts: [{ actKey: 'oral', sourceUid: `auto:chat:raw${rawIds[1]}:oral` }] });
  const list = listJudgeCandidates(id, { limit: 5 });
  assert.deepEqual(list.map(x => x.id), [rawIds[0]], '只有第一条没有流水');
  assert.equal(list[0].scene, 'chat');
  assert.ok(list[0].lines.some(l => l.includes('她的第 1 句')), '要带上她的回复');
  assert.ok(list[0].lines.some(l => l.includes('用户第 1 句')), '也要带上用户那句');
  assert.equal(list[0].conversationId, conversationId);
});

test('listJudgeCandidates：群聊 raw 只取她自己说的那几行；没说过的轮次不入选', async t => {
  const db = getDb();
  const { id } = seed(t, { rounds: 0, displayName: '甲' });
  const other = Number(db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?,?,?)')
    .run('ai_乙', '乙', '你是乙。').lastInsertRowid);
  const gid = Number(db.prepare("INSERT INTO group_chats (name, created_by) VALUES ('群', 'user')").run().lastInsertRowid);
  db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id);
  db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, other);
  const conv = `group_${gid}`;
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  // 第 1 轮：她说了话
  const rawA = Number(insert.run(conv, 'assistant', '[乙]: 你好呀\n[甲]: 我有点热\n[乙]: 怎么了').lastInsertRowid);
  // 第 2 轮：她一句话都没说
  const rawB = Number(insert.run(conv, 'assistant', '[乙]: 今天天气不错').lastInsertRowid);

  const list = listJudgeCandidates(id, { limit: 5 });
  assert.deepEqual(list.map(x => x.id), [rawA], '没说过话的 rawB 不该入选');
  assert.deepEqual(list[0].lines, ['我有点热'], '只取甲自己的台词');
  assert.equal(list[0].scene, 'group');
});

// ──────────────── 5. 批量补判 ────────────────

test('judgeRecentRounds：串行补判最近若干轮，汇总 scanned/judged/recorded', async t => {
  const { id, rawIds } = seed(t, { rounds: 3 });
  let calls = 0;
  __setLlmCallForTest(async () => {
    calls += 1;
    return JSON.stringify({ acts: [{ act_key: 'hand', partner: 'user', confidence: 0.7 }], reason: '摸' });
  });
  const summary = await judgeRecentRounds(id, { limit: 2 });
  assert.equal(summary.scanned, 2, 'limit=2 只扫两条');
  assert.equal(summary.judged, 2);
  assert.equal(summary.recorded, 2);
  assert.equal(calls, 2);
  assert.deepEqual(summary.errors, []);
  const db = getDb();
  const rows = db.prepare('SELECT raw_id, act_key, source FROM character_intimate_log WHERE character_id = ? ORDER BY raw_id').all(id);
  assert.deepEqual(rows.map(r => [r.act_key, r.source]), [['hand', 'llm'], ['hand', 'llm']]);
  assert.deepEqual(rows.map(r => r.raw_id).sort((a, b) => a - b), [rawIds[1], rawIds[2]].sort((a, b) => a - b), '补的是最近两条');

  // 再跑一次：刚才那两条已有具体行为 → 不会被重复记账；只剩最早那条还没判过
  const again = await judgeRecentRounds(id, { limit: 2 });
  assert.equal(again.scanned, 1, '只剩最早那一条未判');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM character_intimate_log WHERE character_id = ?').get(id).c, 3, '第二轮又补了 1 笔（3 轮各 1 笔，无重复）');
  // 第三次：全部轮次都已有具体行为 → 没有任何候选，也不再调用模型
  let callsAfter = calls;
  const third = await judgeRecentRounds(id, { limit: 3 });
  assert.equal(third.scanned, 0 , '全部已记账 → 无候选');
  assert.equal(calls, callsAfter, '无候选时不该再调模型');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM character_intimate_log WHERE character_id = ?').get(id).c, 3);
});

test('setAiJudgeEnabled：开关落到档案里，默认关', async t => {
  const { id } = seed(t, { rounds: 0 });
  assert.equal(getBodyProfile(id).aiJudgeEnabled, false, '默认关（避免每轮多一次 LLM 调用）');
  assert.equal(setAiJudgeEnabled(id, true).aiJudgeEnabled, true);
  assert.equal(getBodyProfile(id).aiJudgeEnabled, true);
  assert.equal(setAiJudgeEnabled(id, false).aiJudgeEnabled, false);
});
