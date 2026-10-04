/**
 * 设置页 · B1 阶段二「重复时自动加强约束」开关（task-20 附带）
 *
 * 契约：features.antiRepetitionEscalation（默认开），走既有通用 PUT /api/config/features。
 * 口径（Lead 2026-09-30）：专题 L4 的「重写兜底」antiRepetitionReroll **本轮不接线**
 * （键已预留、默认关、打开暂无效果），所以**故意不给 UI 入口**——本文件把这条也钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

const file = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const descriptor = parseSfc(file).descriptor
const script = descriptor.scriptSetup.content
const template = descriptor.template.content
// 重写兜底的替换语义落在 store 里（D2）：读源码断言
const storeScript = readFileSync(new URL('../src/stores/chat.js', import.meta.url), 'utf8')

test('「重复时自动加强约束」开关：LinsheSwitch 绑定 + 默认开 + 走通用 features PUT', () => {
  assert.ok(template.includes('v-model="features.antiRepetitionEscalation"'), '要绑到 features.antiRepetitionEscalation')
  assert.ok(template.includes("@change=\"saveAntiRepFeature('antiRepetitionEscalation', features.antiRepetitionEscalation)\""),
    '改动走既有 saveAntiRepFeature')
  assert.ok(script.includes('antiRepetitionEscalation: true'), '本地默认与后端一致（默认开）')
  assert.ok(script.includes('antiRepetitionEscalation: \'重复时自动加强约束\''), '注册中文名，供保存 toast 复用')
  // 用 LinsheSwitch，不许裸 checkbox
  assert.doesNotMatch(template, /type="checkbox"/)
})

test('文案与口径：讲清升级/回落；「重写兜底」D2 起正式接线（默认关）且写明代价', () => {
  assert.ok(template.includes('重复时自动加强约束'), '标题')
  assert.ok(template.includes('连续 3 轮'), '说明要写清触发条件')
  assert.ok(template.includes('立刻回落'), '说明要写清回落')
  // D2：antiRepetitionReroll 从「键已预留、不接线」变成正式开关（默认关）⇒ 旧断言反过来了
  assert.ok(template.includes('features.antiRepetitionReroll'), '要有绑定')
  assert.ok(template.includes("saveAntiRepFeature('antiRepetitionReroll'"), '要有保存入口')
  assert.ok(script.includes('antiRepetitionReroll: false'), '本地默认与后端一致（默认关）')
  assert.ok(script.includes("antiRepetitionReroll: '重写这一轮'"), '注册中文名，供保存 toast 复用')
  // 说明必须写清代价：多一次模型调用（用户点名要说明）
  const rowAt = template.indexOf('features.antiRepetitionReroll')
  const row = template.slice(Math.max(0, rowAt - 800), rowAt + 200)
  assert.ok(/多消耗一次模型调用|多一次模型调用|多烧一次/.test(row), '说明要写清「会多消耗一次模型调用」')
  assert.ok(/默认关闭|默认关/.test(row), '说明要写清默认关')
})

test('重写兜底：store 认「替换」事件，走的是替换语义（不追加、清掉多余气泡）', () => {
  // 形状由 b1-antirep 定、尚未落地 ⇒ 先按约定事件名写并在源码里标注（见 stores/chat.js 注释）
  // 只看**代码**（第一版用 includes 被注释里的同名字符串满足了 ⇒ 假绿）
  // 事件名已按 docs/anti-repetition.md §12.4 冻结为 replace_last_assistant
  assert.ok(/lastEvent === 'replace_last_assistant'/.test(storeScript), '要在事件分支里判冻结后的事件名')
  assert.ok(storeScript.includes('applyAssistantReplace'), '要复用一个可单测的替换函数（utils/assistantReplace.js）')
  // 替换路径的实质：复用既有气泡 → 多出来的删掉 ⇒ 不重复、不残留旧文本
  assert.ok(storeScript.includes('messages.value.filter(x => x.id !== bubbleIds[i])'), '多出来的气泡要被删掉（旧文本不残留）')
  assert.ok(storeScript.includes('bubbleIds.length = parts.length'), '气泡 id 列表要跟着收敛（不重复）')
})

test('模板可编译', () => {
  const compiled = compileTemplate({ source: template, filename: 'SettingsView.vue', id: 'settings-view' })
  assert.deepEqual(compiled.errors, [])
})
