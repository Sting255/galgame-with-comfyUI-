/**
 * 上下文面板回归测试：模型窗口声明/三级回退、用量与余量、分项统计、压缩接口
 *
 * 手段：
 *   - 纯函数层直接断言（resolveContextWindow / computeUsageFields / segmentKeyForBlock / buildBreakdown）；
 *   - 路由层挂真实 express + 真发 HTTP（与 test/intimateAiEditHttp.test.js 同路子），
 *     这样 409 / 200 空态 / 超时转后台都是真实状态码与真实 JSON；
 *   - 假上游就挂在同一个本地服务器上（/v1/chat/completions、/v1/models），config.llm.baseURL
 *     指向它——**openai SDK 在 node 下走 node-fetch，不经过 globalThis.fetch**，
 *     只堵 globalThis.fetch 是堵不住 LLM 流量的（这一点吃过亏）；
 *     globalThis.fetch 另装一个只放行本机地址的桩，既保证本文件不出网，又能让
 *     /v1/models 的探测真的走到假上游；
 *   - 改 .env 的用例（PUT /api/config/llm）跑完按字节还原配置文件，绝不让测试改坏真实配置。
 *
 * 边界声明：假上游只验证"链路与口径"，不代表真实网关 /v1/models 的字段形态；
 * 真实网关字段差异（context_length / max_allowed_size …）由 contextWindowFromModelEntry 的用例覆盖。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nodeFetch from 'node-fetch';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';
// 把 HTTP 等待预算压到 1.5s，否则"超时转后台"这条分支得真等 8 秒才跑得到
// （本机假上游跑一轮摘要实测 ~200ms，1.5s 足够让正常用例走"等到了"的分支）
process.env.CONTEXT_COMPRESS_HTTP_BUDGET_MS = '1500';

// ── 假上游状态 ──

let modelsPayload = { data: [{ id: 'cn:deepseek-v4-flash', context_length: 1000000 }] };
let chatContent = '（假摘要）这一段被压缩成了摘要。';
let chatRequestCount = 0;
let chatBarrier = null;   // 非 null 时下一批摘要请求挂住，直到 release()

/** 让摘要请求挂住（模拟"上游很慢"），返回的 release() 放行；after() 会兜底放行，避免测试进程被吊住 */
function blockChat() {
  let resolve;
  const barrier = { promise: new Promise(r => { resolve = r; }), resolve: null };
  barrier.resolve = resolve;
  chatBarrier = barrier;
  return {
    release() {
      const pending = chatBarrier;
      chatBarrier = null;
      if (pending) pending.resolve();
    },
  };
}

function completionBody(content) {
  return {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 0,
    model: 'fixture',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
  };
}

const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const contextUsage = await import('../src/services/contextUsage.js');
const { SUMMARIZE_INTERVAL } = await import('../src/services/summarizer.js');
const contextRoutes = (await import('../src/routes/context.js')).default;
const configRoutes = (await import('../src/routes/config.js')).default;
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');

const app = express();
app.use(express.json());
app.use('/api/context', wrapRouterAsync(contextRoutes));
app.use('/api/config', wrapRouterAsync(configRoutes));

// 假上游：/v1/models 与 /v1/chat/completions
app.get('/v1/models', (_req, res) => res.json(modelsPayload));
app.post('/v1/chat/completions', async (_req, res) => {
  chatRequestCount++;
  if (chatBarrier) await chatBarrier.promise;
  res.json(completionBody(chatContent));
});

const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}/v1`;

// 只有本机假上游放行，其余一律禁止出网（vector / comfy / 图片知识库等后台探测都会被拦下）
const realLocalFetch = nodeFetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  if (url.startsWith(`http://127.0.0.1:${PORT}/`)) return realLocalFetch(url, init);
  throw new Error(`context-usage fixture forbids network: ${url}`);
};

// LLM 配置指向假上游；其它字段保持仓库默认（不写盘，只动内存）
config.llm.apiKey = 'fixture-key';
config.llm.baseURL = LOCAL_BASE_URL;
config.llm.model = 'cn:deepseek-v4-flash';

after(() => {
  // 兜底放行：任何还挂着的假上游请求都要收尾，否则 SDK 的 10 分钟超时定时器会吊住测试进程
  if (chatBarrier) chatBarrier.resolve();
  chatBarrier = null;
  server.close();
  closeDb();
});

/** 真发 HTTP（globalThis.fetch 被本机白名单桩占住，只能自己用 node:http 打服务） */
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

const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

/** 直接改 .env 的用例：跑完把文件按字节还原（.env 是真实配置，测试不许留痕） */
async function withEnvFileRestored(fn) {
  const original = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH) : null;
  try {
    return await fn();
  } finally {
    if (original === null) { try { fs.unlinkSync(ENV_PATH); } catch { /* 本来就没有 */ } }
    else fs.writeFileSync(ENV_PATH, original);
  }
}

/** 轮询等待（避免用固定 sleep 猜后台活干完没有） */
async function waitFor(check, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return false;
}

