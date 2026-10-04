/**
 * D1 · 设置页「细化精度」三档（用户裁决：精度可选高中低，说明要短，默认 8 步）
 *
 * 契约（Lead 定死）：键 features.hiresQuality，取值 high|medium|low，**默认 low**；
 * 映射：高 = 12 步 / 中 = 10 步 / 低 = 8 步（都走现有 turbo 参数 CFG 1.0）；走通用 PUT /api/config/features。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { reactive } from 'vue'

const file = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const d = parseSfc(file).descriptor
const script = d.scriptSetup.content
const template = d.template.content
const nodes = parseJs(script, { sourceType: 'module' }).program.body

function declarationOf(name) {
  return nodes.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
    .find(x => x.id && x.id.name === name)
}
function fnSource(name) {
  const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
  assert.ok(node, name + ' 应存在')
  return script.slice(node.start, node.end)
}

test('三档常量：high/medium/low，文案 高/中/低，默认 low（=8 步）', () => {
  const modes = declarationOf('HIRES_QUALITY_MODES').init
  const pairs = modes.elements.map(e => [e.properties[0].value.value, e.properties[1].value.value])
  assert.deepEqual(pairs, [['high', '高'], ['medium', '中'], ['low', '低']])
  assert.equal(declarationOf('DEFAULT_HIRES_QUALITY').init.value, 'low', '默认是 low（8 步）')
})

test('normalizeHiresQuality：非法 / 缺失一律回落 low', () => {
  const fn = new Function('state', 'with (state) { ' + fnSource('normalizeHiresQuality') + '; return normalizeHiresQuality }')({
    HIRES_QUALITY_MODES: declarationOf('HIRES_QUALITY_MODES').init.elements.map(e => ({ value: e.properties[0].value.value })),
    DEFAULT_HIRES_QUALITY: 'low',
  })
  assert.equal(fn('high'), 'high')
  assert.equal(fn('medium'), 'medium')
  assert.equal(fn('low'), 'low')
  for (const bad of [undefined, null, '', 'HIGH', 'ultra', 0, {}]) assert.equal(fn(bad), 'low', String(bad) + ' 应回落 low')
})

test('模板：LinsheTabs 三档 + 选项与常量同源 + 展示值归一化', () => {
  const compiled = compileTemplate({ source: template, filename: 'SettingsView.vue', id: 'sv' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(/<linshe-tabs[\s\S]{0,400}HIRES_QUALITY_MODES/.test(template), '要用 LinsheTabs 且选项吃常量')
  assert.ok(template.includes('normalizeHiresQuality(features.hiresQuality)'), '展示值要归一化')
  assert.ok(template.includes('saveHiresQuality'), '改动走保存函数')
  assert.doesNotMatch(template, /role="tablist"/, '不许自造分段控件')
})

test('说明：简短（≤2 行）且必须含三档对应关系与默认值', () => {
  const at = template.indexOf('hiresQuality')
  const block = template.slice(Math.max(0, at - 900), at + 300)
  assert.ok(/12\s*步/.test(block), '要写清「高 12 步」')
  assert.ok(/10\s*步/.test(block), '要写清「中 10 步」')
  assert.ok(/8\s*步/.test(block), '要写清「低 8 步」')
  assert.ok(/默认/.test(block), '要写清默认值')
  // 说明是页面上的文字：不含 markdown 记号、不是超长段落
  const descLine = block.split('\n').find(l => l.includes('12') && l.includes('8'))
  assert.ok(descLine, '三档映射应写在同一句里')
  assert.ok(descLine.length < 220, '说明要短（实测 ' + (descLine || '').length + ' 字符）')
})

test('保存：成功走通用 features PUT；失败回滚；同档不重复 PUT；非法值归一后再发', async () => {
  const src = fnSource('saveHiresQuality')
  function build(impl, initial) {
    const puts = []
    const toasts = []
    const state = {
      features: reactive({ hiresQuality: initial }),
      updateFeatureFlag: (k, v) => { puts.push([k, v]); return impl() },
      toastFn: (m, t) => toasts.push({ m, t }),
      HIRES_QUALITY_MODES: declarationOf('HIRES_QUALITY_MODES').init.elements.map(e => ({ value: e.properties[0].value.value })),
      DEFAULT_HIRES_QUALITY: 'low',
    }
    state.normalizeHiresQuality = new Function('state', 'with (state) { ' + fnSource('normalizeHiresQuality') + '; return normalizeHiresQuality }')(state)
    const labelFn = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'hiresQualityLabel')
    if (labelFn) state.hiresQualityLabel = new Function('state', 'with (state) { ' + script.slice(labelFn.start, labelFn.end) + '; return hiresQualityLabel }')(state)
    return { run: new Function('state', 'with (state) { ' + src + '; return saveHiresQuality }')(state), state, puts, toasts }
  }
  const okHigh = build(() => Promise.resolve({}), 'low')
  await okHigh.run('high')
  assert.deepEqual(okHigh.puts, [['hiresQuality', 'high']])
  assert.equal(okHigh.state.features.hiresQuality, 'high')

  const same = build(() => Promise.resolve({}), 'low')
  await same.run('low')
  assert.equal(same.puts.length, 0, '同档不该发请求')

  const bad = build(() => Promise.reject(new Error('后端炸了')), 'medium')
  await bad.run('high')
  assert.equal(bad.state.features.hiresQuality, 'medium', '失败要回滚上一档')
  assert.equal(bad.toasts[0].t, 'error')

  const illegal = build(() => Promise.resolve({}), 'medium')
  await illegal.run('ultra')
  assert.deepEqual(illegal.puts, [['hiresQuality', 'low']], '非法值归一成 low 再发')
})
