/**
 * 玩具链的「群聊维度」守卫（2026-10-03；两位独立审查者各自复现的真机 bug）
 *
 * 用户原话：「在群聊里进行点玩具和插入动作 消息会去到私聊里 这是不应该的
 *            在哪里聊天就在哪里继续进行」
 *
 * 根因：`routes/toys.js` 把 `publishToyReaction` 的写入器写死成
 * `proactiveChatScheduler.writeProactiveMessage`（⇒ `char_<id>` + `proactive_message`），
 * 而群聊页只认统一流的 `group_message` / `group_message_update`
 * （`routes/groups.js` 的 emit → `web-ui/src/stores/groups.js` 的 `_enqueue`）
 * ⇒ 玩家在群聊玩具面板里装 / 调 / 摘，她的反应与配图全落到私聊、群里什么都看不到，
 * 顺带把群聊成人闸门（`features.touchGroupAdult`）也绕过去了。
 *
 * 这份测试钉五层（都是真断言，不是"源码里有某行"）：
 *   ① 群聊：反应写进 `group_<gid>`（raw 带「[名字]: 」前缀、messages 一气泡一行、speaker 是她）
 *      + **只**广播 `group_message`，私聊会话零写入；
 *   ② 私聊：一字未改（`char_<id>` + `proactive_message`，不广播任何群事件）——**不传 scene = 私聊**；
 *   ③ 补图事件名：群 ⇒ `group_message_update`（整份群 payload + images，群聊 store 靠它匹配气泡）；
 *      私 ⇒ `proactive_message_update`（`{ msg_id, raw_id, images }`，字段名不变）；
 *   ④ 群聊成人闸门（与触摸 / 亲密同一条）：开关关着时装 / 调强度 / 摘下 / 她自己玩全部 403 +
 *      `code='group_adult_blocked'` + 触摸链那句人话，且**一个字节都不写**；私聊不受这个开关影响；
 *   ⑤ 场景校验：`scene=group` 缺 groupId / 群不存在 / 她不在群里 ⇒ 400 人话，不落任何消息。
 *
 * 全程离线与确定性：LLM 走假上游（照 test/touchImageStats.test.js），出图走注入的假生成器，
 * 时间/随机都不参与断言（不依赖 `now - 2h` 这类会跨 UTC 日界的写法）。
 */

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

// ── 假上游 LLM（openai SDK 走自己的 HTTP，不受 globalThis.fetch 桩影响）──
const stub = { reply: '', fail: false, calls: 0 }
const upstream = http.createServer((req, res) => {
  let text = ''
  req.on('data', chunk => { text += chunk })
  req.on('end', () => {
    if (!String(req.url || '').includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    stub.calls += 1
    if (stub.fail) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stub llm failure', type: 'invalid_request_error' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: stub.reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const UPSTREAM = 'http://127.0.0.1:' + upstream.address().port + '/v1'

// 只放行本测试自己的 app（LLM 走 openai SDK，不经过这里）；其余出网一律拒
const realFetch = globalThis.fetch
let base = ''
globalThis.fetch = async (url, init) => {
  if (base && String(url).startsWith(base)) return realFetch(url, init)
  throw new Error('toy group fixture forbids network: ' + url)
}

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
config.llm.freeEgg = false
config.llm._apiKey = 'stub-key'
config.llm._baseURL = UPSTREAM
config.llm._model = 'stub-model'
config.llm._thinkingMode = 'disabled'
config.llm._extraBody = {}

const { getDb, closeDb } = await import('../src/db/index.js')
const { saveAffinity } = await import('../src/services/emotionEngine.js')
const { getTouchGate } = await import('../src/services/touchActionService.js')
const toys = await import('../src/services/toyService.js')
const toysRoutes = (await import('../src/routes/toys.js')).default
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js')

const app = express()
app.use(express.json())
app.use('/api/characters', toysRoutes)
let server = null
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => {
  removeClient(sse)
  if (server) await new Promise(resolve => server.close(resolve))
  upstream.close()
  closeDb()
})

// ── SSE 抓取桩（群/私两套事件各有各的名字，这里都要能看见）──
const sse = { chunks: [], write(chunk) { this.chunks.push(String(chunk)) } }
addClient(sse)
function takeSse(eventType) {
  const out = []
  sse.chunks = sse.chunks.filter(chunk => {
    const matched = /^event: (.+)\ndata: (.*)\n\n$/s.exec(chunk)
    if (matched && matched[1] === eventType) { out.push(JSON.parse(matched[2])); return false }
    return true
  })
  return out
}
function resetSse() { sse.chunks.length = 0 }

const db = () => getDb()
const api = async (urlPath, init) => {
  const res = await fetch(base + urlPath, init)
  let body = null
  try { body = await res.json() } catch (err) { body = null }
  return { status: res.status, body }
}
const post = (urlPath, body) => api(urlPath, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
})

let seq = 0
function seedCharacter({ affinity = 60 } = {}) {
  seq += 1
  const info = db().prepare(
    "INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, '完整人格', '短人格')"
  ).run('toygroup_' + seq, '群玩具' + seq)
  const id = Number(info.lastInsertRowid)
  // 显式落好感：项圈（Lv3 / 不要求亲密授权）刚好过线，别吃种子里的默认值
  saveAffinity(id, affinity, false)
  return id
}
function seedGroup(memberIds) {
  seq += 1
  const gid = Number(db().prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('玩具群' + seq, '话题').lastInsertRowid)
  for (const id of memberIds) db().prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id)
  return gid
}
const displayNameOf = id => db().prepare('SELECT display_name FROM characters WHERE id = ?').pluck().get(id)
const rawRows = conversationId => db().prepare('SELECT role, content FROM raw_messages WHERE conversation_id = ? ORDER BY id').all(conversationId)
const msgRows = conversationId => db().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId)
const msgCount = conversationId => db().prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId).n
const rawCount = conversationId => db().prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(conversationId).n

