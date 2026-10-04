/**
 * 她自己主动玩玩具（2026-10-02，用户原话「不能强制角色自己玩玩具」）
 *
 * 这份钉五件事：
 *   ① **独立判断路径**：好感/淫乱度/独处/催眠/情境驱动，硬门槛（not_yet / cooldown / daily_limit /
 *      sleeping / no_toy）一条都不许被"逗一下"越过；够格也可以**自己收住**（held_back）；
 *   ② **三种叙事口径**：独处 / 偷偷玩（secret）/ 当着你面（bold）；
 *   ③ **独立 prompt**：`buildSelfPlayPrompt` 的 JSON 示例字段齐全；`<self_toy_play>` 与 `<worn_toys>`
 *      是**两个块**（不混成一条），且偷偷玩时禁止她自己交代；
 *   ④ **真的动手**：`maybeSelfPlay` 落库（佩戴 + 模式 + 曲线 + 主动日志 + 记忆键），不是只写一句台词；
 *   ⑤ **旧链路不受影响**：没有主动记录时 `<worn_toys>` 的旧形状/旧文案一字不改。
 *
 * 全程注入假时钟与随机源（`now` / `random`）：**没有 sleep，也没有对 Math.random 的依赖**。
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
  throw new Error('toy self-play fixture forbids network: ' + url)
}

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const { saveAffinity, setOath, loadEmotionState, evolveEmotion, saveEmotionSnapshot } = await import('../src/services/emotionEngine.js')
const hypno = await import('../src/services/hypnosisService.js')
const toys = await import('../src/services/toyService.js')
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

const db = () => getDb()
let seq = 0
function mkChar(name) {
  seq += 1
  return Number(db().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')").run('sp' + seq + '_' + name, name).lastInsertRowid)
}
const T0 = new Date('2026-10-02T10:00:00Z')
const at = (sec) => new Date(T0.getTime() + sec * 1000)
const ALL = toys.selfPlayPickOrder()

const api = async (path, init) => {
  const res = await fetch(base + path, init)
  let body = null
  try { body = await res.json() } catch (err) { body = null }
  return { status: res.status, body }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

/** 判定夹具：只给"够格/不够格"的显式输入，别让默认值把结论搅浑 */
const judge = (over = {}) => toys.decideSelfPlay({
  affinity: 90, lewdness: 80, arousal: 0.5, alone: true, userPresent: false,
  availableKeys: ALL, random: () => 0, ...over,
})

/**
 * 把**淫乱度**垫到及格线（默认 20 次佩戴历史 → 30 分）。
 * 淫乱度是推导出来的硬门槛（≥20），所以"她会不会自己动手"的用例必须先垫它，
 * 否则测的就变成"关系没到 ⇒ not_yet"（那条另有专门用例）。
 * 用"戴上再摘下"：equip_count 照记，但不留佩戴状态（免得干扰用例自己的佩戴断言）。
 */
function seedLewd(id, times = 20) {
  for (let i = 0; i < times; i++) {
    toys.equipToy(id, 'collar', { now: T0 })
    toys.removeToy(id, 'collar', { now: T0 })
  }
  return toys.lewdnessFor(id).lewdness
}

// ── ① 独立判断路径：硬门槛 ────────────────────────────────────────────────────

test('① 硬门槛（连随机都不掷）：没玩具/睡着/关系没到/冷却中/今日到顶各自有自己的判定码', () => {
  assert.equal(toys.SELF_PLAY_CODES.PLAY, 'self_play')
  assert.equal(judge({ availableKeys: [] }).code, 'no_toy')
  assert.equal(judge({ sleeping: true }).code, 'sleeping')
  assert.equal(judge({ sleeping: true, hypnosisActive: true }).code, 'self_play', '催眠里她照样会自己动手')
  assert.equal(judge({ affinity: 54 }).code, 'not_yet', '好感差一点就不行（阈值 55）')
  assert.equal(judge({ lewdness: 19 }).code, 'not_yet', '淫乱度不够也不行（阈值 20）')
  const cool = judge({ minutesSinceLast: 5 })
  assert.equal(cool.code, 'cooldown')
  assert.equal(cool.play, false)
  assert.equal(judge({ playsToday: 4 }).code, 'daily_limit')
  // 门槛判定要给"人话理由"（面板/日志直接用）
  assert.ok(judge({ affinity: 0 }).reason.length > 4)
})