let seedSeq = 0;
/** 造一个私聊会话：默认 10 轮（够触发滚动摘要的 10 条 assistant 阈值） */
function seedConversation({ users = 10, assistants = 10 } = {}) {
  const db = getDb();
  const characterId = Number(db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`).run(`ctx_${++seedSeq}`, `上下文角色${seedSeq}`).lastInsertRowid);
  const conversationId = `char_${characterId}`;
  for (let i = 0; i < Math.max(users, assistants); i++) {
    if (i < users) db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'user', ?)`).run(conversationId, `用户第${i}句`);
    if (i < assistants) db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`).run(conversationId, `角色第${i}句`);
  }
  return { characterId, conversationId };
}

// ── 1. 上下文窗口：declared → provider → default 三级回退 ──

test('resolveContextWindow：声明 > 上游 > 默认', () => {
  assert.deepEqual(resolve(1000000, 200000), { contextWindow: 1000000, contextWindowSource: 'declared' });
  assert.deepEqual(resolve(null, 200000), { contextWindow: 200000, contextWindowSource: 'provider' });
  assert.deepEqual(resolve(null, null), { contextWindow: contextUsage.DEFAULT_CONTEXT_WINDOW, contextWindowSource: 'default' });
  // 非法声明（0 / 负数 / 非数字）等于没声明，继续往下回退
  for (const bad of [0, -1, 'abc', '', null, undefined]) {
    assert.equal(resolve(bad, 200000).contextWindowSource, 'provider', `声明 ${String(bad)} 应视为未声明`);
    assert.equal(resolve(bad, null).contextWindowSource, 'default');
  }
});

function resolve(declared, provider) {
  return contextUsage.resolveContextWindow({ declared, provider });
}

/** 只回一份模型列表的假 fetch（纯函数用例用，不依赖服务器） */
function modelsFetcher(payload) {
  return async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('添加模型：没填窗口时先从上游 /v1/models 取 context_length', async () => {
  contextUsage.clearProviderContextWindowCache();
  const found = await contextUsage.resolveDeclaredOrProviderWindow({
    baseURL: 'http://gateway.test/v1',
    model: 'cn:deepseek-v4-flash',
    fetchImpl: modelsFetcher({ data: [{ id: 'cn:deepseek-v4-flash', context_length: 1000000 }] }),
  });
  assert.deepEqual(found, {
    contextWindow: 1000000,
    contextWindowSource: 'provider',
    endpoint: 'http://gateway.test/v1/models',
  });
});

test('添加模型：上游没有该模型 / 上游挂了，都退回保守默认 128000（并标明 default）', async () => {
  contextUsage.clearProviderContextWindowCache();
  // 上游报了一堆模型，但没有目标模型 → 不拿别的模型的窗口瞎猜
  const missing = await contextUsage.resolveDeclaredOrProviderWindow({
    baseURL: 'http://gateway.test/v1',
    model: 'cn:deepseek-v4-flash',
    fetchImpl: modelsFetcher({ data: [{ id: 'other-model', context_length: 32000 }, { id: 'another', context_length: 8000 }] }),
  });
  assert.deepEqual(missing, { contextWindow: 128000, contextWindowSource: 'default' });

  // 上游只有一条且不是目标模型 → 同样不猜
  const onlyOther = await contextUsage.resolveDeclaredOrProviderWindow({
    baseURL: 'http://gateway.test/v1',
    model: 'cn:deepseek-v4-flash',
    fetchImpl: modelsFetcher({ data: [{ id: 'other-model', context_length: 32000 }] }),
  });
  assert.equal(onlyOther.contextWindowSource, 'default');

  // 上游压根没给窗口字段
  const noField = await contextUsage.resolveDeclaredOrProviderWindow({
    baseURL: 'http://gateway.test/v1',
    model: 'cn:deepseek-v4-flash',
    fetchImpl: modelsFetcher({ data: [{ id: 'cn:deepseek-v4-flash' }] }),
  });
  assert.equal(noField.contextWindowSource, 'default');

  // 连不上 / 500
  const unreachable = await contextUsage.fetchProviderContextWindow({
    baseURL: 'http://gateway.test/v1', model: 'cn:deepseek-v4-flash',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(unreachable, null);
  const serverError = await contextUsage.fetchProviderContextWindow({
    baseURL: 'http://gateway.test/v1', model: 'cn:deepseek-v4-flash',
    fetchImpl: async () => new Response('boom', { status: 500 }),
  });
  assert.equal(serverError, null);
});

test('添加模型：用户填了窗口就不再问上游（declared 最高优先级）', async () => {
  contextUsage.clearProviderContextWindowCache();
  let called = 0;
  const resolved = await contextUsage.resolveDeclaredOrProviderWindow({
    declared: '64000',
    baseURL: 'http://gateway.test/v1',
    model: 'cn:deepseek-v4-flash',
    fetchImpl: async () => { called++; throw new Error('不该被调用'); },
  });
  assert.deepEqual(resolved, { contextWindow: 64000, contextWindowSource: 'declared' });
  assert.equal(called, 0, '用户声明了窗口就不该再打上游');
});

test('contextWindowFromModelEntry 容忍网关的几种字段名（context_length / max_allowed_size）', () => {
  assert.equal(contextUsage.contextWindowFromModelEntry({ context_length: 1000000 }), 1000000);
  assert.equal(contextUsage.contextWindowFromModelEntry({ max_allowed_size: 65536 }), 65536);
  assert.equal(contextUsage.contextWindowFromModelEntry({ context_window: '131072' }), 131072);
  assert.equal(contextUsage.contextWindowFromModelEntry({ context_length: 0, max_allowed_size: 32000 }), 32000);
  assert.equal(contextUsage.contextWindowFromModelEntry({ max_output_tokens: 8192 }), null, 'max_output_tokens 是输出上限，不能当窗口');
});

// ── 2. 用量 / 余量 / 百分数 ──

test('computeUsageFields：usedPercent 是 0~100 百分数，remainingTokens 不为负', () => {
  assert.deepEqual(contextUsage.computeUsageFields({ usedTokens: 4408, contextWindow: 1000000 }), {
    usedTokens: 4408, usedPercent: 0.44, remainingTokens: 995592,
  });
  // 用满 / 超出窗口：百分数封顶 100，余量落 0（不出现负数）
  assert.deepEqual(contextUsage.computeUsageFields({ usedTokens: 128000, contextWindow: 128000 }), {
    usedTokens: 128000, usedPercent: 100, remainingTokens: 0,
  });
  assert.deepEqual(contextUsage.computeUsageFields({ usedTokens: 200000, contextWindow: 128000 }), {
    usedTokens: 200000, usedPercent: 100, remainingTokens: 0,
  });
  // 非法输入不产生 NaN
  assert.deepEqual(contextUsage.computeUsageFields({ usedTokens: null, contextWindow: null }), {
    usedTokens: 0, usedPercent: 0, remainingTokens: 128000,
  });
});

// ── 3. 分项口径 ──

test('segmentKeyForBlock：按块标签分段，不认识的标签落 other', () => {
  assert.equal(contextUsage.segmentKeyForBlock('<rag_memories>\n1. 记忆\n</rag_memories>'), 'memory');
  assert.equal(contextUsage.segmentKeyForBlock('<user_portrait>印象</user_portrait>'), 'memory');
  assert.equal(contextUsage.segmentKeyForBlock('<active_chat_history>\n[用户]: hi\n</active_chat_history>'), 'transcript');
  assert.equal(contextUsage.segmentKeyForBlock('<reply_length>\n- 短一点\n</reply_length>'), 'directive');
  assert.equal(contextUsage.segmentKeyForBlock('<hypnosis_command kind="body_control">\n服从\n</hypnosis_command>'), 'directive');
  assert.equal(contextUsage.segmentKeyForBlock('<round_directive>\n群里接话\n</round_directive>'), 'directive');
  assert.equal(contextUsage.segmentKeyForBlock('<time_context>\n21:00\n</time_context>'), 'other');
  assert.equal(contextUsage.segmentKeyForBlock('没有标签的块'), 'other');
  // 无标签但语义明确的动态块
  assert.equal(contextUsage.segmentKeyForBlock('\n【当前情绪状态 — 此指令影响你的说话方式】\n- 开心'), 'directive');
});

test('buildBreakdown：固定 5 段固定顺序，chars 精确、tokens 按字符估算', () => {
  const breakdown = contextUsage.buildBreakdown({
    system: ['你好世界呀'],
    memory: ['<rag_memories>记忆</rag_memories>'],
    transcript: [],
  });
  assert.deepEqual(breakdown.map(item => item.key), ['system', 'memory', 'transcript', 'directive', 'other']);
  assert.deepEqual(breakdown.map(item => item.label), ['系统提示词', '记忆与档案', '对话消息', '本轮指令', '其他']);
  assert.equal(breakdown[0].chars, 5);
  assert.equal(breakdown[0].tokens, Math.ceil(5 / 1.6));
  assert.equal(breakdown[1].chars, '<rag_memories>记忆</rag_memories>'.length);
  assert.equal(breakdown[2].tokens, 0);
  // 允许直接传历史消息对象（只取 content）
  const withMessages = contextUsage.buildBreakdown({ transcript: [{ role: 'user', content: '四个字啊' }] });
  assert.equal(withMessages[2].chars, 4);
});

// ── 4. GET /api/context/usage ──

test('GET /api/context/usage：还没发过请求的会话 → 200 空态（不是 500）', async () => {
  const { conversationId } = seedConversation({ users: 1, assistants: 1 });
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'none');
  assert.equal(res.json.usedTokens, 0);
  assert.deepEqual(res.json.breakdown, []);
  assert.equal(res.json.remainingTokens, res.json.contextWindow);
  assert.equal(res.json.updatedAt, null);
});

test('GET /api/context/usage：不存在的会话 → 200 空态', async () => {
  const res = await api('GET', '/api/context/usage?conversationId=char_999999');
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'none');
  assert.equal(res.json.usedTokens, 0);
  assert.deepEqual(res.json.breakdown, []);
});

test('GET /api/context/usage：缺 conversationId → 400（契约要求必传）', async () => {
  const res = await api('GET', '/api/context/usage');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /conversationId/);
});

test('GET /api/context/usage：真实 usage 到位 → source=last-request，形状严格', async () => {
  const { conversationId } = seedConversation({ users: 6, assistants: 6 });
  contextUsage.recordContextUsage({
    conversationId,
    model: 'cn:deepseek-v4-flash',
    segments: {
      system: ['系统提示词'.repeat(300)],
      memory: ['<rag_memories>\n1. 她不吃香菜\n</rag_memories>'],
      transcript: ['<active_chat_history>\n[用户]: 你好\n</active_chat_history>'],
      directive: ['<reply_length>\n- 短一点\n</reply_length>'],
      other: ['<time_context>\n21:00\n</time_context>'],
    },
  });
  const before = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(before.json.source, 'estimate', '没有真实 usage 时必须是 estimate，不能冒充精确值');
  const estimate = before.json.usedTokens;

  // 把"主聊天流"的真实 usage 贴上去；其它标签（planner / 记忆整理）必须被忽略
  // 上游报的 prompt_tokens 与本地分段估算不是同一套口径（真实值还含消息 JSON 开销、
  // tokenizer 差异），但量级应在同一档：这里取估算值的 1.15 倍当"真实值"
  const realPromptTokens = Math.round(estimate * 1.15);
  contextUsage.beginContextCapture({ conversationId, model: 'cn:deepseek-v4-flash', expectLabel: '主聊天流' });
  contextUsage.notePromptUsage('聊天记忆整理', { prompt_tokens: 999999 });
  const ignored = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(ignored.json.usedTokens, estimate, '标签不匹配的调用不得污染本会话用量');
  contextUsage.notePromptUsage('主聊天流', { prompt_tokens: realPromptTokens });

  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200);
  const payload = res.json;
  // 前端按这份形状写死，键与顺序都要锁住。
  // 2026-09-30 追加三个**纯加法**字段（代码审查改进 §2.3）：稳定前缀指纹，供面板判断
  // "这轮缓存命中掉了是稳定前缀变了、还是只有动态尾部变了"。老前端忽略未知键即可。
  assert.deepEqual(Object.keys(payload), [
    'conversationId', 'model', 'contextWindow', 'contextWindowSource',
    'usedTokens', 'usedPercent', 'remainingTokens', 'source', 'updatedAt',
    'stablePrefixHash', 'fullPrefixHash', 'requestHash',
    'breakdown', 'breakdownCalibrated',
  ]);
  assert.equal(payload.conversationId, conversationId);
  assert.equal(payload.source, 'last-request');
  assert.equal(payload.usedTokens, realPromptTokens);
  assert.equal(payload.usedPercent, Math.round((realPromptTokens / payload.contextWindow) * 10000) / 100);
  assert.equal(payload.remainingTokens, payload.contextWindow - realPromptTokens);
  assert.equal(new Date(payload.updatedAt).getTime() > 0, true, 'updatedAt 应是真实时间戳');
  assert.equal(payload.breakdown.length, 5);
  for (const item of payload.breakdown) {
    assert.deepEqual(Object.keys(item), ['key', 'label', 'tokens', 'chars', 'tokensCalibrated']);
    assert.equal(typeof item.tokens, 'number');
    assert.equal(typeof item.chars, 'number');
    assert.equal(typeof item.tokensCalibrated, 'number');
  }
  // 分段求和 vs 顶层 usedTokens 的**测试意图**：
  //   - tokens 是"按字符估算"，顶层是上游报的真实 prompt_tokens，两者口径本就不同，
  //     所以只要求同量级（±35%）；**估算值原样保留**，不拿摊派结果去覆盖它。
  //   - 与真实总量对齐走新增的 tokensCalibrated（按真实总量等比摊派），
  //     这一份必须严格自洽：标定后分项之和 == usedTokens（见下）。
  //   - source='estimate' 时 tokens 之和必须严格相等（同一套估算），见下一个用例。
  const sum = payload.breakdown.reduce((total, item) => total + item.tokens, 0);
  assert.ok(
    Math.abs(sum - payload.usedTokens) <= payload.usedTokens * 0.35,
    `分项求和 ${sum} 与真实 usedTokens ${payload.usedTokens} 偏离过大（允许 ±35%）`,
  );
  assert.equal(payload.breakdownCalibrated, true, '拿到真实 usedTokens 就该标定');
  const calibratedSum = payload.breakdown.reduce((total, item) => total + (item.tokensCalibrated || 0), 0);
  assert.equal(calibratedSum, payload.usedTokens, '标定后分项之和必须等于真实 usedTokens');
});


test('GET /api/context/usage：稳定前缀指纹进 payload（代码审查改进 §2.3）', async () => {
  const { conversationId } = seedConversation({ users: 2, assistants: 2 });
  contextUsage.recordContextUsage({
    conversationId,
    model: 'cn:deepseek-v4-flash',
    prefixHashes: { stablePrefixHash: 'stable-aaa', fullPrefixHash: 'full-aaa', requestHash: 'req-aaa' },
    segments: { system: ['稳定前缀'] },
  });
  const first = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(first.status, 200);
  assert.equal(first.json.stablePrefixHash, 'stable-aaa', '稳定前缀指纹必须落进 payload（前端据此判断\"哪个块动了\"）');
  assert.equal(first.json.fullPrefixHash, 'full-aaa');
  assert.equal(first.json.requestHash, 'req-aaa');

  // 下一轮稳定前缀变了 → 指纹跟着变（这就是面板要显示的"一致/变化"）
  contextUsage.recordContextUsage({
    conversationId,
    model: 'cn:deepseek-v4-flash',
    prefixHashes: { stablePrefixHash: 'stable-bbb', fullPrefixHash: 'full-bbb', requestHash: 'req-bbb' },
    segments: { system: ['稳定前缀（好感度换档）'] },
  });
  const second = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(second.json.stablePrefixHash, 'stable-bbb');
  assert.notEqual(second.json.stablePrefixHash, first.json.stablePrefixHash, '稳定块动了 → 指纹必须变化');
});

test('未传 prefixHashes（老调用点/群聊）→ 三个指纹字段为 null，不报错', async () => {
  const { conversationId } = seedConversation({ users: 1, assistants: 1 });
  contextUsage.recordContextUsage({ conversationId, model: 'x', segments: { system: ['只有分段'] } });
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.stablePrefixHash, null);
  assert.equal(res.json.fullPrefixHash, null);
  assert.equal(res.json.requestHash, null);
});
test('GET /api/context/usage：estimate 来源时，分项求和与 usedTokens 严格一致', async () => {
  const { conversationId } = seedConversation({ users: 3, assistants: 3 });
  contextUsage.recordContextUsage({
    conversationId,
    model: 'cn:deepseek-v4-flash',
    segments: {
      system: ['系统提示词'.repeat(50)],
      memory: ['<user_portrait>画像</user_portrait>'],
      transcript: ['<active_chat_history>\n[用户]: 你好\n</active_chat_history>'],
      directive: ['<reply_length>\n- 短一点\n</reply_length>'],
    },
  });
  const res = await api('GET', `/api/context/usage?conversationId=${conversationId}`);
  assert.equal(res.json.source, 'estimate');
  const sum = res.json.breakdown.reduce((total, item) => total + item.tokens, 0);
  // 同一套估算口径下，分项之和就是顶层 usedTokens（估算来源不存在第二套口径）
  assert.equal(sum, res.json.usedTokens);
});

test('组装后补记的段（appendContextSegment）会并入对应分项', () => {
  const { conversationId } = seedConversation({ users: 1, assistants: 1 });
  const snapshot = contextUsage.recordContextUsage({ conversationId, model: 'm', segments: { system: ['系统'] } });
  assert.equal(snapshot.breakdown.find(item => item.key === 'memory').chars, 0);
  contextUsage.appendContextSegment(conversationId, 'memory', '<group_town_life_records>小镇记录</group_town_life_records>');
  contextUsage.appendContextSegment(conversationId, 'nope', '非法分段应被忽略');
  const afterBlocks = contextUsage.snapshotBreakdown(contextUsage.getContextUsageSnapshot(conversationId));
  assert.equal(afterBlocks.find(item => item.key === 'memory').chars, '<group_town_life_records>小镇记录</group_town_life_records>'.length);
  assert.equal(afterBlocks.length, 5);
});

// ── 3.5 两个组装点真的在记（私聊 buildChatContextSegments / 群聊 buildGroupContext） ──

test('buildChatContextSegments：私聊组装材料按分段归类（这就是面板分项的采集口径）', () => {
  const segments = contextUsage.buildChatContextSegments({
    stableBlocks: ['<world_setting>世界</world_setting>', '人格与格式规则'],
    // 两条按空行拼成一条（与 buildChatContext 的拼法一致），空串要被丢掉
    preSummarySystem: ['活人感规则', '', '表情包清单'],
    summaryBlock: '[历史摘要] 她说过不吃香菜',
    preHistoryMessages: [{ role: 'user', content: '<group_chat_log>群里的近况</group_chat_log>' }],
    history: [{ role: 'user', content: '你吃香菜吗' }, { role: 'assistant', content: '不吃' }],
    dynamicBlocks: [
      '<user_portrait>印象：怕冷</user_portrait>',
      '<rag_memories>\n1. 她不吃香菜\n</rag_memories>',
      '<active_chat_history>\n[用户]: 你好\n</active_chat_history>',
      '<reply_length>\n- 短一点\n</reply_length>',
      '<time_context>\n21:00\n</time_context>',
      '【⚠️ 重逢提示 — 仅本次生成可见】她之前发了两条都没回',
    ],
  });

  // 系统提示词 = 稳定块 + 拼好的摘要前 system（不含被丢掉的空串）
  assert.deepEqual(segments.system, ['<world_setting>世界</world_setting>', '人格与格式规则', '活人感规则\n\n表情包清单']);
  // 记忆与档案 = 画像 + RAG（群聊实况块是 preHistoryMessages，归 transcript 还是 memory 由标签决定）
  assert.deepEqual(segments.memory, ['<user_portrait>印象：怕冷</user_portrait>', '<rag_memories>\n1. 她不吃香菜\n</rag_memories>']);
  // 对话消息 = 摘要 + 历史前的消息层 + 历史 + 活跃历史块
  assert.deepEqual(segments.transcript, [
    '[历史摘要] 她说过不吃香菜',
    '<group_chat_log>群里的近况</group_chat_log>',
    '你吃香菜吗',
    '不吃',
    '<active_chat_history>\n[用户]: 你好\n</active_chat_history>',
  ]);
  // 本轮指令 = reply_length + 无标签的重逢提示
  assert.equal(segments.directive.length, 2);
  assert.ok(segments.directive.some(block => block.includes('<reply_length>')));
  assert.ok(segments.directive.some(block => block.includes('重逢提示')));
  // 环境块归 other
  assert.deepEqual(segments.other, ['<time_context>\n21:00\n</time_context>']);

  // 分项之和 = 各段文本的估算之和（同一套函数，不存在第二口径）
  const breakdown = contextUsage.buildBreakdown(segments);
  assert.equal(breakdown.length, 5);
  assert.ok(breakdown.find(item => item.key === 'system').chars > 0);
  assert.ok(breakdown.find(item => item.key === 'memory').chars > 0);
  assert.ok(breakdown.find(item => item.key === 'directive').tokens > 0);
});

test('buildGroupContext：群聊组装点也会落一份分段快照（system/记忆/transcript/指令/其他）', async () => {
  const db = getDb();
  const groupId = Number(db.prepare(`INSERT INTO group_chats (name) VALUES ('上下文测试群')`).run().lastInsertRowid);
  const characterId = Number(db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`)
    .run(`grp_ctx_${++seedSeq}`, `群成员${seedSeq}`).lastInsertRowid);
  db.prepare(`INSERT INTO group_members (group_id, character_id) VALUES (?, ?)`).run(groupId, characterId);

  const { getGroupWithMembers, buildGroupContext, groupConvId } = await import('../src/services/groupChatEngine.js');
  const group = getGroupWithMembers(groupId);
  const messages = buildGroupContext(group, [
    '<time_context>21:00</time_context>',
    '<rag_memories>\n1. 群里聊过香菜\n</rag_memories>',
    '<round_directive>角色们接着聊</round_directive>',
    '「用户」在群里发了消息，接下来角色们要接话。',
  ]);
  assert.ok(messages.length >= 5, '至少要有 system 层 + transcript + 本轮指令');

  const conversationId = groupConvId(groupId);
  const snapshot = contextUsage.getContextUsageSnapshot(conversationId);
  assert.ok(snapshot, 'buildGroupContext 必须留下分段快照');
  const byKey = Object.fromEntries(contextUsage.snapshotBreakdown(snapshot).map(item => [item.key, item]));
  assert.ok(byKey.system.chars > 0, '群卡/协议/世界观进 system 段');
  assert.ok(byKey.memory.chars > 0, '<rag_memories> 进记忆与档案段');
  assert.ok(byKey.transcript.chars > 0, '<group_transcript> 进对话消息段');
  assert.ok(byKey.directive.chars > 0, 'round_directive 进本轮指令段');
  assert.ok(byKey.other.chars > 0, '<time_context> 进其他段');
  // 快照记的是"真的拼进 messages 的那些字符串"，与消息本体对得上
  const transcriptMessage = messages.find(message => message.content.startsWith('<group_transcript>'));
  assert.ok(transcriptMessage, 'transcript 消息应当在 messages 里');
  assert.equal(byKey.transcript.chars, transcriptMessage.content.length);
  // 不重不漏：五段 chars 之和 == 真正拼进请求的消息字数（directiveBlocks 被拼成同一条消息，
  // 若把 <rag_memories> 既算进指令段又算进记忆段，这里就会多出来）
  const totalChars = contextUsage.snapshotBreakdown(snapshot).reduce((sum, item) => sum + item.chars, 0);
  assert.equal(totalChars, messages.reduce((sum, message) => sum + message.content.length, 0));
});