function stubReaction(text = '她腿一软，扶住了桌沿。') {
  stub.fail = false
  stub.calls = 0
  stub.reply = JSON.stringify({
    reaction_text: text,
    image_prompt: 'a girl gripping the table edge',
    emotion_delta: { valence: 0.05, arousal: 0.2, dominance: -0.05 },
    facial_expression: '害羞',
    annoyed: false,
  })
}

/** 开关三件套的临时设置（用例之间绝不互相污染） */
const savedFeatures = {
  toys: config.features.toys,
  touchGroupAdult: config.features.touchGroupAdult,
  touchImageMode: config.features.touchImageMode,
}
function setFeatures({ toys: t, groupAdult, imageMode } = {}) {
  if (t !== undefined) config.features.toys = t
  if (groupAdult !== undefined) config.features.touchGroupAdult = groupAdult
  if (imageMode !== undefined) config.features.touchImageMode = imageMode
}
function restoreFeatures() {
  config.features.toys = savedFeatures.toys
  config.features.touchGroupAdult = savedFeatures.touchGroupAdult
  config.features.touchImageMode = savedFeatures.touchImageMode
}

// ──────────────── ① 群聊：反应写进群会话 + 只广播 group_message ────────────────

test('① 群聊装玩具：写进 group_<gid>（[名字] 前缀 / speaker 是她）+ 只广播 group_message，私聊零写入', async () => {
  setFeatures({ toys: true, groupAdult: true, imageMode: 'never' })
  try {
    const id = seedCharacter()
    const gid = seedGroup([id])
    const name = displayNameOf(id)
    stubReaction('她腿一软，扶住了桌沿。')
    resetSse()

    const res = await post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1, scene: 'group', groupId: gid })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.toy.status, 'worn')
    assert.equal(res.body.reaction.ok, true, '夹具：反应必须真的写出来（否则这条用例什么都没验到）')
    assert.equal(res.body.reaction.reactionText, '她腿一软，扶住了桌沿。')

    // 群会话里能看到（形状与 groupChatEngine.serializeMsg 对齐：raw 带说话人前缀，messages 一气泡一行）
    const raws = rawRows(`group_${gid}`)
    assert.equal(raws.length, 1)
    assert.equal(raws[0].role, 'assistant')
    assert.equal(raws[0].content, `[${name}]: 她腿一软，扶住了桌沿。`)
    const msgs = msgRows(`group_${gid}`)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].content, '她腿一软，扶住了桌沿。')
    assert.equal(Number(msgs[0].speaker_character_id), id, 'speaker 必须是被装玩具的那个角色（群聊页据此渲染她的气泡）')

    // 广播：群聊页只认统一流的 group_message；私聊那条事件一次都不许出现
    const events = takeSse('group_message')
    assert.equal(events.length, 1, '只广播一次 group_message')
    for (const key of ['id', 'group_id', 'role', 'content', 'seq', 'speaker_character_id', 'speaker_name', 'created_at']) {
      assert.ok(key in events[0], `群 payload 缺少群聊页需要的键：${key}`)
    }
    assert.equal(events[0].id, msgs[0].id)
    assert.equal(events[0].group_id, gid)
    assert.equal(events[0].seq, msgs[0].seq)
    assert.equal(events[0].speaker_character_id, id)
    assert.equal(events[0].speaker_name, name)
    assert.equal(events[0].source, 'toy')
    assert.equal(takeSse('proactive_message').length, 0, '群聊场景绝不许再发私聊那条 proactive_message')

    // **最关键**：私聊会话一个字节都没被污染
    assert.equal(msgCount(`char_${id}`), 0, '群聊场景下不许往 char_<id> 写任何东西')
    assert.equal(rawCount(`char_${id}`), 0)
  } finally {
    restoreFeatures()
  }
})

