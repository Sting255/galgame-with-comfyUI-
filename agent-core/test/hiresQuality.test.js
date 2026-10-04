/**
 * HiresFix 细化精度三档 `features.hiresQuality`（2026-09-30 · D1 实测裁决）
 *
 * 用户裁决：设置里给「精度 高/中/低」，**默认 low = 8 步**。
 * 映射（D1 同一角色卡/prompt/seed 实测）：high = 12 步 / medium = 10 步 / low = 8 步，CFG 固定 1.0（turbo）。
 * `hiresTurboSteps` 保留为**底层逃生门**：被改成非内置默认（12）时以它为准，绕过三档。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
const realFetch = globalThis.fetch;
// 只放行本机（测试自建的 express/ComfyUI 桩），其余一律拒绝：防误打真网关/真 ComfyUI
globalThis.fetch = async (url, ...rest) => {
  const text = String(url);
  if (text.includes('127.0.0.1') || text.includes('localhost')) return realFetch(url, ...rest);
  throw new Error('hires quality fixture forbids network: ' + text);
};

const { config, updateFeatureFlag, normalizeHiresQuality } = await import('../src/config.js');
config.dbPath = ':memory:';
const { buildHiresWorkflow, resolveTurboSteps, HIRES_QUALITY_STEPS } = await import('../src/services/imageRefine.js');
const { getDb } = await import('../src/db/index.js');

function samplerValues(built) {
  const workflow = built?.wf || built;
  const ks = workflow.nodes.find(n => n.type === 'KSampler' || n.type === 'KSamplerAdvanced');
  assert.ok(ks, '构建结果里应当有 KSampler 节点');
  const w = ks.widgets_values || [];
  return { steps: w[2], cfg: w[3], denoise: w[6] };
}
function stepsFor(quality) {
  config.features.hiresQuality = quality;
  return samplerValues(buildHiresWorkflow('a girl standing', {})).steps;
}
function resetOverrides() {
  config.comfyui.hiresTurboSteps = 12;
  config.comfyui.hiresTurbo = true;
  config.comfyui.hiresCfg = 5.0;
  config.comfyui.hiresDenoise = 0.35;
}

test('A 默认 low（= 8 步）；默认值必须来自 config.js 源码（防内存污染假绿）', async () => {
  resetOverrides();
  assert.equal(config.features.hiresQuality, 'low', '默认档位是 low（用户指定）');
  assert.equal(resolveTurboSteps(), 8, '默认 → 8 步');
  assert.equal(samplerValues(buildHiresWorkflow('a girl', {})).steps, 8, '构建出的 workflow 也是 8 步');

  const cfg = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.ok(/hiresQuality:\s*normalizeHiresQuality\(process\.env\.FEATURE_HIRES_QUALITY\)/.test(cfg),
    'config.js 必须用 FEATURE_HIRES_QUALITY 声明该键（否则只有内存里的值，装机不生效）');
  const settings = await readFile(new URL('../src/db/settings.js', import.meta.url), 'utf8');
  assert.ok(settings.includes('feature_hiresQuality'), 'db/settings.js 必须登记落库键');
});

test('B 三档映射：high = 12 步 / medium = 10 步 / low = 8 步（CFG 恒 1.0）', () => {
  resetOverrides();
  assert.deepEqual(HIRES_QUALITY_STEPS, { high: 12, medium: 10, low: 8 });
  for (const [quality, steps] of [['high', 12], ['medium', 10], ['low', 8]]) {
    assert.equal(stepsFor(quality), steps, quality + ' → ' + steps + ' 步');
  }
  config.features.hiresQuality = 'high';
  const v = samplerValues(buildHiresWorkflow('a girl', {}));
  assert.equal(v.cfg, 1.0, 'turbo 的 CFG 仍是 1.0');
  assert.equal(v.denoise, 0.35, 'denoise 不受精度档影响');
});

test('C 非法值一律回落 low（= 8 步）', () => {
  resetOverrides();
  assert.equal(normalizeHiresQuality('ultra'), 'low');
  assert.equal(normalizeHiresQuality(''), 'low');
  assert.equal(normalizeHiresQuality(undefined), 'low');
  assert.equal(normalizeHiresQuality(' medium '), 'medium', '首尾空白容错');
  assert.equal(normalizeHiresQuality('HIGH'), 'low', '大小写不折叠，与前端同一判定（HIGH 视为非法）');
  assert.equal(stepsFor('ultra'), 8);
  assert.equal(stepsFor(undefined), 8);
});

test('D hiresTurboSteps 显式覆盖优先于三档（底层逃生门）', () => {
  resetOverrides();
  config.comfyui.hiresTurboSteps = 20;
  assert.equal(stepsFor('high'), 20, '显式设了就用它，别再让两处打架');
  assert.equal(stepsFor('low'), 20);
  resetOverrides();
  assert.equal(stepsFor('high'), 12, '回到内置默认 12 后重新由三档决定');
});

test('E 设置写入：updateFeatureFlag 三态 + 落库 feature_hiresQuality', () => {
  resetOverrides();
  getDb();   // 先开库：settings.js 的句柄由 db/index.js 在首次 getDb() 时注入，否则写入会被静默吞掉
  updateFeatureFlag('hiresQuality', 'medium');
  assert.equal(config.features.hiresQuality, 'medium');
  assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_hiresQuality'), 'medium', '重启不丢');
  updateFeatureFlag('hiresQuality', 'bogus');
  assert.equal(config.features.hiresQuality, 'low', '非法值回落 low，不写脏值');
  assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_hiresQuality'), 'low');
  assert.equal(typeof config.features.hiresQuality, 'string', '三态字符串，不许被布尔强转');
});

test('F turbo 开关关闭时与精度档无关（逐字节回到旧口径的回归）', () => {
  resetOverrides();
  config.comfyui.hiresTurbo = false;
  config.comfyui.hiresSteps = 35;
  const v = samplerValues(buildHiresWorkflow('a girl', {}));
  assert.equal(v.steps, 35, '关掉 turbo → 用 hiresSteps');
  assert.equal(v.cfg, 5.0, '关掉 turbo → 用 hiresCfg');
  resetOverrides();
});

test('G 线路：GET /api/config 带回 hiresQuality；PUT /api/config/features 可切换、落库、且立刻影响 workflow 步数', async () => {
  resetOverrides();
  getDb();
  const express = (await import('express')).default;
  const configRoutes = (await import('../src/routes/config.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRoutes);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const putFeature = (value) => fetch(base + '/api/config/features', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'hiresQuality', value }),
  }).then(async res => ({ status: res.status, json: await res.json() }));
  try {
    const get1 = await (await fetch(base + '/api/config')).json();
    assert.equal(get1.features.hiresQuality, 'low', 'GET 默认 low');

    const put = await putFeature('medium');
    assert.equal(put.status, 200);
    assert.equal(put.json.features.hiresQuality, 'medium', 'PUT 回执带新值');
    assert.equal(config.features.hiresQuality, 'medium', '内存立即生效（不用重启）');
    assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_hiresQuality'), 'medium', '落库（重启不丢）');
    assert.equal(samplerValues(buildHiresWorkflow('x', {})).steps, 10, 'PUT 后 workflow 真的用 10 步');

    await putFeature('high');
    assert.equal(samplerValues(buildHiresWorkflow('x', {})).steps, 12, 'high ⇒ 12 步');

    const bad = await putFeature('ultra');
    assert.equal(bad.status, 200);
    assert.equal(bad.json.features.hiresQuality, 'low', '非法值回落 low，不写脏值');
    assert.equal(samplerValues(buildHiresWorkflow('x', {})).steps, 8, '回落 low ⇒ 8 步');
  } finally {
    server.close();
    config.features.hiresQuality = 'low';
  }
});
