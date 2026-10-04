/**
 * 真机反馈问题 1+2+3（专题-动作交互改版 §七）
 *
 * 问题 1+2：面板全屏遮罩挡住消息流 → ①遮罩收窄成底部区域（不盖消息区、不压暗）+ ③点完动作自动收起
 *          （成功且非隐式 ⇒ 关；被拒 ⇒ 不关，用户要换个动作再试）
 * 问题 3：提示行文案随 mode 变 —— 有 implicit 待回应 ⇒ 「她还没回应你的动作，跟她说句话吧」
 *          🔌 后端字段 pendingByMode:{instant,implicit} 写作时尚未落地，先按该形状写并标注；缺字段回落现有文案
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { ref } from 'vue'

import { pendingHintByMode, pendingHintOf, PENDING_IMPLICIT_HINT } from '../src/components/touchActionLogic.js'

const panelFile = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const panel = parseSfc(panelFile).descriptor
const panelTemplate = panel.template.content
const panelScript = panel.scriptSetup.content
const panelStyle = panelFile.slice(panelFile.indexOf('<style'))

function viewOf(name) {
  const d = parseSfc(readFileSync(new URL('../src/views/' + name, import.meta.url), 'utf8')).descriptor
  return { script: d.scriptSetup.content, template: d.template.content }
}
const chat = viewOf('ChatView.vue')
const group = viewOf('GroupChatView.vue')
const { parse: parseJs } = await import('@babel/parser')
function fnSource(script, name) {
  const nodes = parseJs(script, { sourceType: 'module' }).program.body
  const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
  assert.ok(node, name + ' 应存在')
  return script.slice(node.start, node.end)
}

// ── 问题 1：遮罩不再全屏 ──

test('遮罩收窄成底部区域：不盖消息区、不再全屏压暗', () => {
  assert.ok(/inset:\s*auto\s+0\s+0\s+0/.test(panelStyle), '遮罩要 inset: auto 0 0 0（只占底部）')
  assert.equal(/inset:\s*0\s*;/.test(panelStyle), false, '不能再用 inset: 0 全屏')
  assert.equal(/background:\s*rgba\(\s*0\s*,\s*0\s*,\s*0/.test(panelStyle), false, '去掉全屏压暗底色')
  assert.equal(/backdrop-filter:\s*var\(--modal-backdrop\)/.test(panelStyle), false, '底部条不需要毛玻璃遮罩')
  assert.ok(panelStyle.includes('position: fixed'), '仍是固定定位')
  assert.ok(panelStyle.includes('align-items: flex-end'), '仍然底部对齐')
  assert.ok(panelStyle.includes('.touch-overlay-enter-active'), '0.3s 过渡保留')
})

// ── 问题 3：文案随 mode 变（纯函数） ──

test('pendingHintByMode：有 implicit 待回应给「跟她说句话吧」，否则回落现有文案', () => {
  assert.equal(PENDING_IMPLICIT_HINT, '她还没回应你的动作，跟她说句话吧')
  assert.equal(pendingHintByMode({ count: 2, byMode: { instant: 0, implicit: 2 } }), PENDING_IMPLICIT_HINT)
  assert.equal(pendingHintByMode({ count: 1, byMode: { instant: 0, implicit: 1 } }), PENDING_IMPLICIT_HINT)
  assert.equal(pendingHintByMode({ count: 3, byMode: { instant: 3, implicit: 0 } }), '还有 3 个动作等她回应')
  // 🔌 后端字段没落地 / 缺字段 → 回落现有文案，不许炸
  assert.equal(pendingHintByMode({ count: 3 }), '还有 3 个动作等她回应')
  assert.equal(pendingHintByMode({ count: 3, byMode: null }), '还有 3 个动作等她回应')
  assert.equal(pendingHintByMode({ count: 0, byMode: { implicit: 0 } }), '')
  assert.equal(pendingHintByMode(), '')
  assert.equal(pendingHintOf(2), '还有 2 个动作等她回应', '旧函数保持不变（回归）')
})

test('面板：吃 pendingByMode 并用它出文案；入口角标同源', () => {
  assert.ok(panelScript.includes('pendingByMode'), '要有 pendingByMode prop')
  assert.ok(panelScript.includes('pendingHintByMode'), '文案走 mode 感知的纯函数')
  assert.ok(chat.script.includes('pendingHintByMode'), '聊天页角标标题同源')
  assert.ok(group.script.includes('pendingHintByMode'), '群聊页同源')
})

// ── 问题 2：点完动作自动收起（成功关、被拒不关） ──

function buildActioner(script, impl) {
  const toasts = []
  const state = {
    chat: { activeCharId: 9 },
    store: { activeGroupId: 42 },
    touchTargetId: ref(7),
    touchBusyActions: ref(new Set()),
    showTouchPanel: ref(true),
    api: { performTouchAction: () => impl() },
    performTouchAction: () => impl(),
    toastFn: (m, t) => toasts.push({ m, t }),
    toast: (m, t) => toasts.push({ m, t }),
    loadTouchActions: () => {},
    loadTouchState: () => {},
  }
  return { run: new Function('state', 'with (state) { ' + fnSource(script, 'onTouchAction') + '; return onTouchAction }')(state), state, toasts }
}

test('§4.2：动作成功后面板**不再自动收起**（常驻，可连着摸）；被拒也不收', async () => {
  const okInstant = buildActioner(chat.script, () => Promise.resolve({ allowed: true, mode: 'instant' }))
  await okInstant.run('pat_head')
  assert.equal(okInstant.state.showTouchPanel.value, true, '§4.2 作废了自动收起 —— 成功后面板要留着')

  const denied = buildActioner(chat.script, () => Promise.resolve({ allowed: false, code: 'affinity_low', message: '她现在还不愿意让你这样' }))
  await denied.run('hug')
  assert.equal(denied.state.showTouchPanel.value, true, '被拒不能关（用户要换个动作）')
  assert.equal(denied.toasts[0].m, '她现在还不愿意让你这样')

  const implicit = buildActioner(chat.script, () => Promise.resolve({ allowed: true, mode: 'implicit' }))
  await implicit.run('hug')
  assert.equal(implicit.state.showTouchPanel.value, true, '隐式（她这轮没反应）不关，让用户接着来')
})

test('GroupChatView：成功也不自动收起（§4.2）/ 被拒不收', async () => {
  const ok = buildActioner(group.script, () => Promise.resolve({ allowed: true, mode: 'instant' }))
  await ok.run('pat_head')
  assert.equal(ok.state.showTouchPanel.value, true, '群聊同样不自动收起')
  const denied = buildActioner(group.script, () => Promise.resolve({ allowed: false, code: 'group_adult_blocked', message: '这种事别在群里做' }))
  await denied.run('touch_breast')
  assert.equal(denied.state.showTouchPanel.value, true, '群聊被拒不关')
})
