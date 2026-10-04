/**
 * 性爱交互「可点击推进」· 面板与接线守卫（task-1）
 *
 * 覆盖 `web-ui/src/components/IntimateActionPanel.vue` 与 `web-ui/src/api/index.js` 的追加函数：
 *   · 面板能编译（模板无语法错）、自包含（Teleport + 受控 open + 自己的取数/上报）；
 *   · **不写裸控件**（按钮 / 输入 / 选择一律 Linshe 组件）——源码扫描前先剥注释（本仓踩过三次）；
 *   · 0.3s 过渡：面板开合、累积度条宽度、提示行切换；
 *   · 交互契约：体位 = chip（`:active`）、节奏 = LinsheTabs、动作 = LinsheButton（`:disabled` / `loading`）；
 *   · 只在服务端放行时 emit('reaction')（不伪造反应，反应由后端广播进消息流）；
 *   · api 层两个函数存在且路径正确（Lead 挂载后前端就能真连）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate, compileScript } from '@vue/compiler-sfc'

const panelUrl = new URL('../src/components/IntimateActionPanel.vue', import.meta.url)
assert.ok(existsSync(panelUrl), 'IntimateActionPanel.vue 应存在（task-1 的核心交付）')

const panelFile = readFileSync(panelUrl, 'utf8')
const panel = parseSfc(panelFile).descriptor
const panelTemplate = panel.template.content
const panelScript = panel.scriptSetup.content
const panelStyle = panelFile.slice(panelFile.indexOf('<style'))

/** 剥 HTML 注释（源码扫描型断言必须先剥注释再断言） */
function stripHtmlComments(source) {
  return String(source).replace(/<!--[\s\S]*?-->/g, '')
}
/** 剥 JS 注释 */
function stripJsComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const cleanTemplate = stripHtmlComments(panelTemplate)
const cleanScript = stripJsComments(panelScript)
const cleanStyle = panelStyle.replace(/\/\*[\s\S]*?\*\//g, '')

const apiFile = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
const cleanApi = stripJsComments(apiFile)

// ── 1. 编译与自包含 ──

test('面板能编译：模板无错、是单文件组件且有 script setup / scoped style', () => {
  const compiled = compileTemplate({ source: panelTemplate, filename: 'IntimateActionPanel.vue', id: 'ia' })
  assert.deepEqual(compiled.errors, [])
  // <script setup> 也要真过一遍编译器（语法错 / 重复声明在这里就会炸，不是等浏览器白屏）
  const script = compileScript(panel, { id: 'ia' })
  assert.ok(script.content.includes('export default'), 'script setup 必须能编译成组件模块')
  assert.ok(panel.scriptSetup, '必须用 <script setup>')
  assert.ok(panel.styles.length > 0, '必须有样式块')
  assert.ok(panel.styles.every(s => s.scoped), '样式必须 scoped（不污染全局）')
})

test('面板自包含：Teleport 到 body + 受控 open + 自己取数上报 + 不插消息', () => {
  assert.ok(cleanTemplate.includes('<Teleport to="body">'), '浮动面板要 Teleport 到 body')
  assert.ok(cleanTemplate.includes('v-if="open"'), '显隐由父组件的 open 受控')
  assert.ok(cleanTemplate.includes('role="dialog"'), '要有 dialog 语义')
  assert.ok(cleanScript.includes("import { fetchIntimateActionState, postIntimateAction } from '../api/index.js'"),
    '面板自己走 api 层取数与上报（自包含，父组件不必代劳）')
  assert.ok(cleanScript.includes('defineProps'), '要有明确的 props 契约')
  assert.ok(cleanScript.includes('defineEmits'), '要有明确的 emits 契约')
  assert.ok(cleanScript.includes("'close'") && cleanScript.includes("'reaction'"), 'emit 至少要有 close / reaction')
  assert.ok(cleanScript.includes('defineExpose'), '要 expose refresh() 给父组件')
  // 不伪造反应：只有服务端放行才 emit reaction
  assert.ok(cleanScript.includes("if (result.allowed) emit('reaction'"), '只在放行时上报 reaction')
})

test('门控拒绝必须 toast 服务端那句人话（不许静默），reaction:null 也要有一行已推进', () => {
  // 被拒：toast + 面板内提示都用服务端 message
  assert.ok(cleanScript.includes("if (!result.allowed && result.message) toast?.(result.message, 'info')"),
    '被拒要把服务端 message 直接 toast（Lead 裁决）')
  assert.ok(cleanScript.includes('setFeedback(actionFeedbackText(payload), !result.allowed)'),
    '面板内也要显示同一句（toast 会消失，面板留着）')
  // 反馈行由纯逻辑给文案（reaction:null 时是「已推进…」而不是空白）
  assert.ok(cleanScript.includes('actionFeedbackText'), '文案必须走纯逻辑（可单测）')
  assert.ok(cleanTemplate.includes('v-if="feedback"'), '有反馈就要渲染出来')
  assert.ok(cleanTemplate.includes('class="ia-feedback"'), '反馈行有独立样式位')
  // 读不到状态 / 上报失败也要有提示，不留白屏
  assert.ok(cleanScript.includes("setFeedback(err?.message || '读取状态失败', true)"), '读状态失败要给提示')
  assert.ok(cleanScript.includes("setFeedback(err?.message || '推进失败', true)"), '上报失败要给提示')
  // 功能关闭时面板要说明，而不是一串点不动的按钮
  assert.ok(cleanTemplate.includes('「性爱推进」功能当前已关闭。'), '功能关闭要有说明行')
})

test('面板 props / emits 契约（Lead 挂 ChatView 按这个接）', () => {
  const propsBlock = /defineProps\(\{([\s\S]*?)\}\)/.exec(cleanScript)?.[1] || ''
  assert.match(propsBlock, /open:\s*\{\s*type:\s*Boolean/, 'open 是布尔受控显隐')
  assert.match(propsBlock, /characterId:\s*\{\s*type:\s*\[Number,\s*String\]/, 'characterId 必填角色 id')
  const emitsBlock = /defineEmits\(\[([\s\S]*?)\]\)/.exec(cleanScript)?.[1] || ''
  for (const name of ['close', 'reaction', 'state']) {
    assert.ok(emitsBlock.includes(`'${name}'`), 'emits 契约要含 ' + name)
  }
})

// ── 2. 统一组件（剥注释后断言，别被自己的注释绊倒） ──

test('不写裸控件：button / input / select / textarea 一律走 Linshe 组件', () => {
  assert.ok(!/<\s*button[\s>]/.test(cleanTemplate), '禁止裸 <button>')
  assert.ok(!/<\s*input[\s>]/.test(cleanTemplate), '禁止裸 <input>')
  assert.ok(!/<\s*select[\s>]/.test(cleanTemplate), '禁止裸 <select>')
  assert.ok(!/<\s*textarea[\s>]/.test(cleanTemplate), '禁止裸 <textarea>')
  assert.ok(cleanScript.includes("import LinsheButton from './ui/LinsheButton.vue'"), '必须用 LinsheButton')
  assert.ok(cleanScript.includes("import LinsheTabs from './ui/LinsheTabs.vue'"), '节奏分段必须用 LinsheTabs')
  assert.ok(cleanTemplate.includes('<linshe-button'), '模板里用 linshe-button')
  assert.ok(cleanTemplate.includes('<linshe-tabs'), '模板里用 linshe-tabs')
  // 不自己画遮罩 / 不自造模态皮肤
  assert.ok(!/class="[^"]*(modal|overlay|mask)[^"]*"/.test(cleanTemplate), '不新造遮罩 / 模态皮肤')
})

test('交互契约：体位 = chip（:active）、节奏 = LinsheTabs（档位显示）、动作 = LinsheButton（:disabled + loading）', () => {
  // 体位胶囊
  const chips = /<linshe-button[\s\S]*?variant="chip"[\s\S]*?>/.exec(cleanTemplate)
  assert.ok(chips, '体位要用 chip 变体')
  assert.ok(cleanTemplate.includes(':active="item.key === view.positionKey"'), '当前体位要 :active 高亮')
  assert.ok(cleanTemplate.includes('@click="changePosition(item)"'), '点体位＝换过去（立刻一轮反应）')
  // 节奏分段（只作状态显示：切换由「加速 / 慢下来」两个动作推进）
  assert.ok(/:model-value="view.pace"/.test(cleanTemplate), '节奏分段绑定服务端 pace')
  assert.ok(/:options="paces"/.test(cleanTemplate), '分段选项来自纯逻辑')
  // 动作按钮
  assert.ok(cleanTemplate.includes(':disabled="!action.available || busy || loading || !enabled"'), '不可用 / 忙 / 读取中 / 功能关闭都要禁用')
  assert.ok(cleanTemplate.includes(':loading="busy && busyKey === action.key"'), '上报中要 loading')
  // 2026-10-02 改：置灰理由的 title 由内联三元改成 hintFor(action)（开关回显要能换 title）
  // —— 老契约的**行为**必须保住：未生效时仍回落 `action.available ? action.hint : action.reason`。
  assert.ok(cleanTemplate.includes(':title="hintFor(action)"'), '置灰要给人话理由（现走 hintFor）')
  assert.ok(/const hintFor = \(action\)[\s\S]{0,260}?action\.available \? action\.hint : action\.reason/.test(panelFile),
    'hintFor 未生效时必须回落 `action.available ? action.hint : action.reason`（别把置灰理由弄丢）')

  // 状态 HUD：她的好感（决定配合 / 抗拒）也要看得见
  assert.ok(cleanTemplate.includes('好感 {{ her.affinity ?? 0 }}'), 'HUD 要显示好感度')
  // 累积度 + 状态 HUD
  assert.ok(cleanTemplate.includes('累积 {{ view.accumulation }}/100'), '累积度要直白显示')
  assert.ok(cleanTemplate.includes(':style="{ width: progressPercent(view) + \'%\' }"'), '累积度条宽度绑纯逻辑')
})

// ── 3. 0.3s 过渡 ──

test('0.3s 过渡：面板开合 / 累积度条 / 提示行，一处都不许硬跳', () => {
  assert.ok(cleanTemplate.includes('<Transition name="ia-panel">'), '面板要 Transition')
  assert.ok(cleanTemplate.includes('<Transition name="ia-fade">'), '提示行要 Transition')
  assert.ok(cleanStyle.includes('.ia-panel-enter-active'), '面板过渡类名要对上')
  assert.ok(cleanStyle.includes('.ia-fade-enter-active'), '提示过渡类名要对上')
  assert.match(cleanStyle, /\.ia-panel-enter-active,[\s\S]*?transition:[^;]*0\.3s/, '面板开合 0.3s')
  assert.match(cleanStyle, /\.ia-bar-fill[\s\S]*?transition:[^;]*0\.3s/, '累积度条宽度 0.3s')
  assert.match(cleanStyle, /\.ia-fade-enter-active,[\s\S]*?transition:[^;]*0\.3s/, '提示行切换 0.3s')
  assert.ok(!/transition:[^;]*0\.(?!3s)/.test(cleanStyle), '过渡时长只允许 0.3s')
})

test('双主题：色值一律走 token，不写死背景 / 文字色', () => {
  assert.ok(cleanStyle.includes('var(--bg-secondary)'))
  assert.ok(cleanStyle.includes('var(--border)'))
  assert.ok(cleanStyle.includes('var(--accent)'))
  assert.ok(cleanStyle.includes('var(--text-secondary)'))
})

// ── 4. api 层接线 ──

test('api/index.js 追加了两个函数，路径与后端挂载一致且不改别人已有的函数', () => {
  assert.ok(cleanApi.includes('export function fetchIntimateActionState(characterId'), '缺 fetchIntimateActionState')
  assert.ok(cleanApi.includes('export function postIntimateAction(characterId, actionKey'), '缺 postIntimateAction')
  // 2026-10-02：GET 多拼了一段场景 query（?scene=group&groupId=），路径主体不变
  assert.match(cleanApi, /request\(`\/intimate-actions\/\$\{encodeURIComponent\(characterId\)\}\/state\$\{query\}`/,
    'GET 路径必须是 /intimate-actions/:id/state（末尾拼场景 query）')
  assert.match(cleanApi, /const query = scene === 'group' && groupId \? `\?scene=group&groupId=/,
    '群聊场景要把 groupId 拼进 query（否则她的反应会落到私聊）')
  assert.match(cleanApi, /request\(`\/intimate-actions\/\$\{encodeURIComponent\(characterId\)\}\/\$\{encodeURIComponent\(actionKey\)\}`/,
    'POST 路径必须是 /intimate-actions/:id/:action')
  assert.ok(cleanApi.includes("method: 'POST'"), '推进要走 POST')
  // 原有的函数不能被碰：抽查两个老函数还在
  assert.ok(cleanApi.includes('export function listItems()'), '不许覆盖别人已有的函数')
  assert.ok(cleanApi.includes('export async function getTimePerception('), '不许覆盖别人已有的函数（时间感知）')
})