test('① 加分的驱动量能叠加：被逗一下只加分，越不过硬门槛', () => {
  const plain = judge({ encouraged: false })
  const teased = judge({ encouraged: true })
  assert.ok(teased.score > plain.score, '被逗要加分：' + plain.score + ' → ' + teased.score)
  // 硬门槛在前：好感不够时，逗她也一样 not_yet
  assert.equal(judge({ affinity: 10, encouraged: true }).code, 'not_yet')
  assert.equal(judge({ minutesSinceLast: 1, encouraged: true }).code, 'cooldown')
  // 够格但骰子不给面子 ⇒ 她自己收住（她有权拒绝）
  const held = judge({ random: () => 0.999 })
  assert.equal(held.play, false)
  assert.equal(held.code, 'held_back')
  assert.ok(held.reason.length > 4)
})

test('① 三种叙事口径：独处 / 偷偷玩 / 当着你面', () => {
  const alone = judge({ alone: true, userPresent: false })
  assert.equal(alone.secret, false)
  assert.equal(alone.bold, false)
  const secret = judge({ alone: false, userPresent: true, affinity: 70, lewdness: 40 })
  assert.equal(secret.secret, true, '你在场但还不够敢 ⇒ 偷偷用')
  assert.equal(secret.bold, false)
  const bold = judge({ alone: false, userPresent: true, affinity: 90, lewdness: 80 })
  assert.equal(bold.bold, true, '关系深又敢 ⇒ 当着你面用')
  assert.equal(bold.secret, false)
})

test('① 挑玩具：淫乱度越高越敢挑"里面那几件"；全戴上了就改成推高档位', () => {
  const shy = judge({ lewdness: 25 })
  const daring = judge({ lewdness: 100 })
  assert.ok(toys.daringOf(toys.getToy(shy.toyKey)) < toys.daringOf(toys.getToy(daring.toyKey)),
    '低淫乱度挑浅的、高淫乱度挑深的：' + shy.toyKey + ' vs ' + daring.toyKey)
  const allWorn = judge({ wornKeys: ALL })
  assert.equal(allWorn.action, 'bump', '全都戴着了 ⇒ 把身上的调高')
  assert.ok(ALL.includes(allWorn.toyKey))
  // 模式与曲线随淫乱度升级（她越敢，玩法越花）
  assert.equal(judge({ lewdness: 25 }).mode, 'steady')
  assert.notEqual(judge({ lewdness: 100 }).mode, 'steady')
  assert.equal(judge({ lewdness: 25 }).curve, null)
  assert.ok(judge({ lewdness: 100 }).curve, '高淫乱度会给自己上强度曲线')
})

// ── ② 真的动手（落库 + 模式 + 曲线 + 日志）──────────────────────────────────

