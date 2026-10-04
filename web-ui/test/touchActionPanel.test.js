/**
 * 交互改版（专题-动作交互改版 §二/§三）：✋ 入口 + 底部弹层大卡片面板
 *
 * 用户裁决：删掉输入框上方常驻条，✋ 动作图标放输入区图标排最右端（发送按钮左侧），
 * 点开底部弹层 + 大卡片网格（复用 GiftPanel 的形态范式），Lv1/2/3 三段分组。
 * 本文件先写红：面板组件与纯函数都还不存在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { computed, ref, reactive } from 'vue'

import { TOUCH_ACTIONS, buildActionGroups, annoyanceTierKey, toleranceLabel, likeBadgeOf } from '../src/components/touchActionLogic.js'

const panelUrl = new URL('../src/components/TouchActionPanel.vue', import.meta.url)
assert.ok(existsSync(panelUrl), 'TouchActionPanel.vue 应存在（交互改版的核心交付）')

const panelFile = readFileSync(panelUrl, 'utf8')
const panel = parseSfc(panelFile).descriptor
const panelTemplate = panel.template.content
const panelScript = panel.scriptSetup.content
const panelStyle = panelFile.slice(panelFile.indexOf('<style'))
const panelNodes = parseJs(panelScript, { sourceType: 'module' }).program.body

const chat = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor
const chatTemplate = chat.template.content
const chatScript = chat.scriptSetup.content
const group = parseSfc(readFileSync(new URL('../src/views/GroupChatView.vue', import.meta.url), 'utf8')).descriptor
const groupTemplate = group.template.content
const groupScript = group.scriptSetup.content

function fnSource(nodes, name) {
  const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
  return node ? panelScript.slice(node.start, node.end) : ''
}
function makeRunner(name, state) {
  const src = fnSource(panelNodes, name)
  assert.ok(src, name + ' 应存在')
  return new Function('state', 'with (state) { ' + src + ' return ' + name + ' }')(state)
}

// ── 1. 纯函数：耐受档 / 偏好角标 ──

test('annoyanceTierKey：与后端同阈值（>80 refusing / >50 warm / 其余 fine）', () => {
  assert.equal(annoyanceTierKey(0), 'fine')
  assert.equal(annoyanceTierKey(50), 'fine', '阈值是「大于」')
  assert.equal(annoyanceTierKey(51), 'warm')
  assert.equal(annoyanceTierKey(80), 'warm')
  assert.equal(annoyanceTierKey(81), 'refusing')
  assert.equal(annoyanceTierKey(undefined), 'fine')
})

test('toleranceLabel：优先用服务端 tier，缺了按 annoyance 推；文案短句化', () => {
  assert.equal(toleranceLabel({ tier: 'fine' }), '还乐意')
  assert.equal(toleranceLabel({ tier: 'warm' }), '有点不耐烦了')
  assert.equal(toleranceLabel({ tier: 'refusing' }), '已经很烦了')
  assert.equal(toleranceLabel({ annoyance: 90 }), '已经很烦了', '没有 tier 就按数值推')
  assert.equal(toleranceLabel({ tier: 'nonsense', annoyance: 60 }), '有点不耐烦了', '非法 tier 回落数值')
  assert.equal(toleranceLabel(null), '还乐意')
  assert.equal(toleranceLabel({}), '还乐意')
})

test('likeBadgeOf：≥1.25 喜欢♥ / ≤0.75 讨厌～ / 其余无角标', () => {
  assert.equal(likeBadgeOf(1.25), '♥')
  assert.equal(likeBadgeOf(2), '♥')
  assert.equal(likeBadgeOf(1.24), '')
  assert.equal(likeBadgeOf(0.75), '～')
  assert.equal(likeBadgeOf(0.5), '～')
  assert.equal(likeBadgeOf(1), '')
  assert.equal(likeBadgeOf(undefined), '')
})

// ── 2. 面板模板：形态照 GiftPanel（底部弹层 + 卡片网格） ──

test('面板：Teleport + 底部弹层 + 分组卡片网格 + 0.3s 渐入渐出', () => {
  const compiled = compileTemplate({ source: panelTemplate, filename: 'TouchActionPanel.vue', id: 'tp' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(panelTemplate.includes('<Teleport to="body">'), '弹层要 Teleport 到 body')
  assert.ok(panelTemplate.includes('class="touch-overlay"'), '底部对齐遮罩')
  assert.ok(panelTemplate.includes('class="touch-panel"'))
  assert.ok(panelTemplate.includes('class="touch-grid"'), '大卡片网格')
  assert.ok(panelTemplate.includes('class="touch-card"'), '卡片（不是小胶囊）')
  assert.ok(panelTemplate.includes('class="touch-group-title"'), 'Lv 分段标题')
  assert.ok(panelTemplate.includes('<Transition name="touch-overlay"'), '要 0.3s 过渡')
  assert.ok(panelStyle.includes('.touch-overlay-enter-active'), '过渡类名要对上')
  assert.match(panelStyle, /transition:[^;]*0\.3s/)
  assert.ok(panelStyle.includes('align-items: flex-end'), '底部对齐（照 GiftPanel）')
  assert.ok(panelStyle.includes('position: fixed'), '整屏遮罩')
})

test('面板：双主题 token、无裸 button、关闭键用 LinsheButton', () => {
  assert.doesNotMatch(panelTemplate, /<button/)
  assert.ok(panelTemplate.includes('<linshe-button'), '关闭键用 Linshe 组件')
  assert.ok(panelScript.includes('LinsheButton'), '要 import')
  for (const token of ['var(--bg-secondary)', 'var(--text-bright)', 'var(--text-secondary)', 'var(--accent)', 'var(--border)']) {
    assert.ok(panelStyle.includes(token), '样式要走 token：' + token)
  }
  // 卡片是整卡热区 → AGENTS.md 组件约定第 4 条：div + role=button + 自包含样式
  assert.ok(panelTemplate.includes('role="button"'))
  assert.ok(panelTemplate.includes('tabindex="0"'))
})

// ── 3. 面板接口与行为（沿用 TouchActionBar 的形） ──

test('面板：props 与 emits 与旧动作条同形（外加 states / open / close）', () => {
  for (const prop of ['serverGroups', 'state', 'busyAction', 'actions', 'targetName', 'requiresTarget', 'pendingCount']) {
    assert.ok(panelScript.includes(prop), '要有 prop：' + prop)
  }
  assert.ok(panelScript.includes('states'), '耐受/偏好数据要能传进来')
  assert.ok(panelScript.includes('open'), '受控显隐')
  const emitsLine = panelScript.match(/defineEmits\(\[([^\]]*)\]\)/)
  assert.ok(emitsLine, '要有 defineEmits')
  for (const ev of ['action', 'open', 'pick-target', 'close']) {
    assert.ok(emitsLine[1].includes(ev), '要有 emit：' + ev)
  }
})

test('面板：有待回应才在顶部显示提示行，文案随 mode 变（专题 §七 问题 3）', () => {
  assert.ok(panelTemplate.includes('v-if="pendingHint"'), '有文案才显示')
  assert.ok(panelTemplate.includes('{{ pendingHint }}'), '文案由 pendingHintByMode 出')
  assert.ok(panelScript.includes('pendingHintByMode'), 'mode 感知（有 implicit 就提醒她还没回应）')
})

test('面板：门控不满足 → 卡片半透明 + 状态行显示服务端拒绝原因（可点）', () => {
  assert.ok(/is-disabled/.test(panelTemplate), '置灰类')
  // 只看状态行那段：别被 :title 里的同名绑定蒙混过去（第一版就是这么假绿的）
  const statusAt = panelTemplate.indexOf('class="touch-card-status"')
  const statusBlock = statusAt >= 0 ? panelTemplate.slice(statusAt, statusAt + 320) : ''
  assert.ok(statusBlock.includes('action.gate.message'), '状态行要显示服务端那句原因')
  assert.ok(/aria-disabled/.test(panelTemplate))
})

test('onPick：拒绝只 toast 服务端 message（不是报错）；busy 忽略连点；唤醒给提示', () => {
  function build(overrides = {}) {
    const toasts = []
    const actions = []
    const emits = []
    const state = {
      props: Object.assign({
        requiresTarget: false,
        targetName: '',
        busyAction: '',
      }, overrides),
      emit: (name, payload) => emits.push([name, payload]),
      toastFn: (msg, type) => toasts.push({ msg, type }),
      WAKE_WARNING_TEXT: '她睡着了，这一下会把她弄醒',
    }
    return { run: makeRunner('onPick', state), toasts, actions, emits, state }
  }
  // 拒绝：只 toast，不发 action
  const denied = build()
  denied.run({ key: 'hug', label: '抱抱', gate: { allowed: false, code: 'affinity_low_lv2', message: '她现在还不愿意让你这样' } })
  assert.equal(denied.emits.length, 0, '拒绝不上报')
  assert.equal(denied.toasts[0].msg, '她现在还不愿意让你这样')
  assert.equal(denied.toasts[0].type, 'info')

  // 群聊没选对象：toast + 请求选人
  const noTarget = build({ requiresTarget: true })
  noTarget.run({ key: 'hug', gate: { allowed: true } })
  assert.deepEqual(noTarget.emits, [['pick-target', undefined]])
  assert.ok(noTarget.toasts[0].msg.includes('先选一个人'))

  // busy：忽略连点
  const busy = build({ busyAction: 'hug' })
  busy.run({ key: 'hug', gate: { allowed: true } })
  assert.equal(busy.emits.length, 0, '上报中忽略连点')

  // 唤醒提示 + 正常上报
  const ok = build()
  ok.run({ key: 'touch_breast', gate: { allowed: true, wakesSleeping: true } })
  assert.deepEqual(ok.emits, [['action', 'touch_breast']])
  assert.equal(ok.toasts[0].msg, '她睡着了，这一下会把她弄醒')
})

test('groups：服务端优先，端点不可用时回落镜像', () => {
  const server = [{ level: 1, label: '日常', actions: [{ key: 'x', label: 'X', gate: { allowed: true } }] }]
  const state = {
    props: { serverGroups: server, state: {}, actions: TOUCH_ACTIONS },
    buildActionGroups,
    TOUCH_ACTIONS,
    computed,
  }
  const node = panelNodes.find(n => n.type === 'VariableDeclaration'
    && n.declarations.some(d => d.id.name === 'groups'))
  assert.ok(node, '要有 groups computed')
  const src = panelScript.slice(node.start, node.end)
  const groups = new Function('state', 'with (state) { ' + src + '; return groups }')(state)
  assert.equal(groups.value[0].actions[0].key, 'x', '服务端优先')

  const mirrorState = Object.assign({}, state, { props: { serverGroups: [], state: {}, actions: TOUCH_ACTIONS } })
  const mirror = new Function('state', 'with (state) { ' + src + '; return groups }')(mirrorState)
  assert.ok(mirror.value.length >= 2, '回落镜像分组')
  assert.ok(mirror.value[0].actions.length > 0)
})

// ── 4. 两个页面：✋ 入口 + 面板挂载 + 角标 ──

test('聊天页：✋ 图标在图标排最右（发送按钮左侧），角标显示 pendingCount', () => {
  assert.ok(chatTemplate.includes('touch-icon-btn'), '要有 ✋ 入口按钮')
  assert.ok(chatScript.includes('showTouchPanel'), '要有面板显隐 ref')
  assert.ok(chatTemplate.includes('<TouchActionPanel'), '要挂面板')
  assert.ok(chatTemplate.includes(':open="showTouchPanel"'), '受控显隐')
  assert.ok(chatScript.includes("import TouchActionPanel from '../components/TouchActionPanel.vue'"))
  // 位置：✋ 在发送按钮之前
  assert.ok(chatTemplate.indexOf('touch-icon-btn') < chatTemplate.indexOf('class="send-btn"'), '✋ 要排在发送按钮左侧')
  // 角标：pendingCount>0 才显示数字点
  assert.ok(/touchPendingCount > 0/.test(chatTemplate), '角标要有阈值判断')
  assert.ok(/touch-icon-badge/.test(chatTemplate))
})

test('聊天页：动作条挂载整个移除（常驻条不再存在）', () => {
  assert.equal(chatTemplate.includes('<TouchActionBar'), false, '常驻条要移除')
  assert.equal(chatScript.includes('TouchActionBar'), false, '旧组件 import 也要清掉')
})

test('群聊页：同一颗 ✋，先选人；面板顶部可换人', () => {
  assert.ok(groupTemplate.includes('touch-icon-btn'), '群聊同一颗 ✋')
  assert.ok(groupTemplate.includes('<TouchActionPanel'), '要挂面板')
  assert.ok(groupTemplate.includes(':requires-target="true"'), '群聊需要先选人')
  assert.ok(groupScript.includes('openTargetPicker'), '选人复用既有 @提及面板')
  assert.equal(groupTemplate.includes('<TouchActionBar'), false, '常驻条要移除')
  assert.equal(groupScript.includes('TouchActionBar'), false)
})
