/**
 * §5.1 群聊引擎拆分 · 第 4 刀（反重复段 → groupAntiRepetition.js）的**行为不变**测试。
 *
 * 黄金快照：常量/签名、合并块的**精确 key 集合**与**块全文 sha256**、接线入口（collect）在
 * 真实库上的取数与判定结果、两条早退分支。搬完同一批必须全绿。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('anti-rep fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const eng = await import('../src/services/groupChatEngine.js')

after(() => closeDb())

const sha = s => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16)
const RESULT_KEYS = ['block', 'escalate', 'escalated', 'escalatedRunLength', 'lockedTopic', 'maxEscalatedOverlap', 'maxOverlap', 'mode', 'overlaps', 'reason', 'runLength', 'skipped', 'topicKeywords', 'topicLock', 'topicLockSource', 'topicProgressBlock', 'trend']
const TOPIC = 'A: 今晚去吃火锅吧'

let seq = 0
function fixture(rawCount) {
  seq += 1
  const a = Number(getDb().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, 'p')").run('ar' + seq, 'A').lastInsertRowid)
  const gid = Number(getDb().prepare("INSERT INTO group_chats (name, topic) VALUES (?, 't')").run('反重复群' + seq).lastInsertRowid)
  getDb().prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, a)
  const conv = 'group_' + gid
  for (let i = 0; i < rawCount; i += 1) {
    getDb().prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(conv, TOPIC)
  }
  const members = getDb().prepare('SELECT c.id, c.display_name FROM group_members gm JOIN characters c ON c.id = gm.character_id WHERE gm.group_id = ?').all(gid)
  return { gid, members, conv }
}

test('① 常量与签名不变', () => {
  assert.equal(eng.GROUP_ANTI_REPETITION_TURNS, 6)
  assert.deepEqual({
    hypno: eng.isWholeGroupHypnotized.length,
    build: eng.buildGroupAntiRepetitionBlock.length,
    collect: eng.collectGroupAntiRepetitionBlock.length,
  }, { hypno: 0, build: 0, collect: 1 })
})

test('② isWholeGroupHypnotized：空表 / 无状态 / 全群都没被控 → false（口径=「整群」）', () => {
  assert.equal(eng.isWholeGroupHypnotized([]), false)
  assert.equal(eng.isWholeGroupHypnotized([{ id: 999999 }]), false)
  const { members } = fixture(0)
  assert.equal(eng.isWholeGroupHypnotized(members), false)
})

test('③ 关掉开关：{enabled:false, block:null, result:null} 逐字段不变', () => {
  assert.deepEqual(eng.buildGroupAntiRepetitionBlock({ enabled: false }), { enabled: false, block: null, result: null })
})

test('④ 无轮次：block=null，result 的 key 集合逐项不变（17 个）', () => {
  const built = eng.buildGroupAntiRepetitionBlock({ turns: [] })
  assert.equal(built.enabled, true)
  assert.equal(built.block, null)
  assert.deepEqual(Object.keys(built.result).sort(), RESULT_KEYS)
})

test('⑤ 六条同话题文本轮：块全文 sha256 不变 + mode=escalated', () => {
  const synthetic = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, content: TOPIC }))
  const built = eng.buildGroupAntiRepetitionBlock({
    turns: synthetic, emotionSnapshots: [], hypnosisActive: false, escalationEnabled: true, textOnly: true, enabled: true,
  })
  assert.equal(sha(built.block), '1fd8163ea2532355')
  assert.ok(built.block.startsWith('<anti_repetition mode="escalated">'))
  assert.equal(built.result.mode, 'escalated')
  assert.equal(built.result.escalated, true)
  assert.deepEqual(Object.keys(built.result).sort(), RESULT_KEYS)
})

test('⑥ collectGroupAntiRepetitionBlock：真实库取数 + 判定逐项不变（7 条同话题 raw）', () => {
  const { gid, members } = fixture(7)
  const out = eng.collectGroupAntiRepetitionBlock({ id: gid, members }, {})
  assert.equal(out.enabled, true)
  assert.equal(out.turns.length, 6)          // GROUP_ANTI_REPETITION_TURNS
  assert.equal(out.emotionSnapshots.length, 0) // 群会话没有快照写入点
  assert.equal(sha(out.block), '1f6fbb4ec5ada2b0')
  assert.equal(out.result.mode, 'escalated')
  assert.equal(out.result.escalated, true)
  assert.equal(out.result.topicLock, true)          // 7 条同话题 ⇒ 话题锁判定成立（块仍被 escalated 抢走）
  assert.deepEqual(Object.keys(out.result).sort(), RESULT_KEYS)
})

test('⑦ 两条早退分支：非法群 id / 总开关关闭 → 零查询零块的 skipped 形状', () => {
  const skipped = { enabled: false, block: null, result: null, turns: [], emotionSnapshots: [] }
  assert.deepEqual(eng.collectGroupAntiRepetitionBlock({ id: 0 }, {}), skipped)
  const { gid, members } = fixture(3)
  const prev = config.features.antiRepetition
  config.features.antiRepetition = false
  try {
    assert.deepEqual(eng.collectGroupAntiRepetitionBlock({ id: gid, members }, {}), skipped)
  } finally {
    config.features.antiRepetition = prev
  }
})