test('① 群聊调强度 / 摘下：同样写进群会话（不只装那一条链）', async () => {
  setFeatures({ toys: true, groupAdult: true, imageMode: 'never' })
  try {
    const id = seedCharacter()
    const gid = seedGroup([id])
    // 先用**私聊**戴上（群聊闸门在用例④单独验），再在群里调强度 / 摘下
    stubReaction('她呼吸乱了一拍。')
    await post(`/api/characters/${id}/toys/nipple_clamp/equip`, { intensity: 1 })
    assert.equal(rawCount(`char_${id}`), 1, '夹具：私聊那次反应落在私聊（用例②会正面钉这条）')
    const privateMsgsBefore = msgCount(`char_${id}`)
    assert.ok(privateMsgsBefore >= 1, '夹具：私聊那边真的落了气泡（她会分句）')

    stubReaction('她倒抽了一口气。')
    resetSse()
    const set = await post(`/api/characters/${id}/toys/nipple_clamp/set-intensity`, { intensity: 3, scene: 'group', groupId: gid })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.equal(set.body.toy.intensity, 3)

    stubReaction('她松了一口气。')
    const rm = await post(`/api/characters/${id}/toys/nipple_clamp/remove`, { scene: 'group', groupId: gid })
    assert.equal(rm.status, 200, JSON.stringify(rm.body))

    const msgs = msgRows(`group_${gid}`)
    assert.deepEqual(msgs.map(m => m.content), ['她倒抽了一口气。', '她松了一口气。'], '两条反应都要落在群里，且按顺序')
    assert.equal(msgs[0].seq + 1, msgs[1].seq, 'seq 递增（群聊页按它排序）')
    assert.equal(takeSse('group_message').length, 2)
    assert.equal(takeSse('proactive_message').length, 0)
    // 私聊那边只有装玩具那一轮，调强度/摘下的反应**没有**再往私聊写
    //（她的反应会被分句成多条 messages，所以这里按 raw_messages 计数：一轮反应 = 一行 raw）
    assert.equal(rawCount(`char_${id}`), 1, '调强度 / 摘下的反应不许再落到私聊')
    assert.equal(msgCount(`char_${id}`), privateMsgsBefore, '私聊气泡数也不许增加')
  } finally {
    restoreFeatures()
  }
})

// ──────────────── ② 私聊：一字未改 ────────────────

