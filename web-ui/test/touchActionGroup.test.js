/**
 * SLG 动作系统 · 阶段二 · 群聊动作条
 *
 * 口径：群聊是多人 ⇒ 先选「对谁」再选动作；POST 带 { scene:'group', groupId }；
 * gate 走 GET .../touch/actions?scene=group 的服务端逐条 gate（镜像只兜底）；
 * 反应由后端写进群会话并 broadcast('group_message')，前端**不自己插消息**。
 *
 * 选人复用该页既有的 @提及成员选择器（useMentionPicker + .mention-panel 视觉，includeAll=false）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { ref } from 'vue'

import { buildMentionOptions } from '../src/composables/useMentionPicker.js'
import { buildGroupsFromServer } from '../src/components/touchActionLogic.js'

const viewFile = readFileSync(new URL('../src/views/GroupChatView.vue', import.meta.url), 'utf8')
const view = parseSfc(viewFile).descriptor
const viewScript = view.scriptSetup.content
const viewTemplate = view.template.content
const viewNodes = parseJs(viewScript, { sourceType: 'module' }).program.body

// 交互改版（专题-动作交互改版 §3.3-4）：TouchActionBar 已删除，逻辑迁到 TouchActionPanel。
// 变量名沿用 barXxx 以免大改断言，但读的已经是面板组件。
const barFile = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const bar = parseSfc(barFile).descriptor
const barScript = bar.scriptSetup.content
const barTemplate = bar.template.content
const barNodes = parseJs(barScript, { sourceType: 'module' }).program.body

function fnSource(nodes, script, name) {
  const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
  return node ? script.slice(node.start, node.end) : ''
}
function makeRunner(nodes, script, name, state) {
  const src = fnSource(nodes, script, name)
  assert.ok(src, name + ' 应存在')
  return new Function('state', 'with (state) { ' + src + ' return ' + name + ' }')(state)
}

// ── 1. 群聊 gate：吃服务端，Lv3 应被 group_adult_blocked 拦下 ──

test('群聊 gate 吃服务端：Lv3 在群里被 group_adult_blocked 拦（message 原样用）', () => {
  const groups = buildGroupsFromServer({
    actions: [
      { key: 'pat_head', label: '摸头', level: 1, levelLabel: 'Lv1 日常', wakes: false },
      { key: 'stroke_hair', label: '摸头发', level: 2, levelLabel: 'Lv2 亲密', wakes: false },
      { key: 'touch_breast', label: '摸胸', level: 3, levelLabel: 'Lv3 敏感', wakes: false },
    ],
    gate: {
      pat_head: { allowed: true, code: 'ok', message: '' },
      stroke_hair: { allowed: false, code: 'affinity_low', message: '她还不太习惯你离得这么近' },
      touch_breast: { allowed: false, code: 'group_adult_blocked', message: '这种事别在群里做' },
    },
    levels: { 1: 'Lv1 日常', 2: 'Lv2 亲密', 3: 'Lv3 敏感' },
  })
  const flat = groups.flatMap(g => g.actions)
  const byKey = Object.fromEntries(flat.map(a => [a.key, a.gate]))

  assert.equal(byKey.pat_head.allowed, true)
  assert.equal(byKey.pat_head.source, 'server')
  assert.equal(byKey.stroke_hair.allowed, false)
  assert.equal(byKey.stroke_hair.code, 'affinity_low')
  assert.equal(byKey.touch_breast.allowed, false)
  assert.equal(byKey.touch_breast.code, 'group_adult_blocked', '群聊 Lv3 默认拦截由服务端给码')
  assert.equal(byKey.touch_breast.message, '这种事别在群里做')
})

// ── 2. 「对谁」复用既有 @提及选择器（不另造视觉） ──

const members = [
  { id: 7, display_name: '小满', avatar_path: '/a.png' },
  { id: 8, display_name: '阿澈', avatar_path: '' },
]

test('选人复用 useMentionPicker：includeAll=false 时没有「全体成员」这一项', () => {
  const all = buildMentionOptions(members, '', true)
  assert.equal(all[0].isAll, true, '默认首项是全体成员')

  const targets = buildMentionOptions(members, '', false)
  assert.equal(targets.length, 2, '动作对象只能是具体成员，不能是全体')
  assert.equal(targets.some(o => o.isAll), false)
  assert.deepEqual(targets.map(o => o.id), [7, 8])
  // 沿用成员自带字段（头像 / 名字），不额外造数据
  assert.equal(targets[0].display_name, '小满')
  assert.equal(targets[0].avatar_path, '/a.png')
})

test('GroupChatView 用既有 @提及面板与 composable 做「对谁」，没有另造一套视觉', () => {
  assert.ok(viewScript.includes('useMentionPicker(() => store.activeGroup?.members || [], { includeAll: false })'))
  assert.ok(viewTemplate.includes('class="mention-panel"'), '复用既有面板类名')
  assert.ok(viewTemplate.includes('class="mention-item"'), '复用既有候选项类名')
  assert.ok(viewTemplate.includes('class="mention-avatar"'), '复用既有头像类名')
  assert.ok(viewTemplate.includes('touch-group-wrap'))
  assert.ok(viewFile.includes('.touch-group-wrap { position: relative; }'), '相对定位让复用的 .mention-panel 正常贴在动作条上方')
})

// ── 3. pickTarget ──

test('pickTarget：选中成员并收起面板；忽略「全体成员」这种非法对象', () => {
  const state = {
    touchTargetId: ref(null),
    closeTargetPicker: () => { state.closed = true },
    closed: false,
  }
  const pick = makeRunner(viewNodes, viewScript, 'pickTarget', state)

  pick({ id: 8, display_name: '阿澈' })
  assert.equal(state.touchTargetId.value, 8)
  assert.equal(state.closed, true, '选完要收起面板')

  state.touchTargetId.value = 8
  pick({ isAll: true, display_name: '全体成员' })
  assert.equal(state.touchTargetId.value, 8, '全体成员不是合法动作对象')
  pick(null)
  assert.equal(state.touchTargetId.value, 8)
})

// ── 4. loadTouchActions：群聊口径 ──

test('loadTouchActions：按 scene=group 拉目标成员的门控；换对象期间丢弃过期响应', async () => {
  const calls = []
  const state = {
    touchTargetId: ref(7),
    touchServerGroups: ref([]),
    store: { activeGroupId: 42 },
    fetchTouchActions: (id, opts) => { calls.push([id, opts]); return Promise.resolve({ actions: [{ key: 'pat_head', label: '摸头', level: 1, wakes: false }], gate: { pat_head: { allowed: true, code: 'ok', message: '' } }, levels: { 1: 'Lv1 日常' } }) },
    buildGroupsFromServer,
  }
  const load = makeRunner(viewNodes, viewScript, 'loadTouchActions', state)

  await load()
  assert.deepEqual(calls[0], [7, { scene: 'group' }], '群聊必须带 scene=group')
  assert.equal(state.touchServerGroups.value.length, 1)
  assert.equal(state.touchServerGroups.value[0].actions[0].gate.source, 'server')
})

test('loadTouchActions：端点失败 → 清空以回落镜像；没目标 / 没群 → 不请求', async () => {
  const calls = []
  const failing = {
    touchTargetId: ref(7),
    touchServerGroups: ref([{ level: 1, actions: [] }]),
    store: { activeGroupId: 42 },
    fetchTouchActions: () => { calls.push(1); return Promise.reject(new Error('boom')) },
    buildGroupsFromServer,
  }
  const loadFail = makeRunner(viewNodes, viewScript, 'loadTouchActions', failing)
  await loadFail()
  assert.deepEqual(failing.touchServerGroups.value, [], '失败要清空，让组件回落镜像')
  assert.equal(calls.length, 1)

  const noTarget = {
    touchTargetId: ref(null),
    touchServerGroups: ref([{ level: 1, actions: [] }]),
    store: { activeGroupId: 42 },
    fetchTouchActions: () => { calls.push(2); return Promise.resolve({}) },
    buildGroupsFromServer,
  }
  await makeRunner(viewNodes, viewScript, 'loadTouchActions', noTarget)()
  assert.equal(calls.length, 1, '没选对象不该请求')
  assert.deepEqual(noTarget.touchServerGroups.value, [])

  const noGroup = {
    touchTargetId: ref(7),
    touchServerGroups: ref([]),
    store: { activeGroupId: null },
    fetchTouchActions: () => { calls.push(3); return Promise.resolve({}) },
    buildGroupsFromServer,
  }
  await makeRunner(viewNodes, viewScript, 'loadTouchActions', noGroup)()
  assert.equal(calls.length, 1, '没进群不该请求')
})

// ── 5. onTouchAction：POST 形状 + 被拒 / 成功 / 抛错 / 连点 ──

function buildGroupActioner(impl) {
  const toasts = []
  const posts = []
  const reloads = []
  const stateReloads = []
  const state = {
    touchTargetId: ref(7),
    touchBusyActions: ref(new Set()),   // §4.2：单值 → Set（不同动作可并发）
    store: { activeGroupId: 42 },
    performTouchAction: (...args) => { posts.push(args); return impl() },
    toast: (msg, type) => toasts.push({ msg, type }),
    loadTouchActions: () => { reloads.push(1) },
    showTouchPanel: ref(false),
    // task-29：动作做完待回应条数会变，onTouchAction 结束时要一并刷新
    loadTouchState: () => { stateReloads.push(1) },
  }
  return { run: makeRunner(viewNodes, viewScript, 'onTouchAction', state), toasts, posts, reloads, stateReloads, state }
}

test('群聊 POST：带 { scene: group, groupId }，被拒只 toast 服务端 message', async () => {
  const r = buildGroupActioner(() => Promise.resolve({ allowed: false, code: 'group_adult_blocked', message: '这种事别在群里做' }))
  await r.run('touch_breast')

  assert.deepEqual(r.posts, [[7, 'touch_breast', { scene: 'group', groupId: 42 }]])
  assert.equal(r.toasts.length, 1)
  assert.equal(r.toasts[0].msg, '这种事别在群里做')
  assert.equal(r.toasts[0].type, 'info')
  assert.equal(r.state.touchBusyActions.value.size, 0, 'busy 必须清掉')
  assert.equal(r.reloads.length, 1)
  assert.equal(r.stateReloads.length, 1, '结束后也刷新待回应条数（task-29）')
})

test('群聊成功：不弹多余 toast、**不自己插消息**（等后端 group_message 广播）', async () => {
  const r = buildGroupActioner(() => Promise.resolve({ allowed: true, code: 'ok', mode: 'instant' }))
  await r.run('pat_head')
  assert.equal(r.toasts.length, 0)
  assert.equal(r.state.touchBusyActions.value.size, 0)
  assert.equal(r.reloads.length, 1)

  const src = fnSource(viewNodes, viewScript, 'onTouchAction')
  assert.equal(src.includes('messages'), false, 'onTouchAction 不许碰消息列表')
  assert.equal(src.includes('push('), false, '不自己插消息')
})

test('群聊：隐式回落 / notice / 抛错 / 连点 / 缺目标 都处理正确', async () => {
  const implicit = buildGroupActioner(() => Promise.resolve({ allowed: true, mode: 'implicit', fallback: true }))
  await implicit.run('hug')
  assert.equal(implicit.toasts[0].msg, '她的反应会在下次发言时出现')

  const notice = buildGroupActioner(() => Promise.resolve({ allowed: true, mode: 'implicit', notice: '今日即时反应额度已用完' }))
  await notice.run('hug')
  assert.equal(notice.toasts[0].msg, '今日即时反应额度已用完')

  const bad = buildGroupActioner(() => Promise.reject(new Error('动作系统已关闭')))
  await bad.run('pat_head')
  assert.equal(bad.toasts[0].type, 'error')
  assert.equal(bad.state.touchBusyActions.value.size, 0)

  // §4.2：同动作在飞忽略重复；**不同动作可并发**
  const busy = buildGroupActioner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  busy.state.touchBusyActions.value = new Set(['pat_head'])
  await busy.run('pat_head')
  assert.equal(busy.posts.length, 0, '同动作飞行中不得重复 POST')

  const concurrent = buildGroupActioner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  concurrent.state.touchBusyActions.value = new Set(['hug'])
  await concurrent.run('pat_head')
  assert.equal(concurrent.posts.length, 1, '§4.2：不同动作可以并发点')

  const noTarget = buildGroupActioner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  noTarget.state.touchTargetId.value = null
  await noTarget.run('pat_head')
  assert.equal(noTarget.posts.length, 0, '没选「对谁」不得上报')

  const noGroup = buildGroupActioner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  noGroup.state.store.activeGroupId = null
  await noGroup.run('pat_head')
  assert.equal(noGroup.posts.length, 0)
})

// ── 6. 组件：requiresTarget 时的守卫 ──

test('动作条：requiresTarget 且没选对象时点动作 → 只提示 + 请求选人，不上报', () => {
  const pickNode = barNodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'onPick')
  const src = barScript.slice(pickNode.start, pickNode.end)
  const toasts = []
  const emitted = []
  const state = {
    props: { busyAction: '', requiresTarget: true, targetName: '' },
    toastFn: (msg, type) => toasts.push({ msg, type }),
    emit: (name, payload) => emitted.push({ name, payload }),
    WAKE_WARNING_TEXT: 'x',
  }
  const run = new Function('state', 'with (state) { ' + src + ' return onPick }')(state)

  run({ key: 'pat_head', label: '摸头', gate: { allowed: true, message: '', wakesSleeping: false } })
  assert.equal(emitted.filter(e => e.name === 'action').length, 0, '没选对象不得上报动作')
  assert.equal(toasts.length, 1)
  assert.deepEqual(emitted.filter(e => e.name === 'pick-target'), [{ name: 'pick-target', payload: undefined }])
})

test('动作条：requiresTarget 且已选对象 → 正常上报；不 requiresTarget（私聊）→ 行为不变', () => {
  const pickNode = barNodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'onPick')
  const src = barScript.slice(pickNode.start, pickNode.end)

  function build(props) {
    const emitted = []
    const state = { props, toastFn: () => {}, emit: (name, payload) => emitted.push({ name, payload }), WAKE_WARNING_TEXT: 'x' }
    return { run: new Function('state', 'with (state) { ' + src + ' return onPick }')(state), emitted }
  }

  const group = build({ busyAction: '', requiresTarget: true, targetName: '小满' })
  group.run({ key: 'pat_head', label: '摸头', gate: { allowed: true, message: '', wakesSleeping: false } })
  assert.deepEqual(group.emitted, [{ name: 'action', payload: 'pat_head' }])

  const priv = build({ busyAction: '', requiresTarget: false, targetName: '' })
  priv.run({ key: 'hug', label: '抱抱', gate: { allowed: true, message: '', wakesSleeping: false } })
  assert.deepEqual(priv.emitted, [{ name: 'action', payload: 'hug' }], '私聊不受影响')
})

test('动作条：模式切换到群聊时渲染目标胶囊；展开且没选对象时自动请求选人', () => {
  assert.ok(barScript.includes('targetName: { type: String'), '要有 targetName prop')
  assert.ok(barScript.includes('requiresTarget: { type: Boolean'), '要有 requiresTarget prop')
  assert.ok(barTemplate.includes('v-if="requiresTarget"'))
  assert.ok(barTemplate.includes("emit('pick-target')"))
  assert.ok(barScript.includes("if (props.requiresTarget && !props.targetName) emit('pick-target')"), '展开时自动甩出选人面板')
})

// ── 7. 两个模板都能编译 ──

test('GroupChatView / TouchActionPanel 模板可编译，群聊接线齐备', () => {
  const v = compileTemplate({ source: viewTemplate, filename: 'GroupChatView.vue', id: 'group-chat-view' })
  assert.deepEqual(v.errors, [])
  const b = compileTemplate({ source: barTemplate, filename: 'TouchActionPanel.vue', id: 'touch-action-panel' })
  assert.deepEqual(b.errors, [])

  assert.ok(viewTemplate.includes(':requires-target="true"'), '群聊必须要求先选对象')
  assert.ok(viewTemplate.includes(':target-name='))
  assert.ok(viewTemplate.includes('@pick-target="openTargetPicker"'))
  assert.ok(viewTemplate.includes('@action="onTouchAction"'))
  assert.ok(viewTemplate.includes('@open="onTouchPanelOpen"') || viewTemplate.includes('@open="loadTouchActions"'), '面板打开时刷新（群聊同口径）')
  assert.ok(viewTemplate.includes(':server-groups="touchServerGroups"'))
  assert.ok(viewScript.includes("performTouchAction(targetId, actionId, { scene: 'group', groupId })"))
});
// ── 8. 与后端 task-17 的 group_message 契约（只断言一次；前端渲染逻辑不改） ──

test('后端群内反应 payload 与群聊页监听一致（task-17）：speaker_character_id + group_id 都要在', (t) => {
  let src
  try {
    src = readFileSync(new URL('../../agent-core/src/routes/touch.js', import.meta.url), 'utf8')
  } catch {
    return t.skip('后端源码不可读（独立检出？）')
  }
  // 群聊场景必须广播 group_message —— 走私聊写入器的话群里根本看不到
  assert.ok(src.includes("broadcast('group_message'"), '群聊场景要广播 group_message')
  assert.ok(src.includes("normalized.scene === 'group'"), '只有 group 场景才走群内写入')

  // payload 形状：用 AST 取 writeGroupTouchMessage 里 payload 字面量的**真实 key**
  // （源码里 content / seq 是简写属性，用字符串 includes('content:') 会漏 —— 第一版就这么错的）
  const ast = parseJs(src, { sourceType: 'module' }).program.body
  const writer = ast.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'writeGroupTouchMessage')
  assert.ok(writer, '要能找到 task-17 的群内写入器 writeGroupTouchMessage')
  const ret = writer.body.body.find(s => s.type === 'ReturnStatement')
  assert.ok(ret, '写入器要有 return')
  const payloadProp = ret.argument.properties.find(p => (p.key.name || p.key.value) === 'payload')
  assert.ok(payloadProp, '写入器要 return payload')
  const payloadKeys = payloadProp.value.properties.map(p => p.key.name || p.key.value)
  for (const field of ['id', 'group_id', 'role', 'content', 'seq', 'speaker_character_id', 'speaker_name', 'created_at', 'source', 'touch']) {
    assert.ok(payloadKeys.includes(field), 'payload 要有 ' + field)
  }
  assert.ok(src.includes('speaker_character_id: Number(character.id)'), 'speaker 必须是**被做动作的那个角色**（群聊页据此渲染成她的气泡）')

  // 前端消费侧：群聊页只认这条统一流事件；_enqueue 依赖 group_id 与 id
  const storeFile = readFileSync(new URL('../src/stores/groups.js', import.meta.url), 'utf8')
  assert.ok(storeFile.includes("onEvent('group_message'"), '群聊 store 要监听 group_message')
  assert.ok(storeFile.includes('_getSession(msg.group_id)'), '_enqueue 按 group_id 找会话')
  assert.ok(storeFile.includes('session.seenMsgIds.has(msg.id)'), '_enqueue 按 id 去重')
  // 前端不自己插消息：渲染整条交给上面的监听
  const actionSrc = fnSource(viewNodes, viewScript, 'onTouchAction')
  assert.equal(actionSrc.includes('messages'), false)
  assert.equal(actionSrc.includes('push('), false)
});