test('② maybeSelfPlay：她愿意就真的戴上 + 设模式/曲线 + 落主动日志', () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('落库')
    seedLewd(id)
    const r = toys.maybeSelfPlay(id, {
      now: T0, emotion: { affinity: 100, arousal: 0.8 }, presence: { userPresent: false, alone: true },
      random: () => 0.001,
    })
    assert.equal(r.play, true)
    assert.equal(r.applied, true)
    assert.ok(r.toyKey, '要选出玩具')
    const worn = toys.listWornToys(id, { now: T0 })
    assert.equal(worn.length, 1, '她真的把玩具用上了（不是只写台词）')
    assert.equal(worn[0].toyKey, r.toyKey)
    assert.equal(worn[0].status, 'worn')
    assert.ok(worn[0].maxIntensity >= worn[0].intensity && worn[0].intensity >= 1, '档位要在合法范围内')
    // 主动日志（面板/冷却都靠它）
    const last = toys.lastSelfPlay(id, { now: at(120) })
    assert.ok(last, '要写主动日志')
    assert.equal(last.toy_key, r.toyKey)
    assert.equal(last.minutesAgo, 2, 'minutesAgo 用注入的 now 算（不用 sleep）')
    assert.equal(toys.selfPlayCountToday(id, { now: T0 }), 1)
    // 记忆键：与"用户给她戴"不是同一条（事件后缀区分）
    const entry = toys.buildToyMemoryEntry({ characterId: id, toyKey: r.toyKey, event: 'self_play', intensity: r.intensity, at: '2026-10-02 10:00:00', secret: true })
    assert.ok(entry.content.includes('我自己'), '主语是她：' + entry.content)
    assert.ok(entry.content.includes('没让'), '偷偷玩要留伏笔')
    assert.ok(entry.dedupe_key.endsWith(':self_play'), '幂等键后缀区分事件：' + entry.dedupe_key)
  } finally { config.features.toys = prev }
})

test('② 冷却与当日上限在真库上生效；开关关着一律不动手', () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('冷却')
    seedLewd(id)
    const first = toys.maybeSelfPlay(id, {
      now: T0, emotion: { affinity: 100 }, presence: { userPresent: false, alone: true }, random: () => 0.001,
    })
    assert.equal(first.play, true)
    const again = toys.maybeSelfPlay(id, {
      now: at(60), emotion: { affinity: 100 }, presence: { userPresent: false, alone: true }, random: () => 0.001,
    })
    assert.equal(again.play, false, '刚过 60 秒不该又来一次')
    assert.equal(again.code, 'cooldown')
    assert.equal(toys.selfPlayCountToday(id, { now: T0 }), 1, '被拒时不写日志')
    config.features.toys = false
    const off = toys.maybeSelfPlay(id, { now: at(3600), emotion: { affinity: 100 }, random: () => 0.001 })
    assert.equal(off.code, 'toys_disabled')
    assert.equal(toys.selfPlayCountToday(id, { now: T0 }), 1)
  } finally { config.features.toys = prev }
})

test('② 淫乱度是派生量（亲密行为 / 玩具历史 / 主动次数），权重可复算', () => {
  assert.equal(toys.lewdnessScore({}), 0)
  assert.equal(toys.lewdnessScore({ intimateActs: 30 }), 50)
  assert.equal(toys.lewdnessScore({ toyEquips: 20 }), 30)
  assert.equal(toys.lewdnessScore({ selfPlays: 10 }), 20)
  assert.equal(toys.lewdnessScore({ intimateActs: 30, toyEquips: 20, selfPlays: 10 }), 100)
  assert.equal(toys.lewdnessScore({ intimateActs: 300 }), 50, '单项封顶：光靠次数堆不出 100')
  const id = mkChar('淫乱度')
  assert.equal(toys.lewdnessFor(id).lewdness, 0)
  for (let i = 0; i < 20; i++) toys.equipToy(id, 'collar', { now: T0 })
  assert.equal(toys.lewdnessFor(id).lewdness, 30, '20 次佩戴历史 → 30 分')
})

test('② 在场/独处：以"最后一次用户发言"为准（超过 10 分钟没人说话算独处）', () => {
  const id = mkChar('在场')
  assert.equal(toys.userPresence(id, { now: T0 }).alone, true, '从没说过话 ⇒ 独处')
  db().prepare("INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, 'user', '在吗', ?)")
    .run('char_' + id, '2026-10-02 09:59:00')
  const around = toys.userPresence(id, { now: T0 })
  assert.equal(around.userPresent, true)
  assert.equal(around.alone, false)
  const later = toys.userPresence(id, { now: at(20 * 60) })
  assert.equal(later.alone, true, '20 分钟没人说话 ⇒ 她一个人了')
  assert.ok(later.idleMinutes >= 20)
})