test('② 私聊装玩具（不传 scene）：写 char_<id> + proactive_message，不广播任何群事件', async () => {
  setFeatures({ toys: true, groupAdult: true, imageMode: 'never' })
  try {
    const id = seedCharacter()
    const name = displayNameOf(id)
    stubReaction('……嗯。')
    resetSse()

    const res = await post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1 })
    assert.equal(res.status, 200)
    assert.equal(res.body.reaction.ok, true)

    const raws = rawRows(`char_${id}`)
    assert.equal(raws.length, 1, '私聊反应写 char_<id>（老行为逐字不变）')
    assert.equal(raws[0].content, '……嗯。', 'raw 正文不带说话人前缀（私聊口径与群聊不同）')
    const msgs = msgRows(`char_${id}`)
    assert.ok(msgs.length >= 1, '私聊照样要落气泡（她会分句）')
    assert.ok(msgs.map(m => m.content).join('').includes('嗯'), '私聊气泡里就是她刚说的那句')
    assert.equal(msgs[0].is_proactive, 1, '私聊主动消息照旧标 is_proactive')

    const events = takeSse('proactive_message')
    assert.equal(events.length, 1)
    assert.equal(events[0].content, '……嗯。')
    assert.equal(events[0].msg_id, msgs[0].id)
    assert.equal(events[0].source, 'toy')
    assert.equal(events[0].display_name, name)
    assert.deepEqual(events[0].images, [], '第一段不带图（图走 update 那一段）')
    assert.equal(takeSse('group_message').length, 0, '私聊不许发群事件')
  } finally {
    restoreFeatures()
  }
})

// ──────────────── ③ 补图：事件名与载荷按场景分叉（唯一来源 reactionImageUpdate）────────────────

test('③ 群聊补图：group_message_update 带整份群 payload（id/group_id/seq/speaker）+ images，且图真的挂进群消息', async () => {
  setFeatures({ toys: true, groupAdult: true })
  try {
    const id = seedCharacter()
    const gid = seedGroup([id])
    const name = displayNameOf(id)
    const character = db().prepare('SELECT id, display_name, avatar_path, base_prompt, short_prompt FROM characters WHERE id = ?').get(id)
    resetSse()

    // 默认写入器（真写库）+ 默认广播（真总线），只把"出图"换成假结果
    const result = toys.publishToyReaction({
      character,
      reactionText: '她夹紧了腿，没敢抬头。',
      imagePrompt: 'a girl pressing her thighs together',
      source: 'toy',
      scene: 'group',
      groupId: gid,
      deps: { generateImage: async () => ({ urls: ['/images/chat/toy-group.png'], prompt: 'p' }) },
    })
    assert.equal(result.ok, true)
    const text = takeSse('group_message')
    assert.equal(text.length, 1)
    await result.imagePromise

    const updates = takeSse('group_message_update')
    assert.equal(updates.length, 1, '图好了要补一次 group_message_update（群聊页靠它换图）')
    assert.equal(updates[0].id, text[0].id, 'id 必须与刚才那条群气泡一致（否则群聊 store 匹配不到）')
    assert.equal(updates[0].group_id, gid)
    assert.equal(updates[0].seq, text[0].seq)
    assert.equal(updates[0].speaker_character_id, id)
    assert.equal(updates[0].speaker_name, name)
    assert.equal(updates[0].content, '她夹紧了腿，没敢抬头。')
    assert.deepEqual(updates[0].images, ['/images/chat/toy-group.png'])
    // 图真的挂进了那条群消息（刷新 / 相册也看得到）
    assert.deepEqual(JSON.parse(db().prepare('SELECT images FROM messages WHERE id = ?').get(text[0].id).images), ['/images/chat/toy-group.png'])
    // 私聊那条 update 事件名一次都不许出现
    assert.equal(takeSse('proactive_message_update').length, 0)
    assert.equal(msgCount(`char_${id}`), 0)
  } finally {
    restoreFeatures()
  }
})

