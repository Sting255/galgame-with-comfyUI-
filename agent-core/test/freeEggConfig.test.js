// 每日免费鸡蛋（opencode zen 匿名档）配置口径回归
//
// 背景（2026-09-28 实测）：上游把免费档改成必须登录 OpenCode 才能用，原名单 mimo-v2.5-free
// 等一律 403 FreeTierError；全量复测 82 个模型后只剩 space-bunny-free 仍允许匿名调用。
// 同时该模型对 thinking:{type:'disabled'} 直接返回 400 invalid_request，而免费鸡蛋模式
// 原本强制注入 disabled —— 只换名单不换 thinking 口径，鸡蛋每次请求都会失败。
// 这两条口径都很容易被"顺手改回去"，故用测试钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, FREE_EGG_MODELS } from '../src/config.js';

test('免费鸡蛋名单只剩匿名可用的 space-bunny-free', () => {
  assert.deepEqual(FREE_EGG_MODELS, ['space-bunny-free']);
});

test('免费鸡蛋开启时的请求口径（免 Key + 不发送 thinking）', t => {
  const saved = {
    freeEgg: config.llm.freeEgg,
    apiKey: config.llm._apiKey,
    baseURL: config.llm._baseURL,
    model: config.llm._model,
    thinkingMode: config.llm._thinkingMode,
    headers: config.llm._headers,
    extraBody: config.llm._extraBody,
  };
  t.after(() => {
    config.llm.freeEgg = saved.freeEgg;
    config.llm._apiKey = saved.apiKey;
    config.llm._baseURL = saved.baseURL;
    config.llm._model = saved.model;
    config.llm._thinkingMode = saved.thinkingMode;
    config.llm._headers = saved.headers;
    config.llm._extraBody = saved.extraBody;
  });

  // 用户自有配置先摆成一组可辨识的值，便于确认关闭后原样恢复
  config.llm._apiKey = 'own-key-fixture';
  config.llm._baseURL = 'http://127.0.0.1:7863/v1';
  config.llm._model = 'cn:deepseek-v4-flash';
  config.llm._thinkingMode = 'enabled';
  config.llm._headers = { 'x-own': '1' };
  config.llm._extraBody = { top_p: 0.9 };

  config.llm.freeEgg = true;
  assert.equal(config.llm.baseURL, 'https://opencode.ai/zen/v1', '鸡蛋走 zen 免费端点');
  assert.equal(config.llm.model, 'space-bunny-free', '鸡蛋用匿名可用的免费模型');
  assert.equal(config.llm.apiKey, '', '匿名访问：不发送 Authorization');
  // 关键：必须是 omit。若改回 disabled，请求体会带 thinking:{type:'disabled'}，上游直接 400
  assert.equal(config.llm.thinkingMode, 'omit', '鸡蛋模式不发送 thinking 参数');
  assert.deepEqual(config.llm.headers, {}, '鸡蛋模式不夹带自有自定义请求头');
  assert.deepEqual(config.llm.extraBody, {}, '鸡蛋模式不夹带自有 extraBody');

  config.llm.freeEgg = false;
  assert.equal(config.llm.apiKey, 'own-key-fixture', '关闭后恢复自有 Key');
  assert.equal(config.llm.baseURL, 'http://127.0.0.1:7863/v1', '关闭后恢复自有地址');
  assert.equal(config.llm.model, 'cn:deepseek-v4-flash', '关闭后恢复自有模型');
  assert.equal(config.llm.thinkingMode, 'enabled', '关闭后恢复自有思考口径');
  assert.deepEqual(config.llm.headers, { 'x-own': '1' });
  assert.deepEqual(config.llm.extraBody, { top_p: 0.9 });
});
