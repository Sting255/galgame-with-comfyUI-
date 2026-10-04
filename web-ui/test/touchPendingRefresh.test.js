/**
 * task-29 · 群聊 pendingCount 接线 + 消费后刷新（复审 §10.2 问题 2/3）
 *
 * 问题 2：GroupChatView grep pendingCount = 0 —— 群聊口径要拉
 *         GET /api/characters/:id/touch/state?scene=group&groupId=<n>（不传 = 旧行为 / 私聊口径）。
 * 问题 3：隐式动作被下一轮聊天消费后没有刷新钩子 ⇒「她明明回应了，提示还在」——
 *         在既有的 messages 变化钩子里补一次刷新，且**同一轮多条消息只刷一次**，
 *         并保留「换角色 / 换对象丢弃过期响应」的竞态守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc } from '@vue/compiler-sfc'

import { fetchTouchState } from '../src/api/index.js'
import { createCoalescer } from '../src/components/touchActionLogic.js'

const chat = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor
const chatScript = chat.scriptSetup.content
const chatTemplate = chat.template.content
const group = parseSfc(readFileSync(new URL('../src/views/GroupChatView.vue', import.meta.url), 'utf8')).descriptor
const groupScript = group.scriptSetup.content
const groupTemplate = group.template.content

// ── 1. 契约：touch/state 的查询串 ──

function withCapturedFetch(fn) {
  const urls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, json: async () => ({ pendingCount: 0 }) }
  }
  return Promise.resolve().then(fn).then(
    () => { globalThis.fetch = original; return urls },
    (err) => { globalThis.fetch = original; throw err },
  )
}

test('touch/state 查询串：不传参数 = 旧行为；scene/groupId 按需带上', async () => {
  const urls = await withCapturedFetch(async () => {
    await fetchTouchState(7)
    await fetchTouchState(7, { scene: 'chat' })
    await fetchTouchState(7, { scene: 'group', groupId: 3 })
    await fetchTouchState(7, { scene: 'group', groupId: 0 })
    await fetchTouchState(7, { scene: 'group', groupId: null })
  })
  assert.equal(urls[0], '/api/characters/7/touch/state', '不传参数必须与旧行为逐字节一致')
  assert.equal(urls[1], '/api/characters/7/touch/state?scene=chat')
  assert.equal(urls[2], '/api/characters/7/touch/state?scene=group&groupId=3')
  assert.equal(urls[3], '/api/characters/7/touch/state?scene=group&groupId=0', 'groupId=0 也要带上（别当假值丢掉）')
  assert.equal(urls[4], '/api/characters/7/touch/state?scene=group', 'groupId 为空就不带该参数')
})

test('fetchTouchState 返回体带 pendingCount（透传给调用方，不在 api 层加工）', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ pendingCount: 4, quota: {} }) })
  try {
    const res = await fetchTouchState(7)
    assert.equal(res.pendingCount, 4)
  } finally {
    globalThis.fetch = original
  }
})

// ── 2. 合并器：同一轮多条消息只刷一次 ──

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
  }
}

test('createCoalescer：窗口内的重复 schedule 被合并，只跑一次', () => {
  const runs = []
  const { timers, setTimer, clearTimer } = fakeTimers()
  const c = createCoalescer({ delay: 300, run: () => runs.push(1), setTimer, clearTimer })

  assert.equal(c.schedule(), true, '第一次要真的排上')
  assert.equal(c.schedule(), false, '同一轮第二条消息要被合并')
  assert.equal(c.schedule(), false)
  assert.equal(timers.length, 1, '只挂一个定时器（别把请求打爆）')
  assert.equal(timers[0].ms, 300)
  assert.equal(runs.length, 0, '窗口没到之前不跑')

  timers[0].fn()
  assert.equal(runs.length, 1, '一次窗口只刷一次')
  assert.equal(c.schedule(), true, '窗口过了可以再排')
  assert.equal(timers.length, 2)
})

test('createCoalescer：cancel 能拦住待执行的刷新（切角色时用）', () => {
  const runs = []
  const { timers, setTimer, clearTimer } = fakeTimers()
  const c = createCoalescer({ delay: 300, run: () => runs.push(1), setTimer, clearTimer })
  c.schedule()
  assert.equal(c.cancel(), true)
  assert.equal(timers[0].cleared, true)
  assert.equal(c.pending, false)
  assert.equal(c.cancel(), false, '没得取消时返回 false')
  assert.equal(runs.length, 0)
})

// ── 3. ChatView：消息变化后合并刷新，且保留竞态守卫 ──

test('ChatView：messages 变化触发合并刷新，不再只靠切角色/点动作', () => {
  const watchAt = chatScript.indexOf('watch(() => chat.messages.length')
  assert.ok(watchAt >= 0, '要有既有的 messages.length 监听')
  const body = chatScript.slice(watchAt, watchAt + 1200)
  assert.ok(body.includes('scheduleTouchStateRefresh'), '既有的消息监听里要补一次待回应刷新')
  assert.ok(chatScript.includes('createCoalescer'), '要用合并器，别每条消息都打一次请求')
  assert.ok(/function scheduleTouchStateRefresh|const scheduleTouchStateRefresh/.test(chatScript))
})

test('ChatView：竞态守卫还在（换角色丢弃过期响应）+ 切角色时取消待刷', () => {
  assert.ok(chatScript.includes('if (chat.activeCharId !== charId) return'), '过期响应要丢弃')
  const watchAt = chatScript.indexOf('watch(() => chat.activeCharId')
  const body = chatScript.slice(watchAt, watchAt + 400)
  assert.ok(body.includes('loadTouchState'), '切角色要立刻刷一次')
  assert.ok(body.includes('cancel') || body.includes('touchStateCoalescer'), '还要取消上一轮待执行的合并刷新')
})

// ── 4. GroupChatView：群聊口径 ──

test('GroupChatView：按 scene=group&groupId 拉 pendingCount，并传给动作面板', () => {
  const at = groupScript.indexOf('async function loadTouchState')
  assert.ok(at >= 0, '要有 loadTouchState')
  // 只看这个函数体：别被 loadTouchActions / performTouchAction 里那两处 scene: 'group' 蒙混过去
  const body = groupScript.slice(at, at + 700)
  assert.ok(body.includes('fetchTouchState'), 'loadTouchState 必须调 fetchTouchState（不是 fetchTouchActions）')
  assert.ok(/scene: 'group'/.test(body), '群聊口径要带 scene=group')
  assert.ok(/groupId/.test(body), '要带 groupId')
  assert.ok(groupScript.includes('touchPendingCount'), '要有本地状态')
  assert.ok(groupTemplate.includes(':pending-count="touchPendingCount"'), '要传给 TouchActionPanel')
})

test('GroupChatView：对齐后端群聊口径（整群计数）+ 换群丢弃过期响应 + 消息变化合并刷新', () => {
  // 后端 §3.8：群聊口径是**整个群**的、不按 character 过滤 ⇒ 路径角色只是用来定位会话
  const pathAt = groupScript.indexOf('function touchPathId')
  assert.ok(pathAt >= 0, '要有路径角色选择')
  const pathBody = groupScript.slice(pathAt, pathAt + 200)
  assert.ok(/touchTargetId/.test(pathBody), '优先用选中的对象')
  assert.ok(/members/.test(pathBody) && /\[0\]/.test(pathBody), '没选对象时回落群内第一个成员（否则没选人就不显示提示）')
  assert.ok(/store\.activeGroupId !== groupId/.test(groupScript), '换了群要丢弃过期响应')
  assert.ok(/touchPathId\(\) !== pathId/.test(groupScript), '路径角色变了也要丢弃')
  assert.ok(/payload && payload\.pendingCount/.test(groupScript), '读的是生效场景的 pendingCount')
  assert.ok(groupScript.includes('createCoalescer'), '群聊同样要合并，别打爆')
  assert.ok(/scheduleTouchStateRefresh|touchStateCoalescer\.schedule\(\)/.test(groupScript), '消息变化要触发刷新')
})

test('GroupChatView：没选对象 / 没进群时不显示提示（归零）', () => {
  assert.ok(/touchPendingCount\.value = 0/.test(groupScript), '拿不到对象/群时归零')
})
