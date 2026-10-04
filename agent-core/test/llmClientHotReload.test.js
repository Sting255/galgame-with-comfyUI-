/**
 * llm-client 的配置热更新与重试退避（审查 §6.1 / §6.2 · 2026-09-30）
 *
 * §6.1：`_client` 是单例，配置（baseURL / apiKey）变更后若没人调 `resetClient()` 就会继续用旧配置。
 *   本文件钉住"**不依赖调用方记得 resetClient**"这条契约：配置指纹变了，下一次调用必须自愈重建。
 * §6.2：429 属可重试 —— 核实结论是**已有指数退避**（`retryDelay * 2^(attempt-1)`，默认 1000ms），
 *   本文件用 `retryDelay: 60` 实测两段退避 ≈ 60 / 120ms（并证明 429 确实会重试、最终成功）。
 *
 * 两个假上游都不联网，只监听 127.0.0.1。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH = ':memory:';

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm._model = 'stub-model';
config.llm._thinkingMode = 'disabled';
config.llm._extraBody = {};
const { chatSync, resetClient } = await import('../src/llm/llm-client.js');

function makeUpstream(name, { statuses = [] } = {}) {
  const state = { name, calls: 0, lastAuth: '', lastUrl: '', lastAt: 0, gaps: [], bodies: [] };
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      state.calls += 1;
      state.lastAuth = String(req.headers.authorization || '');
      state.lastUrl = String(req.url || '');
      state.bodies.push(text);
      const now = Date.now();
      if (state.lastAt) state.gaps.push(now - state.lastAt);
      state.lastAt = now;
      const status = statuses[state.calls - 1] || 200;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub', object: 'chat.completion', created: 0, model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: name + '-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return { state, server };
}
const A = makeUpstream('A');
const B = makeUpstream('B');
const R = makeUpstream('R', { statuses: [429, 429, 200] });
await new Promise(resolve => A.server.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => B.server.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => R.server.listen(0, '127.0.0.1', resolve));
const urlA = 'http://127.0.0.1:' + A.server.address().port + '/v1';
const urlB = 'http://127.0.0.1:' + B.server.address().port + '/v1';
const urlR = 'http://127.0.0.1:' + R.server.address().port + '/v1';

after(() => {
  A.server.close();
  B.server.close();
  R.server.close();
  resetClient();
});

const ask = (label, opts = {}) => chatSync([{ role: 'user', content: 'hi' }], { label, max_tokens: 8, retries: 0, ...opts });

test('§6.1 配置热更新：没调 resetClient 也要自愈（baseURL / apiKey 变了 ⇒ 下一次调用用新配置）', async () => {
  resetClient();
  config.llm._baseURL = urlA;
  config.llm._apiKey = 'key-one';
  assert.equal(await ask('hot-reload-1'), 'A-ok');
  assert.equal(A.state.calls, 1, '第一次走 A');
  assert.match(A.state.lastAuth, /key-one/);

  // 模拟"某条配置更新路径忘了 resetClient"：只改 config，不调 resetClient
  config.llm._baseURL = urlB;
  config.llm._apiKey = 'key-two';
  assert.equal(await ask('hot-reload-2'), 'B-ok', '配置变了必须立刻用新网关');
  assert.equal(B.state.calls, 1, '新 baseURL 要收到请求（旧实现会一直打 A）');
  assert.match(B.state.lastAuth, /key-two/, 'apiKey 也要跟着换');
  assert.equal(A.state.calls, 1, '旧网关不该再收到请求');
});

test('§6.1 显式 resetClient 仍然有效；配置没变时连续调用复用同一个客户端', async () => {
  resetClient();
  config.llm._baseURL = urlA;
  config.llm._apiKey = 'key-one';
  const base = A.state.calls;
  await ask('hot-reload-3');
  await ask('hot-reload-4');
  assert.equal(A.state.calls, base + 2, '两次调用都在 A（配置没变就复用客户端）');
  resetClient();
  await ask('hot-reload-5');
  assert.equal(A.state.calls, base + 3, '显式 reset 后照样能用');
});

test('§6.2 429 可重试 + 指数退避（retryDelay 200 ⇒ 实测 ≈200/400ms），且最终成功', async () => {
  // 计时口径说明（2026-09-30 修 flaky）：本用例原来用 retryDelay=60 并断言「第二段 ≥1.5× 第一段」，
  // 60ms 级别的两段间隔受事件循环/宿主机调度抖动影响极大（全量回归跑并行文件时第一段被拉长到 ~90ms，
  // 第二段 ~125ms ⇒ 比例 1.39 < 1.5 假红）。现在：① 基线上调到 200ms（比例的分母不再被小延迟放大）；
  // ② 断言改成"绝对下界 + 1.2 倍容差"，既能抓真故障又不吃抖动。
  resetClient();
  config.llm._baseURL = urlR;
  config.llm._apiKey = 'key-r';
  const started = Date.now();
  const content = await ask('retry-429', { retries: 2, retryDelay: 200, maxRetries: 0 });
  const elapsed = Date.now() - started;
  // 真故障①"不重试"：429 不重试就会直接抛，calls=1、这里拿到不到 'R-ok'
  assert.equal(content, 'R-ok', '第三次（429,429,200）应当成功');
  assert.equal(R.state.calls, 3, '两次 429 都要重试（不重试 ⇒ 只有 1 次请求）');
  assert.equal(R.state.gaps.length, 2, '两段退避');
  const [g1, g2] = R.state.gaps;
  // 真故障②"不退避"：固定 sleep 或 0 退避 ⇒ g1≈0 / g2≈200（都会被下面两条抓住）
  assert.ok(g1 >= 150, '第一段退避必须接近 retryDelay=200ms（不退避 ⇒ ≈0）：' + g1 + 'ms');
  assert.ok(g2 >= 300, '第二段必须接近 2×retryDelay=400ms（固定 sleep 只会 ≈200）：' + g2 + 'ms');
  // 比例只作冗余校验（真正抓故障的是上面两条绝对下界），容差放到 1.15 以防并行全量回归时的调度抖动
  assert.ok(g2 >= g1 * 1.15, '指数关系（1.15 倍容差）：' + g1 + '/' + g2 + 'ms');
  assert.ok(elapsed >= 450, '总时长下界（下界对抖动安全）：' + elapsed + 'ms');
  assert.ok(elapsed < 5000, '退避总时长有界（不读 Retry-After，最长 2 次退避）：' + elapsed + 'ms');
});