// ── ③ 独立 prompt / 独立块 ───────────────────────────────────────────────────

test('③ 她自己动手的 prompt：JSON 示例字段齐全 + 明说只要 JSON', () => {
  const prompt = toys.buildSelfPlayPrompt({
    toyLabel: '吸吮器', part: '阴蒂', effect: '负压吸住阴蒂不停嘬', intensity: 3, maxIntensity: 5,
    mode: 'pulse', modeRhythm: '一阵一阵的冲击', modePhaseText: '正被这一波顶着',
    secret: true, lewdness: 80, userName: '用户',
  })
  const text = prompt.messages.map(m => m.content).join('\n')
  for (const field of ['reaction_text', 'image_prompt', 'inner_thought', 'emotion_delta', 'facial_expression', 'annoyed', 'hidden']) {
    assert.ok(text.includes(field), 'JSON 示例要含字段 ' + field)
  }
  assert.ok(text.includes('不要输出任何解释'), '要明说只输出 JSON')
  assert.ok(text.includes('她自己主动做的'), '要说清这是她自己的主动性，不是用户命令')
  assert.ok(text.includes('不许直接说出口'), '偷偷玩时禁止直白交代')
  assert.ok(prompt.temperature > 0 && prompt.max_tokens > 0)
})

test('③ 解析：inner_thought / hidden 要真的解析出来；坏输出不写脏数据', async () => {
  const raw = JSON.stringify({
    reaction_text: '我……嗯。', image_prompt: 'a girl biting her lip', inner_thought: '别被发现。',
    emotion_delta: { valence: 0.06, arousal: 0.24, dominance: 0.05 }, facial_expression: '脸红咬唇',
    annoyed: false, hidden: true,
  })
  const { parseReactionOutput } = await import('../src/services/touchActionService.js')
  const ok = toys.parseSelfPlayOutput(raw, parseReactionOutput)
  assert.equal(ok.ok, true)
  assert.equal(ok.innerThought, '别被发现。')
  assert.equal(ok.hidden, true)
  assert.equal(ok.reactionText, '我……嗯。')
  assert.equal(ok.facialExpression, '脸红咬唇')
  assert.ok(ok.emotionDelta.arousal > 0.2)
  const bad = toys.parseSelfPlayOutput('她红着脸没说话', parseReactionOutput)
  assert.equal(bad.ok, false)
  assert.equal(bad.reactionText, '', '解析失败不许把原文当台词')
  assert.equal(bad.innerThought, '')
})

test('③ <self_toy_play> 与 <worn_toys> 是两个块（她自己的主动不混进状态块）', () => {
  const block = toys.buildSelfPlayBlock({
    toyLabel: '吸吮器', part: '阴蒂（吸口整个含住）', effect: '负压吸住阴蒂不停嘬',
    intensity: 3, maxIntensity: 5, mode: 'pulse', modeRhythm: '一阵一阵的冲击',
    secret: true, lewdness: 80, minutesAgo: 3, userName: '用户',
  })
  assert.ok(block.includes('<self_toy_play>') && block.includes('</self_toy_play>'))
  assert.equal(block.includes('<worn_toys>'), false, '不许混进状态块')
  assert.ok(block.includes('不是用户的命令'), '要写明不是用户的命令')
  assert.ok(block.includes('吸吮器') && block.includes('3/5'))
  assert.ok(block.includes('绝对不许自己交代'), '偷偷玩：禁止她自己交代')
  assert.ok(block.length <= toys.MAX_SELF_PLAY_BLOCK_CHARS, '块有长度上限，超了会被截断：' + block.length)
  // 当着你面 / 独处 两种口径也要各自写对
  const bold = toys.buildSelfPlayBlock({ toyLabel: '跳蛋', intensity: 2, maxIntensity: 5, bold: true })
  assert.ok(bold.includes('当着'), '明着玩：写"当着你的面"')
  assert.equal(bold.includes('绝对不许自己交代'), false)
  const alone = toys.buildSelfPlayBlock({ toyLabel: '跳蛋', intensity: 2, maxIntensity: 5, alone: true })
  assert.ok(alone.includes('独处'))
  // 群聊：带成员限定行（与 worn_toys 群聊版同口径）
  const group = toys.buildSelfPlayBlock({ toyLabel: '跳蛋', intensity: 2, maxIntensity: 5, secret: true, scene: 'group', subjectName: '流萤' })
  assert.ok(group.includes('本节只对「流萤」生效'))
  // 没玩具名 ⇒ 空串（调用方据此零注入）
  assert.equal(toys.buildSelfPlayBlock({}), '')
})