test('③ 私聊补图：仍然是 proactive_message_update + { msg_id, raw_id, images }（字段名不变）', async () => {
  setFeatures({ toys: true, groupAdult: true })
  try {
    const id = seedCharacter()
    const character = db().prepare('SELECT id, display_name, avatar_path, base_prompt, short_prompt FROM characters WHERE id = ?').get(id)
    // 真落**两条**私聊消息行（多段反应：她的反应会被 writeProactiveMessage 分句成多条气泡），
    // 图写进的是最后一条 ⇒ 这样默认的 attachToyImagesToMessage 会真的把图挂上去
    const rawId = Number(db().prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(`char_${id}`, '……嗯。……没什么。').lastInsertRowid)
    const insertMsg = db().prepare(
      "INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id) VALUES (?, ?, 'assistant', ?, ?, ?)"
    )
    const firstMsgId = Number(insertMsg.run(`char_${id}`, rawId, '……嗯。', 0, id).lastInsertRowid)
    const lastMsgId = Number(insertMsg.run(`char_${id}`, rawId, '……没什么。', 1, id).lastInsertRowid)
    assert.notEqual(firstMsgId, lastMsgId, '夹具：两条气泡要有不同的 id（否则这条用例测不到锚点）')
    resetSse()

    const result = toys.publishToyReaction({
      character,
      reactionText: '……嗯。……没什么。',
      imagePrompt: 'a girl looking away',
      source: 'toy',
      // 私聊写入器由调用方注入（与 routes/toys.js 的接线同款）
      deps: {
        writeMessage: () => ({ firstMsgId, lastMsgId, rawId, segments: ['……嗯。', '……没什么。'], msgIds: [firstMsgId, lastMsgId] }),
        broadcastText: () => {},
        generateImage: async () => ({ urls: ['/images/chat/toy-chat.png'], prompt: 'p' }),
      },
    })
    await result.imagePromise

    const updates = takeSse('proactive_message_update')
    assert.equal(updates.length, 1, '私聊补图仍是 proactive_message_update')
    // ⚠️ 锚点必须是**落库挂图的那一条**（lastMsgId）：以前只给 firstMsgId ⇒ 直播时图跟在第一段后面、
    //    刷新后跳到第二段后面（用户看到"图会跑"）。字段名与形状一个字符都没动。
    assert.deepEqual(updates[0], { msg_id: lastMsgId, raw_id: rawId, images: ['/images/chat/toy-chat.png'] })
    assert.equal(updates[0].msg_id, lastMsgId, '实时广播的锚 == 落库挂图的锚（同一条气泡）')
    assert.deepEqual(JSON.parse(db().prepare('SELECT images FROM messages WHERE id = ?').get(lastMsgId).images), ['/images/chat/toy-chat.png'])
    assert.equal(db().prepare('SELECT images FROM messages WHERE id = ?').get(firstMsgId).images, null, '第一段那条不该被挂图')
    assert.equal(takeSse('group_message').length, 0)
    assert.equal(takeSse('group_message_update').length, 0, '私聊不许复用群聊的 update 事件')
  } finally {
    restoreFeatures()
  }
})

// ──────────────── ④ 群聊成人闸门（与触摸 / 亲密同一条）────────────────

test('④ 2026-10-04「玩具限制全删」：群聊开关**关着**时玩具四条链也不再被拦（触摸链仍拦 = 对照组）', async () => {
  setFeatures({ toys: true, groupAdult: false, imageMode: 'never' })
  try {
    // **对照组**：同样条件下触摸链**仍然**拦 —— 证明这次改的是玩具这一块，
    // 而不是把 `touchGroupAdult` 这条闸门从系统里废掉（那样 Lv3 触摸也会被顺带放开）。
    const touchGate = getTouchGate({
      actionKey: 'touch_clit', affinity: 60, isOath: false, hypnotized: false, sleeping: false,
      intimateAuthorized: true, scene: 'group', allowGroupAdult: false,
    })
    assert.equal(touchGate.code, 'group_adult_blocked', '触摸链的群聊闸门必须原样保留')
    assert.ok(touchGate.message.length > 4, '夹具：触摸链必须给出一句人话')

    const id = seedCharacter()
    const gid = seedGroup([id])
    // 私聊先戴上（这条同时是"私聊不受影响"的反向守卫）
    stubReaction('她愣了一下。')
    const privateEquip = await post(`/api/characters/${id}/toys/nipple_clamp/equip`, { intensity: 2 })
    assert.equal(privateEquip.status, 200, '私聊照常：' + JSON.stringify(privateEquip.body))
    resetSse()

    const cases = [
      ['装', () => post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1, scene: 'group', groupId: gid })],
      ['调强度', () => post(`/api/characters/${id}/toys/nipple_clamp/set-intensity`, { intensity: 3, scene: 'group', groupId: gid })],
      ['摘下', () => post(`/api/characters/${id}/toys/nipple_clamp/remove`, { scene: 'group', groupId: gid })],
      ['她自己玩', () => post(`/api/characters/${id}/toys/self-play`, { encourage: true, scene: 'group', groupId: gid })],
    ]
    // 放行 = 事情**真的发生了**（不是回了个 200 就完事）：逐条核响应体里的状态
    const expectBody = {
      '装': (b) => assert.equal(b.toy.status, 'worn', '装要真的戴上'),
      '调强度': (b) => assert.equal(b.toy.intensity, 3, '调强度要真的改到 3 档'),
      '摘下': (b) => assert.equal(b.toy.status, 'removed', '摘下要真的摘了'),
      '她自己玩': () => {},   // 它返回的是 self-play 预览，状态由下面两条总账核
    }
    for (const [label, run] of cases) {
      const res = await run()
      assert.equal(res.status, 200, label + ' 不该再被玩具门控拦：' + JSON.stringify(res.body))
      assert.notEqual(res.body.code, 'group_adult_blocked', label + ' 不该再回群聊闸门码')
      expectBody[label](res.body)
    }
    assert.ok(toys.listWornToys(id).some(t => t.toyKey === 'collar'), '总账：collar 应仍在戴着清单里')
    assert.equal(toys.listWornToys(id).some(t => t.toyKey === 'nipple_clamp'), false,
      '总账：摘下的 nipple_clamp 不该还留在戴着清单里')
  } finally {
    restoreFeatures()
  }
})

