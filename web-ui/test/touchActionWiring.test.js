/**
 * SLG 动作系统 · task-15 前端接线
 *
 * 契约来源：docs/touch-system.md §6.3
 *   - GET  /api/characters/:id/touch/actions → 清单 + 逐 key 门控 {allowed, code, message, wakesSleeping, exempt}
 *   - GET  /api/characters/:id/touch/state   → { states:{<key>:{annoyance,tier,likeRatio,updatedAt}}, quota }
 *   - POST /api/characters/:id/touch/:action → 门控拒绝 = **200 + { allowed:false, code, message }**（不是 4xx）
 *     成功 instant 时 reaction 已由后端落库 + 广播，前端靠既有 handleProactiveMessage 渲染
 *
 * 本文件测三件事：
 *   1. 服务端 gate 归一化：**服务端优先**（哪怕与镜像不一致）、字段缺失才回落镜像；
 *   2. 服务端清单优先（服务层加动作前端自动跟上），空响应回落镜像；
 *   3. ChatView.onTouchAction 真跑：被拒只 toast 服务端 message、成功不伪造反应、失败 error toast、连点忽略。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { ref } from 'vue'

import {
  TOUCH_GATE_CODES,
  buildGroupsFromServer,
  findTouchAction,
  normalizeServerGate,
  resolveActionGate,
} from '../src/components/touchActionLogic.js'
import { fetchTouchActions, fetchTouchState, performTouchAction } from '../src/api/index.js'

// 交互改版（专题-动作交互改版 §3.3-4）：常驻条删除，组件形态换成 TouchActionPanel（接口同形，断言照旧）
const barScript = parseSfc(readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const barTemplate = parseSfc(readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')).descriptor.template.content

const chatDescriptor = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor
const chatScript = chatDescriptor.scriptSetup.content
const chatTemplate = chatDescriptor.template.content
const chatNodes = parseJs(chatScript, { sourceType: 'module' }).program.body

// ── 1. 服务端 gate 归一化 ──

test('normalizeServerGate：服务端字段齐全时一律以服务端为准（哪怕与镜像相反）', () => {
  const mirrorSaysNo = { allowed: false, code: 'affinity_low', message: '镜像文案', wakesSleeping: false, level: 3, exempt: null, source: 'mirror' }

  // 镜像说不行、服务端说行（比如催眠中豁免）→ 必须听服务端的
  const allowed = normalizeServerGate({ allowed: true, code: 'ok', message: '', wakesSleeping: false, exempt: 'hypnosis' }, mirrorSaysNo)
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.code, 'ok')
  assert.equal(allowed.exempt, 'hypnosis')
  assert.equal(allowed.message, '')
  assert.equal(allowed.source, 'server')

  // 镜像说行、服务端说不行 → 也必须听服务端的
  const mirrorSaysYes = { allowed: true, code: 'ok', message: '', wakesSleeping: false, level: 3, exempt: null, source: 'mirror' }
  const denied = normalizeServerGate({ allowed: false, code: 'sleeping_blocked', message: '服务端那句人话' }, mirrorSaysYes)
  assert.equal(denied.allowed, false)
  assert.equal(denied.code, 'sleeping_blocked')
  assert.equal(denied.message, '服务端那句人话', '被拒时要用服务端 message，不是镜像文案')
  assert.equal(denied.source, 'server')
})

test('normalizeServerGate：服务端字段缺失 / 不是布尔时回落镜像', () => {
  const mirror = resolveActionGate(findTouchAction('stroke_hair'), { affinity: 0 })
  assert.equal(mirror.allowed, false, '前置：镜像这里应当拦下')

  for (const bad of [undefined, null, {}, { code: 'ok' }, { allowed: 'yes' }]) {
    const gate = normalizeServerGate(bad, mirror)
    assert.equal(gate.source, 'mirror')
    assert.equal(gate.allowed, mirror.allowed)
    assert.equal(gate.code, mirror.code)
    assert.equal(gate.message, mirror.message)
  }

  // 只给了 allowed（缺 code / message）→ 补齐
  const partial = normalizeServerGate({ allowed: false }, mirror)
  assert.equal(partial.allowed, false)
  assert.equal(partial.code, mirror.code)
  assert.equal(partial.message, mirror.message)
})

test('normalizeServerGate：放行时不会把镜像的拒绝文案带出来', () => {
  const mirror = resolveActionGate(findTouchAction('touch_breast'), { affinity: 0 })
  const gate = normalizeServerGate({ allowed: true, code: 'ok' }, mirror)
  assert.equal(gate.allowed, true)
  assert.equal(gate.message, '', '放行就该是空文案')
})

// ── 2. 服务端清单优先 ──

test('buildGroupsFromServer：清单也用服务端的（服务层加动作，前端自动跟上）', () => {
  const payload = {
    actions: [
      { key: 'pat_head', label: '摸头', level: 1, levelLabel: 'Lv1 日常', wakes: false },
      { key: 'brand_new_action', label: '服务层新动作', level: 2, levelLabel: 'Lv2 亲密', wakes: true },
    ],
    gate: {
      pat_head: { allowed: true, code: 'ok', message: '', wakesSleeping: false, exempt: null },
      brand_new_action: { allowed: false, code: 'affinity_low', message: '她还不愿意', wakesSleeping: false, exempt: null },
    },
    levels: { 1: 'Lv1 日常', 2: 'Lv2 亲密' },
  }
  const groups = buildGroupsFromServer(payload)
  assert.deepEqual(groups.map(g => g.level), [1, 2])
  assert.deepEqual(groups.map(g => g.label), ['日常', '亲密'], '服务端 levelLabel 的 LvN 前缀要剥掉')
  assert.deepEqual(groups.flatMap(g => g.actions).map(a => a.key), ['pat_head', 'brand_new_action'])
  assert.equal(groups[1].actions[0].wakes, true)

  const denied = groups[1].actions[0].gate
  assert.equal(denied.source, 'server')
  assert.equal(denied.allowed, false)
  assert.equal(denied.code, 'affinity_low')
  assert.equal(denied.message, '她还不愿意')
})

test('buildGroupsFromServer：payload 为空 / 无 actions → []（交给组件回落镜像）', () => {
  for (const bad of [null, undefined, {}, { actions: [] }, { actions: 'nope' }]) {
    assert.deepEqual(buildGroupsFromServer(bad), [])
  }
})

test('buildGroupsFromServer：服务端漏了某条 gate 时，该条回落镜像且 code 仍在白名单内', () => {
  const groups = buildGroupsFromServer({ actions: [{ key: 'touch_breast', label: '摸胸', level: 3, wakes: false }] })
  assert.equal(groups.length, 1)
  const gate = groups[0].actions[0].gate
  assert.equal(gate.source, 'mirror')
  assert.ok(TOUCH_GATE_CODES.includes(gate.code), '回落出来的 code 也必须是服务层白名单里的值')
})

test('buildGroupsFromServer：服务端未知等级也能分组显示（不静默丢动作）', () => {
  const groups = buildGroupsFromServer({
    actions: [{ key: 'future_action', label: '未来的动作', level: 4 }],
    gate: { future_action: { allowed: true, code: 'ok', message: '' } },
    levels: { 4: 'Lv4 未知' },
  })
  assert.deepEqual(groups.map(g => g.level), [4])
  assert.equal(groups[0].actions.length, 1, '服务端加了新等级，前端不该把它丢掉')
})

// ── 3. api 层真实请求形状 ──

async function captureRequests(run) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try { await run() } finally { globalThis.fetch = original }
  return calls
}

test('api：fetchTouchActions 拼查询串，performTouchAction 打 POST，fetchTouchState 走 state', async () => {
  const calls = await captureRequests(async () => {
    await fetchTouchActions(7, { scene: 'chat' })
    await performTouchAction(7, 'pat_head', { scene: 'chat' })
    await fetchTouchState(7)
  })
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, '/api/characters/7/touch/actions?scene=chat')
  assert.equal(calls[1].url, '/api/characters/7/touch/pat_head')
  assert.equal(calls[1].opts.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].opts.body), { scene: 'chat' })
  assert.equal(calls[2].url, '/api/characters/7/touch/state')
})

test('api：maxLevel / allowGroupAdult 只在传了时才进查询串', async () => {
  const calls = await captureRequests(async () => {
    await fetchTouchActions(3, { maxLevel: 2, allowGroupAdult: true })
    await fetchTouchActions(3)
  })
  assert.equal(calls[0].url, '/api/characters/3/touch/actions?maxLevel=2&allowGroupAdult=1')
  assert.equal(calls[1].url, '/api/characters/3/touch/actions', '不传参数就不该有问号')
})

// ── 4. ChatView.onTouchAction 真跑 ──

const actionNode = chatNodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'onTouchAction')
const actionSrc = actionNode ? chatScript.slice(actionNode.start, actionNode.end) : ''

function buildActionRunner(impl) {
  const toasts = []
  const posts = []
  const reloads = []
  const pendingReloads = []
  const state = {
    chat: { activeCharId: 9 },
    touchBusyActions: ref(new Set()),   // §4.2：单值 → Set（不同动作可并发）
    api: { performTouchAction: (...args) => { posts.push(args); return impl() } },
    toastFn: (msg, type) => toasts.push({ msg, type }),
    loadTouchActions: () => { reloads.push(1) },
    showTouchPanel: ref(false),
    // task-25 ③：动作做完待回应条数会变，onTouchAction 结束时要一并刷新
    loadTouchState: () => { pendingReloads.push(1) },
  }
  const factory = new Function('state', 'with (state) { ' + actionSrc + ' return onTouchAction }')
  return { run: factory(state), toasts, posts, reloads, pendingReloads, state }
}

test('POST 被拒（200 + allowed:false）→ 只 toast 服务端那句 message，不伪造反应', async () => {
  assert.ok(actionNode, 'onTouchAction 应存在')
  const r = buildActionRunner(() => Promise.resolve({
    allowed: false, code: 'affinity_low', message: '她现在还不愿意让你这样',
  }))
  await r.run('touch_breast')

  assert.deepEqual(r.posts, [[9, 'touch_breast', { scene: 'chat' }]])
  assert.equal(r.toasts.length, 1)
  assert.equal(r.toasts[0].msg, '她现在还不愿意让你这样')
  assert.equal(r.toasts[0].type, 'info')
  assert.equal(r.state.touchBusyActions.value.size, 0, 'busy 必须清掉')
  assert.equal(r.reloads.length, 1, '结束后刷新门控 / 腻烦')
  assert.equal(r.pendingReloads.length, 1, '结束后也刷新待回应条数（task-25 ③）')
})

test('POST 成功（instant）→ 不弹 toast、不自己插消息（交给既有广播渲染）', async () => {
  const r = buildActionRunner(() => Promise.resolve({ allowed: true, code: 'ok', mode: 'instant', reaction: { text: '……' } }))
  await r.run('pat_head')
  assert.equal(r.toasts.length, 0, '即时反应走消息流，不该再弹一句话')
  assert.equal(r.state.touchBusyActions.value.size, 0)
  assert.equal(r.reloads.length, 1)
  assert.equal(actionSrc.includes('messages.value'), false, '反应由既有广播链路渲染，onTouchAction 不许自己插消息')
})

test('POST 成功但回落隐式 → 提示她的反应下次发言时出现', async () => {
  const r = buildActionRunner(() => Promise.resolve({ allowed: true, mode: 'implicit', fallback: true, reason: 'instant_failed' }))
  await r.run('hug')
  assert.equal(r.toasts.length, 1)
  assert.equal(r.toasts[0].msg, '她的反应会在你下次发言时出现')
})

test('服务端 notice 原样透出（如即时反应配额用完）', async () => {
  const r = buildActionRunner(() => Promise.resolve({ allowed: true, mode: 'implicit', notice: '今日即时反应额度已用完，她的反应将在你下次发言时出现' }))
  await r.run('hug')
  assert.equal(r.toasts.length, 1)
  assert.equal(r.toasts[0].msg, '今日即时反应额度已用完，她的反应将在你下次发言时出现')
})

test('请求抛错（400 非法 action / 404 / 409 功能关闭）→ error toast 且 busy 清掉', async () => {
  const r = buildActionRunner(() => Promise.reject(new Error('动作系统已关闭')))
  await r.run('pat_head')
  assert.equal(r.toasts.length, 1)
  assert.equal(r.toasts[0].type, 'error')
  assert.equal(r.toasts[0].msg, '动作系统已关闭')
  assert.equal(r.state.touchBusyActions.value.size, 0)
  assert.equal(r.reloads.length, 1, '失败也要把 busy 清掉并刷新')
})

test('§4.2 连点：同动作在飞时忽略重复；**不同动作可并发**；没有活跃角色时不发请求', async () => {
  const same = buildActionRunner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  same.state.touchBusyActions.value = new Set(['pat_head'])
  await same.run('pat_head')
  assert.equal(same.posts.length, 0, '同动作飞行中不得重复 POST')

  const other = buildActionRunner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  other.state.touchBusyActions.value = new Set(['hug'])
  await other.run('pat_head')
  assert.equal(other.posts.length, 1, '§4.2：不同动作可以并发点（这是本轮的玩法）')

  const noChar = buildActionRunner(() => Promise.resolve({ allowed: true, mode: 'instant' }))
  noChar.state.chat.activeCharId = null
  await noChar.run('pat_head')
  assert.equal(noChar.posts.length, 0)
})

// ── 5. 接线（源码级） ──

test('动作条：有 serverGroups 就用服务端，没有才回落镜像；展开时通知父组件刷新', () => {
  assert.ok(barScript.includes('serverGroups: { type: Array'))
  assert.ok(barScript.includes('props.serverGroups && props.serverGroups.length'), '服务端优先')
  assert.ok(barScript.includes('buildActionGroups(props.state, props.actions)'), '无服务端时回落镜像')
  assert.ok(barScript.includes("emit('open')"), '展开时要发 open 让父组件刷门控')
  assert.ok(barTemplate.includes('v-for="group in groups"'))
})

test('ChatView 接线：拉服务端清单 + POST 上报 + 展开/切角色时刷新', () => {
  assert.ok(chatScript.includes('const touchServerGroups = ref([])'))
  assert.ok(chatScript.includes("api.fetchTouchActions(charId, { scene: 'chat' })"))
  assert.ok(chatScript.includes('touchServerGroups.value = buildGroupsFromServer(payload)'))
  // task-29 起这个 watch 多了「取消待合并刷新 + 重拉待回应条数」，所以不再断言整行了
  assert.ok(/watch\(\(\) => chat\.activeCharId, \(\) => \{[\s\S]{0,300}loadTouchActions\(\)/.test(chatScript),
    '切角色要重拉动作清单')
  assert.ok(chatScript.includes("api.performTouchAction(charId, actionId, { scene: 'chat' })"))
  assert.ok(chatScript.includes('res.allowed !== true'), '按 200 + allowed:false 的口径判拒绝（不是靠 catch）')
  assert.ok(chatScript.includes('touchServerGroups.value = []'), '端点失败要清空以回落镜像')
  assert.ok(chatTemplate.includes(':server-groups="touchServerGroups"'))
  assert.ok(chatTemplate.includes('@open="onTouchPanelOpen"'), '面板打开时刷新门控与玩具')
  // 玩具已改为**独立模块**（用户要求）：props / 事件挂在 <ToyPanel> 上，不再挂动作面板。
  // 「未解锁不渲染入口」由 toyPanel.test.js 钉（入口按钮带 v-if="toysEnabled"）。
  assert.ok(chatTemplate.includes(':worn-toys="wornToys"'), '必须传 worn-toys 给 ToyPanel')
  assert.ok(chatTemplate.includes(':open="showToyPanel"'), '要做独立面板的受控显隐')
  for (const ev of ['toy-equip', 'toy-intensity', 'toy-remove']) {
    assert.ok(chatTemplate.includes('@' + ev + '="'), 'ChatView 必须接 ' + ev)
  }
  assert.ok(/api\.fetchToys\(/.test(chatScript), '必须真的拉服务端玩具状态')
  assert.ok(/api\.equipToy\(/.test(chatScript), '装上必须真的 POST')
  assert.ok(/api\.removeToy\(/.test(chatScript), '摘下必须真的 POST')
})
