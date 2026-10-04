/**
 * 上下文面板改动（本次新增）：快照落库、分项标定、窗口惰性探测
 *
 * 覆盖：
 *   1. **快照落库**：写 → 重开库（同进程关了句柄再开，等价重启）→ 还能读回上次用量，
 *      且 source='snapshot'（绝不标成 last-request），updatedAt 保留；
 *      只留最近 200 个会话（按 updatedAt 淘汰最旧）；同会话 1s 内的写合并；
 *      写库失败只 warn，不影响 recordContextUsage 的返回与聊天主链路。
 *   2. **分项标定**：有真实 usedTokens 时 breakdownCalibrated=true，
 *      分项之和（tokensCalibrated）严格等于 usedTokens，估算值 tokens 原样保留；
 *      没有真实用量时 false + tokensCalibrated=null（估算之和本来就等于 usedTokens）。
 *   3. **窗口惰性探测**：窗口还是 default 时探一次上游 /v1/models ——
 *      成功 → provider + 进缓存（第二次不再探测）；上游报错/挂死 → 仍 default、
 *      接口 200 且不慢（挂死按 1.8s 超时收口，整请求 < 2.5s）；declared 从不探测。
 *
 * 环境：DB_PATH 指向 mkdtemp 的临时库（真实库不碰），globalThis.fetch 默认挡网络，
 * 窗口探测用例临时换成桩（成功 / 报错 / 挂死三种）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-ctx-persist-'));
const DB_PATH = path.join(TMP, 'agent.db');
process.env.DB_PATH = DB_PATH;
process.env.LOG_TO_FILE = 'false';
const forbidNetwork = async url => { throw new Error(`context panel fixture forbids network: ${url}`); };
globalThis.fetch = forbidNetwork;

const { config } = await import('../src/config.js');
config.dbPath = DB_PATH;
const { getDb, closeDb } = await import('../src/db/index.js');
const contextUsage = await import('../src/services/contextUsage.js');
const contextRoutes = (await import('../src/routes/context.js')).default;
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');

const app = express();
app.use(express.json());
app.use('/api/context', wrapRouterAsync(contextRoutes));

const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

// 保存/还原真实 LLM 配置（用例只动内存，不写盘）
const savedLlm = {
  model: config.llm.model,
  baseURL: config.llm.baseURL,
  contextWindow: config.llm.contextWindow,
  contextWindowSource: config.llm.contextWindowSource,
};

after(async () => {
  globalThis.fetch = forbidNetwork;
  contextUsage.clearProviderContextWindowCache();
  config.llm.model = savedLlm.model;
  config.llm.baseURL = savedLlm.baseURL;
  config.llm.contextWindow = savedLlm.contextWindow;
  config.llm.contextWindowSource = savedLlm.contextWindowSource;
  await new Promise(resolve => server.close(resolve));
  closeDb();
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.warn(`[contextUsagePersist.test] 临时目录清理失败（可手动删）: ${TMP} :: ${err.message}`);
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

function captureConsole(t, method) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => { lines.push(args.map(value => String(value)).join(' ')); };
  t.after(() => { console[method] = original; });
  return lines;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sumBy = (list, key) => list.reduce((sum, item) => sum + (Number(item?.[key]) || 0), 0);

let seedSeq = 0;
/** 造一个私聊会话（面板只认 raw_messages 里出现过的会话） */
function seedConversation({ users = 1, assistants = 1 } = {}) {
  const db = getDb();
  const suffix = ++seedSeq;
  const characterId = Number(db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`
  ).run(`ctxpanel_${suffix}`, `面板角色${suffix}`).lastInsertRowid);
  const conversationId = `char_${characterId}`;
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  for (let i = 0; i < Math.max(users, assistants); i += 1) {
    if (i < users) insert.run(conversationId, 'user', `用户第 ${i} 句`);
    if (i < assistants) insert.run(conversationId, 'assistant', `角色第 ${i} 句`);
  }
  return { characterId, conversationId };
}

/** 快照在 system_settings 里的键（前缀 + conversationId，用来按前缀做 200 上限淘汰） */
const snapshotKey = conversationId => `context_usage:${conversationId}`;

function storedSnapshot(conversationId) {
  const raw = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
    .pluck().get(snapshotKey(conversationId));
  return raw ? JSON.parse(raw) : null;
}

/** 直接往库里塞一条"上一次用量"（用来构造 200 上限的场景） */
function seedStoredSnapshot(conversationId, updatedAt, chars = 8) {
  const breakdown = contextUsage.buildBreakdown({ system: ['系'.repeat(chars)], memory: [], transcript: [], directive: [], other: [] });
  getDb().prepare('INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(snapshotKey(conversationId), JSON.stringify({
      conversationId,
      model: 'm',
      contextWindow: null,
      contextWindowSource: null,
      breakdown,
      breakdownExtra: [],
      estimatedTokens: contextUsage.sumBreakdownTokens(breakdown),
      usedTokens: null,
      source: 'estimate',
      updatedAt,
    }));
}

// ──────────────── 1. 分项标定（纯函数 + 接口） ────────────────

test('calibrateBreakdown：按真实总量等比摊派，取整用最大余数法，分项之和严格等于总量', () => {
  const items = [
    { key: 'system', tokens: 10, chars: 20 },
    { key: 'memory', tokens: 30, chars: 60 },
    { key: 'transcript', tokens: 0, chars: 0 },
  ];
  const exact = contextUsage.calibrateBreakdown(items, 100);
  assert.deepEqual(exact.map(item => item.tokensCalibrated), [25, 75, 0]);
  assert.equal(sumBy(exact, 'tokensCalibrated'), 100);
  assert.deepEqual(exact.map(item => item.tokens), [10, 30, 0], '估算值原样保留，不被覆盖');

  // 除不尽：普通四舍五入会差几，最大余数法保证严格自洽
  const uneven = contextUsage.calibrateBreakdown(
    [{ key: 'a', tokens: 1, chars: 7 }, { key: 'b', tokens: 1, chars: 7 }, { key: 'c', tokens: 1, chars: 7 }],
    100,
  );
  assert.equal(sumBy(uneven, 'tokensCalibrated'), 100);
  assert.deepEqual(uneven.map(item => item.tokensCalibrated).sort((a, b) => a - b), [33, 33, 34]);

  // 有真实总量但估算全为 0（只有换行/标点这类）时按字符数摊派，仍然自洽
  const byChars = contextUsage.calibrateBreakdown(
    [{ key: 'a', tokens: 0, chars: 30 }, { key: 'b', tokens: 0, chars: 10 }],
    80,
  );
  assert.equal(sumBy(byChars, 'tokensCalibrated'), 80);
  assert.deepEqual(byChars.map(item => item.tokensCalibrated), [60, 20]);

  // 无从摊派：没有真实总量 / 分项全空
  assert.equal(contextUsage.calibrateBreakdown(items, 0), null);
  assert.equal(contextUsage.calibrateBreakdown(items, null), null);
  assert.equal(contextUsage.calibrateBreakdown([], 100), null);
  assert.equal(contextUsage.calibrateBreakdown([{ key: 'a', tokens: 0, chars: 0 }], 100), null);
});

test('GET /api/context/usage：没有真实用量 → breakdownCalibrated=false、tokensCalibrated=null，估算之和==usedTokens', async () => {
  const { conversationId } = seedConversation();
  config.llm.contextWindow = savedLlm.contextWindow ?? 128000;
  config.llm.contextWindowSource = 'declared';
  contextUsage.recordContextUsage({
    conversationId,
    model: 'm',
    segments: {
      system: ['系统提示词'.repeat(30)],
      memory: ['<rag_memories>\n1. 她不吃香菜\n</rag_memories>'],
      transcript: ['<active_chat_history>\n[用户]: 你好\n</active_chat_history>'],
    },
  });

  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.source, 'estimate');
  assert.equal(res.json.breakdownCalibrated, false, '没有真实用量就不摊派');
  assert.equal(res.json.breakdown.length, 5);
  for (const item of res.json.breakdown) {
    assert.deepEqual(Object.keys(item), ['key', 'label', 'tokens', 'chars', 'tokensCalibrated']);
    assert.equal(item.tokensCalibrated, null);
  }
  assert.equal(sumBy(res.json.breakdown, 'tokens'), res.json.usedTokens, '估算口径下分项之和就是 usedTokens');
});

test('GET /api/context/usage：拿到真实 usedTokens → breakdownCalibrated=true 且分项之和 == usedTokens', async () => {
  const { conversationId } = seedConversation();
  config.llm.contextWindow = 200000;
  config.llm.contextWindowSource = 'declared';
  contextUsage.recordContextUsage({
    conversationId,
    model: 'm',
    segments: {
      system: ['系统提示词'.repeat(30)],
      memory: ['<rag_memories>\n1. 她不吃香菜\n</rag_memories>'],
      transcript: ['<active_chat_history>\n[用户]: 你好\n</active_chat_history>'],
      directive: ['<reply_length>\n- 短一点\n</reply_length>'],
      other: ['<time_context>\n21:00\n</time_context>'],
    },
  });
  const before = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  const estimateSum = sumBy(before.json.breakdown, 'tokens');
  assert.equal(before.json.breakdownCalibrated, false);

  // 上游报的真实 prompt_tokens（故意取一个除不尽、且与估算有偏差的值）
  const realUsedTokens = Math.round(estimateSum * 1.37) + 7;
  contextUsage.beginContextCapture({ conversationId, model: 'm', expectLabel: null });
  contextUsage.notePromptUsage('主聊天流', { prompt_tokens: realUsedTokens });

  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.source, 'last-request');
  assert.equal(res.json.usedTokens, realUsedTokens);
  assert.equal(res.json.breakdownCalibrated, true);
  assert.equal(
    sumBy(res.json.breakdown, 'tokensCalibrated'),
    res.json.usedTokens,
    '标定后分项之和严格等于顶层 usedTokens',
  );
  assert.equal(sumBy(res.json.breakdown, 'tokens'), estimateSum, '估算值 tokens 不被标定覆盖');
  assert.equal(
    Math.abs(estimateSum - realUsedTokens) > 0,
    true,
    '这个用例的前提：估算与真实值确实有偏差（-14% 那类）',
  );
});

// ──────────────── 2. 快照落库 / 重开库可读 ────────────────

test('快照落库：重开库后还能读回上次用量，source=snapshot 且 updatedAt 保留', async t => {
  const { conversationId } = seedConversation();
  config.llm.contextWindow = 200000;
  config.llm.contextWindowSource = 'declared';
  const snapshot = contextUsage.recordContextUsage({
    conversationId,
    model: 'm',
    segments: { system: ['系统提示词'.repeat(20)], memory: ['<user_portrait>画像</user_portrait>'] },
  });
  assert.equal(contextUsage.snapshotUsage(snapshot).source, 'estimate', '本进程内还是"估算"');

  // 库里确实有：键 = context_usage:<conversationId>，值含面板要的字段
  const stored = storedSnapshot(conversationId);
  assert.ok(stored, '快照必须落库');
  for (const field of ['usedTokens', 'breakdown', 'model', 'contextWindow', 'updatedAt', 'source']) {
    assert.ok(field in stored, `库里要含 ${field}`);
  }
  assert.equal(stored.updatedAt, snapshot.updatedAt);
  assert.equal(stored.estimatedTokens, snapshot.estimatedTokens);

  // 模拟重启：关库重开 + 清掉进程内快照
  closeDb();
  getDb();
  contextUsage.clearContextUsageSnapshots();

  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.source, 'snapshot', '从持久化快照读到的上一次用量必须是 snapshot');
  assert.notEqual(res.json.source, 'last-request', '历史用量不能冒充"最近一次请求"');
  assert.equal(res.json.usedTokens, snapshot.estimatedTokens);
  assert.equal(res.json.updatedAt, snapshot.updatedAt, 'updatedAt 要保留（前端显示"更新于 xx:xx"）');
  assert.equal(res.json.breakdown.length, 5);
  assert.equal(sumBy(res.json.breakdown, 'chars'), snapshot.breakdown.reduce((sum, i) => sum + i.chars, 0));
  void t;
});

test('重开库：真实用量也留下来了（source=snapshot，标定照样成立）', async () => {
  const { conversationId } = seedConversation();
  config.llm.contextWindow = 200000;
  config.llm.contextWindowSource = 'declared';
  contextUsage.recordContextUsage({
    conversationId,
    model: 'm',
    segments: { system: ['系统提示词'.repeat(25)], transcript: ['<active_chat_history>\n[用户]: 你好\n</active_chat_history>'] },
  });
  // 同会话 1s 内的写会合并，等过节流窗口再补真实用量（真实链路里 LLM 也要跑几百毫秒~几秒）
  await sleep(contextUsage.SNAPSHOT_WRITE_THROTTLE_MS + 120);
  contextUsage.beginContextCapture({ conversationId, model: 'm', expectLabel: null });
  contextUsage.notePromptUsage('主聊天流', { prompt_tokens: 4321 });
  assert.equal(storedSnapshot(conversationId).usedTokens, 4321, '真实用量要落库');

  closeDb();
  getDb();
  contextUsage.clearContextUsageSnapshots();
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.json.source, 'snapshot');
  assert.equal(res.json.usedTokens, 4321);
  assert.equal(res.json.breakdownCalibrated, true);
  assert.equal(sumBy(res.json.breakdown, 'tokensCalibrated'), 4321);
});

test('写库节流：同会话 1s 内的多次写合并成一次，节流窗口过后写最新状态', async () => {
  const { conversationId } = seedConversation();
  contextUsage.recordContextUsage({ conversationId, segments: { system: ['A'.repeat(20)] } });
  assert.equal(storedSnapshot(conversationId).breakdown[0].chars, 20);

  contextUsage.recordContextUsage({ conversationId, segments: { system: ['B'.repeat(90)] } });
  assert.equal(storedSnapshot(conversationId).breakdown[0].chars, 20, '1s 内的第二次写被合并掉（不写库）');

  await sleep(contextUsage.SNAPSHOT_WRITE_THROTTLE_MS + 120);
  contextUsage.recordContextUsage({ conversationId, segments: { system: ['C'.repeat(50)] } });
  assert.equal(storedSnapshot(conversationId).breakdown[0].chars, 50, '节流窗口过后补上最新状态');
});

test('落库上限：只留最近 200 个会话，按 updatedAt 淘汰最旧的', async () => {
  // 前面的用例也落过几条，这里先清空，只留本用例自己的 205 条
  getDb().prepare(`DELETE FROM system_settings WHERE setting_key LIKE 'context_usage:%'`).run();
  const prefix = 'cap_';
  const count = 205;
  for (let i = 0; i < count; i += 1) {
    seedStoredSnapshot(`${prefix}${i}`, new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString());
  }
  assert.equal(contextUsage.countPersistedSnapshots(), count);

  // 再写一条新的（最旧的那几条应被淘汰）
  const { conversationId } = seedConversation();
  contextUsage.recordContextUsage({ conversationId, segments: { system: ['新会话'] } });

  assert.equal(contextUsage.countPersistedSnapshots(), contextUsage.MAX_PERSISTED_SNAPSHOTS, '上限 200');
  assert.equal(contextUsage.loadContextUsageSnapshot(`${prefix}0`), null, '最旧的被淘汰');
  assert.equal(contextUsage.loadContextUsageSnapshot(`${prefix}5`), null);
  assert.ok(contextUsage.loadContextUsageSnapshot(`${prefix}6`), '第 7 旧的留下');
  assert.ok(contextUsage.loadContextUsageSnapshot(conversationId), '刚写的那条留下');
  assert.equal(storedSnapshot(conversationId)?.conversationId, conversationId);
});

test('写库失败只 warn：recordContextUsage 照常返回、内存快照照常在，不影响聊天主链路', async t => {
  const { conversationId } = seedConversation();
  const warns = captureConsole(t, 'warn');
  const goodPath = config.dbPath;
  // 把库指到一个"父路径是文件"的位置 → getDb() 打不开，persist 必须自己吞掉
  const notADir = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  config.dbPath = path.join(notADir, 'agent.db');
  closeDb();
  try {
    const snapshot = contextUsage.recordContextUsage({ conversationId, segments: { system: ['系统'] } });
    assert.ok(snapshot, '写库失败也必须照常返回快照（不能抛）');
    assert.equal(contextUsage.getContextUsageSnapshot(conversationId), snapshot, '内存快照仍在');
    assert.equal(snapshot.estimatedTokens > 0, true);
    assert.equal(warns.some(line => line.includes('用量快照写库失败')), true, '要留一条 warn 说明为什么没落库');
  } finally {
    config.dbPath = goodPath;
    closeDb();
    getDb();
  }

  // 库恢复之后：接口照常 200，快照还在（内存里那份）
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.source, 'estimate');
  assert.equal(res.json.usedTokens > 0, true);
});

// ──────────────── 3. 窗口惰性探测 ────────────────

/** 把窗口状态置成"真机出厂"：default 128000、没声明过 */
function useFactoryDefaultWindow() {
  config.llm.model = 'lazy-probe-model';
  config.llm.baseURL = 'https://upstream.invalid/v1';
  config.llm.contextWindow = contextUsage.DEFAULT_CONTEXT_WINDOW;
  config.llm.contextWindowSource = 'default';
  contextUsage.clearProviderContextWindowCache();
}

function modelsStub(entry, counter) {
  return async () => {
    counter.probes += 1;
    return { ok: true, json: async () => ({ data: [entry] }) };
  };
}

test('窗口惰性探测：default 时探一次上游 → provider + 缓存（第二次不再探测）', async () => {
  const { conversationId } = seedConversation();
  useFactoryDefaultWindow();
  const counter = { probes: 0 };
  globalThis.fetch = modelsStub({ id: 'lazy-probe-model', context_length: 1000000 }, counter);

  const first = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.contextWindow, 1000000, '出厂值 128000 应被上游真值替换');
  assert.equal(first.json.contextWindowSource, 'provider');
  assert.equal(counter.probes, 1, '恰好探一次上游 /v1/models');

  const second = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(second.json.contextWindow, 1000000);
  assert.equal(second.json.contextWindowSource, 'provider');
  assert.equal(counter.probes, 1, '第二次命中进程内缓存，不再探测');
  assert.equal(contextUsage.getCachedProviderContextWindow(config.llm.baseURL, config.llm.model), 1000000);

  const third = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(third.json.contextWindowSource, 'provider');
  assert.equal(counter.probes, 1, '第三次同样不再探测');
  assert.equal(third.json.usedTokens, first.json.usedTokens);
});

test('窗口惰性探测：上游报错 → 仍 default、接口 200 且不慢（不 500）', async () => {
  const { conversationId } = seedConversation();
  useFactoryDefaultWindow();
  let probes = 0;
  globalThis.fetch = async () => { probes += 1; throw new Error('上游 503'); };

  const started = Date.now();
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contextWindow, contextUsage.DEFAULT_CONTEXT_WINDOW);
  assert.equal(res.json.contextWindowSource, 'default', '探不到就如实回落默认，不假装 provider');
  assert.equal(probes, 1);
  assert.ok(elapsed < 1000, `上游立刻报错时接口不该被拖慢（实际 ${elapsed}ms）`);
});

test('窗口惰性探测：上游挂死 → 1.8s 超时收口，整个请求仍 < 2.5s', async () => {
  const { conversationId } = seedConversation();
  useFactoryDefaultWindow();
  let aborted = false;
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('stub 不该等到这里')), 6000);
    bail.unref?.();
    init.signal?.addEventListener('abort', () => {
      aborted = true;
      clearTimeout(bail);
      reject(new Error('aborted by lazy probe timeout'));
    });
  });

  const started = Date.now();
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contextWindow, contextUsage.DEFAULT_CONTEXT_WINDOW);
  assert.equal(res.json.contextWindowSource, 'default');
  assert.equal(aborted, true, '超时要把上游请求 abort 掉（别留悬挂连接）');
  assert.equal(contextUsage.LAZY_PROVIDER_PROBE_TIMEOUT_MS >= 1500, true, '超时档在 1.5~2s');
  assert.equal(contextUsage.LAZY_PROVIDER_PROBE_TIMEOUT_MS <= 2000, true);
  assert.ok(elapsed < 2500, `接口不能因为探测慢而超过约 2.5s（实际 ${elapsed}ms）`);
});

test('窗口惰性探测：用户声明过（declared）就一次都不探', async () => {
  const { conversationId } = seedConversation();
  config.llm.model = 'lazy-probe-model';
  config.llm.baseURL = 'https://upstream.invalid/v1';
  config.llm.contextWindow = 555000;
  config.llm.contextWindowSource = 'declared';
  contextUsage.clearProviderContextWindowCache();
  let probes = 0;
  globalThis.fetch = async () => { probes += 1; throw new Error('不该探测'); };

  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contextWindow, 555000);
  assert.equal(res.json.contextWindowSource, 'declared');
  assert.equal(probes, 0, 'declared 是最高优先级，探测都不该发生');
});

test('POST /api/context/compress 的返回也带窗口（同一套惰性探测口径）且 before 形状不变', async () => {
  const { conversationId } = seedConversation();
  useFactoryDefaultWindow();
  const counter = { probes: 0 };
  globalThis.fetch = modelsStub({ id: 'lazy-probe-model', context_length: 1000000 }, counter);

  const res = await api('POST', '/api/context/compress', { conversationId });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.before, { usedTokens: 0 }, '既有 before 形状不能被改');
  assert.equal(res.json.contextWindow, 1000000);
  assert.equal(res.json.contextWindowSource, 'provider');
  assert.equal(res.json.summaryCreated, false);
  assert.equal(counter.probes, 1);
});
