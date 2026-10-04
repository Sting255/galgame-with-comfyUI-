/**
 * 玩具系统 · **批量装卸**契约测试（2026-10-04 用户：「玩具不能批量装卸 还得一个个点 比较麻烦 这个也加上」）。
 *
 * 钉四件事：
 *   ① 契约：`POST /:id/toys/batch` 的入参/出参形状（`applied[]` / `skipped[{toyKey,reason}]` / `worn[]`）；
 *   ② **一次批量 = 一次感受 = 一条反应**：整批只调 **1 次**模型、只上屏 **1 条**消息，
 *      且喂进去的事实句**列全清单**、点明"同一瞬间"（不是 0 次、不是 N 次、也不是"只提第一件"）；
 *   ③ 1 件回落单件口径（一件不算"一批"）；
 *   ④ 边界：总开关关 403 / 非法 id 400 / 场景非法 400 / 未知 key 进 skipped 而不是静默丢。
 *
 * ⚠️ **探针的接法（2026-10-04 踩过一次，别再退回去）**：
 * 上一版把探针挂在 `globalThis.fetch` 上数"出网次数"。**那个探针是瞎的** ——
 * LLM 链走的是 `openai` SDK，它**不用** `globalThis.fetch`（实测：打桩后仍然真的发出了请求、
 * 拿到了真实回复，而探针计数为 0）。于是"整批只调一次"这条断言**恒真**，绿灯是假的。
 * 现在改成把 `config.llm.baseURL` 指向本测试的桩服务器（SDK 自己的传输层，绕不过去）：
 * 每一次"她说话"的调用都会真的打进来，body 原文就是喂给她的 prompt。
 */

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const { TOY_KEYS, listWornToys, getToy } = await import('../src/services/toyService.js')
const toysRoutes = (await import('../src/routes/toys.js')).default

let server = null
let base = ''
let prevLlm = null

/** 每次模型调用的**请求体原文**（真正的探针，见文件头说明） */
const llmCalls = []

/** 桩回复：够 `parseReactionOutput` 解析出一句反应就行 */
const REACTION_CONTENT = JSON.stringify({
  reaction_text: '（桩）身上一下子有点乱，我先缓一下……',
  image_prompt: 'english: a seated woman reacting, toys visible',
  emotion_delta: { valence: 0.05, arousal: 0.18, dominance: -0.05 },
  facial_expression: '脸红咬唇',
  annoyed: false,
})