// ── ④ 注入：她刚自己玩过的那几轮，叙事要记得这件事 ────────────────────────────

test('④ buildWornToysBlock：她刚自己玩过（15 分钟内）才追加独立块；过期/显式关闭都不追加', () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('注入')
    seedLewd(id)
    // 先给她戴上（用户命令线），此时不该有任何主动块
    toys.equipToy(id, 'vibe_egg', { intensity: 2, now: T0 })
    const clean = toys.buildWornToysBlock(id, { scene: 'chat', now: T0 })
    assert.ok(clean.startsWith('<worn_toys>') && clean.endsWith('</worn_toys>'), '没有主动记录时保持旧形状')
    assert.equal(clean.includes('self_toy_play'), false)

    const r = toys.maybeSelfPlay(id, {
      now: T0, emotion: { affinity: 100, arousal: 0.5 }, presence: { userPresent: false, alone: true }, random: () => 0.001,
    })
    assert.equal(r.play, true, '夹具：她确实自己动手了')
    const fresh = toys.buildWornToysBlock(id, { scene: 'chat', now: at(300) })
    assert.ok(fresh.includes('<worn_toys>') && fresh.includes('</worn_toys>'), '状态块还在')
    assert.ok(fresh.includes('<self_toy_play>'), '5 分钟后要带上她自己的那段')
    assert.ok(fresh.indexOf('</worn_toys>') < fresh.indexOf('<self_toy_play>'), '两个块分开，顺序=状态在前、主动性在后')
    // 过期（>15 分钟）就不再提
    const stale = toys.buildWornToysBlock(id, { scene: 'chat', now: at(16 * 60) })
    assert.equal(stale.includes('self_toy_play'), false, '15 分钟前的旧事不该一直挂着')
    assert.ok(stale.endsWith('</worn_toys>'))
    // 显式关闭：任何时刻都不追加
    const off = toys.buildWornToysBlock(id, { scene: 'chat', now: at(300), includeSelfPlay: false })
    assert.equal(off.includes('self_toy_play'), false)
    // 群聊：她的那段也要带成员限定行
    const group = toys.buildWornToysBlock(id, { scene: 'group', now: at(300), subjectName: '流萤' })
    assert.ok(group.includes('本节只对「流萤」生效'))
  } finally { config.features.toys = prev }
})

// ── ⑤ 路由 ────────────────────────────────────────────────────────────────────

test('⑤ GET /toys/self-play 只给判定预览，不产生任何佩戴/日志（读就是读）', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('预览')
    saveAffinity(id, 90, false)
    const res = await api('/api/characters/' + id + '/toys/self-play')
    assert.equal(res.status, 200)
    assert.ok(res.body.decision && typeof res.body.decision.play === 'boolean')
    assert.ok(['self_play', 'held_back'].includes(res.body.decision.code) || res.body.decision.code === 'not_yet')
    assert.ok(res.body.lewdness && typeof res.body.lewdness.score === 'number')
    assert.equal(typeof res.body.context.affinity, 'number')
    assert.equal(res.body.context.wornCount, 0)
    assert.equal(toys.listWornToys(id).length, 0, '预览绝不能顺手给她戴上')
    assert.equal(toys.selfPlayCountToday(id), 0, '预览也不写日志')
  } finally { config.features.toys = prev }
})

