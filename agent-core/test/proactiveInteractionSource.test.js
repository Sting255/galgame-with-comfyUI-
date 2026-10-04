/**
 * §4.1 核实：`last_interaction_at` 的系统写入会不会污染**主动聊天判定**
 * （审查规划「规划-代码审查改进-20260930.md」§4.1，优先级表第 2 位）
 *
 * **核实结论：证伪（在 proactiveChatScheduler 这条链上）**
 *   1. 调度器两处 `hoursSince` 都读 **`messages` 里 role='user' 的最后一条**
 *      （`proactiveChatScheduler.js:824-835` 主路径、`:1185-1189` force 路径），
 *      **全文不出现 `last_interaction_at`**；
 *   2. 全仓读 `user_relationships.last_interaction_at` 的只有 `routes/chat.js:658`（另一条链，不在本任务范围）；
 *      另有一堆 `last_interaction_at` 命中属于**别的表**（`character_events` / `town_npc_events`），同名不同表；
 *   3. 「从未互动过的角色」语义本来就是对的：没有 user 消息 ⇒ `hoursSince=null` ⇒ `computeProactiveScore` 当 999 档（最高分）。
 *
 * 因此本文件是**前提测试**（防第四次踩坑）：钉住「主动聊天的时间来源只能是用户发言」，
 * 以后谁把 `hoursSince` 改成读 `user_relationships.last_interaction_at`，这里会红。
 *
 * 真实表结构 + 真实查库路径（:memory:，不联网）。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DB_PATH = ':memory:'
globalThis.fetch = async url => { throw new Error('proactive interaction fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const { loadAffinity, saveAffinity, setOath } = await import('../src/services/emotionEngine.js')
const { computeProactiveScore, resolveHoursSinceLastUserMessage } = await import('../src/services/proactiveChatScheduler.js')

after(() => closeDb())

let seq = 0
function mkChar(name) {
  seq += 1
  return Number(getDb().prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')"
  ).run('pro_' + seq + '_' + name, name).lastInsertRowid)
}
const addUserMessage = id => getDb().prepare(
  "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', '你好')"
).run('char_' + id)
const relRow = id => getDb().prepare(
  'SELECT affinity, relationship_text, last_interaction_at FROM user_relationships WHERE character_id = ?'
).get(id)

test('① 从未互动过的角色：没有关系行 ⇒ loadAffinity 返回默认 50', () => {
  const id = mkChar('未互动')
  assert.equal(relRow(id), undefined, '前提：库里没有这行')
  assert.equal(loadAffinity(id), 50, '默认就是 50（中间值）')
})

test('② 隐患的这一半成立：系统写入（saveAffinity 默认 updateLastInteraction=true）会建行并把 last_interaction_at 刷成 now', () => {
  const id = mkChar('系统写入')
  saveAffinity(id, 55)
  const row = relRow(id)
  assert.ok(row, '顺手建了关系行（关系文本为空串）')
  assert.equal(row.affinity, 55)
  assert.equal(row.relationship_text, '')
  assert.ok(row.last_interaction_at, '⚠️ 系统写入确实刷新了 last_interaction_at —— 这就是审查担心的那半')
})

test('③ 证伪：主动聊天判定读的是**用户发言**，系统写入动不了它（真实查库路径）', () => {
  const id = mkChar('只被系统写过')
  saveAffinity(id, 55)                  // 系统写入
  assert.ok(relRow(id)?.last_interaction_at, 'DB 层的 last_interaction_at 已被写')
  assert.equal(
    resolveHoursSinceLastUserMessage('char_' + id), null,
    '但调度器口径：没有任何 role=user 的消息 ⇒ hoursSince 仍是 null（999 档）',
  )
  const never = computeProactiveScore(null, 55, { valence: 0.5, arousal: 0.5, dominance: 0.5 })
  const justNow = computeProactiveScore(0, 55, { valence: 0.5, arousal: 0.5, dominance: 0.5 })
  assert.ok(never > justNow + 0.3, '从未聊过必须是最高档：' + never.toFixed(3) + ' vs ' + justNow.toFixed(3))
  assert.ok(never > 0.7, '从未互动 → 高分（active 触发），实际 ' + never.toFixed(3))
})

test('④ 对照：只有**用户真的发言**才会把 hoursSince 拉下来（分数随之下降）', () => {
  const id = mkChar('用户聊过')
  addUserMessage(id)
  const hours = resolveHoursSinceLastUserMessage('char_' + id)
  assert.ok(hours !== null && hours >= 0 && hours < 0.01, '刚发的 user 消息 ⇒ hoursSince≈0，实际 ' + hours)
  const score = computeProactiveScore(hours, 50, { valence: 0.5, arousal: 0.5, dominance: 0.5 })
  const never = computeProactiveScore(null, 50, { valence: 0.5, arousal: 0.5, dominance: 0.5 })
  assert.ok(score < never - 0.3, '刚聊过要显著低于从未聊过：' + score.toFixed(3) + ' vs ' + never.toFixed(3))
})

test('⑤ 源码级守卫：调度器的时间来源只能是 messages+role=user，且不得引入 last_interaction_at', () => {
  const src = readFileSync(new URL('../src/services/proactiveChatScheduler.js', import.meta.url), 'utf8')
  // 剥掉注释再断言：注释里可以解释这件事，**代码**里不许出现这个字段
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.match(code, /WHERE conversation_id = \? AND role = 'user'/, 'hoursSince 必须来自 messages 的 user 发言')
  assert.doesNotMatch(code, /last_interaction_at/, '调度器代码不得读 last_interaction_at（系统写入会污染它）')
  // 注：调度器**另有**一处合法读关系表（L311 `SELECT relationship_text, is_oath`，给问候语拼关系上下文），
  // 那是既有用途、与本隐患无关 ⇒ 这里只钉"不得读 last_interaction_at"这一个字段。
  const uses = (code.match(/resolveHoursSinceLastUserMessage\(conversationId\)/g) || []).length
  assert.equal(uses, 2, '两条路径（主 + force）都必须走同一个 helper，实际 ' + uses)
})

test('⑥ 记录在案：setOath 的 INSERT 分支同样会写 last_interaction_at（属"用户动作"链，非本隐患，但一并钉住）', () => {
  const id = mkChar('誓约')
  setOath(id, 1)
  const row = relRow(id)
  assert.equal(row.affinity, 50)
  assert.ok(row.last_interaction_at, 'setOath 建行时也写时间戳')
  assert.equal(resolveHoursSinceLastUserMessage('char_' + id), null, '但同样不影响主动聊天判定（没有 user 消息）')
})
