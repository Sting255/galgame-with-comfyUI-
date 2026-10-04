/**
 * 反重复采样参数透传（专题·车轱辘话与钻牛角尖 · 阶段一 L3 / 规划 C5）
 *
 * 规划 C5 要求「只读核实 llm-client 是否透传 presence_penalty / frequency_penalty」。
 * 结论（离线可复跑证据）：**原实现完全不透传** —— 请求体里根本没有这两个字段；
 * 本测试钉住改造后的口径：
 *   · 默认 null（= 设置页留空 / 未配置）→ 请求体里不出现该字段，**与加参数前逐字节一致**
 *   · 显式传值（含 0）→ 原样透传（0 的语义是"不惩罚"，不是"不发送"）
 *   · extraBody 仍然可以覆盖（保持"自定义请求体"的既有语义）
 *
 * 打桩方式：把 require.cache 里的 node-fetch 换成假实现（OpenAI SDK 在运行时 require 它），
 * 于是 llm-client 会走到"真 SDK 组装请求体 → 假网络"的路径，抓到的就是真实请求体。
 * **不产生任何真实 LLM 调用**；真网关探针（确认中转站是否接受该参数）需用户授权，本轮未做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.DB_PATH = ':memory:';

const require = createRequire(import.meta.url);
const nodeFetchPath = require.resolve('node-fetch');

/** 假网络：记录每次请求体，回一个空流 */
const net = { streamBodies: [], syncBody: null };
const realFetchModule = require.cache[nodeFetchPath];
require.cache[nodeFetchPath] = {
  id: nodeFetchPath,
  filename: nodeFetchPath,
  loaded: true,
  exports: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream) {
      net.streamBodies.push(body);
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    net.syncBody = body;
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { chatStream, chatSync } = await import('../src/llm/llm-client.js');

test.after(() => {
  if (realFetchModule) require.cache[nodeFetchPath] = realFetchModule;
});

// 一组可辨识的基础配置（假网络下不会真的发出请求）
config.llm.freeEgg = false;
config.llm._apiKey = 'stub-key';
config.llm._baseURL = 'https://stub.local/v1';
config.llm._model = 'stub-model';
config.llm._thinkingMode = 'disabled';
config.llm._extraBody = {};

async function runStream(opts = {}) {
  net.streamBodies.length = 0;
  for await (const _delta of chatStream([{ role: 'user', content: '你好' }], { label: 'anti-rep-test', ...opts })) {
    // 假网络没内容增量，这里只把生成器跑完
  }
  assert.equal(net.streamBodies.length, 1, '应当恰好发出一次流式请求');
  return net.streamBodies[0];
}

test('默认（penalty 未设置）：请求体里没有 presence_penalty / frequency_penalty', async () => {
  config.llm.antiRepetitionPenalty = null;
  config.llm.antiRepetitionFrequency = null;

  const body = await runStream({ temperature: 0.72 });
  assert.equal(body.model, 'stub-model');
  assert.equal(body.stream, true);
  assert.equal('presence_penalty' in body, false, '默认不发送 presence_penalty（与加参数前逐字节一致）');
  assert.equal('frequency_penalty' in body, false, '默认不发送 frequency_penalty');
  assert.ok(body.messages.length > 0);
});

test('config 全局值命中：两个字段原样进请求体', async () => {
  config.llm.antiRepetitionPenalty = 0.4;
  config.llm.antiRepetitionFrequency = 0.3;
  try {
    const body = await runStream();
    assert.equal(body.presence_penalty, 0.4);
    assert.equal(body.frequency_penalty, 0.3);
  } finally {
    config.llm.antiRepetitionPenalty = null;
    config.llm.antiRepetitionFrequency = null;
  }
});

test('调用方显式传参优先于 config；显式传 0 也要发送（0 ≠ 不发送）', async () => {
  config.llm.antiRepetitionPenalty = 0.4;
  try {
    const body = await runStream({ presence_penalty: 0, frequency_penalty: -0.5 });
    assert.equal(body.presence_penalty, 0, '显式 0 必须发送（语义是"不惩罚"，不是"不发送"）');
    assert.equal(body.frequency_penalty, -0.5);
  } finally {
    config.llm.antiRepetitionPenalty = null;
  }
});

test('sync 路径同样透传（摘要 / 情绪评估等任务与主回复同口径）', async () => {
  net.syncBody = null;
  const out = await chatSync([{ role: 'user', content: 'hi' }], { label: 'anti-rep-sync', retries: 0, presence_penalty: 0.25 });
  assert.equal(out, 'ok');
  assert.ok(net.syncBody, '应当发出一次非流式请求');
  assert.equal(net.syncBody.presence_penalty, 0.25);
  assert.equal('frequency_penalty' in net.syncBody, false, '未设置的那一个仍然不发送');
});

test('extraBody 仍然可以覆盖 penalty（保持"自定义请求体"的既有语义）', async () => {
  config.llm.antiRepetitionPenalty = 0.4;
  config.llm._extraBody = { presence_penalty: 1.5 };
  try {
    const body = await runStream();
    assert.equal(body.presence_penalty, 1.5, 'extraBody 在 penalty 之后合并，应能覆盖');
  } finally {
    config.llm.antiRepetitionPenalty = null;
    config.llm._extraBody = {};
  }
});
