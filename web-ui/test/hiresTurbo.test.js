/**
 * 设置页 · HiresFix「细化用 turbo 参数」开关（前端接线与行为）
 *
 * 真机背景：放大细化工作流的主模型是 turbo 蒸馏模型，软件却长期注入 CFG 5 / 35 步；
 * CFG>1 会让 turbo 每步多跑一条无条件分支（双倍算力）且画质退化。
 *
 * 契约（后端已落地，见 agent-core/src/routes/config.js 与 imageRefine.js）：
 *   - 设置键 config.comfyui.hiresTurbo（boolean，默认 true）→ GET /api/config 的 comfy.hiresTurbo
 *   - PUT /api/config/hires 收 { turboMode }，响应回 hiresTurbo
 *   - 打开 = 细化强制 CFG 1.0 / 12 步（忽略 hiresSteps/hiresCfg）；关闭 = 沿用那两个值；即时生效
 *
 * 本文件测：模板接线（必须用 LinsheSwitch，不许裸 checkbox）、默认值与加载兜底、
 * 摘要显示的生效参数、开关成功 / 失败回滚，以及 api/index.js 的真实请求形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { ref } from 'vue'

import { updateHiresSettings } from '../src/api/index.js'

const settings = parseSfc(readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')).descriptor
const settingsScript = settings.scriptSetup.content
const settingsTemplate = settings.template.content
const settingsNodes = parseJs(settingsScript, { sourceType: 'module' }).program.body

const modal = parseSfc(readFileSync(new URL('../src/components/HiresFixModal.vue', import.meta.url), 'utf8')).descriptor
const modalScript = modal.scriptSetup.content
const modalTemplate = modal.template.content

function allDeclarations(nodes) {
  return nodes.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
}
function declarationOf(name) {
  return allDeclarations(settingsNodes).find(d => d.id && d.id.name === name)
}
function literalOf(name) {
  const d = declarationOf(name)
  return d && d.init ? d.init.value : undefined
}
// 把 SFC 里某个计算属性源码取出来，喂给假 state 执行（沿用 townServiceManagerScope.test.js 的写法）
function evaluateComputed(name, state) {
  const node = declarationOf(name)
  assert.ok(node, name + ' 应存在')
  const arrow = node.init.arguments[0]
  const run = new Function('state', 'with (state) { return (' + settingsScript.slice(arrow.start, arrow.end) + ') }')
  return run(state)
}

test('设置页 HiresFix 区块用 LinsheSwitch 接入 turbo 开关', () => {
  const compiled = compileTemplate({ source: settingsTemplate, filename: 'SettingsView.vue', id: 'settings-view' })
  assert.deepEqual(compiled.errors, [])
  assert.match(settingsTemplate, /<linshe-switch[^>]*v-model="hiresTurbo"/, '必须用 LinsheSwitch 且绑到 hiresTurbo')
  assert.match(settingsTemplate, /v-model="hiresTurbo"[\s\S]{0,240}?@change="onHiresTurboToggle"/, '切换后要立即保存')
  assert.match(settingsTemplate, /hiresfix-turbo-row/, '开关要落在 HiresFix 区块内')
  assert.doesNotMatch(settingsTemplate, /type="checkbox"/, '不许裸 checkbox 冒充开关')
})

test('hiresTurbo 默认 true，加载时用 ?? true 兜底（与后端默认一致）', () => {
  const d = declarationOf('hiresTurbo')
  assert.ok(d, 'hiresTurbo ref 应存在')
  assert.equal(d.init.callee.name, 'ref')
  assert.equal(d.init.arguments[0].value, true, '后端默认 true，前端必须一致')
  assert.match(settingsScript, /hiresTurbo\.value = data\.comfy\.hiresTurbo \?\? true/)
})

test('turbo 参数常量与后端默认一致（CFG 1.0 / 12 步）', () => {
  assert.equal(literalOf('HIRES_TURBO_STEPS'), 12)
  assert.equal(literalOf('HIRES_TURBO_CFG'), 1.0)
})

test('细化摘要显示实际生效参数：开 turbo 走 12 步 / CFG 1.0，关掉沿用输入值', () => {
  // 2026-10-01 并入上游 v3.6.2 进阶版后，hiresSummary 还要读工作流模式与采样来源两个 ref，
  // 假 state 必须把它们一起喂进来（否则 ReferenceError），否则这条用例断不到真正的文案。
  const state = {
    hiresTurbo: ref(true),
    hiresSteps: ref(35),
    hiresCfg: ref(5),
    hiresDenoise: ref(0.35),
    hiresMaxSize: ref(2000),
    hiresLoraCount: ref(0),
    hiresWorkflowMode: ref('basic'),
    hiresSamplingMode: ref('source'),
    HIRES_TURBO_STEPS: literalOf('HIRES_TURBO_STEPS'),
    HIRES_TURBO_CFG: literalOf('HIRES_TURBO_CFG'),
  }
  const summary = evaluateComputed('hiresSummary', state)
  assert.equal(summary(), '最长边 2000 · 12 步 · 重绘 0.35 · CFG 1.0 · turbo')
  state.hiresTurbo.value = false
  assert.equal(summary(), '最长边 2000 · 35 步 · 重绘 0.35 · CFG 5')
  state.hiresTurbo.value = true
  state.hiresLoraCount.value = 2
  assert.ok(summary().includes('LoRA 2'))
  // 进阶版（2026-10-01 新增）：带版本前缀；
  // 「跟随原图」与「步数/CFG」是互斥说法，不许并排 —— turbo 开时只跟随采样器/调度器（说准），
  // turbo 关时整段跟随源工作流（此时不显示步数/CFG）。
  state.hiresWorkflowMode.value = 'advanced'
  assert.equal(summary(), '进阶版 · 最长边 2000 · 12 步 · 重绘 0.35 · CFG 1.0 · LoRA 2 · turbo · 采样器跟随原图')
  state.hiresTurbo.value = false
  assert.equal(summary(), '进阶版 · 最长边 2000 · 采样跟随原图 · 重绘 0.35 · LoRA 2')
  state.hiresTurbo.value = true
  state.hiresSamplingMode.value = 'custom'
  assert.equal(summary(), '进阶版 · 最长边 2000 · 12 步 · 重绘 0.35 · CFG 1.0 · LoRA 2 · turbo')
})

test('切换开关：成功即时保存并提示，失败回滚开关并报错', async () => {
  const node = settingsNodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'onHiresTurboToggle')
  assert.ok(node, 'onHiresTurboToggle 应存在')
  const src = settingsScript.slice(node.start, node.end)

  function build(requestImpl) {
    const calls = []
    const toasts = []
    const state = {
      hiresTurbo: ref(false),
      updateHiresSettings: (payload) => { calls.push(payload); return requestImpl() },
      toastFn: (msg, type) => toasts.push({ msg, type }),
      HIRES_TURBO_STEPS: literalOf('HIRES_TURBO_STEPS'),
      HIRES_TURBO_CFG: literalOf('HIRES_TURBO_CFG'),
    }
    const factory = new Function('state', 'with (state) { ' + src + ' return onHiresTurboToggle }')
    return { run: factory(state), state, calls, toasts }
  }

  const ok = build(() => Promise.resolve({ ok: true, hiresTurbo: true }))
  await ok.run(true)
  assert.deepEqual(ok.calls, [{ turboMode: true }], '只传 turboMode，不夹带其它字段')
  assert.equal(ok.state.hiresTurbo.value, true)
  assert.equal(ok.toasts.length, 1)
  assert.equal(ok.toasts[0].type, 'success')
  assert.ok(ok.toasts[0].msg.includes('12 步'))

  // 失败：用户从「开」拨到「关」（v-model 已先把本地值改成 false），保存失败必须回滚回 true
  const bad = build(() => Promise.reject(new Error('后端炸了')))
  bad.state.hiresTurbo.value = true
  await bad.run(false)
  assert.deepEqual(bad.calls, [{ turboMode: false }])
  assert.equal(bad.state.hiresTurbo.value, true, '失败必须回滚本地开关')
  assert.equal(bad.toasts[0].type, 'error')
  assert.ok(bad.toasts[0].msg.includes('后端炸了'))
})

async function capturePut(payload) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, json: async () => ({ ok: true, hiresTurbo: true }) }
  }
  try {
    await updateHiresSettings(payload)
  } finally {
    globalThis.fetch = original
  }
  return calls
}

test('PUT /api/config/hires：单独传 turboMode 时 body 只含 turboMode', async () => {
  const calls = await capturePut({ turboMode: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/config/hires')
  assert.equal(calls[0].opts.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { turboMode: false })
})

test('PUT /api/config/hires：弹窗整包保存仍带上 turboMode 与原字段', async () => {
  const calls = await capturePut({ loras: [], steps: 35, cfg: 5, denoise: 0.35, maxSize: 2000, artistMode: 'empty', artist: '', turboMode: true })
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.turboMode, true)
  assert.equal(body.steps, 35)
  assert.equal(body.cfg, 5)
  assert.equal(body.maxSize, 2000)
})

test('弹窗里也有同一开关，并参与弹窗自己的「保存」', () => {
  const compiled = compileTemplate({ source: modalTemplate, filename: 'HiresFixModal.vue', id: 'hires-fix-modal' })
  assert.deepEqual(compiled.errors, [])
  assert.match(modalTemplate, /<linshe-switch[^>]*v-model="turbo"/)
  assert.match(modalTemplate, /class="hires-turbo-notice"[^>]*>[^<]*暂不生效/, 'turbo 打开时要有「步数/CFG 暂不生效」的提示')
  assert.match(modalScript, /initialTurbo:\s*\{[\s\S]{0,80}?type:\s*Boolean[\s\S]{0,40}?default:\s*true/, 'props 默认必须为 true')
  assert.match(modalScript, /updateHiresSettings\(\{[\s\S]{0,400}?turboMode:\s*turbo\.value/)
  assert.match(modalScript, /emit\('saved',\s*\{[\s\S]{0,400}?turbo:\s*turbo\.value/)
  assert.doesNotMatch(modalTemplate, /type="checkbox"/)
})

test('设置页把 turbo 状态传给弹窗，弹窗保存后回写', () => {
  assert.match(settingsTemplate, /<HiresFixModal[^>]*:initial-turbo="hiresTurbo"/)
  assert.match(settingsScript, /if \(turbo !== undefined\) hiresTurbo\.value = turbo/)
})
