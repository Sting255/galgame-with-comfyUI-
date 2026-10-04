/**
 * HiresFix「按 turbo 模型最优参数细化」开关（2026-09-29）
 *
 * 真机结论：`放大细化工作流.json` 的主模型是 **anima_turboV10**（蒸馏模型），但软件一直往里注入
 * **CFG 5.0 / 35 步**。CFG>1 时每一步要额外跑一条无条件分支（双倍算力），且蒸馏模型在 CFG>1
 * 下画面会退化 —— 既慢又画质差。
 *
 * 修法：新增 `config.comfyui.hiresTurbo`（默认 true，设置页可随时开关）。开关打开 → 注入
 * `hiresTurboSteps=12 / hiresTurboCfg=1.0`；关闭 → **逐字节回到旧口径**（沿用 hiresSteps/hiresCfg）。
 * 这是关键回归点：关掉之后老用户的行为必须一模一样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`hires fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { buildHiresWorkflow } = await import('../src/services/imageRefine.js');

/** 递归找 KSampler（构建结果可能是 API 格式 {class_type,inputs} 或 UI 格式 {type,widgets_values}） */
function findNode(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  if (node.class_type === 'KSampler' || node.type === 'KSampler') return node;
  for (const v of Object.values(node)) {
    const hit = findNode(v, seen);
    if (hit) return hit;
  }
  return null;
}
/** 两种格式取同一组值：API 走 inputs，UI 走 widgets_values（[2]=步数 [3]=CFG [6]=denoise） */
function samplerValues(workflow) {
  const ks = findNode(workflow);
  assert.ok(ks, '构建结果里应当有 KSampler 节点');
  if (ks.inputs && ks.inputs.steps !== undefined) return { steps: ks.inputs.steps, cfg: ks.inputs.cfg, denoise: ks.inputs.denoise };
  const w = ks.widgets_values || [];
  return { steps: w[2], cfg: w[3], denoise: w[6] };
}

test('A 开关打开（默认）：细化用 turbo 参数 —— CFG 1.0 / 步数由精度档决定（默认 low = 8 步）', () => {
  config.comfyui.hiresTurbo = true;
  config.comfyui.hiresTurboSteps = 12;      // 内置默认 = 不覆盖（见 imageRefine.resolveTurboSteps 的优先级）
  config.features.hiresQuality = 'low';     // D1 用户裁决后的默认档（high 12 / medium 10 / low 8）
  const v = samplerValues(buildHiresWorkflow('a girl standing', {}));
  assert.equal(v.steps, 8, '默认精度 low ⇒ 8 步（2026-09-30 D1 裁决；三档映射见 hiresQuality.test.js）');
  assert.equal(v.cfg, 1.0, 'turbo 开关打开时 CFG 应为 1.0（CFG>1 会双倍算力且画质退化）');
});

test('B 开关关闭：逐字节回到旧口径（沿用用户填的 hiresSteps/hiresCfg）', () => {
  config.comfyui.hiresTurbo = false;
  config.comfyui.hiresSteps = 35;
  config.comfyui.hiresCfg = 5.0;
  const v = samplerValues(buildHiresWorkflow('a girl standing', {}));
  assert.equal(v.steps, 35, '关闭开关必须回到 35 步');
  assert.equal(v.cfg, 5.0, '关闭开关必须回到 CFG 5.0');
});

test('C 自定义值：打开时被忽略、关闭时生效（证明「开关」真的管用）', () => {
  config.comfyui.hiresSteps = 50;
  config.comfyui.hiresCfg = 7.5;
  config.comfyui.hiresTurboSteps = 12;      // 保持内置默认，让精度档说了算
  config.features.hiresQuality = 'high';    // 这一档 = 12 步
  config.comfyui.hiresTurbo = true;
  let v = samplerValues(buildHiresWorkflow('x', {}));
  assert.equal(v.steps, 12, '打开时自定义步数不生效（精度 high ⇒ 12）');
  assert.equal(v.cfg, 1.0, '打开时自定义 CFG 不生效');
  config.comfyui.hiresTurbo = false;
  v = samplerValues(buildHiresWorkflow('x', {}));
  assert.equal(v.steps, 50, '关闭后自定义步数生效');
  assert.equal(v.cfg, 7.5, '关闭后自定义 CFG 生效');
});

test('D 开关只影响 KSampler 的步数/CFG，denoise 与其它参数不受牵连', () => {
  config.comfyui.hiresTurbo = true;
  config.comfyui.hiresDenoise = 0.35;
  const v = samplerValues(buildHiresWorkflow('x', {}));
  assert.equal(v.denoise, 0.35, '重绘幅度仍是 hiresDenoise（turbo 开关不该改它）');
});

test('E 挂点：路由与配置齐备（设置键/GET/PUT）', async () => {
  const cfg = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.ok(cfg.includes("persistSettingSync('comfy_hires_turbo'"), '开关必须持久化，否则重启丢失');
  assert.ok(cfg.includes('hiresTurbo: true,'), '默认值为 true');
  const route = await readFile(new URL('../src/routes/config.js', import.meta.url), 'utf8');
  assert.ok(route.includes('hiresTurbo: config.comfyui.hiresTurbo !== false,'), 'GET 要回传开关');
  // 2026-10-01 并入上游 v3.6.2 的进阶版后，PUT /hires 的解构参数表变长了（多了
  // samplingMode / globalLoraScale / sourceBlend / upscaleModel / workflowMode），
  // 所以这里不再写死「artist, turboMode」的相邻字面量，改成按语义断言：
  // 一边必须**从 req.body 解构出 turboMode**，一边必须**把它透传下去**（两处都断，比原来更严）。
  assert.ok(/const \{[^}]*\bturboMode\b[^}]*\} = req\.body/.test(route), 'PUT 要接收 turboMode');
  assert.ok(/updateHiresSettings\(\{[^}]*\bturboMode\b[^}]*\}\)/.test(route), 'PUT 要把 turboMode 透传给 updateHiresSettings');
  const settings = await readFile(new URL('../src/db/settings.js', import.meta.url), 'utf8');
  assert.ok(settings.includes("comfy_hires_turbo:"), '设置键必须登记进 SETTING_TO_CONFIG（否则重启丢值）');

  // ── 同一批：工作流模式自动探测「双向一致」（③）──
  assert.ok(cfg.includes("if (getSetting('workflow_mode_source') === 'manual')"), '手动选过模式就不得被自动探测覆盖');
  assert.ok(cfg.includes("persistSettingSync('workflow_mode_source', 'manual')"), 'PUT /workflow-mode 必须标记为手动来源');
  // 有 turbo 时必须**纠正并持久化**，而不是只打日志（旧实现就是只打日志 → 装机后一直跑 base 18s/张）
  assert.ok(/if \(hasTurbo\) \{[\s\S]{0,400}persistSettingSync\('workflow_mode', 'turbo'\)/.test(cfg),
    '有 turbo 却停在 base 时必须写回 turbo');
  assert.ok(settings.includes('workflow_mode_source:'), '来源标记要登记进 SETTING_TO_CONFIG（否则重启丢）');
});
