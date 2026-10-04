/**
 * D2 重写兜底 · 替换语义（docs/anti-repetition.md §12.4 冻结形状）
 *
 * 事件名：replace_last_assistant；形状：{ content, segments:[{content, emojiKeys, images}], reason, turn }
 * 要害：复用既有气泡（不追加）、末尾多出来的删掉（旧文本不残留）、**表情包与图片不能丢**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseJs } from '@babel/parser'
import { applyAssistantReplace } from '../src/utils/assistantReplace.js'

const storeScript = readFileSync(new URL('../src/stores/chat.js', import.meta.url), 'utf8')

function setup(count = 2) {
  const messages = []
  const bubbleIds = []
  for (let i = 0; i < count; i += 1) {
    const id = 'b' + i
    bubbleIds.push(id)
    messages.push({ id, role: 'assistant', type: 'text', content: '旧文本' + i, created_at: 'old', sticker_images: [{ url: 'e' + i }], images: [{ url: 'i' + i }] })
  }
  return { messages, bubbleIds }
}

test('复用既有气泡：只改内容，不新增消息（不重复）', () => {
  const { messages, bubbleIds } = setup(2)
  const before = messages.length
  applyAssistantReplace({ messages, bubbleIds, segments: [{ content: '新A' }, { content: '新B' }] })
  assert.equal(messages.length, before, '不许新增气泡')
  assert.deepEqual(messages.map(m => m.content), ['新A', '新B'])
  assert.deepEqual(bubbleIds, ['b0', 'b1'], 'id 列表保持不变')
  assert.equal(messages.some(m => m.content.includes('旧文本')), false, '旧文本不残留')
})

test('重写后气泡变少：末尾多出来的删掉（不残留旧的第二段）', () => {
  const { messages, bubbleIds } = setup(3)
  applyAssistantReplace({ messages, bubbleIds, segments: [{ content: '只剩一段' }] })
  assert.equal(messages.length, 1, '多出来的气泡被删除')
  assert.deepEqual(bubbleIds, ['b0'])
  assert.equal(messages[0].content, '只剩一段')
})

test('重写后气泡变多：新增消息、id 列表跟着长，不覆盖别人', () => {
  const { messages, bubbleIds } = setup(1)
  applyAssistantReplace({ messages, bubbleIds, segments: [{ content: 'A' }, { content: 'B' }], uid: () => 'new-id' })
  assert.equal(messages.length, 2)
  assert.deepEqual(bubbleIds, ['b0', 'new-id'])
  assert.deepEqual(messages.map(m => m.content), ['A', 'B'])
})

test('图片：给了非空 urls 就换；没给 / 空数组 → **保持原样（不丢）**', () => {
  const a = setup(1)
  applyAssistantReplace({ messages: a.messages, bubbleIds: a.bubbleIds, segments: [{ content: 'x', images: ['u1', 'u2'] }] })
  assert.deepEqual(a.messages[0].images, [{ url: 'u1', base64: null }, { url: 'u2', base64: null }])

  const b = setup(1)
  applyAssistantReplace({ messages: b.messages, bubbleIds: b.bubbleIds, segments: [{ content: 'x' }] })
  assert.deepEqual(b.messages[0].images, [{ url: 'i0' }], '没给 images 不能把图丢掉')

  const c = setup(1)
  applyAssistantReplace({ messages: c.messages, bubbleIds: c.bubbleIds, segments: [{ content: 'x', images: [] }] })
  assert.deepEqual(c.messages[0].images, [{ url: 'i0' }], '空数组同样不丢')
})

test('表情包：emojiKeys 缺失不动；空数组＝这轮没表情（清掉）；非空 → 保留原有（key 换不出 url，宁可不换也不丢）', () => {
  const a = setup(1)
  applyAssistantReplace({ messages: a.messages, bubbleIds: a.bubbleIds, segments: [{ content: 'x' }] })
  assert.deepEqual(a.messages[0].sticker_images, [{ url: 'e0' }], '字段缺失 → 不动')

  const b = setup(1)
  applyAssistantReplace({ messages: b.messages, bubbleIds: b.bubbleIds, segments: [{ content: 'x', emojiKeys: [] }] })
  assert.deepEqual(b.messages[0].sticker_images, [], '显式空 → 清掉')

  const c = setup(1)
  applyAssistantReplace({ messages: c.messages, bubbleIds: c.bubbleIds, segments: [{ content: 'x', emojiKeys: ['k1'] }] })
  assert.deepEqual(c.messages[0].sticker_images, [{ url: 'e0' }], '非空 → 保留（不丢表情）')
})

test('store 接线：认 replace_last_assistant，并调这个纯函数', () => {
  assert.ok(storeScript.includes('replace_last_assistant'), '要认冻结后的事件名')
  assert.ok(/lastEvent === 'replace_last_assistant'/.test(storeScript), '要在事件分支里判它（不是只在注释里）')
  assert.ok(storeScript.includes('applyAssistantReplace'), '要复用一个可单测的纯函数')
  assert.ok(/from '..\/utils\/assistantReplace.js'/.test(storeScript), '要 import')
})
test('stickerUrls（契约定名）：非空就覆盖 sticker_images；缺失 / 空数组 → 保持原样', () => {
  const a = setup(1)
  applyAssistantReplace({ messages: a.messages, bubbleIds: a.bubbleIds, segments: [{ content: 'x', stickerUrls: ['s1', 's2'] }] })
  assert.deepEqual(a.messages[0].sticker_images, [{ url: 's1', base64: null }, { url: 's2', base64: null }], '给了 url 要换')

  const b = setup(1)
  applyAssistantReplace({ messages: b.messages, bubbleIds: b.bubbleIds, segments: [{ content: 'x' }] })
  assert.deepEqual(b.messages[0].sticker_images, [{ url: 'e0' }], '没给 stickerUrls 不能动表情')

  const c = setup(1)
  applyAssistantReplace({ messages: c.messages, bubbleIds: c.bubbleIds, segments: [{ content: 'x', stickerUrls: [] }] })
  assert.deepEqual(c.messages[0].sticker_images, [{ url: 'e0' }], '空数组同样保持原样')
})

test('优先级：有 stickerUrls 用 url；没 url 才退回 emojiKeys 的保留/清空规则', () => {
  const a = setup(1)
  applyAssistantReplace({ messages: a.messages, bubbleIds: a.bubbleIds, segments: [{ content: 'x', stickerUrls: ['s9'], emojiKeys: ['k1'] }] })
  assert.deepEqual(a.messages[0].sticker_images, [{ url: 's9', base64: null }], 'url 优先于 key')

  const b = setup(1)
  applyAssistantReplace({ messages: b.messages, bubbleIds: b.bubbleIds, segments: [{ content: 'x', emojiKeys: [] }] })
  assert.deepEqual(b.messages[0].sticker_images, [], '没 url 时退回 emojiKeys 规则')

  const c = setup(1)
  applyAssistantReplace({ messages: c.messages, bubbleIds: c.bubbleIds, segments: [{ content: 'x', emojiKeys: ['k1'] }] })
  assert.deepEqual(c.messages[0].sticker_images, [{ url: 'e0' }], '没 url 时保留')
})

