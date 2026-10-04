/**
 * §5.1 群聊引擎拆分 · 第 3 刀（出图簇 → groupImagePipeline.js）的**行为不变**测试。
 *
 * 设计要点：
 *   · **只用公有导出**（`ensureForcedClimaxImage` / `defaultForcedClimaxPrompt` /
 *     `buildForcedClimaxImageMessages` / `groupConvId`）—— 因为 `emitGroupImageFor` 与
 *     `generateGroupImage` 在搬家前是模块私有，测试必须搬家前后都能 import；
 *     这两个私有函数的行为通过 `ensureForcedClimaxImage` 的副作用（新建气泡 + raw 图片行 +
 *     image_tasks 落库 + 事件）间接钉住。
 *   · **不写真盘**：生图桩一律走失败分支（`images: []`），避免测试往图片目录写文件；
 *     真实成功路径由既有 e2e/真机链路覆盖（本文件刻意不碰文件系统）。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('image pipeline fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const eng = await import('../src/services/groupChatEngine.js')

after(() => closeDb())

let seq = 0
function mkChar(name, prompt) {
  seq += 1
  return Number(getDb().prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)"
  ).run('img_' + seq + '_' + name, name, prompt || '人格').lastInsertRowid)
}
function mkGroup(ids) {
  seq += 1
  const gid = Number(getDb().prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('出图群' + seq, 't').lastInsertRowid)
  for (const id of ids) getDb().prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id)
  return gid
}
const membersOf = gid => getDb().prepare(
  'SELECT c.id, c.display_name, c.name, c.base_prompt FROM group_members gm JOIN characters c ON c.id = gm.character_id WHERE gm.group_id = ?'
).all(gid)
const failRunner = async () => ({ success: false, error: 'stub-fail', images: [] })

test('① 导出面与签名不变（4 个公有符号 + .length）', () => {
  assert.equal(typeof eng.ensureForcedClimaxImage, 'function')
  assert.equal(typeof eng.defaultForcedClimaxPrompt, 'function')
  assert.equal(typeof eng.buildForcedClimaxImageMessages, 'function')
  assert.deepEqual({
    ensure: eng.ensureForcedClimaxImage.length,
    fallback: eng.defaultForcedClimaxPrompt.length,
    messages: eng.buildForcedClimaxImageMessages.length,
    convId: eng.groupConvId.length,
  }, { ensure: 1, fallback: 1, messages: 0, convId: 1 })
  assert.equal(eng.groupConvId(7), 'group_7')
})

test('② 兜底画面描述逐字节不变（不依赖入参）', () => {
  const expected = '1girl, intimate scene, flushed face, trembling body, sweat, disheveled hair, closed eyes, heavy breathing, indoor bedroom, warm dim lamp light, soft focus, close-up'
  assert.equal(eng.defaultForcedClimaxPrompt({ display_name: 'A' }), expected)
  assert.equal(eng.defaultForcedClimaxPrompt(null), expected)
})

test('③ buildForcedClimaxImageMessages 三条消息逐字节不变（含最近 6 条 raw）', () => {
  const a = mkChar('A', '人格A')
  const gid = mkGroup([a])
  const group = { id: gid, members: membersOf(gid) }
  const conv = eng.groupConvId(gid)
  const db = getDb()
  const rawId = Number(db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '')").run(conv).lastInsertRowid)
  db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'user', '<user_message read_only=\"true\">\n你好\n</user_message>')").run(conv)
  db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', 'A: 在的')").run(conv)
  const messages = eng.buildForcedClimaxImageMessages({ group, character: group.members[0], rawId, userName: '用户' })
  assert.equal(messages.length, 3)
  assert.deepEqual(messages.map(m => m.role), ['system', 'system', 'user'])
  assert.equal(messages[2].content, '现在生成这张图的英文画面描述。')
  assert.ok(messages[0].content.startsWith('人格A'))
  assert.ok(messages[0].content.includes('群聊最近的剧本：'))
  assert.ok(messages[0].content.includes('A: 在的'))
  assert.ok(messages[1].content.includes('【当前画面生成规则·最高优先级】'))
  assert.ok(messages[1].content.includes('A 刚刚在群聊里被用户用催眠指令强制带上了高潮'))
})

test('④ ensureForcedClimaxImage 三条早退分支不变（空表 / 已发过图 / 成员不在群里）', async () => {
  const a = mkChar('A'); const b = mkChar('B')
  const gid = mkGroup([a])
  const group = { id: gid, members: membersOf(gid) }
  assert.equal(await eng.ensureForcedClimaxImage([], { group, written: [], rawLines: [], emit: () => {}, imagePromises: [] }), false)
  assert.equal(await eng.ensureForcedClimaxImage([{ id: a }], {
    group, written: [{ id: 1, hasImage: true, speaker_character_id: a }], rawLines: [], emit: () => {}, imagePromises: [],
  }), false)
  assert.equal(await eng.ensureForcedClimaxImage([{ id: b }], {
    group, written: [], rawLines: [], emit: () => {}, imagePromises: [],
  }), false)
})

test('⑤ 模型给了描述：新气泡 + raw 图片行 + image_tasks 落库 + 事件（行为不变）', async () => {
  const a = mkChar('A')
  const gid = mkGroup([a])
  const group = { id: gid, members: membersOf(gid) }
  const conv = eng.groupConvId(gid)
  const db = getDb()
  const rawId = Number(db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '')").run(conv).lastInsertRowid)
  const written = []; const rawLines = []; const events = []; const imagePromises = []
  const ok = await eng.ensureForcedClimaxImage([{ id: a }], {
    group, written, rawLines, rawId, imagePromises,
    emit: (name, data) => events.push({ name, data }),
    deps: { imagePromptChat: async () => 'a girl on a rooftop, night' },
    options: { generateImage: failRunner },
  })
  assert.equal(ok, true)
  assert.equal(imagePromises.length, 1)
  // raw 剧本追加的是协议格式的图片行
  assert.deepEqual(rawLines, ['', '[A]: {a girl on a rooftop, night}'])
  // 新建了一条空文本气泡承载图片，并广播出去
  assert.equal(written.length, 1)
  assert.equal(written[0].content, '')
  assert.equal(written[0].hasImage, true)
  assert.equal(written[0].speaker_character_id, a)
  assert.ok(events.some(e => e.name === 'group_msg' && e.data.speaker_character_id === a))
  assert.ok(events.some(e => e.name === 'generate_start' && e.data.speaker_character_id === a))
  // 落库：气泡 + image_tasks（running→failed，桩刻意失败，避免写真盘）
  const bubble = db.prepare('SELECT id, content, images FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv)
  assert.equal(bubble.content, '')
  assert.equal(bubble.images, null)
  const task = db.prepare('SELECT conversation_id, source_msg_id, prompt_original, status FROM image_tasks ORDER BY id DESC LIMIT 1').get()
  assert.equal(task.conversation_id, conv)
  assert.equal(task.source_msg_id, bubble.id)
  assert.equal(task.prompt_original, 'a girl on a rooftop, night')
  assert.equal(task.status, 'failed')
  assert.ok(events.some(e => e.name === 'generate_error'))
})

test('⑥ 模型返回空描述：走兜底描述（行为不变）', async () => {
  const a = mkChar('A')
  const gid = mkGroup([a])
  const group = { id: gid, members: membersOf(gid) }
  const written = []; const rawLines = []; const imagePromises = []
  const ok = await eng.ensureForcedClimaxImage([{ id: a }], {
    group, written, rawLines, imagePromises,
    emit: () => {},
    deps: { imagePromptChat: async () => '' },
    options: { generateImage: failRunner },
  })
  assert.equal(ok, true)
  assert.equal(imagePromises.length, 1)
  assert.equal(rawLines[1], '[A]: {' + eng.defaultForcedClimaxPrompt(group.members[0]) + '}')
})

test('⑦ 依赖面守卫：搬走的 groupConvId 必须仍被引擎绑定（最近记录注入簇实测）', () => {
  // 事故复现（2026-09-30 · cb78f7f 那次集成红 15 条，根因实证）：
  // 第 3 刀把 groupConvId 搬进 groupImagePipeline.js 后，引擎有一小段"已删定义、未加 import"的窗口，
  // 于是所有调 groupConvId 的地方（含 buildRecentGroupLogBlock）抛 groupConvId is not defined。
  // 这条守卫把「引擎仍能拿到 groupConvId + 最近记录注入照常工作」钉死。
  assert.equal(typeof eng.groupConvId, 'function', 'groupConvId 必须仍能从 groupChatEngine 导入')
  assert.equal(eng.groupConvId(42), 'group_42')
  assert.equal(typeof eng.buildRecentGroupLogBlock, 'function')

  const db = new Database(':memory:')
  db.exec('CREATE TABLE group_chats (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, last_message_at DATETIME); CREATE TABLE group_members (group_id INTEGER NOT NULL, character_id INTEGER NOT NULL); CREATE TABLE raw_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL); CREATE TABLE rolling_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, end_msg_id INTEGER NOT NULL DEFAULT 0, summary TEXT, checkpoint_version INTEGER NOT NULL DEFAULT 0);')
  const at = min => new Date(Date.now() - min * 60000).toISOString().slice(0, 19).replace('T', ' ')
  const gid = Number(db.prepare('INSERT INTO group_chats (name, last_message_at) VALUES (?, ?)').run('宵夜群', at(1)).lastInsertRowid)
  db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, 42)
  const conv = eng.groupConvId(gid)
  // 与既有簇测试同构：发图行与台词拆成两行（{\"prompt\":\"…\"} 形式，剥除路径已被既有 9 例证明）
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conv, 'assistant', '[A]: 我在楼下等你\n[A]: {\"prompt\":\"a girl at the gate, night\"}')
  db.prepare('INSERT INTO rolling_summaries (conversation_id, end_msg_id, summary, checkpoint_version) VALUES (?, ?, ?, 1)').run(conv, 10, '他们约好去吃宵夜')

  const block = eng.buildRecentGroupLogBlock(db, 42, '用户')
  assert.ok(block.includes('<group_chat_log>'), '活跃群必须注入')
  assert.ok(block.includes('宵夜群'), '要注明群名')
  assert.ok(block.includes('他们约好去吃宵夜'), '要带群聊摘要')
  assert.ok(block.includes('我在楼下等你'), '要带最近两轮记录')
  assert.ok(!block.includes('a girl at the gate'), '生图行必须被剥掉')
  const gid2 = Number(db.prepare('INSERT INTO group_chats (name, last_message_at) VALUES (?, ?)').run('沉寂群', at(30)).lastInsertRowid)
  db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid2, 42)
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(eng.groupConvId(gid2), 'assistant', 'B: 有人吗')
  const block2 = eng.buildRecentGroupLogBlock(db, 42, '用户')
  assert.ok(!block2.includes('沉寂群'), '超过 5 分钟的群不得注入')
  db.close()
})