before(async () => {
  const app = express()
  app.use(express.json({ limit: '8mb' }))
  // 模型桩：`config.llm.baseURL` 指到这里 ⇒ 每一次"她说话"都跑不掉
  app.post('/v1/chat/completions', (req, res) => {
    llmCalls.push(req.body)
    res.json({
      id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: req.body?.model || 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content: REACTION_CONTENT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  })
  app.use('/api/characters', toysRoutes)
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = 'http://127.0.0.1:' + server.address().port

  prevLlm = { baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, imageMode: config.features.toyImageMode }
  config.llm.baseURL = base + '/v1'
  config.llm.apiKey = 'test-key'
  // 出图是另一条链（ComfyUI）；本文件只验"她说了几句话"，所以显式关掉
  config.features.toyImageMode = 'never'
})

after(async () => {
  if (prevLlm) {
    config.llm.baseURL = prevLlm.baseURL
    config.llm.apiKey = prevLlm.apiKey
    config.features.toyImageMode = prevLlm.imageMode
  }
  if (server) await new Promise(resolve => server.close(resolve))
  closeDb()
})

let seq = 0
function mkChar(name) {
  seq += 1
  return Number(getDb().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')").run('bt' + seq + '_' + name, name).lastInsertRowid)
}
const api = async (path, init) => {
  const res = await fetch(base + path, init)
  let body = null
  try { body = await res.json() } catch (err) { body = null }
  return { status: res.status, body }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
const wornKeys = (id) => listWornToys(id).filter(t => t.status === 'worn').map(t => t.toyKey).sort()
/** 她的反应**上屏了几条**（raw_messages 一行 = 一条反应气泡；分句只影响 messages 表） */
const reactionRows = (id) => getDb()
  .prepare("SELECT content FROM raw_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id")
  .all('char_' + id)

/** 最近一次模型调用里那一行「事实：…」 */
function lastFactLine() {
  const body = llmCalls[llmCalls.length - 1]
  const content = String(body?.messages?.[0]?.content || '')
  return content.split('\n').find(l => l.startsWith('事实：')) || null
}
function lastPromptText() {
  const body = llmCalls[llmCalls.length - 1]
  return String(body?.messages?.[0]?.content || '')
}

/** 批量链一律要在开着总开关的前提下跑；用完还原，别污染后面的用例 */
async function withToysOn(fn) {
  const prev = config.features.toys
  config.features.toys = true
  try { return await fn() } finally { config.features.toys = prev }
}

test('① 全部戴上：applied = 可用清单、状态真的变了，且**整批只调一次模型、只上屏一条反应**', async () => {
  await withToysOn(async () => {
    const id = mkChar('A')
    const list = await api('/api/characters/' + id + '/toys')
    assert.equal(list.body.unlocked, true)
    const available = list.body.available.map(a => a.toyKey).sort()
    assert.ok(available.length >= 5, '可用清单至少 5 件，实际 ' + available.length)
    assert.deepEqual(wornKeys(id), [], '前置：一开始什么都没戴')

    const before = llmCalls.length
    const res = await post('/api/characters/' + id + '/toys/batch', { action: 'equip' })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.action, 'equip')
    assert.deepEqual(res.body.applied.slice().sort(), available, 'applied 要等于可用清单')
    assert.deepEqual(res.body.skipped, [], '第一次装不该有跳过')

    // ②核心不变式：**一次批量 = 一次感受 = 一条反应**
    //    口径改过两次，两次都是用户实测反馈逼出来的：
    //      · 第一版「批量静默、一次模型都不调」→ 用户：「角色没有反馈 …… 右上角的思考也没变化」；
    //      · 第二版「只调一次但事实句只写第一件」→ 用户：「一次性拿掉的话不要一个一个的去反馈，
    //        直接让角色一次性感受到然后再去反馈」。
    //    现在钉的是**精确的一次**：既挡住"完全不反应"，也挡住"逐件各调一次"。
    const calls = llmCalls.length - before
    assert.equal(calls, 1, `整批只该调 1 次模型，实际 ${calls} 次（件数 ${available.length}）`)
    assert.equal('reaction' in res.body, true, '响应里要有 reaction 字段（她会有一句话）')
    assert.ok(res.body.reaction?.ok, '桩返回的是合法反应 JSON，这一条必须解析成功')
    assert.equal(reactionRows(id).length, 1, `整批只该上屏 1 条反应，实际 ${reactionRows(id).length} 条`)

    // ②二次：**内容也要对** —— 事实句把整批列全 + 点明"同一瞬间"
    //    （上一版真机日志实证：一次摘了 2 件，事实句只写「项圈」）
    const fact = lastFactLine()
    assert.ok(fact, '她要收到一条事实句')
    for (const key of available) {
      const label = getToy(key)?.label || key
      assert.ok(fact.includes('「' + label + '」'), `事实句漏了「${label}」：${fact}`)
    }
    assert.ok(fact.includes('同一瞬间一起到位'), '要写明是同一瞬间一起到位：' + fact)
    assert.ok(!fact.includes('你给她戴上了'), '批量不许再走单件事实句：' + fact)
    assert.ok(lastPromptText().includes('这一批是同一次动作'), '写作要求里要禁止"一件接一件"的时间顺序')
    assert.ok(!lastPromptText().includes('这件玩具的作用方式：'), '批量不许再写"这件玩具"')

    // 记忆同口径：一次批量**一条**（原来一件都不写）
    assert.ok(res.body.memory, '响应里要有 memory（她会记住"他一次给我戴上了几件"）')
    assert.ok(String(res.body.memory.content).includes('一次给我戴上了'), res.body.memory.content)
    assert.ok(String(res.body.memory.content).includes('一次 ' + available.length + ' 件'), res.body.memory.content)

    // 状态真的变了
    assert.deepEqual(wornKeys(id), available, '库里的穿戴状态要跟着变')
    assert.equal(res.body.worn.length, available.length, '响应里的 worn 也要是全量')
  })
})

test('② 全部摘下：applied = 当前已戴的全部，摘完清单为空，同样只调一次模型', async () => {
  await withToysOn(async () => {
    const id = mkChar('B')
    await post('/api/characters/' + id + '/toys/batch', { action: 'equip' })
    const on = wornKeys(id)
    assert.ok(on.length >= 5, '前置：先戴上')

    const before = llmCalls.length
    const res = await post('/api/characters/' + id + '/toys/batch', { action: 'remove' })
    assert.equal(res.status, 200)
    assert.equal(res.body.action, 'remove')
    assert.deepEqual(res.body.applied.slice().sort(), on, 'applied 要等于摘下前的已戴集合')
    assert.deepEqual(res.body.skipped, [])
    assert.equal(llmCalls.length - before, 1, `摘下整批也只该调 1 次模型，实际 ${llmCalls.length - before} 次`)
    const fact = lastFactLine()
    assert.ok(fact.includes('同一瞬间一起消失'), '摘下要写"同一瞬间一起消失"：' + fact)
    assert.ok(!fact.includes('一起到位'), '摘下不该用"到位"：' + fact)
    for (const key of on) {
      const label = getToy(key)?.label || key
      assert.ok(fact.includes('「' + label + '」'), `事实句漏了「${label}」：${fact}`)
    }
    assert.deepEqual(wornKeys(id), [], '摘完应为空')
  })
})

test('③ 显式 toyKeys：只动指定的那几件（其余不动）；1 件回落单件口径', async () => {
  await withToysOn(async () => {
    const id = mkChar('C')
    const pick = ['vibe_egg', 'collar']
    const res = await post('/api/characters/' + id + '/toys/batch', { action: 'equip', toyKeys: pick, intensity: 2 })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.applied.slice().sort(), pick.slice().sort())
    assert.deepEqual(wornKeys(id), pick.slice().sort(), '只该装上点名的两件')
    // intensity 透传到每件（vibe_egg max 5 / collar 恒 0）
    const egg = listWornToys(id).find(t => t.toyKey === 'vibe_egg')
    assert.equal(egg.intensity, 2)
    const collar = listWornToys(id).find(t => t.toyKey === 'collar')
    assert.equal(collar.intensity, 0, '项圈 maxIntensity=0 ⇒ 仍被 clamp 到 0')
    // 2 件也是"一批"：档位逐件写清（项圈恒 0，不许糊成"都是 2 档"）
    const twoFact = lastFactLine()
    assert.ok(twoFact.includes('强度 2') && twoFact.includes('强度 0'), '档位要逐件写：' + twoFact)

    // 只摘一件
    const off = await post('/api/characters/' + id + '/toys/batch', { action: 'remove', toyKeys: ['vibe_egg'] })
    assert.deepEqual(off.body.applied, ['vibe_egg'])
    assert.deepEqual(wornKeys(id), ['collar'], '另一件不许被顺带摘掉')
    // **1 件不是"一批"**：走单件事实句，不许出现"一次性…1 件"这种别扭措辞
    const oneFact = lastFactLine()
    assert.ok(oneFact.includes('你把她身上的玩具摘了下来'), '1 件要走单件事实句：' + oneFact)
    assert.ok(!oneFact.includes('同一瞬间'), '1 件不许出现"同一瞬间"：' + oneFact)
    assert.ok(!off.body.memory?.dedupe_key?.startsWith('toy:batch:'), '1 件的记忆走单件口径')
  })
})

test('④ skipped 给原因码，不静默吞掉：unknown_toy / already_worn / not_worn', async () => {
  await withToysOn(async () => {
    const id = mkChar('D')
    // 未知 key 要进 skipped（不是 400、也不是悄悄丢掉）
    const r1 = await post('/api/characters/' + id + '/toys/batch', { action: 'equip', toyKeys: ['vibe_egg', 'no_such_toy'] })
    assert.equal(r1.status, 200)
    assert.deepEqual(r1.body.applied, ['vibe_egg'])
    assert.deepEqual(r1.body.skipped, [{ toyKey: 'no_such_toy', reason: 'unknown_toy' }])
    // 被跳过的 key 不许进事实句（别让她对没发生的事有反应）
    assert.ok(!String(lastPromptText()).includes('no_such_toy'), '未知 key 不许喂给模型')
    // 已经戴着的再装 = already_worn
    const r2 = await post('/api/characters/' + id + '/toys/batch', { action: 'equip', toyKeys: ['vibe_egg'] })
    assert.deepEqual(r2.body.applied, [])
    assert.deepEqual(r2.body.skipped, [{ toyKey: 'vibe_egg', reason: 'already_worn' }])
    // 没戴的摘 = not_worn
    const r3 = await post('/api/characters/' + id + '/toys/batch', { action: 'remove', toyKeys: ['nipple_clamp'] })
    assert.deepEqual(r3.body.applied, [])
    assert.deepEqual(r3.body.skipped, [{ toyKey: 'nipple_clamp', reason: 'not_worn' }])
  })
})

test('⑤ 边界：总开关关 → 403 toys_disabled；非法 id → 400；群场景非法 → 400', async () => {
  const prev = config.features.toys
  config.features.toys = false
  try {
    const id = mkChar('E')
    const r = await post('/api/characters/' + id + '/toys/batch', { action: 'equip' })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'toys_disabled')
  } finally { config.features.toys = prev }

  await withToysOn(async () => {
    assert.equal((await post('/api/characters/abc/toys/batch', { action: 'equip' })).status, 400)
    // 群聊：群不存在 ⇒ 400（证明这条链真的解析了场景，而不是"什么都不传就悄悄写私聊"）
    const id = mkChar('F')
    const g = await post('/api/characters/' + id + '/toys/batch', { action: 'equip', scene: 'group', groupId: 999999 })
    assert.equal(g.status, 400, '不存在的群必须 400：' + JSON.stringify(g.body))
  })
})

test('⑥ 幂等与顺序无关：连做两次"全部戴上"，第二次全进 skipped、状态不变、也不多调模型', async () => {
  await withToysOn(async () => {
    const id = mkChar('G')
    const first = await post('/api/characters/' + id + '/toys/batch', { action: 'equip' })
    const snapshot = wornKeys(id)
    const before = llmCalls.length
    const second = await post('/api/characters/' + id + '/toys/batch', { action: 'equip' })
    assert.deepEqual(second.body.applied, [], '第二次没有新东西可装')
    assert.equal(second.body.skipped.length, first.body.applied.length)
    assert.ok(second.body.skipped.every(s => s.reason === 'already_worn'))
    assert.deepEqual(wornKeys(id), snapshot, '状态不许被第二次操作改坏')
    // 一件都没动 ⇒ 不该有任何反应（别对"什么都没发生"演一场）
    assert.equal(llmCalls.length - before, 0, '没有实际变化时不该调模型')
    assert.equal(second.body.reaction, null)
    assert.equal(second.body.memory, null)
    // 目录里的 5 个基准 key 都在（防止 availablePayload 与 TOY_KEYS 脱节）
    assert.ok(TOY_KEYS.every(k => snapshot.includes(k)), 'TOY_KEYS 都应能装上')
  })
})