test('⑤ POST /toys/self-play：关系没到 → play:false 且什么都不写（她有权不动手）', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('拒绝')
    const res = await post('/api/characters/' + id + '/toys/self-play', { encourage: true })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.play, false)
    assert.equal(res.body.code, 'not_yet', '好感 0：逗她也没用（硬门槛）')
    assert.equal(res.body.encouraged, true, '要说清这次是被逗过的')
    assert.ok(res.body.reason.length > 4)
    assert.equal(toys.listWornToys(id).length, 0)
    assert.equal(toys.selfPlayCountToday(id), 0)
  } finally { config.features.toys = prev }
})

test('⑤ POST /toys/self-play：满配（好感/誓约/淫乱度/独处/催眠/被逗）她一定动手，且真的戴上 + 上屏', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('满配')
    saveAffinity(id, 100, false)
    setOath(id, true)
    // 淫乱度拉满：20 次玩具佩戴 + 30 次亲密 + 10 次**昨天**的主动
    //（"当天上限"按真实日期算，所以过去的主动必须挂在昨天之前，否则撞 daily_limit）
    const yesterday = new Date(Date.now() - 30 * 3600 * 1000)
    seedLewd(id, 20)
    for (let i = 0; i < 30; i++) {
      db().prepare("INSERT INTO character_intimate_log (character_id, source_uid, act_key) VALUES (?, ?, 'hand')").run(id, 'sp_' + seq + '_' + i)
    }
    for (let i = 0; i < 10; i++) {
      toys.recordSelfPlay(id, { code: 'self_play', action: 'equip', secret: true }, { now: yesterday, toyKey: 'vibe_egg', intensity: 2, mode: 'pulse' })
    }
    assert.equal(toys.lewdnessFor(id).lewdness, 100, '夹具：淫乱度拉满')
    assert.equal(toys.selfPlayCountToday(id, { now: new Date() }), 0, '夹具：今天还没主动过')
    hypno.grantHypnosisPhone(id)
    hypno.hypnotize(id, { minutes: 600 })
    const conv = 'char_' + id
    for (let i = 0; i < 6; i++) {
      const next = evolveEmotion(loadEmotionState(conv), { valence: 0.1, arousal: 0.3, dominance: 0 })
      saveEmotionSnapshot(conv, null, next, 'joy', 100, null, '测试夹具')
    }
    const res = await post('/api/characters/' + id + '/toys/self-play', { encourage: true })
    assert.equal(res.status, 200)
    assert.equal(res.body.play, true, '这种情况下她不可能不动手：' + JSON.stringify(res.body))
    assert.ok(res.body.toyKey)
    assert.ok(res.body.label, '要给出玩具名（面板直接显示）')
    assert.ok(res.body.intensity >= 1)
    assert.equal(typeof res.body.secret, 'boolean')
    assert.equal(res.body.reaction && typeof res.body.reaction.ok, 'boolean', '反应是增强项：结构要在（成败看环境）')
    assert.ok(res.body.memory && res.body.memory.dedupe_key.endsWith(':self_play'), '要写她自己那一条记忆')
    assert.ok(res.body.memory.content.includes('我自己'), '记忆主语是她：' + res.body.memory.content)
    const worn = toys.listWornToys(id, { now: new Date() })
    assert.ok(worn.some(t => t.toyKey === res.body.toyKey), '要真的戴上')
    assert.equal(toys.selfPlayCountToday(id, { now: new Date() }), 1)
  } finally { config.features.toys = prev }
})

test('⑤ 开关关着：self-play 读写都 403', async () => {
  const prev = config.features.toys
  config.features.toys = false
  try {
    const id = mkChar('关着')
    assert.equal((await api('/api/characters/' + id + '/toys/self-play')).status, 403)
    assert.equal((await post('/api/characters/' + id + '/toys/self-play', {})).status, 403)
  } finally { config.features.toys = prev }
})
