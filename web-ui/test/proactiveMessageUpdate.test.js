/**
 * 专题 §八 8.2 · 私聊两段式：`proactive_message_update` 把图补到那条文字气泡上
 *
 * payload（后端定，未落地前按此写并标注）：{ msg_id, raw_id, images }
 * 要点：按 msg_id 挂到**正确的那条**文字后面 / 重复 update **不重复挂** / 找不到 msg_id **安全忽略**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const stream = readFileSync(new URL('../src/stores/unifiedStream.js', import.meta.url), 'utf8')
const chatSrc = readFileSync(new URL('../src/stores/chat.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

function handlerSource() {
  const at = chatSrc.indexOf('function handleProactiveMessageUpdate')
  assert.ok(at >= 0, 'chat store 要有 handleProactiveMessageUpdate')
  const end = chatSrc.indexOf('\n  }', at)
  return chatSrc.slice(at, end + 4)
}

function run(messages, data) {
  let n = 0
  const state = {
    messages: { value: messages },
    uid: () => 'new-' + (++n),
    clearTouchPlaceholder: () => {},   // §8.2 起 handler 会顺带撤等待期占位（另见 touchPlaceholder.test.js）
  }
  const fn = new Function('state', 'with (state) { ' + handlerSource() + '; return handleProactiveMessageUpdate }')(state)
  fn(data)
  return messages
}

const text = id => ({ id, role: 'assistant', type: 'text', content: '她的话' })
const img = urls => ({ type: 'image_gen', images: urls.map(u => ({ url: u })) })

test('分发表登记了 proactive_message_update', () => {
  assert.ok(/proactive_message_update:\s*d => _dispatch\('proactive_message_update', d\)/.test(stream))
})

test('App.vue 订阅该事件并交给 chat store', () => {
  assert.ok(app.includes("onStreamEvent('proactive_message_update'"), '要订阅')
  assert.ok(app.includes('handleProactiveMessageUpdate'), '要交给 store')
})

test('按 msg_id 把图挂到**正确那条**文字后面（不是无脑 push 到末尾）', () => {
  const msgs = [text('m1'), text('m2')]
  run(msgs, { msg_id: 'm1', raw_id: 7, images: ['u1'] })
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1].type, 'image_gen', '插在 m1 紧后面')
  assert.equal(msgs[2].id, 'm2', 'm2 还在（没被顶掉）')
  assert.deepEqual(msgs[1].images, [{ url: 'u1', base64: null }])
  assert.equal(msgs[1].genStatus, 'done')
})

test('重复 update → 不重复挂（alreadyHas 去重）', () => {
  const msgs = [text('m1'), img(['u1'])]
  run(msgs, { msg_id: 'm1', raw_id: 7, images: ['u1'] })
  assert.equal(msgs.length, 2, '同一批图不重复挂')
})

test('同一锚点换一批图 → 允许再挂（不是同批就不算重复）', () => {
  const msgs = [text('m1'), img(['u1'])]
  run(msgs, { msg_id: 'm1', raw_id: 7, images: ['u2'] })
  assert.equal(msgs.length, 3, '不同批图应当再挂一条')
})

test('找不到 msg_id / 空 images → 安全忽略，不新建气泡', () => {
  const a = [text('m1')]
  run(a, { msg_id: 'nope', images: ['u1'] })
  assert.equal(a.length, 1, '找不到锚点不新建')
  const b = [text('m1')]
  run(b, { msg_id: 'm1', images: [] })
  assert.equal(b.length, 1, '没有图不动')
  const c = [text('m1')]
  run(c, { images: ['u1'] })
  assert.equal(c.length, 1, '没有 msg_id 不动')
  const d = [text('m1')]
  run(d, null)
  assert.equal(d.length, 1, 'null 不炸')
})
