/**
 * 「AI 判断行为」每日配额（本次改动新增）
 *
 * 覆盖：
 *   1. 默认 200 次/天；0 = 不限制（remaining=null、exhausted 恒 false）；
 *   2. 非法值：PUT /api/config/ai-judge 的 -1 / 1.5 / 字符串 / 缺失 → 400；
 *      GET /api/config 顶层多一个 aiJudge 对象，PUT 返回同一形状；
 *   3. 额度用完：**一次模型都不调**——自动补判（judgeRoundInBackground）打跳过日志，
 *      手动补判（judgeRound / judgeRecentRounds → POST …/ai-judge/run）返回 quota 且 errors 有人话；
 *   4. 计数落 system_settings（按本地日期，一行 { date, used }）：同一天的计数在
 *      **关库重开**后仍在；跨天自动归零。
 *
 * 环境约定：DB_PATH 指向 mkdtemp 出来的临时文件库（真实库 agent.db 不在访问范围内），
 * 先设环境变量再动态 import；LLM 用可注入的假调用，globalThis.fetch 抛错挡网络。
 * 计数是全局的（同一份库跨用例累积），所以需要绝对值的用例先 resetQuota()。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-aijudge-quota-'));
const DB_PATH = path.join(TMP, 'agent.db');
process.env.DB_PATH = DB_PATH;
process.env.LOG_TO_FILE = 'false';
globalThis.fetch = async url => { throw new Error(`ai-judge quota fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = DB_PATH; // 兜底：绝不允许漂到真实库
const { getDb, closeDb } = await import('../src/db/index.js');
const judge = await import('../src/services/intimateAiJudge.js');
const configRoutes = (await import('../src/routes/config.js')).default;
const intimateRoutes = (await import('../src/routes/intimate.js')).default;
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');

const app = express();
app.use(express.json());
app.use('/api/config', wrapRouterAsync(configRoutes));
app.use('/api/characters', wrapRouterAsync(intimateRoutes));

const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

after(async () => {
  judge.__setLlmCallForTest(null);
  await new Promise(resolve => server.close(resolve));
  closeDb();
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.warn(`[aiJudgeDailyQuota.test] 临时目录清理失败（可手动删）: ${TMP} :: ${err.message}`);
  }
});

function api(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: requestPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 替掉 console.log / console.warn 收集输出（用例结束自动还原） */
function captureConsole(t, method) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => { lines.push(args.map(value => String(value)).join(' ')); };
  t.after(() => { console[method] = original; });
  return lines;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

/** 把今天的计数清掉（同一份库跨用例累积，绝对值断言前必须先归零） */
function resetQuota() {
  getDb().prepare('DELETE FROM system_settings WHERE setting_key = ?').run(judge.AI_JUDGE_QUOTA_SETTING_KEY);
}

let seedSeq = 0;
/** 造角色 + 若干轮私聊 raw（judgeRound 的幂等锚点是 assistant raw id） */
function seed(t, { rounds = 3 } = {}) {
  const db = getDb();
  t.after(() => { closeDb(); judge.__setLlmCallForTest(null); });
  const id = Number(db.prepare(
    'INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)'
  ).run(`quota_${++seedSeq}`, `配额角色${seedSeq}`, '你是她。').lastInsertRowid);
  const conv = `char_${id}`;
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  const rawIds = [];
  for (let i = 0; i < rounds; i += 1) {
    insert.run(conv, 'user', `用户第 ${i + 1} 句`);
    rawIds.push(Number(insert.run(conv, 'assistant', `她的第 ${i + 1} 句`).lastInsertRowid));
  }
  return { db, id, rawIds, conversationId: conv };
}

/** 注入假 LLM 并数它被调用了几次 */
function countCalls(t) {
  const state = { calls: 0 };
  judge.__setLlmCallForTest(async () => {
    state.calls += 1;
    return JSON.stringify({ acts: [], reason: '只是聊天' });
  });
  t.after(() => judge.__setLlmCallForTest(null));
  return state;
}

const setLimit = value => judge.setAiJudgeDailyLimit(value);

// ──────────────── 1. 默认值 / 0 = 不限制 / 非法值 ────────────────