// ── 5. 模型配置接口带上 contextWindow / contextWindowSource ──

test('POST /api/config/llm/profiles：用户填的窗口 → declared，GET 配置能读回', async () => {
  const name = `带窗口的模型_${++seedSeq}`;
  const res = await api('POST', '/api/config/llm/profiles', {
    name,
    baseURL: LOCAL_BASE_URL,
    model: 'cn:deepseek-v4-flash',
    contextWindow: 200000,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contextWindow, 200000);
  assert.equal(res.json.contextWindowSource, 'declared');
  const saved = res.json.profiles.find(p => p.name === name);
  assert.equal(saved.contextWindow, 200000);
  assert.equal(saved.contextWindowSource, 'declared');

  const config0 = await api('GET', '/api/config');
  assert.equal(config0.status, 200);
  const readBack = config0.json.llmProfiles.find(p => p.id === saved.id);
  assert.equal(readBack.contextWindow, 200000);
  assert.equal(readBack.contextWindowSource, 'declared');
});

test('POST /api/config/llm/profiles：没填窗口 → 从上游 /v1/models 取（provider）', async () => {
  contextUsage.clearProviderContextWindowCache();
  modelsPayload = { data: [{ id: 'cn:deepseek-v4-flash', context_length: 1000000 }] };
  const res = await api('POST', '/api/config/llm/profiles', {
    name: `上游窗口_${++seedSeq}`,
    baseURL: LOCAL_BASE_URL,
    model: 'cn:deepseek-v4-flash',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contextWindow, 1000000);
  assert.equal(res.json.contextWindowSource, 'provider');
});

test('POST /api/config/llm/profiles：上游给不出窗口 → 保守默认 128000（default）', async () => {
  contextUsage.clearProviderContextWindowCache();
  modelsPayload = { data: [{ id: 'other', context_length: 8000 }] };
  const res = await api('POST', '/api/config/llm/profiles', {
    name: `默认窗口_${++seedSeq}`,
    baseURL: LOCAL_BASE_URL,
    model: 'cn:deepseek-v4-flash',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contextWindow, 128000);
  assert.equal(res.json.contextWindowSource, 'default');
});

test('GET /api/config 的 llm 段带 contextWindow / contextWindowSource；PUT /api/config/llm 能声明与清空', async t => {
  const savedWindow = config.llm.contextWindow;
  const savedSource = config.llm.contextWindowSource;
  t.after(() => {
    config.llm.contextWindow = savedWindow;
    config.llm.contextWindowSource = savedSource;
  });

  // 本用例会写真实 .env（persistEnv 的落点），跑完按字节还原
  const originalEnv = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH) : null;
  await withEnvFileRestored(async () => {
    const put = await api('PUT', '/api/config/llm', { contextWindow: 555000 });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.contextWindow, 555000);
    assert.equal(put.json.contextWindowSource, 'declared');

    const readBack = await api('GET', '/api/config');
    assert.equal(readBack.json.llm.contextWindow, 555000);
    assert.equal(readBack.json.llm.contextWindowSource, 'declared');

    // 非法值要拒掉（不能悄悄写成 NaN / 0）
    const bad = await api('PUT', '/api/config/llm', { contextWindow: -5 });
    assert.equal(bad.status, 400);

    // 清空声明 → 服务端按三级回退解析：上游报了这个模型就写 provider
    contextUsage.clearProviderContextWindowCache();
    modelsPayload = { data: [{ id: 'cn:deepseek-v4-flash', context_length: 1000000 }] };
    const cleared = await api('PUT', '/api/config/llm', { contextWindow: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.contextWindow, 1000000);
    assert.equal(cleared.json.contextWindowSource, 'provider');

    // 上游给不出窗口时，清空后落到保守默认（default），不能留 null 让面板无值可显示
    contextUsage.clearProviderContextWindowCache();
    modelsPayload = { data: [{ id: 'other', context_length: 8000 }] };
    const fallback = await api('PUT', '/api/config/llm', { contextWindow: '' });
    assert.equal(fallback.status, 200, fallback.text);
    assert.equal(fallback.json.contextWindow, 128000);
    assert.equal(fallback.json.contextWindowSource, 'default');

    // 换模型时旧窗口不再成立（含上游探到的值）→ 必须清空，等新模型重新声明/探测
    await api('PUT', '/api/config/llm', { model: 'cn:deepseek-v4-flash' });
    await api('PUT', '/api/config/llm', { contextWindow: 777000 });
    assert.equal(config.llm.contextWindow, 777000);
    const switched = await api('PUT', '/api/config/llm', { model: 'cn:another-model' });
    assert.equal(switched.json.contextWindow, null);
    assert.equal(switched.json.contextWindowSource, null);
  });

  // 文件必须逐字节回到原样（否则测试就改了用户的真实配置）
  const restored = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH) : null;
  assert.deepEqual(restored, originalEnv, '.env 必须原样还原');
});

// ── 6. POST /api/context/compress ──

test('POST /api/context/compress：没有可压缩内容 → 200 + summaryCreated:false（不假装成功）', async () => {
  const { conversationId } = seedConversation({ users: 2, assistants: 1 });
  const res = await api('POST', '/api/context/compress', { conversationId });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.conversationId, conversationId);
  assert.equal(res.json.summaryCreated, false);
  assert.equal(res.json.after, null);
  assert.deepEqual(res.json.before, { usedTokens: 0 });
  assert.match(res.json.message, /没有可压缩/);
});

