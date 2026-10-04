/**
 * 玩具侧两条遗留的红测试（专题 §2.4 表末行 + §2.7 出图）：
 *   ① 睡着时调**高**强度 ⇒ 必须把她弄醒（复用 scheduleManager.tempWake），反应 prompt 里带「刚被惊醒」；
 *      强度 1~2 ⇒ 不唤醒（口径 = toyService.toyWakePlan，即 gateToy 返回的 wakesOnIntensity 的消费点）。
 *   ② 玩具反应**两段式**：文字先广播（images: []）→ 出图不 await → 图好补 proactive_message_update；
 *      出图失败 ⇒ 只有文字、不发 update。
 */

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
const realFetch = globalThis.fetch
let base = ''
globalThis.fetch = async (url, init) => {
  if (base && String(url).startsWith(base)) return realFetch(url, init)
  throw new Error('toy fixture forbids network: ' + url)
}

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const toys = await import('../src/services/toyService.js')
const sched = await import('../src/services/scheduleManager.js')
const toysRoutes = (await import('../src/routes/toys.js')).default

let server = null
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/characters', toysRoutes)
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  closeDb()
})

let seq = 0
function mkChar(name) {
  seq += 1
  return Number(getDb().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')").run('tw' + seq + '_' + name, name).lastInsertRowid)
}
const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  let json = null
  try { json = await res.json() } catch (err) { json = null }
  return { status: res.status, body: json }
}

test('① toyWakePlan：睡着 + 高强度要唤醒并带「刚被惊醒」；睡着 + 低强度不唤醒；没睡着不涉及', () => {
  const high = toys.toyWakePlan({ sleeping: true, intensity: 5 })
  assert.equal(high.wake, true)
  assert.ok(high.extraContext.includes('刚被惊醒'), '反应 prompt 要带这个事实')
  const low = toys.toyWakePlan({ sleeping: true, intensity: 1 })
  assert.equal(low.wake, false)
  assert.ok(low.extraContext.includes('没有把她弄醒'))
  assert.equal(toys.toyWakePlan({ sleeping: false, intensity: 5 }).wake, false)
  assert.equal(toys.TOY_WAKE_INTENSITY, 3)
})

test('② applyToyWake：睡着+高强度才调 tempWake（spy 验三支）；真实 tempWake 冒烟写 temporary_wake_until', () => {
  const calls = []
  const spy = id => calls.push(id)
  const high = toys.applyToyWake({ characterId: 5, sleeping: true, intensity: 5, tempWake: spy })
  assert.equal(high.wake, true)
  assert.equal(high.woke, true)
  assert.deepEqual(calls, [5])
  assert.equal(toys.applyToyWake({ characterId: 5, sleeping: true, intensity: 1, tempWake: spy }).woke, false)
  assert.equal(toys.applyToyWake({ characterId: 5, sleeping: false, intensity: 5, tempWake: spy }).woke, false)
  assert.deepEqual(calls, [5], '低强度/没睡着都不许调 tempWake')
  assert.equal(toys.applyToyWake({ characterId: 5, sleeping: true, intensity: 5 }).woke, false, '没注入 tempWake 就只报判定')
  // 真实机制冒烟（route 里注入的就是它）：确实会写 temporary_wake_until
  const { tempWake, getSleepStatus } = sched
  const id = mkChar('冒烟')
  const res = tempWake(id)
  assert.equal(res.ok, true)
  assert.ok(getSleepStatus(id).temporaryWakeUntil, 'tempWake 会写 temporary_wake_until')
})

