/**
 * 反重复设置的 HTTP 契约（专题·车轱辘话与钻牛角尖 · 阶段一）
 *
 * 覆盖：GET /api/config 暴露的字段形状（features 两个开关 + llm 两个 penalty）、
 * PUT /api/config/anti-repetition 的保存 / 清空 / 400 校验，
 * 以及"重启后仍在"——即 system_settings 的 SETTING_TO_CONFIG 映射真的生效
 * （历史上漏注册映射时 setSetting 只写不读，值和界面会静默不一致）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`antiRepetition api fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const configRoutes = (await import('../src/routes/config.js')).default;
// settings 句柄只在 getDb() 打开库时注入：先开库，下面的 PUT 才会真正落 system_settings
getDb();

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/config', configRoutes);
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

test('GET /api/config：features 暴露两个反重复开关，llm 暴露两个 penalty（默认 null）', async () => {
  const { status, json } = await api('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(json.features.antiRepetition, true, '默认开');
  assert.equal(json.features.antiRepetitionLock, true, '默认开');
  assert.equal('antiRepetitionPenalty' in json.llm, true);
  assert.equal('antiRepetitionFrequency' in json.llm, true);
});

test('PUT /api/config/anti-repetition：保存数字、写库、可清空回 null', async () => {
  const saved = await api('PUT', '/api/config/anti-repetition', { presence: 0.4, frequency: -0.3 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.antiRepetitionPenalty, 0.4);
  assert.equal(saved.json.antiRepetitionFrequency, -0.3);
  assert.equal(config.llm.antiRepetitionPenalty, 0.4);
  assert.equal(config.llm.antiRepetitionFrequency, -0.3);

  // 写库（重启后可由 SETTING_TO_CONFIG 读回）
  const db = getDb();
  const stored = db.prepare("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('anti_repetition_penalty','anti_repetition_frequency') ORDER BY setting_key").all();
  assert.deepEqual(stored, [
    { setting_key: 'anti_repetition_frequency', setting_value: '-0.3' },
    { setting_key: 'anti_repetition_penalty', setting_value: '0.4' },
  ]);

  // 立刻用同一张映射表读回，证明"重启也不会丢"
  const { loadSystemSettings } = await import('../src/db/settings.js');
  loadSystemSettings(db);
  assert.equal(config.llm.antiRepetitionPenalty, 0.4);
  assert.equal(config.llm.antiRepetitionFrequency, -0.3);

  // 清空 → null（请求体里不发送该字段）
  const cleared = await api('PUT', '/api/config/anti-repetition', { presence: '', frequency: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.antiRepetitionPenalty, null);
  assert.equal(cleared.json.antiRepetitionFrequency, null);
  assert.equal(config.llm.antiRepetitionPenalty, null);
  assert.equal(getDb().prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'anti_repetition_penalty'").pluck().get(), '');
});

test('PUT /api/config/anti-repetition：越界/非法值一律 400，且不污染内存', async () => {
  config.llm.antiRepetitionPenalty = null;
  for (const payload of [{ presence: 3 }, { presence: -2.5 }, { frequency: 9 }, { frequency: 'abc' }]) {
    const res = await api('PUT', '/api/config/anti-repetition', payload);
    assert.equal(res.status, 400, `${JSON.stringify(payload)} 应当被拒绝`);
  }
  assert.equal(config.llm.antiRepetitionPenalty, null, '非法请求不得改动内存配置');
  const missing = await api('PUT', '/api/config/anti-repetition', {});
  assert.equal(missing.status, 400);
});

test('PUT /api/config/features：两个开关可关可开（走既有 updateFeatureFlag）', async () => {
  const off = await api('PUT', '/api/config/features', { key: 'antiRepetition', value: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.features.antiRepetition, false);
  assert.equal(getDb().prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'feature_antiRepetition'").pluck().get(), 'false');

  const on = await api('PUT', '/api/config/features', { key: 'antiRepetitionLock', value: false });
  assert.equal(on.json.features.antiRepetitionLock, false);

  await api('PUT', '/api/config/features', { key: 'antiRepetition', value: true });
  await api('PUT', '/api/config/features', { key: 'antiRepetitionLock', value: true });
  assert.equal(config.features.antiRepetition, true);
  assert.equal(config.features.antiRepetitionLock, true);
});
test('PUT /api/config/features：reroll 开关走同一入口、写库、并装回 config（D2）', async () => {
  // 用户点名「开关放到设置里」：前端那一个 switch 必须真的能改变后端行为，
  // 所以这里验到**落库 + 读回**为止（纯内存切换不算数）。
  const on = await api('PUT', '/api/config/features', { key: 'antiRepetitionReroll', value: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.features.antiRepetitionReroll, true, '打开后 config 必须是 true');
  assert.equal(getDb().prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'feature_antiRepetitionReroll'").pluck().get(), 'true');

  const off = await api('PUT', '/api/config/features', { key: 'antiRepetitionReroll', value: false });
  assert.equal(off.json.features.antiRepetitionReroll, false, '关掉后必须回 false');
  assert.equal(getDb().prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'feature_antiRepetitionReroll'").pluck().get(), 'false');
  assert.equal(config.features.antiRepetitionReroll, false, '收尾：留在关（默认态）');
});