test('POST /api/context/compress：会话不存在 → 200 + summaryCreated:false', async () => {
  const res = await api('POST', '/api/context/compress', { conversationId: 'char_999999' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.summaryCreated, false);
  assert.match(res.json.message, /找不到该会话/);
});

test('POST /api/context/compress：总开关关闭 → 200 + summaryCreated:false + 说明', async t => {
  const { conversationId } = seedConversation();
  const saved = config.features.memory;
  config.features.memory = false;
  t.after(() => { config.features.memory = saved; });

  const res = await api('POST', '/api/context/compress', { conversationId });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.summaryCreated, false);
  assert.match(res.json.message, /总开关已关闭/);
});

test('POST /api/context/compress：缺 conversationId → 400', async () => {
  const res = await api('POST', '/api/context/compress', {});
  assert.equal(res.status, 400);
  assert.match(res.json.error, /conversationId/);
});

test('POST /api/context/compress：正放松动摘要链路 → summaryCreated:true，并带上 before.usedTokens', async () => {
  const { conversationId } = seedConversation();
  chatContent = '（假摘要）他把香菜挑掉了，还说下次一起去看电影。';
  // 先制造一份用量快照，before 里应带上它
  contextUsage.recordContextUsage({ conversationId, model: 'm', segments: { system: ['系统提示词'.repeat(64)] } });
  const snapshotBefore = contextUsage.snapshotUsage(contextUsage.getContextUsageSnapshot(conversationId));

  const res = await api('POST', '/api/context/compress', { conversationId, reason: '用户点了压缩按钮' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.summaryCreated, true);
  assert.deepEqual(res.json.before, { usedTokens: snapshotBefore.usedTokens });
  assert.equal(res.json.after, null, '压缩是下一轮才见效，after 必须如实为 null');
  assert.match(res.json.message, /已触发上下文压缩/);

  // 确实走了既有摘要链路：rolling_summaries 里落了摘要
  const rows = getDb().prepare(`SELECT summary FROM rolling_summaries WHERE conversation_id = ?`).all(conversationId);
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, /香菜/);
});