test.skip('②b 路由级（睡着需要日程快照，:memory: 里造不出真实睡眠态）', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('睡美人')
    const db = getDb()
    db.prepare("INSERT INTO character_worn_toys (character_id, toy_key, intensity, status, equip_count, equipped_at, updated_at) VALUES (?, 'vibe_egg', 0, 'worn', 1, datetime('now'), datetime('now'))").run(id)
    db.prepare("UPDATE characters SET is_sleeping = 1, sleep_until = datetime('now', '+3 hours') WHERE id = ?").run(id)
    const r = await post('/api/characters/' + id + '/toys/vibe_egg/set-intensity', { intensity: 5 })
    assert.equal(r.status, 200)
    assert.equal(r.body.toy.intensity, 5)
    const row = db.prepare('SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?').get(id)
    assert.equal(Number(row.is_sleeping), 0, '高强度必须把她弄醒（tempWake）')
    assert.ok(row.temporary_wake_until, 'tempWake 要写 temporary_wake_until')
    assert.ok(r.body.wake && r.body.wake.wake === true, '响应里要带回唤醒事实')

    // 低强度：先让她重新睡着，再调到 1 ⇒ 不该醒
    db.prepare("UPDATE characters SET is_sleeping = 1, sleep_until = datetime('now', '+3 hours'), temporary_wake_until = NULL WHERE id = ?").run(id)
    const r2 = await post('/api/characters/' + id + '/toys/vibe_egg/set-intensity', { intensity: 1 })
    assert.equal(r2.status, 200)
    assert.equal(Number(db.prepare('SELECT is_sleeping FROM characters WHERE id = ?').get(id).is_sleeping), 1)
    assert.equal(Boolean(r2.body.wake && r2.body.wake.wake), false)
  } finally { config.features.toys = prev }
})

test('③ publishToyReaction 两段式：文字先到（images: []）→ 图好补 update（带 msg_id/raw_id/images）', async () => {
  const order = []
  let release = null
  const held = new Promise(resolve => { release = resolve })
  // 多段反应：她的反应被分句成两条气泡（11 / 12），图写进**最后一条**（attachImages(lastMsgId)）
  const written = { firstMsgId: 11, lastMsgId: 12, rawId: 33, segments: ['唔……'], msgIds: [11, 12] }
  const attachAnchors = []
  const result = toys.publishToyReaction({
    character: { id: 7, display_name: '她', avatar_path: null },
    reactionText: '唔……（腿一软）',
    imagePrompt: 'a girl on the bed, thighs pressed together',
    source: 'toy',
    deps: {
      writeMessage: () => written,
      broadcastText: data => order.push(['text', data]),
      broadcastUpdate: data => order.push(['update', data]),
      attachImages: (msgId, urls) => { attachAnchors.push(msgId); return urls },
      generateImage: async () => { order.push(['generate']); return held },
    },
  })
  assert.equal(order.filter(o => o[0] === 'text').length, 1, '文字必须先广播')
  assert.equal(order.some(o => o[0] === 'update'), false, '图没好之前不许发 update')
  const textEvent = order.find(o => o[0] === 'text')[1]
  assert.deepEqual(textEvent.images, [])
  assert.equal(textEvent.msg_id, 11, '文字那条 proactive_message 仍带 firstMsgId（它的契约是 msg_ids + 首条）')
  assert.equal(textEvent.source, 'toy')
  release({ urls: ['/images/a.png'], prompt: 'p', promptRefined: 'p' })
  await result.imagePromise
  const update = order.find(o => o[0] === 'update')
  assert.ok(update, '图好了必须补 proactive_message_update')
  // ⚠️ 2026-10-03 复查（另一位审查者发现的"图会跑"）：这里原来断言 msg_id: 11（firstMsgId），
  //    而图其实是挂进 lastMsgId 那一行的 ⇒ 直播时图跟在**第一段**后面、刷新后跳到最后一段。
  //    `reactionImageUpdate` 现在优先认 lastMsgId，所以这条断言改成 12，并**顺带钉住**
  //    "实时广播的锚 == 落库挂图的锚"（两个 id 必须相同）。
  assert.deepEqual(update[1], { msg_id: 12, raw_id: 33, images: ['/images/a.png'] })
  assert.deepEqual(attachAnchors, [12], '图挂的是最后一条气泡')
  assert.equal(update[1].msg_id, attachAnchors[0], '实时广播的锚必须 == 落库挂图的锚（同一条气泡）')
})

test('④ publishToyReaction 出图失败：只有文字、不发 update', async () => {
  const events = []
  const result = toys.publishToyReaction({
    character: { id: 8, display_name: '她', avatar_path: null },
    reactionText: '嗯…',
    imagePrompt: 'x',
    deps: {
      writeMessage: () => ({ firstMsgId: 21, lastMsgId: 22, rawId: 44, segments: ['嗯…'], msgIds: [21] }),
      broadcastText: () => events.push('text'),
      broadcastUpdate: () => events.push('update'),
      attachImages: (msgId, urls) => urls,
      generateImage: async () => { throw new Error('comfy down') },
    },
  })
  await result.imagePromise
  assert.deepEqual(events, ['text'], '失败 ⇒ 只有文字')
})
