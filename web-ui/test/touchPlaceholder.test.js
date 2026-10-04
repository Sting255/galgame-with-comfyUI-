/**
 * 专题 §八 8.2 可选加强 · 等待期占位气泡
 *
 * 目标：消除「点完 3~5 秒静默」。规则：
 *  · 只在她**真会立刻反应**时插（隐式模式不插）；本地 id + `placeholder:'touch'` 标记定位；
 *  · 真消息（proactive_message）/ update 到达 → 撤；**15 秒超时兜底**；切角色 / 清空消息也撤；
 *  · 绝不按内容或位置删 —— 免得误删她的真消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const chatSrc = readFileSync(new URL('../src/stores/chat.js', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')

const start = chatSrc.indexOf('const TOUCH_PLACEHOLDER_TEXT')
const end = chatSrc.indexOf('function handleProactiveMessage(data) {')
assert.ok(start > 0 && end > start, '要能定位占位气泡那一段')
const BLOCK = chatSrc.slice(start, end)

function build(seed = []) {
  const timers = []
  const state = {
    messages: { value: seed.slice() },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length },
    clearTimeout: id => { const t = timers[id - 1]; if (t) t.cleared = true },
    Date,
  }
  const api = new Function('state', 'with (state) { ' + BLOCK + '; return { showTouchPlaceholder, clearTouchPlaceholder, TOUCH_PLACEHOLDER_TEXT, TOUCH_PLACEHOLDER_TIMEOUT_MS } }')(state)
  return { ...api, state, timers, get msgs() { return state.messages.value } }
}

test('插占位：一条本地气泡、typing 态、带标记与本地 id；超时 15 秒', () => {
  const b = build()
  b.showTouchPlaceholder()
  assert.equal(b.msgs.length, 1)
  const p = b.msgs[0]
  assert.equal(p.placeholder, 'touch', '要有本地标记（精确定位用）')
  assert.equal(p.typing, true, 'typing 态')
  assert.ok(p.id.startsWith('touch-placeholder-'), '本地 id 前缀')
  assert.equal(p.role, 'assistant')
  assert.equal(p.content, b.TOUCH_PLACEHOLDER_TEXT)
  assert.ok(b.TOUCH_PLACEHOLDER_TEXT.length <= 20, '文案要短（实测 ' + b.TOUCH_PLACEHOLDER_TEXT.length + ' 字）')
  assert.equal(b.TOUCH_PLACEHOLDER_TIMEOUT_MS, 15000)
  assert.equal(b.timers.length, 1, '要挂一个超时兜底')
  assert.equal(b.timers[0].ms, 15000)
})

test('真消息到达 → 移除占位（且只删占位，不碰她的真消息）', () => {
  const b = build()
  // 真消息**排在前面**，且文案与占位**一模一样** —— 这样「按内容删」的实现会误删她，测试才咬得住
  b.state.messages.value.push({ id: 'real-1', role: 'assistant', type: 'text', content: b.TOUCH_PLACEHOLDER_TEXT })
  b.showTouchPlaceholder()
  assert.equal(b.msgs.length, 2)
  b.clearTouchPlaceholder()
  assert.equal(b.msgs.length, 1, '只剩真消息')
  assert.equal(b.msgs[0].id, 'real-1', '**同样文案的真消息不能被误删**')
  assert.equal(b.timers[0].cleared, true, '定时器也要清掉（不残留）')
})

test('超时兜底：到点自动移除（异常 / 广播没来也不残留）', () => {
  const b = build()
  b.showTouchPlaceholder()
  assert.equal(b.msgs.length, 1)
  b.timers[0].fn()   // 模拟 15 秒到点
  assert.equal(b.msgs.length, 0, '到点必须自己消失')
})

test('连点不堆叠：重复插只保留一条', () => {
  const b = build()
  b.showTouchPlaceholder()
  b.showTouchPlaceholder()
  b.showTouchPlaceholder()
  assert.equal(b.msgs.length, 1, '连点也只留一条')
  assert.equal(b.timers.filter(t => !t.cleared).length, 1, '旧定时器被清掉，不会误删后来的占位')
})

test('移除路径齐全：proactive_message / update / 切角色 / 清空消息都撤', () => {
  const at = chatSrc.indexOf('function handleProactiveMessage(data) {')
  const head = chatSrc.slice(at, chatSrc.indexOf('\n', at) + 400)
  assert.ok(head.includes('clearTouchPlaceholder()'), 'proactive_message 到达要撤')
  const up = chatSrc.indexOf('function handleProactiveMessageUpdate(data) {')
  assert.ok(chatSrc.slice(up, up + 400).includes('clearTouchPlaceholder()'), 'update 到达也要撤')
  for (const fn of ['async function loadMessages(charId) {', 'async function selectChar(charId) {', 'async function clearActiveMessages() {']) {
    const i = chatSrc.indexOf(fn)
    assert.ok(i > 0, fn + ' 应存在')
    assert.ok(chatSrc.slice(i, i + 200).includes('clearTouchPlaceholder()'), fn + ' 要撤占位（切角色 / 清空）')
  }
  assert.ok(chatSrc.includes('showTouchPlaceholder, clearTouchPlaceholder }'), '要导出给视图用')
})

test('建议 2：乐观插入（POST **之前**）、且在连点守卫之后', () => {
  const at = chatView.indexOf('chat.showTouchPlaceholder')
  assert.ok(at > 0, 'ChatView 要调用')
  const awaitAt = chatView.indexOf('await api.performTouchAction')
  assert.ok(awaitAt > 0)
  assert.ok(at < awaitAt, '必须插在 await POST **之前** —— 否则占位赶不上它要盖住的静默期（建议 2 的核心）')
  assert.ok(chatView.slice(Math.max(0, at - 400), at).includes('touchBusyActions.value.has(actionId)'), '要在连点守卫之后')
  assert.ok(chatView.indexOf('showTouchPlaceholder') < chatView.indexOf("if (!res || res.allowed !== true)"),
    '要在门控判定之前（乐观插入）')
})

test('撤回路径：隐式 / 被拒 / 异常三处都撤（她是真不会反应，占位不能留）', () => {
  // 只看 onTouchAction 这一段 —— 文件里别处也有 res.notice / catch，全局 indexOf 会指错地方
  const tail = chatView.slice(chatView.indexOf('async function onTouchAction'))
  assert.ok(/if \(res\.mode === 'implicit'\)[^\n]*clearTouchPlaceholder/.test(tail),
    '§4.2 起不再自动收起；隐式模式撤占位（那轮她不会立刻反应）')
  assert.ok(/res\.allowed !== true\) \{[\s\S]{0,200}?clearTouchPlaceholder/.test(tail), '被拒要撤占位')
  assert.ok(/\} catch \(err\) \{[\s\S]{0,200}?clearTouchPlaceholder/.test(tail), '异常要撤占位')
})
