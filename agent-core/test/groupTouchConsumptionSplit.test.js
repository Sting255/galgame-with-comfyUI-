/**
 * §5.1 群聊引擎拆分 · 第 1 刀（动作消费簇 → groupTouchConsumption.js）的**行为不变**测试。
 *
 * 目的：抽之前先钉住这簇的**逐字节输出**与**导出面/签名**；搬完同一批必须全绿。
 * 这些断言只描述"对外行为"，不关心代码在哪个文件里（唯一例外：③的源码位置守卫在搬家后指向新文件）。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('split fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const eng = await import('../src/services/groupChatEngine.js')

after(() => closeDb())

const NAME_WHO = 'A'
const RULE_NULL = `<touch_bystander>本轮是群聊：只让「A」演出这一下接触的反应；其他成员**最多 1 个人**可以插一句围观 / 起哄的话（其余人这一轮不要发言），不要整群跟着刷屏。</touch_bystander>`
const RULE_ALLOWED = `<touch_bystander>本轮是群聊：只让「A」演出这一下接触的反应；其他成员**只让「B」**可以插一句围观 / 起哄的话（其余人这一轮不要发言），不要整群跟着刷屏。</touch_bystander>`
const RULE_DENIED = `<touch_bystander>本轮是群聊：只让「A」演出这一下接触的反应；**其他成员这一轮都不要发言**，不要整群跟着刷屏。</touch_bystander>`
const BLOCK_ACTION = `<touch_action>
【本节只对「A」生效：以下所有"你"一律指A，其它成员不受影响、也不知情】
【刚刚的接触】用户 对你做了「摸头」：用户伸手轻轻摸了摸你的头。
【你的耐受】还乐意（她对这一下没有不耐烦）
【你的偏好】谈不上偏好（偏好倍率 1.00）
【这一轮怎么写】
- 把这一下的即时反应写进你这一轮的回复里（一两句体感 / 表情 / 台词就够），再继续应对 用户 说的话。
- 用体感与反应表达，不要报幕（不要写"用户摸了摸我的头"这种复述），也不要把它当话题清单念出来。
- 这是真实发生过的肢体接触，不许装作没发生。
</touch_action>`

let seq = 0
function mkChar(name) {
  seq += 1
  return Number(getDb().prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')"
  ).run('split_' + seq + '_' + name, name).lastInsertRowid)
}
function mkGroup(ids) {
  seq += 1
  const gid = Number(getDb().prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('拆分群' + seq, 't').lastInsertRowid)
  for (const id of ids) getDb().prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id)
  return gid
}
function mkEvent(groupId, characterId, actionKey = 'pat_head', mode = 'implicit') {
  return Number(getDb().prepare(
    "INSERT INTO touch_events (character_id, group_id, action_key, mode, status, created_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'))"
  ).run(characterId, groupId, actionKey, mode).lastInsertRowid)
}
const membersOf = gid => getDb().prepare(
  'SELECT c.id, c.display_name FROM group_members gm JOIN characters c ON c.id = gm.character_id WHERE gm.group_id = ?'
).all(gid)

test('① 导出面与签名不变（六个符号 + .length + 默认概率常量）', () => {
  assert.equal(typeof eng.DEFAULT_TOUCH_BYSTANDER_CHANCE, 'number')
  assert.equal(eng.DEFAULT_TOUCH_BYSTANDER_CHANCE, 0.3)
  assert.deepEqual({
    resolve: eng.resolveTouchBystanderChance.length,
    plan: eng.planTouchBystander.length,
    rule: eng.buildTouchBystanderRule.length,
    collect: eng.collectTouchActionBlocks.length,
    stamp: eng.stampGroupRoundOnlooker.length,
  }, { resolve: 0, plan: 0, rule: 1, collect: 1, stamp: 1 })
})

test('② 围观规则块三态逐字节不变（含空名回落「她」）', () => {
  assert.equal(eng.buildTouchBystanderRule(NAME_WHO, { chance: null }), RULE_NULL)
  assert.equal(eng.buildTouchBystanderRule(NAME_WHO, { chance: 0.3, allowed: true, otherName: 'B' }), RULE_ALLOWED)
  assert.equal(eng.buildTouchBystanderRule(NAME_WHO, { chance: 0.3, allowed: false }), RULE_DENIED)
  assert.equal(eng.buildTouchBystanderRule('', { chance: null }), RULE_NULL.replace('「A」', '「她」'))
})

test('③ 概率解析六种输入不变（undefined/null/false/越界/非数字）', () => {
  assert.deepEqual([
    eng.resolveTouchBystanderChance(undefined),
    eng.resolveTouchBystanderChance(null),
    eng.resolveTouchBystanderChance(false),
    eng.resolveTouchBystanderChance(1.5),
    eng.resolveTouchBystanderChance(-1),
    eng.resolveTouchBystanderChance('abc'),
  ], [0.3, null, null, 1, 0, 0.3])
})

test('④ 围观决策三种情形不变（命中/未命中/无他人可选）', () => {
  const a = mkChar('A'); const b = mkChar('B')
  const members = [{ id: a, display_name: 'A' }, { id: b, display_name: 'B' }]
  assert.deepEqual(eng.planTouchBystander({ members, excludeId: a, chance: 1, random: () => 0 }),
    { chance: 1, roll: 0, allowed: true, member: members[1] })
  assert.deepEqual(eng.planTouchBystander({ members, excludeId: a, chance: 0, random: () => 0.9 }),
    { chance: 0, roll: 0.9, allowed: false, member: null })
  assert.deepEqual(eng.planTouchBystander({ members: [{ id: a }], excludeId: a, chance: 1, random: () => 0 }),
    { chance: 1, roll: 0, allowed: false, member: null })
})

test('⑤ 动作消费的整份返回值逐字节不变（真实表 + 注入随机源）', () => {
  const a = mkChar('A'); const b = mkChar('B')
  const gid = mkGroup([a, b])
  const evId = mkEvent(gid, a)
  const out = eng.collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: 1, bystanderRandom: () => 0 })
  assert.equal(out.blocks.length, 2)
  assert.equal(out.blocks[0], BLOCK_ACTION)
  assert.equal(out.blocks[1], RULE_ALLOWED)
  assert.deepEqual(out.consumed, { id: evId, characterId: a, actionKey: 'pat_head', name: 'A', mode: 'implicit' })
  assert.deepEqual(out.bystander, { chance: 1, roll: 0, allowed: true, memberId: b })
  assert.equal(out.expired, 0)
  assert.equal(out.dropped, 0)
  // 消费即完成：事件被推到 injected（只注入一次）
  assert.equal(getDb().prepare('SELECT status FROM touch_events WHERE id = ?').get(evId).status, 'injected')
})

test('⑥ 关闭总开关 / 非法群 / 无事件 三条早退分支不变', () => {
  const a = mkChar('A'); const b = mkChar('B')
  const gid = mkGroup([a, b])
  const prev = config.features.touch
  config.features.touch = false
  assert.deepEqual(eng.collectTouchActionBlocks({ id: gid, members: membersOf(gid) }), { blocks: [], consumed: null, expired: 0, dropped: 0 })
  config.features.touch = prev
  assert.deepEqual(eng.collectTouchActionBlocks({ id: 0, members: [] }), { blocks: [], consumed: null, expired: 0, dropped: 0 })
  assert.deepEqual(eng.collectTouchActionBlocks({ id: gid, members: membersOf(gid) }), { blocks: [], consumed: null, expired: 0, dropped: 0 })
})

test('⑦ D4 落库入口三个分支不变（缺参 → false；正常 → true 且写满本轮气泡）', () => {
  const db = getDb()
  const a = mkChar('A'); const b = mkChar('B')
  const gid = mkGroup([a, b])
  assert.equal(eng.stampGroupRoundOnlooker(db, { rawId: 0, onlookerCharId: b }), false)
  assert.equal(eng.stampGroupRoundOnlooker(db, { rawId: 1, onlookerCharId: null }), false)
  const conv = 'group_' + gid
  const rawId = Number(db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', '')").run(conv).lastInsertRowid)
  db.prepare("INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id) VALUES (?, ?, 'assistant', 'x', 0, ?)").run(conv, rawId, a)
  assert.equal(eng.stampGroupRoundOnlooker(db, { rawId, onlookerCharId: b }), true)
  assert.equal(db.prepare('SELECT onlooker_char_id FROM messages WHERE raw_id = ?').get(rawId).onlooker_char_id, b)
})
