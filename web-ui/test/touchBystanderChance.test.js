/**
 * 设置页 · 群聊围观插话概率（task-22）
 *
 * 契约（Lead）：features.touchBystanderChance —— 数字 0~1 = 开启；'' / null / false = 关闭。
 * 写入走既有通用 PUT /api/config/features { key:'touchBystanderChance', value }：
 *   数字由后端 0~1 夹取；'off' / null = 关闭；非数字回落 0.3（agent-core/src/config.js:549-556）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { reactive, ref } from 'vue'

const file = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const descriptor = parseSfc(file).descriptor
const script = descriptor.scriptSetup.content
const template = descriptor.template.content
const nodes = parseJs(script, { sourceType: 'module' }).program.body

function declarationOf(name) {
  return nodes.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
    .find(d => d.id && d.id.name === name)
}
function fnSource(name) {
  const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
  assert.ok(node, name + ' 应存在')
  return script.slice(node.start, node.end)
}
function makeRunner(name, state) {
  return new Function('state', 'with (state) { ' + fnSource(name) + ' return ' + name + ' }')(state)
}

const DEFAULT_PERCENT = declarationOf('BYSTANDER_DEFAULT_PERCENT').init.value

// ── 1. 模板：Linshe 组件 + 开关联动滑块 ──

test('围观插话：开关用 LinsheSwitch、概率用 LinsheSlider（不自造皮肤）', () => {
  const compiled = compileTemplate({ source: template, filename: 'SettingsView.vue', id: 'settings-view' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(template.includes('v-model="bystanderEnabled"'), '开关绑本地状态')
  assert.ok(template.includes('@change="saveBystanderEnabled"'))
  assert.ok(template.includes('<linshe-slider'), '概率用现成的 LinsheSlider')
  assert.ok(template.includes('v-model="bystanderPercent"'))
  assert.ok(template.includes(':min="0"') && template.includes(':max="100"'), '0~100%')
  assert.ok(template.includes('@change="saveBystanderChance"'), '松手才保存')
  assert.ok(template.includes('{{ bystanderPercent }}%'), '要有百分比读数')
  assert.ok(template.includes('v-if="bystanderEnabled"'), '关闭时收起滑块')
  // 注意：SettingsView 别处还有历史遗留的裸 range（.freq-control 那几处），所以只对本小节断言
  const rowStart = template.indexOf('class="bystander-row"')
  const row = rowStart >= 0 ? template.slice(rowStart, rowStart + 700) : ''
  assert.ok(row.includes('<linshe-slider'), '本小节要用现成的 LinsheSlider')
  assert.equal(row.includes('type="range"'), false, '本小节禁止自造滑块皮肤')
  assert.doesNotMatch(template, /type="checkbox"/, '禁止裸开关')
  assert.ok(script.includes('touchBystanderChance: 0.3'), '本地默认与后端一致')
})

// ── 2. 百分比归一化 ──

test('chanceToPercent：0~1 → 整数百分比，非法 / 关闭回落默认 30', () => {
  const fn = makeRunner('chanceToPercent', { BYSTANDER_DEFAULT_PERCENT: DEFAULT_PERCENT })
  assert.equal(DEFAULT_PERCENT, 30, '默认 30%')
  assert.equal(fn(0.3), 30)
  assert.equal(fn(0), 0)
  assert.equal(fn(1), 100)
  assert.equal(fn(0.7), 70)
  assert.equal(fn(1.5), 100, '越界夹取')
  assert.equal(fn(-1), 0)
  assert.equal(fn(''), DEFAULT_PERCENT)
  assert.equal(fn(null), DEFAULT_PERCENT)
  assert.equal(fn(false), DEFAULT_PERCENT)
  assert.equal(fn('abc'), DEFAULT_PERCENT)
  assert.equal(fn(undefined), DEFAULT_PERCENT)
})

// ── 3. 保存行为 ──

function buildSaver(impl) {
  const toasts = []
  const puts = []
  const features = reactive({ touchBystanderChance: 0.3 })
  const state = {
    features,
    bystanderEnabled: ref(true),
    bystanderPercent: ref(30),
    toastFn: (msg, type) => toasts.push({ msg, type }),
    updateFeatureFlag: (key, value) => { puts.push([key, value]); return impl() },
    BYSTANDER_DEFAULT_PERCENT: DEFAULT_PERCENT,
  }
  state.chanceToPercent = makeRunner('chanceToPercent', state)
  state.clampPercent = makeRunner('clampPercent', state)
  return {
    enable: makeRunner('saveBystanderEnabled', state),
    chance: makeRunner('saveBystanderChance', state),
    features, state, toasts, puts,
  }
}

test('开启：发送当前百分比（0~1）；关闭：发送 off', async () => {
  const on = buildSaver(() => Promise.resolve({}))
  on.state.bystanderPercent.value = 70
  await on.enable(true)
  assert.deepEqual(on.puts, [['touchBystanderChance', 0.7]])
  assert.equal(on.features.touchBystanderChance, 0.7)
  assert.equal(on.toasts[0].type, 'success')
  assert.ok(on.toasts[0].msg.includes('70%'))

  const off = buildSaver(() => Promise.resolve({}))
  await off.enable(false)
  assert.deepEqual(off.puts, [['touchBystanderChance', 'off']], '关闭语义用 off 表达')
  assert.equal(off.features.touchBystanderChance, 'off')
  assert.ok(off.toasts[0].msg.includes('关闭'))
})

test('拖滑块：保存 0~1；**关闭状态下不发送概率**；同值不重复 PUT', async () => {
  const s = buildSaver(() => Promise.resolve({}))
  await s.chance(45)
  assert.deepEqual(s.puts, [['touchBystanderChance', 0.45]])
  assert.equal(s.features.touchBystanderChance, 0.45)

  // 同值不重复发
  s.puts.length = 0
  await s.chance(45)
  assert.equal(s.puts.length, 0, '同一个百分比不该重复 PUT')

  // 关闭后拖滑块 → 一个包都不发
  const closed = buildSaver(() => Promise.resolve({}))
  closed.state.bystanderEnabled.value = false
  await closed.chance(80)
  assert.equal(closed.puts.length, 0, '关闭状态不得发送概率')
})

test('拖滑块：非法 / 越界值归一后再发', async () => {
  const clampHigh = buildSaver(() => Promise.resolve({}))
  await clampHigh.chance(999)
  assert.deepEqual(clampHigh.puts, [['touchBystanderChance', 1]], '越界夹到 100%')

  // 非数字回落默认 30%：基线故意先设成别的值，否则会命中「同值不发」的短路
  const bad = buildSaver(() => Promise.resolve({}))
  bad.features.touchBystanderChance = 0.7
  await bad.chance('abc')
  assert.deepEqual(bad.puts, [['touchBystanderChance', 0.3]], '非数字回落默认 30%')

  const low = buildSaver(() => Promise.resolve({}))
  await low.chance(-5)
  assert.equal(low.puts[0][1], 0, '负数夹到 0')
})

test('保存失败：开关与概率都回滚', async () => {
  const onFail = buildSaver(() => Promise.reject(new Error('后端炸了')))
  onFail.state.bystanderPercent.value = 60
  await onFail.enable(true)
  assert.equal(onFail.features.touchBystanderChance, 0.3, '开启失败要回滚原值')
  assert.equal(onFail.toasts[0].type, 'error')
  assert.ok(onFail.toasts[0].msg.includes('后端炸了'))

  const sliderFail = buildSaver(() => Promise.reject(new Error('网络断了')))
  await sliderFail.chance(90)
  assert.equal(sliderFail.features.touchBystanderChance, 0.3, '滑块保存失败也要回滚')
  assert.equal(sliderFail.toasts[0].type, 'error')
})