test('POST /api/context/compress：同一会话压缩中 → 409；活干完标记要释放', { timeout: 20000 }, async () => {
  const { conversationId } = seedConversation();
  // 让这一轮的摘要请求挂住，压缩就一直"在途"
  const barrier = blockChat();
  const requestsBefore = chatRequestCount;

  const first = api('POST', '/api/context/compress', { conversationId });
  // 假上游收到摘要请求 ⇒ 路由早就把会话加进"压缩中"了，此时再点必然是 409
  const started = await waitFor(() => chatRequestCount > requestsBefore, { timeoutMs: 10000, stepMs: 5 });
  assert.equal(started, true, '摘要请求始终没发出（压缩没进入在途状态）');

  const second = await api('POST', '/api/context/compress', { conversationId });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'compression in progress');

  barrier.release();
  const settled = await first;
  assert.equal(settled.status, 200, settled.text);

  // 摘要已落库 → 再点一次是"没有可压缩内容"（200），绝不能还是 409（标记泄漏）
  const third = await api('POST', '/api/context/compress', { conversationId });
  assert.equal(third.status, 200, third.text);
  assert.equal(third.json.summaryCreated, false);
});

test('POST /api/context/compress：超过 HTTP 预算 → 如实返回"已开始压缩"，summaryCreated 不假装', { timeout: 20000 }, async () => {
  const { conversationId } = seedConversation();
  const requestsBefore = chatRequestCount;
  const barrier = blockChat();

  const res = await api('POST', '/api/context/compress', { conversationId });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.summaryCreated, null, '还不知道结果就不能声称 true / false');
  assert.match(res.json.message, /已开始压缩/);
  assert.equal(res.json.after, null);
  assert.equal(chatRequestCount > requestsBefore, true, '摘要请求应已发出（否则说明没走到 LLM）');

  barrier.release();
  // 后台继续跑完 → 在途标记释放，之后不再 409
  const released = await waitFor(async () => {
    const probe = await api('POST', '/api/context/compress', { conversationId });
    return probe.status !== 409;
  }, { timeoutMs: 8000 });
  assert.equal(released, true, '后台压缩结束后必须释放并发标记');
});

test('压缩阈值与摘要链路同源：SUMMARIZE_INTERVAL 就是预检用的轮次', () => {
  // hasCompressibleContext 的门槛由调用方从 summarizer 取，避免两处各写一个数字
  const { conversationId } = seedConversation({ users: SUMMARIZE_INTERVAL, assistants: SUMMARIZE_INTERVAL - 1 });
  const db = getDb();
  assert.equal(contextUsage.hasCompressibleContext(db, conversationId, {
    summaryInterval: SUMMARIZE_INTERVAL, triggerRole: 'assistant', memoryMinMessages: 40,
  }), false, `${SUMMARIZE_INTERVAL - 1} 条 assistant 还不够一轮摘要`);
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '再来一句')`).run(conversationId);
  assert.equal(contextUsage.hasCompressibleContext(db, conversationId, {
    summaryInterval: SUMMARIZE_INTERVAL, triggerRole: 'assistant', minMessages: 40, memoryMinMessages: 40,
  }), true);
});