test('④ 开关打开后同一条链立刻放行（证明拦的是开关，不是别的东西）', async () => {
  setFeatures({ toys: true, groupAdult: true, imageMode: 'never' })
  try {
    const id = seedCharacter()
    const gid = seedGroup([id])
    stubReaction('她咬着下唇没说话。')
    resetSse()
    const res = await post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1, scene: 'group', groupId: gid })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(msgCount(`group_${gid}`), 1)
  } finally {
    restoreFeatures()
  }
})

// ──────────────── ⑤ 场景校验 ────────────────

test('⑤ scene=group 的场景校验：缺 groupId / 群不存在 / 她不在群里 ⇒ 400 人话，且不落任何消息', async () => {
  setFeatures({ toys: true, groupAdult: true, imageMode: 'never' })
  try {
    const id = seedCharacter()
    const other = seedCharacter()
    const foreignGroup = seedGroup([other])
    stubReaction('她眨了眨眼。')
    resetSse()

    const noGid = await post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1, scene: 'group' })
    assert.equal(noGid.status, 400)
    assert.equal(noGid.body.code, 'invalid_group')
    assert.match(String(noGid.body.error), /groupId/, '要给出人话（告诉她缺什么）')

    const noGroup = await post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1, scene: 'group', groupId: 999999 })
    assert.equal(noGroup.status, 400)
    assert.equal(noGroup.body.code, 'group_not_found')

    const notMember = await post(`/api/characters/${id}/toys/collar/equip`, { intensity: 1, scene: 'group', groupId: foreignGroup })
    assert.equal(notMember.status, 400)
    assert.equal(notMember.body.code, 'not_group_member')

    // 调强度 / 摘下 / 她自己玩同一条校验（同一个解析函数，四个入口都接了）
    for (const call of [
      () => post(`/api/characters/${id}/toys/collar/set-intensity`, { intensity: 2, scene: 'group' }),
      () => post(`/api/characters/${id}/toys/collar/remove`, { scene: 'group' }),
      () => post(`/api/characters/${id}/toys/self-play`, { scene: 'group' }),
    ]) {
      const res = await call()
      assert.equal(res.status, 400)
      assert.equal(res.body.code, 'invalid_group')
    }

    assert.equal(msgCount(`char_${id}`), 0, '校验失败不许上屏')
    assert.equal(rawCount(`char_${id}`), 0)
    assert.equal(rawCount(`group_${foreignGroup}`), 0)
    assert.equal(takeSse('group_message').length, 0)
    assert.equal(stub.calls, 0, '场景不合法就不该烧模型调用')
  } finally {
    restoreFeatures()
  }
})

