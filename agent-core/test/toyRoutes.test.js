/**
 * 玩具系统 · 路由契约测试（专题 §2.9-2；契约以 web-ui/src/api/index.js 的四个函数为准）。
 *
 * 覆盖：开关关（GET 空清单 + 写接口 403）/ 门控不过 403 / 允许路径全链路（项圈：好感 60 免授权）
 * / 未佩戴 404 / 未知玩具 404 / 非法 id 400。
 * LLM 一律打桩失败（fetch reject）—— 反应是增强项，不应影响穿戴状态。
 */

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
// LLM 只打桩：**只放行本测试自己的服务器**（base 在 before 里赋值），其余出网一律拒 → 反应走失败分支（增强项）
const realFetch = globalThis.fetch
let base = ''
globalThis.fetch = async (url, init) => {
  if (base && String(url).startsWith(base)) return realFetch(url, init)
  throw new Error('toy route fixture forbids network: ' + url)
}

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const { saveAffinity } = await import('../src/services/emotionEngine.js')
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
  return Number(getDb().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')").run('rt' + seq + '_' + name, name).lastInsertRowid)
}

const api = async (path, init) => {
  const res = await fetch(base + path, init)
  let body = null
  try { body = await res.json() } catch (err) { body = null }
  return { status: res.status, body }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

test('① 开关关（默认）：GET 返回 unlocked:false + 空清单；三个写接口 403 toys_disabled', async () => {
  const prev = config.features.toys
  config.features.toys = false
  try {
    const id = mkChar('A')
    const list = await api('/api/characters/' + id + '/toys')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body, { unlocked: false, worn: [], available: [] })
    for (const [path, body] of [['/equip', { intensity: 2 }], ['/set-intensity', { intensity: 2 }], ['/remove', {}]]) {
      const r = await post('/api/characters/' + id + '/toys/vibe_egg' + path, body)
      assert.equal(r.status, 403, path + ' 应 403')
      assert.equal(r.body.error, 'toys_disabled')
    }
  } finally { config.features.toys = prev }
})

test('② 开关开 + 好感 50：清单 5 件、**跳蛋不再被门控拦**（2026-10-04「玩具限制全删」）⇒ 装上 200', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('B')
    const list = await api('/api/characters/' + id + '/toys')
    assert.equal(list.body.unlocked, true)
    assert.equal(list.body.available.length, 5)
    assert.deepEqual(list.body.available.map(a => a.toyKey), ['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp', 'collar'])
    const egg = list.body.available.find(a => a.toyKey === 'vibe_egg')
    // 原先：好感 50 差 Lv4 的 80 ⇒ allowed:false / gate.code 'affinity_low'
    assert.equal(egg.allowed, true, '好感 50 也放行（玩具不再吃好感门槛）')
    assert.equal(egg.gate.code, 'ok')
    assert.equal(egg.gate.allowed, true)
    assert.equal(typeof egg.gate.exempt, 'object', 'gate 形状仍在（前端读它），只是恒放行')
    const r = await post('/api/characters/' + id + '/toys/vibe_egg/equip', { intensity: 3 })
    assert.equal(r.status, 200, '装上不该再被拒：' + JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    assert.equal(r.body.toy.status, 'worn')
    assert.equal(r.body.toy.intensity, 3, '档位照 clamp 生效')
    assert.equal(r.body.gate.allowed, true)
    // 反向守卫：不认识的 key 仍要拦（参数错误 ≠ 内容限制）
    const bad = await post('/api/characters/' + id + '/toys/no_such_toy/equip', {})
    assert.equal(bad.status, 404)
    assert.equal(bad.body.error, 'unknown_toy')
  } finally { config.features.toys = prev }
})

test('③ 允许路径全链路（项圈，好感 60 免授权）：装 → 查 → 调强度 → 摘 → 再调 404', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('C')
    saveAffinity(id, 60, false)
    const equip = await post('/api/characters/' + id + '/toys/collar/equip', {})
    assert.equal(equip.status, 200)
    assert.equal(equip.body.ok, true)
    assert.equal(equip.body.toy.status, 'worn')
    assert.equal(equip.body.toy.intensity, 0)
    assert.equal(equip.body.gate.allowed, true)
    // 反应是增强项：这里只钉「一定有 reaction 结构」，成败取决于环境（本机可能有活 LLM）
    assert.equal(typeof equip.body.reaction.ok, 'boolean')
    assert.equal(typeof equip.body.reaction.reactionText, 'string')
    assert.ok(equip.body.memory && equip.body.memory.dedupe_key.startsWith('toy:' + id + ':collar:'), '要写记忆（幂等键）')

    const list = await api('/api/characters/' + id + '/toys')
    assert.equal(list.body.worn.length, 1)
    assert.equal(list.body.worn[0].toyKey, 'collar')
    assert.equal(list.body.worn[0].gate.allowed, true)

    const set = await post('/api/characters/' + id + '/toys/collar/set-intensity', { intensity: 4 })
    assert.equal(set.status, 200)
    assert.equal(set.body.toy.intensity, 0, '项圈恒 0（clamp）')

    const rm = await post('/api/characters/' + id + '/toys/collar/remove', {})
    assert.equal(rm.status, 200)
    assert.equal(rm.body.toy.status, 'removed')
    assert.ok(rm.body.memory && rm.body.memory.dedupe_key.endsWith(':remove'), '摘下记忆键与戴上不同')

    const again = await post('/api/characters/' + id + '/toys/collar/set-intensity', { intensity: 1 })
    assert.equal(again.status, 404)
    assert.equal(again.body.error, 'toy_not_worn')
  } finally { config.features.toys = prev }
})

test('④ 未知玩具 404 / 非法 id 400', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('D')
    const unknown = await post('/api/characters/' + id + '/toys/nope/equip', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error, 'unknown_toy')
    const bad = await api('/api/characters/abc/toys')
    assert.equal(bad.status, 400)
  } finally { config.features.toys = prev }
})