test('默认每日上限 200；GET /api/config 顶层带 aiJudge 对象', async () => {
  resetQuota();
  assert.equal(judge.DEFAULT_AI_JUDGE_DAILY_LIMIT, 200);
  assert.equal(judge.getAiJudgeDailyLimit(), 200, '从没配过时就是 200（不是 0=不限制）');

  const res = await api('GET', '/api/config');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.aiJudge, { dailyLimit: 200, usedToday: 0, remaining: 200, unlimited: false });
  // 既有顶层字段不能被挤掉/改名
  assert.ok(res.json.features && res.json.llm && res.json.comfy, '既有顶层字段仍在');
});

test('PUT /api/config/ai-judge：0 = 不限制（remaining=null）、正整数生效、非法 400', async () => {
  // 正整数
  const five = await api('PUT', '/api/config/ai-judge', { dailyLimit: 5 });
  assert.equal(five.status, 200, five.text);
  assert.deepEqual(five.json.aiJudge, { dailyLimit: 5, usedToday: 0, remaining: 5, unlimited: false });
  assert.equal(five.json.dailyLimit, 5, '四个字段也平铺一份，前端两种取法都能用');
  assert.equal(judge.getAiJudgeDailyLimit(), 5);
  const readBack = await api('GET', '/api/config');
  assert.equal(readBack.json.aiJudge.dailyLimit, 5, 'GET 能读回刚写的值');

  // 0 = 不限制：remaining 没有意义，如实给 null（不编一个大数字）
  const zero = await api('PUT', '/api/config/ai-judge', { dailyLimit: 0 });
  assert.equal(zero.status, 200, zero.text);
  assert.deepEqual(zero.json.aiJudge, { dailyLimit: 0, usedToday: 0, remaining: null, unlimited: true });
  const status = judge.getAiJudgeQuotaStatus();
  assert.equal(status.exhausted, false, '不限制时永远不会耗尽');
  assert.equal(status.unlimited, true);

  // 非法：负数 / 小数 / 字符串 / 布尔 / null / 缺失
  for (const bad of [-1, 1.5, '5', true, null, undefined]) {
    const res = await api('PUT', '/api/config/ai-judge', { dailyLimit: bad });
    assert.equal(res.status, 400, `dailyLimit=${String(bad)} 应 400（实际 ${res.status}）`);
    assert.match(res.json.error, /dailyLimit/);
  }
  assert.equal(judge.getAiJudgeDailyLimit(), 0, '非法请求不能改掉已保存的值');
});

test('0 = 不限制：额度永远够用，判断照跑', async t => {
  const { id, rawIds } = seed(t, { rounds: 1 });
  const calls = countCalls(t);
  resetQuota();
  await api('PUT', '/api/config/ai-judge', { dailyLimit: 0 });

  const res = await judge.judgeRound({ characterId: id, rawId: rawIds[0], scene: 'chat', lines: ['x'] });
  assert.equal(res.ok, true);
  assert.equal(res.quota.unlimited, true);
  assert.equal(res.quota.exhausted, false);
  assert.equal(res.quota.remaining, null);
  assert.equal(calls.calls, 1, '不限制时照常调用模型');
  assert.equal(judge.getAiJudgeUsedToday(), 1, '不限制也照常计数（面板要看得见今天跑了多少）');
});

// ──────────────── 2. 额度用完：不调模型 ────────────────

test('额度用完：自动补判跳过且不调模型，日志按约定格式打一行', async t => {
  const { id, rawIds } = seed(t, { rounds: 2 });
  const calls = countCalls(t);
  resetQuota();
  await setLimit(1);

  // 第 1 轮用掉唯一的一次（用完之后配额就是"已用完"）
  const first = await judge.judgeRound({ characterId: id, rawId: rawIds[0], scene: 'chat', lines: ['x'] });
  assert.equal(calls.calls, 1);
  assert.deepEqual(first.quota, { dailyLimit: 1, usedToday: 1, remaining: 0, unlimited: false, exhausted: true });

  // 第 2 轮：自动补判挂点（聊天/群聊就是调它）
  const logs = captureConsole(t, 'log');
  judge.judgeRoundInBackground({ characterId: id, rawId: rawIds[1], scene: 'chat', lines: ['y'] });
  await flush();
  assert.equal(calls.calls, 1, '额度用完时绝不能再调模型');
  assert.equal(
    logs.some(line => line.includes(`[intimateAiJudge] 今日配额已用完（1/1），跳过 raw=${rawIds[1]}`)),
    true,
    `跳过日志格式与约定一致（实际：${JSON.stringify(logs)}）`,
  );
  assert.equal(judge.getAiJudgeUsedToday(), 1, '跳过不计数');
});