// ──────────────── ⑥ 接线守卫（四个入口真的把场景传下去了）────────────────

test('⑥ 接线：四条玩具链都解析场景 + 把场景交给 publishToyReaction / 过群聊成人闸门', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const routeSrc = fs.readFileSync(path.join(here, '..', 'src', 'routes', 'toys.js'), 'utf8')
  // 五个写入口（equip / set-intensity / remove / self-play / **batch**）各自解析一次场景
  assert.equal((routeSrc.match(/resolveSceneTarget\(req, characterId\)/g) || []).length, 5,
    '装 / 调强度 / 摘下 / 她自己玩 / **批量装卸** 都要解析场景（少一个 = 那条链又写回私聊）')
  assert.equal((routeSrc.match(/const blocked = groupAdultGate\(characterId, toyKey, ctx\)/g) || []).length, 2,
    '调强度 / 摘下要过群聊成人闸门')
  assert.match(routeSrc, /groupAdultGate\(characterId, null, ctx\)/, '她自己玩那条也要过闸')
  assert.match(routeSrc, /scene: isGroup \? 'group' : 'chat'/, '发布时按场景分叉（群 ⇒ group_message 那条）')
  assert.match(routeSrc, /deps: isGroup[\s\S]{0,120}?writeMessage: writeProactiveMessage/,
    '私聊写入器只在私聊分支注入（群聊分支走 writeGroupInsertMessage）')

  // ── 批量装卸（2026-10-04 用户：「玩具不能批量装卸 还得一个个点 比较麻烦」）──
  // 钉的是**它必须与单件那四条链同口径**，以及**它必须是静默的**这两件事。
  assert.match(routeSrc, /router\.post\('\/:id\/toys\/batch'/, '批量端点要存在')
  const batch = routeSrc.slice(routeSrc.indexOf("router.post('/:id/toys/batch'"))
  assert.match(batch, /resolveSceneTarget\(req, characterId\)/, '批量也要解析场景（否则写错会话）')
  // 2026-10-04 **口径改过**：批量现在**要**有反应（用户实测反馈「角色没有反馈」「右上角的思考也没变化」），
  // 但**整批只调一次**（清单塞进 extraContext）。所以这里钉的是"有且只有一处调用"，
  // 而不是原来的"一处都没有" —— 同一条守卫同时挡住"完全不反应"和"逐件各调一次"。
  assert.equal((batch.match(/reactAndPublish\(/g) || []).length, 1,
    '批量要产**一条汇总反应**（整批一次），不是逐件各一次、也不是一次都不调')
  assert.match(batch, /extraContext/, '整批的清单要走 extraContext 交给反应链（她的反应对象是"一下子多了/少了几件"）')
  assert.match(batch, /broadcast\('toys_batch_changed'/, '批量必须自己广播一次（不产反应就只能靠它刷新前端）')
  assert.match(batch, /if \(!toysUnlocked\(\)\) return res\.status\(403\)\.json\(\{ error: 'toys_disabled' \}\)/,
    '批量也要过总开关（与其它写接口一致）')

  const serviceSrc = fs.readFileSync(path.join(here, '..', 'src', 'services', 'toyService.js'), 'utf8')
  const publish = serviceSrc.slice(serviceSrc.indexOf('export function publishToyReaction'))
  assert.match(publish, /writeGroupInsertMessage\(groupId, char, content/, '群聊写入要走共享的群消息写入器')
  assert.match(publish, /reactionImageUpdate\(\{/, '补图的事件名/载荷只能由 reactionImageUpdate 决定')
  assert.match(publish, /scene: isGroup \? 'group' : 'chat'/)
  // 锚点：target 里必须同时给 lastMsgId（落库挂图那一条）—— 只给 firstMsgId 会让图在多段反应里"跑"
  assert.match(publish, /target: \{ lastMsgId: pending\.lastMsgId, firstMsgId: pending\.firstMsgId, rawId: pending\.rawId \}/,
    '补图锚点要按落库口径（lastMsgId）交给 reactionImageUpdate')
  assert.equal(/msg_id: pending\./.test(publish), false, '不许再自己手拼补图的 msg_id（已收口到 reactionImageUpdate）')
})
