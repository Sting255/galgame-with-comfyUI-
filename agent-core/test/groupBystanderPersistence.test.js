/**
 * D4 · 群聊围观「谁围观」落库（规划-下一步-20260930 §D4 / §五 验收）
 *
 * 现状：概率模型（task-22 的 planTouchBystander）只决定「这一轮允不允许有人插话」，
 * 具体谁开口完全由模型临场决定 —— **没有任何结构记录**，所以「谁围观」不可查询、不可统计。
 *
 * 本次口径：
 *   1. 掷中 → 程序**选定**围观者（排除被摸者）并把选择**落库**到本轮群消息（messages.onlooker_char_id）；
 *   2. 掷不中 → 零围观（不落任何 onlooker）；
 *   3. 关闭概率模型（chance=null）→ 与 task-17 **逐字节**一致（零落库）；
 *   4. 选定者永远不是被摸者，且必须在本群成员里。
 *
 * 真实表结构 + 真实查库写入路径（:memory:，不联网）。先红后绿。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DB_PATH = ':memory:'
globalThis.fetch = async url => { throw new Error('bystander fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const {
  collectTouchActionBlocks,
  stampGroupRoundOnlooker,
} = await import('../src/services/groupChatEngine.js')

after(() => closeDb())

let seq = 0
function mkChar(name) {
  seq += 1
  return Number(getDb().prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')"
  ).run('on_' + seq + '_' + name, name).lastInsertRowid)
}
function mkGroup(memberIds) {
  const db = getDb()
  seq += 1
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('围观群' + seq, '测试').lastInsertRowid)
  for (const id of memberIds) db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id)
  return gid
}
function mkTouchEvent(groupId, characterId) {
  getDb().prepare(
    "INSERT INTO touch_events (character_id, group_id, action_key, mode, status, created_at) VALUES (?, ?, 'pat_head', 'implicit', 'pending', datetime('now'))"
  ).run(characterId, groupId)
}
const membersOf = gid => getDb().prepare(
  'SELECT c.id, c.display_name FROM group_members gm JOIN characters c ON c.id = gm.character_id WHERE gm.group_id = ?'
).all(gid)

test('① 程序选定：掷中时块里点名**具体**成员，且不是被摸者', () => {
  const touched = mkChar('被摸的')
  const other = mkChar('围观的')
  const gid = mkGroup([touched, other])
  mkTouchEvent(gid, touched)
  const hit = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: 1, bystanderRandom: () => 0 })
  assert.equal(hit.bystander.allowed, true)
  assert.equal(hit.bystander.memberId, other, '选定者必须是程序挑的那位')
  assert.notEqual(hit.bystander.memberId, hit.consumed.characterId, '不能是被摸的那位')
  assert.match(hit.blocks[1], /只让「围观的」/, 'prompt 里必须点名（而不是笼统"让某人插一句"）')
})

test('② 落库：选定者写进本轮群消息，且可按 onlooker_char_id 查回来（先红）', () => {
  const db = getDb()
  const cols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name)
  assert.ok(cols.includes('onlooker_char_id'), 'messages 必须有 onlooker_char_id 列')

  const touched = mkChar('被摸2')
  const other = mkChar('围观2')
  const gid = mkGroup([touched, other])
  const conversationId = 'group_' + gid
  const rawId = Number(db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '')").run(conversationId).lastInsertRowid)
  const insert = db.prepare("INSERT INTO messages (conversation_id, raw_id, role, content, images, seq, speaker_character_id) VALUES (?, ?, 'assistant', ?, NULL, ?, ?)")
  insert.run(conversationId, rawId, '被摸的话', 0, touched)
  insert.run(conversationId, rawId, '围观的话', 1, other)

  const ok = stampGroupRoundOnlooker(db, { rawId, onlookerCharId: other })
  assert.equal(ok, true, '写入应报成功')
  const rows = db.prepare('SELECT speaker_character_id, onlooker_char_id FROM messages WHERE raw_id = ? ORDER BY seq').all(rawId)
  assert.deepEqual(rows.map(r => r.onlooker_char_id), [other, other], '本轮每条群消息都带同一个围观者')
  const queried = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE onlooker_char_id = ?').get(other).n
  assert.equal(queried, 2, '可按 onlooker_char_id 查询统计')
})

test('③ 掷不中：零围观、零落库', () => {
  const db = getDb()
  const touched = mkChar('被摸3')
  const other = mkChar('围观3')
  const gid = mkGroup([touched, other])
  mkTouchEvent(gid, touched)
  const miss = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: 0, bystanderRandom: () => 0 })
  assert.equal(miss.bystander.allowed, false)
  assert.match(miss.blocks[1], /其他成员这一轮都不要发言/)
  const conversationId = 'group_' + gid
  const rawId = Number(db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '')").run(conversationId).lastInsertRowid)
  db.prepare("INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id) VALUES (?, ?, 'assistant', '她自己说话', 0, ?)").run(conversationId, rawId, touched)
  stampGroupRoundOnlooker(db, { rawId, onlookerCharId: miss.bystander.memberId })
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE raw_id = ? AND onlooker_char_id IS NOT NULL').get(rawId).n
  assert.equal(n, 0, '没掷中 ⇒ 一条 onlooker 都不许落')
})

test('④ 关闭概率模型：与 task-17 逐字节一致 + 零落库', () => {
  const touched = mkChar('被摸4')
  const other = mkChar('围观4')
  const gid = mkGroup([touched, other])
  mkTouchEvent(gid, touched)
  const off = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: null, bystanderRandom: () => 0 })
  assert.equal(off.bystander.chance, null)
  assert.equal(off.bystander.allowed, false)
  assert.equal(off.bystander.memberId, null, '关闭时不得预选任何人')
  assert.equal(
    off.blocks[1],
    '<touch_bystander>本轮是群聊：只让「被摸4」演出这一下接触的反应；其他成员**最多 1 个人**可以插一句围观 / 起哄的话（其余人这一轮不要发言），不要整群跟着刷屏。</touch_bystander>',
    '关闭态文案必须与 task-17 逐字节一致',
  )
})

test('⑤ 与动作块/催眠块不打架：选定者是群成员、且模块不自造第二个围观者', () => {
  const src = readFileSync(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8')
  // §5.1 纯搬家（2026-09-30）后：围观决策函数搬到 groupTouchConsumption.js，
  // groupChatEngine 只 re-export + 调用 —— 对外导出面不变，因此这条守卫指向新文件。
  const cluster = readFileSync(new URL('../src/services/groupTouchConsumption.js', import.meta.url), 'utf8')
  assert.match(cluster, /planTouchBystander\(\{/, '围观者选择必须继续走 task-22 的纯函数')
  assert.match(src, /stampGroupRoundOnlooker\(/, '群聊轮必须把选择落库')
  assert.match(src, /from '\.\/groupTouchConsumption\.js'/, 'groupChatEngine 必须继续导出这簇（对外面不变）')
  const touched = mkChar('被摸5')
  const other = mkChar('围观5')
  const gid = mkGroup([touched, other])
  mkTouchEvent(gid, touched)
  const hit = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: 1, bystanderRandom: () => 0 })
  const memberIds = membersOf(gid).map(m => m.id)
  assert.ok(memberIds.includes(hit.bystander.memberId), '选定者必须是本群成员')
  // 仍然只有一个围观者：块里只出现一次「只让「…」可以插一句」
  assert.equal((hit.blocks[1].match(/可以插一句围观/g) || []).length, 1)
})