test('额度用完：judgeRound 直接拒绝、judgeRecentRounds 回报 quota 与一句人话', async t => {
  const { id, rawIds } = seed(t, { rounds: 3 });
  const calls = countCalls(t);
  resetQuota();
  await setLimit(1);
  await judge.judgeRound({ characterId: id, rawId: rawIds[0], scene: 'chat', lines: ['x'] });
  assert.equal(calls.calls, 1);

  // judgeRound：明确标记 quotaExhausted，不调模型
  const direct = await judge.judgeRound({ characterId: id, rawId: rawIds[1], scene: 'chat', lines: ['y'] });
  assert.equal(direct.ok, false);
  assert.equal(direct.quotaExhausted, true);
  assert.equal(direct.quota.exhausted, true);
  assert.match(direct.error, /配额已用完/);
  assert.equal(calls.calls, 1);

  // judgeRecentRounds（手动按钮的入口）：一次都不扫、一次都不调
  const summary = await judge.judgeRecentRounds(id, { limit: 3 });
  assert.equal(calls.calls, 1, '手动补判在额度用完时也不能调模型');
  assert.equal(summary.scanned, 0);
  assert.equal(summary.judged, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /今日 AI 判断配额已用完（1\/1）/);
  assert.deepEqual(summary.quota, judge.getAiJudgeQuotaStatus());
  assert.equal(summary.quota.exhausted, true);
  assert.equal(summary.quota.remaining, 0);
  // 既有字段一个都没少
  for (const key of ['scanned', 'judged', 'recorded', 'skipped', 'superseded', 'errors']) {
    assert.ok(key in summary, `既有字段 ${key} 必须保留`);
  }
});

test('POST …/intimate/ai-judge/run：额度用完时返回里带 quota（真实 HTTP）', async t => {
  const { id, rawIds } = seed(t, { rounds: 2 });
  const calls = countCalls(t);
  resetQuota();
  await api('PUT', '/api/config/ai-judge', { dailyLimit: 1 });
  await judge.judgeRound({ characterId: id, rawId: rawIds[0], scene: 'chat', lines: ['x'] });
  assert.equal(calls.calls, 1);

  const res = await api('POST', `/api/characters/${id}/intimate/ai-judge/run`, { limit: 2 });
  assert.equal(res.status, 200, res.text);
  assert.equal(calls.calls, 1, '接口层也不能调模型');
  assert.deepEqual(Object.keys(res.json.quota), ['dailyLimit', 'usedToday', 'remaining', 'unlimited', 'exhausted']);
  assert.deepEqual(res.json.quota, {
    dailyLimit: 1, usedToday: 1, remaining: 0, unlimited: false, exhausted: true,
  });
  assert.match(res.json.errors[0], /今日 AI 判断配额已用完（1\/1）/);
  assert.equal(res.json.scanned, 0);
});

test('额度没用完时：手动补判照跑，返回里同样带 quota（用满后如实变 true）', async t => {
  const { id } = seed(t, { rounds: 2 });
  const calls = countCalls(t);
  resetQuota();
  await setLimit(2);

  const res = await api('POST', `/api/characters/${id}/intimate/ai-judge/run`, { limit: 2 });
  assert.equal(res.status, 200, res.text);
  assert.equal(calls.calls, 2, '两轮各判一次');
  assert.equal(res.json.judged, 2);
  assert.deepEqual(res.json.quota, { dailyLimit: 2, usedToday: 2, remaining: 0, unlimited: false, exhausted: true });
  assert.deepEqual(res.json.errors, []);
});

// ──────────────── 3. 落库：重启不重置 ────────────────

