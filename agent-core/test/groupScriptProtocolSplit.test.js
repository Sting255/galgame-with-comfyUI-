/**
 * §5.1 群聊引擎拆分 · 第 2 刀（协议/解析纯函数簇 → groupScriptProtocol.js）的**行为不变**测试。
 *
 * 黄金快照：搬之前先抓死这一簇的逐字节输出（协议块用 sha256 钉全文）+ 导出面/签名；
 * 搬完同一批必须全绿。零 DB 依赖（只用 :memory: 初始化 config）。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('proto fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { closeDb } = await import('../src/db/index.js')
const eng = await import('../src/services/groupChatEngine.js')

after(() => closeDb())

const A = { id: 11, display_name: 'A' }
const B = { id: 12, display_name: 'B' }
const map = new Map([['A', A], ['B', B]])
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)

test('① 导出面与签名不变（8 个函数 + .length）', () => {
  assert.deepEqual({
    parseScriptLine: eng.parseScriptLine.length,
    mergeGroupContinuationEmoji: eng.mergeGroupContinuationEmoji.length,
    extractEmbeddedGroupImagePrompt: eng.extractEmbeddedGroupImagePrompt.length,
    formatGroupImageLine: eng.formatGroupImageLine.length,
    buildProtocolBlock: eng.buildProtocolBlock.length,
    detectMentions: eng.detectMentions.length,
    detectMentionAll: eng.detectMentionAll.length,
    formatGroupUserMessage: eng.formatGroupUserMessage.length,
  }, {
    parseScriptLine: 2, mergeGroupContinuationEmoji: 2, extractEmbeddedGroupImagePrompt: 1,
    formatGroupImageLine: 2, buildProtocolBlock: 0, detectMentions: 2, detectMentionAll: 1,
    formatGroupUserMessage: 1,
  })
})

test('② buildProtocolBlock 逐字节不变（sha256 钉全文；2026-10-04 因生图规范新增"角色只能来自素材"一条而更新）', () => {
  // 这个协议块里嵌了全局生图规范 `IMAGE_PROMPT_RULE`（断言见下一行）。2026-10-01 按用户要求重写了
  // 那条规范：把"禁止半脱、衣着只能全换或不动"改成"必须精确描述衣着状态（含拉开/褪下的部分状态）"，
  // 并新增一节"身体与动作必须直述、不许用委婉语或回避镜头"。
  //
  // 2026-10-04 **再次更新**（用户实测：出图画的是 Nahida 那类版权角色，不是他名下的角色）：
  // 在 Hard Rules 里**新增一条** —— "Only the characters you were given."：
  // 画面主体只能来自随场景给出的外观锚点；禁止引入场景里没有的角色、
  // 禁止凭空写出场景没给过的作品/系列名。
  // 原规则**一个字没删、一处没改**，纯新增 ⇒ 文本有意再变长：7470 → 7968 字符，sha 随之改变。
  // 这里更新的仍然只是**钉子本身**，它钉住的仍是"这块文本必须稳定，改动了就会被发现"；
  // 同时**加强**：多钉一条"新规则确实嵌在这块里"，防止有人把这条规范从协议块里摘出去。
  const s = eng.buildProtocolBlock()
  assert.equal(s.length, 7968)
  assert.equal(sha(s), '0f51daa86245c8ac')
  assert.ok(s.includes('Priority order: what the bodies are doing'), '生图规范确实嵌在这块里（改规范就要更新本钉子）')
  assert.ok(s.includes('Only the characters you were given'), '2026-10-04 新增的"角色只能来自素材"一条必须在协议块里')
  assert.ok(s.startsWith('<group_chat_rules>'))
  assert.ok(s.endsWith('</group_chat_rules>'))
})

test('③ formatGroupUserMessage 三态不变（新写入 / 幂等 / 旧格式剥离）', () => {
  assert.equal(eng.formatGroupUserMessage('你好'), '<user_message read_only="true">\n你好\n</user_message>')
  assert.equal(eng.formatGroupUserMessage('<user_message read_only="true">\n已有\n</user_message>'),
    '<user_message read_only="true">\n已有\n</user_message>')
  assert.equal(eng.formatGroupUserMessage('[用户]: 旧格式'), '<user_message read_only="true">\n旧格式\n</user_message>')
})

test('④ extractEmbeddedGroupImagePrompt 五种输入不变', () => {
  assert.deepEqual(eng.extractEmbeddedGroupImagePrompt('给你看 {a girl in a yukata on a rooftop}'),
    { prompt: 'a girl in a yukata on a rooftop', text: '给你看' })
  assert.equal(eng.extractEmbeddedGroupImagePrompt('只有台词没有括号'), null)
  assert.deepEqual(eng.extractEmbeddedGroupImagePrompt('{prompt: "wrapped desc"}'), { prompt: 'wrapped desc', text: '' })
  assert.deepEqual(eng.extractEmbeddedGroupImagePrompt('{}'), { prompt: null, text: '' })
  assert.deepEqual(eng.extractEmbeddedGroupImagePrompt('前面 {one} 中间 {two} 后面'),
    { prompt: 'one, two', text: '前面 中间 后面' })
})

test('⑤ formatGroupImageLine 不变', () => {
  assert.equal(eng.formatGroupImageLine('A', ' desc '), '[A]: {desc}')
})

test('⑥ mergeGroupContinuationEmoji 两例不变', () => {
  assert.deepEqual(eng.mergeGroupContinuationEmoji({ content: 'x', images: ['u1'] }, ' y', new Map(), []),
    { content: 'x\ny', images: ['u1'], hasImage: true })
  assert.deepEqual(eng.mergeGroupContinuationEmoji({ content: '', images: [] }, ' z', new Map(), []),
    { content: 'z', images: [], hasImage: false })
})

test('⑦ parseScriptLine 十二例不变（含 [END] / 非成员 / 占位符 / 续写 / 花括号）', () => {
  assert.deepEqual(eng.parseScriptLine('A: 你好', map), { speaker: A, text: '你好' })
  assert.deepEqual(eng.parseScriptLine('B：这是全角冒号', map), { speaker: B, text: '这是全角冒号' })
  assert.deepEqual(eng.parseScriptLine('[END]', map), { end: true })
  assert.deepEqual(eng.parseScriptLine('end', map), { end: true })
  assert.equal(eng.parseScriptLine('C: 不是成员', map), null)
  assert.equal(eng.parseScriptLine('A: {}', map), null)
  assert.equal(eng.parseScriptLine('A: 发了一张图片', map), null)
  assert.equal(eng.parseScriptLine('A: <image_sent />', map), null)
  assert.equal(eng.parseScriptLine('A: [拍了一张图]', map), null)
  assert.deepEqual(eng.parseScriptLine('  没有说话人的续写行  ', map), { continuation: '没有说话人的续写行' })
  assert.deepEqual(eng.parseScriptLine('没有说话人 {a cat on the table}', map),
    { continuation: '没有说话人', imagePrompt: 'a cat on the table' })
  assert.equal(eng.parseScriptLine('', map), null)
})

test('⑧ detectMentions / detectMentionAll 不变', () => {
  assert.deepEqual(eng.detectMentions('@A 你好 B', [A, B]).map(m => m.display_name), ['A'])
  assert.equal(eng.detectMentions('谁都不提', [A, B]).length, 0)
  assert.equal(eng.detectMentionAll('@全体成员 都出来'), true)
  assert.equal(eng.detectMentionAll('@所有人'), true)
  assert.equal(eng.detectMentionAll('@A'), false)
})