test('计数落 system_settings（键 ai_judge_quota，按本地日期一行）：关库重开后仍在', async t => {
  const { id, rawIds } = seed(t, { rounds: 3 });
  const calls = countCalls(t);
  resetQuota();
  await setLimit(200);
  for (const rawId of rawIds) {
    await judge.judgeRound({ characterId: id, rawId, scene: 'chat', lines: ['x'] });
  }
  assert.equal(calls.calls, 3);

  // 真实行：一行 JSON，日期键就是本地日期
  const db = getDb();
  const raw = db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'ai_judge_quota'`).get();
  assert.ok(raw, '计数必须落库（不是只在内存里数）');
  const stored = JSON.parse(raw.setting_value);
  assert.equal(stored.date, judge.localDateKey());
  assert.equal(stored.used, 3);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM system_settings WHERE setting_key = 'ai_judge_quota'`).get().count,
    1,
    '当天一行即可',
  );

  // 重开库（同进程模拟重启：句柄关掉再打开，同一份临时文件）
  closeDb();
  const reopened = getDb();
  assert.equal(judge.getAiJudgeUsedToday(), 3, '重启后计数仍在');
  assert.equal(judge.getAiJudgeQuotaStatus().usedToday, 3);

  // 重开后继续用第 4 次（新的一轮 raw）
  const extraRaw = Number(reopened
    .prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(`char_${id}`, 'assistant', '她再补一句').lastInsertRowid);
  await judge.judgeRound({ characterId: id, rawId: extraRaw, scene: 'chat', lines: ['z'] });
  assert.equal(judge.getAiJudgeUsedToday(), 4);
});

test('跨天归零：库里是昨天的计数时，今天从 0 起算', async t => {
  const { db } = seed(t, { rounds: 0 });
  db.prepare(`INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .run(judge.AI_JUDGE_QUOTA_SETTING_KEY, JSON.stringify({ date: '2020-01-01', used: 99 }));
  assert.equal(judge.getAiJudgeUsedToday(), 0, '昨天用掉 99 次不算今天');
  assert.equal(judge.getAiJudgeQuotaStatus({ now: new Date('2020-01-01T12:00:00') }).usedToday, 99, '同一天才认');
  assert.equal(judge.getAiJudgeQuotaStatus().exhausted, false);

  // 新的一天第一次消耗：从现在起算并覆盖当天那一行
  await setLimit(200);
  judge.consumeAiJudgeQuota();
  const stored = JSON.parse(db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = ?`)
    .get(judge.AI_JUDGE_QUOTA_SETTING_KEY).setting_value);
  assert.equal(stored.date, judge.localDateKey());
  assert.equal(stored.used, 1);
});

test('localDateKey / 状态口径：本地日期、remaining 不为负、exhausted 只在用满后为真', () => {
  assert.equal(judge.localDateKey(new Date(2026, 0, 2, 23, 59, 59)), '2026-01-02');
  assert.equal(judge.localDateKey(new Date(2026, 11, 31, 0, 0, 0)), '2026-12-31');

  assert.deepEqual(judge.buildAiJudgeQuotaStatus(200, 199), {
    dailyLimit: 200, usedToday: 199, remaining: 1, unlimited: false, exhausted: false,
  });
  assert.deepEqual(judge.buildAiJudgeQuotaStatus(200, 200), {
    dailyLimit: 200, usedToday: 200, remaining: 0, unlimited: false, exhausted: true,
  });
  // 计数被手改大也不给负数余量
  assert.deepEqual(judge.buildAiJudgeQuotaStatus(3, 9), {
    dailyLimit: 3, usedToday: 9, remaining: 0, unlimited: false, exhausted: true,
  });
  assert.deepEqual(judge.buildAiJudgeQuotaStatus(0, 12345), {
    dailyLimit: 0, usedToday: 12345, remaining: null, unlimited: true, exhausted: false,
  });

  // 归一化：0 与正整数合法，其余非法
  assert.equal(judge.normalizeAiJudgeDailyLimit(0), 0);
  assert.equal(judge.normalizeAiJudgeDailyLimit('200'), 200);
  for (const bad of [-1, 1.5, 'abc', '', null, undefined, true, {}]) {
    assert.equal(judge.normalizeAiJudgeDailyLimit(bad), null, `${String(bad)} 应视为非法`);
  }
});
