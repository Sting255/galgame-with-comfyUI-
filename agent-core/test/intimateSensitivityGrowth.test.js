/**
 * 「性爱真的会让她更敏感」+「补图事件名别发错」—— 2026-10-03 真机反馈的两条回归
 *
 * ## 用户原话
 *   「在群聊里性爱没问题了 但是光图词 没配图 但是生图又是成功的 而且性爱并没有增加敏感度」
 *
 * ## 两个根因（都不是"逻辑没写"，而是"写错了地方"）
 * 1. **敏感度涨不动**（`services/intimateStimulus.js`）：
 *    · 高潮走错了源 —— 用的是 `intimate_action`（0.2）而不是 `GROWTH.climax`（1.2），
 *      `GROWTH.climax` 那一档**从来没被任何调用点用过**（死代码）；
 *    · 推进面板只给半权重 —— 面板动作 `amount: 0`（累积已由状态机算过）⇒ `gain = 0`
 *      ⇒ 命中"没涨就算半权重"的分支 ⇒ 一下只涨 **0.1**，而面板显示取整值 ⇒ 玩家看到的永远是 0。
 * 2. **群聊补图事件名发错**（`services/reactionImageUpdate.js`）：
 *    推进链不管什么场景都发 `proactive_message_update`，而群聊页只认 `group_message_update`
 *    ⇒ 图真的生成成功、也确实写进了 `messages.images`，但群里那句气泡永远收不到"补图"事件。
 *
 * ## 本文件钉住什么
 *   ① 一场性爱涨多少（可感知的量级，不是 0.1 的小数点）；
 *   ② 高潮按 `GROWTH.climax × 强度` 走（那一档常量不许再是死代码）；
 *   ③ 补图事件名：群聊 = `group_message_update`（必须带群消息 payload 字段）、私聊 = `proactive_message_update`；
 *   ④ 载荷字段是**前端 store 的契约**（少字段群聊就认不出那条气泡）；
 *   ⑤ 补图**锚点**：她的反应被分句成多条气泡时，图挂在**最后一条**（与 `messages.images` 同一行）
 *      —— 直播与刷新后必须一致（2026-10-03 复查：以前直播挂第一条、刷新跳最后一条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { applyIntimateStimulus, stimulusPlan } = await import('../src/services/intimateStimulus.js')
const { saveIntimateScene, emptySceneState, planIntimateAction } = await import('../src/services/intimateActionService.js')
const S = await import('../src/services/sensitivityService.js')
const { reactionImageUpdate, CHAT_IMAGE_UPDATE_EVENT, GROUP_IMAGE_UPDATE_EVENT } = await import('../src/services/reactionImageUpdate.js')
const { writeGroupInsertMessage } = await import('../src/services/groupInsertMessage.js')

const db = getDb()
db.pragma('foreign_keys = OFF')

// 出图/向量记忆在单测里不许联网：memory 写入走 upsertVector，直接打桩掉
globalThis.fetch = async (url) => { throw new Error(`本用例禁止联网：${url}`) }

const CID = 951
db.prepare(`INSERT OR REPLACE INTO characters
  (id, name, display_name, base_prompt, short_prompt, sensitivity, sensitivity_updated_at, heat_mode)
  VALUES (?, ?, ?, ?, ?, 0, NULL, 0)`)
  .run(CID, '敏感增长', '敏感增长', '你是测试角色。', '测试角色')

/** 开一场"正在进行"的性爱（推进面板写的状态） */
/** 把她的数值清回 0，**并且把"今天已经涨了多少"的记账一起清掉**。
 *  2026-10-03：加了每日上限（SEX_DAILY_CAP）之后，同一个角色在一个毫秒里连做四场会撞上限，
 *  用例之间会互相污染 ⇒ 这里显式模拟"新的一天 / 干净的起点"（产品口径本身不变）。 */
function resetSens(id = CID, value = 0) {
  db.prepare(`UPDATE characters SET sensitivity = ?, sensitivity_updated_at = ?, sensitivity_sex_day = NULL,
              sensitivity_sex_day_gain = 0, sensitivity_sex_last_at = NULL WHERE id = ?`)
    .run(value, new Date().toISOString(), id)
}
function openScene() {
  saveIntimateScene(CID, {
    ...emptySceneState(CID),
    active: true,
    penetrating: true,
    actKey: 'vaginal',
    positionKey: 'missionary',
    pace: 2,
    accumulation: 0,
  })
}

const readSens = () => S.getSensitivity(CID).value

test('★ ① 一场性爱（十几下推进）要涨到**看得见**的量级，不再是一下 0.1', async () => {
  openScene()
  resetSens()
  const before = readSens()

  // 模拟推进面板的 12 下（每一轮就是路由里那次 applyIntimateStimulus）
  for (let i = 0; i < 12; i += 1) {
    await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0, reason: '性爱推进：继续抽插' })
  }
  const afterThrusts = readSens()
  assert.ok(afterThrusts - before >= 5,
    `12 下推进至少该涨 5 点（实际 ${(afterThrusts - before).toFixed(2)}）—— 用户报的"没增加"就是这里太小吃不出来`)
  assert.equal(Number((afterThrusts - before).toFixed(2)), Number((12 * S.GROWTH.intimate_action).toFixed(2)),
    '每下按 GROWTH.intimate_action 满权重累加')
})

test('★ ② 高潮走 GROWTH.climax × 强度（那一档常量不许再是死代码）', async () => {
  openScene()
  resetSens()

  const oneThrust = await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0 })
  const afterThrust = readSens()
  assert.ok(oneThrust.gain === 0, '面板那一下的累积已由状态机算过 ⇒ 这里的 gain 是 0')

  const climax = await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0, climax: 3 })
  const afterClimax = readSens()
  const climaxDelta = afterClimax - afterThrust
  assert.equal(Number(climaxDelta.toFixed(2)), Number((S.GROWTH.climax * 3).toFixed(2)),
    `强度 3 的高潮该涨 GROWTH.climax×3 = ${(S.GROWTH.climax * 3).toFixed(2)}，实际 ${climaxDelta.toFixed(2)}`)
  assert.ok(climaxDelta > (afterThrust - 0) * 1, '高潮必须比一次普通推进重得多')
  assert.equal(climax.climaxStrength, 3, '回执里要带上强度（面板据此闪一下"她到了"）')
  assert.ok(climax.sensitivity > afterThrust, '回执里要带上涨完之后的敏感度（面板要看得见）')

  // 强度越高涨得越多
  resetSens()
  await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0, climax: 1 })
  const weak = readSens()
  resetSens()
  await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0, climax: 5 })
  const strong = readSens()
  assert.ok(strong > weak, `强度 5 要涨得比强度 1 多：${weak} vs ${strong}`)
})

test('★ ③ 整场：推进 + 一次高潮 ⇒ 从 0 到"很敏感"约 5 场（量级别再被人当成 bug 报一次）', async () => {
  // 用状态机 + 下游走一遍"一场"：抽插到顶（自动高潮）再收尾
  openScene()
  resetSens()
  const start = readSens()
  let accum = 0
  let climaxes = 0
  for (let i = 0; i < 30 && climaxes === 0; i += 1) {
    const state = { ...emptySceneState(CID), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', pace: 2, accumulation: accum }
    const planned = planIntimateAction(state, { actionKey: 'thrust', affinity: 80 })
    accum = planned.next.accumulation
    if (planned.effects.climaxed) {
      climaxes += 1
      await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0, climax: planned.effects.climaxStrength || 3 })
    } else {
      await applyIntimateStimulus({ characterId: CID, source: 'intimate', amount: 0 })
    }
  }
  assert.equal(climaxes, 1, '这一场应当在她到顶时收口一次')
  const grown = readSens() - start
  assert.ok(grown >= 6, `一场下来至少 +6（实际 ${grown.toFixed(2)}）`)
  assert.ok(grown <= 30, `一场也不该直接把她堆到满（实际 ${grown.toFixed(2)}）`)
})

// ── 补图事件名 ──

test('★ ④ 补图事件名：群聊必须发 group_message_update（发 proactive_message_update 就是"光图词没配图"）', () => {
  const groupPayload = {
    id: 77, group_id: 3, role: 'assistant', content: '她喘着气', seq: 12,
    speaker_character_id: 6, speaker_name: '纳西妲', source: 'intimate_action',
  }
  const group = reactionImageUpdate({ scene: 'group', groupPayload, images: ['/api/images/a.png'], groupId: 3 })
  assert.equal(group.event, GROUP_IMAGE_UPDATE_EVENT)
  assert.equal(group.event, 'group_message_update')
  assert.deepEqual(group.payload.images, ['/api/images/a.png'])
  for (const key of ['id', 'group_id', 'seq', 'speaker_character_id', 'speaker_name', 'content']) {
    assert.ok(key in group.payload, `群消息 payload 的 ${key} 必须带过去（群聊 store 靠它认出是哪条气泡）`)
  }
  assert.equal(group.payload.group_id, 3)

  const chat = reactionImageUpdate({ scene: 'chat', target: { firstMsgId: 9, rawId: 4 }, images: ['/api/images/b.png'] })
  assert.equal(chat.event, CHAT_IMAGE_UPDATE_EVENT)
  assert.equal(chat.event, 'proactive_message_update')
  assert.deepEqual(chat.payload, { msg_id: 9, raw_id: 4, images: ['/api/images/b.png'] }, '私聊只认 msg_id/raw_id/images')

  // 没有图 ⇒ 不发广播（调用方据此跳过）
  assert.equal(reactionImageUpdate({ scene: 'group', groupPayload, images: [] }), null)
  assert.equal(reactionImageUpdate({ scene: 'chat', target: {}, images: null }), null)
  // 群 payload 缺失也要发对事件名（宁可少字段，也不要发错事件）
  const fallback = reactionImageUpdate({ scene: 'group', groupPayload: null, target: { firstMsgId: 5 }, images: ['x'], groupId: 3, reactionText: '嗯' })
  assert.equal(fallback.event, 'group_message_update')
  assert.equal(fallback.payload.id, 5)
  assert.equal(fallback.payload.group_id, 3)
})

test('④ 群消息 payload 与写入器同源：writeGroupInsertMessage 的字段就是补图事件要的字段', () => {
  // 造一个群 + 一个角色，真的写一条群消息，拿它的 payload 去组补图事件
  db.prepare('INSERT OR REPLACE INTO group_chats (id, name, topic) VALUES (301, ?, ?)').run('测试群', '测试用')
  db.prepare('INSERT OR REPLACE INTO group_members (group_id, character_id) VALUES (301, ?)').run(CID)
  const written = writeGroupInsertMessage(301, { id: CID, display_name: '敏感增长' }, '她在群里喘着气')
  assert.ok(written && written.msgId, '群消息要写成功')
  const upd = reactionImageUpdate({ scene: 'group', groupPayload: written.payload, images: ['/api/images/c.png'], groupId: 301 })
  assert.equal(upd.event, 'group_message_update')
  assert.equal(upd.payload.id, written.msgId, '补图事件要指到刚写的那条群消息')
  assert.equal(upd.payload.group_id, 301)
  assert.equal(upd.payload.images.length, 1)
})

test('④ 两条链都走同一个口径（源码守卫：别再各写一份事件名）', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  const intimate = read('routes/intimateActions.js')
  const touch = read('routes/touch.js')
  for (const [name, src] of [['intimateActions.js', intimate], ['touch.js', touch]]) {
    assert.match(src, /reactionImageUpdate\(/, `${name} 要用统一口径组补图广播`)
    assert.equal(/broadcast\('proactive_message_update'/.test(src), false,
      `${name} 里不许再手写事件名（散着写就是这次"群聊发错事件"的根因）`)
    assert.equal(/broadcast\('group_message_update'/.test(src), false, `${name} 里不许再手写事件名`)
  }
})

// ── 补图锚点（2026-10-03 复查：直播与刷新后不一致）─────────────────────────────

test('★ ④c 补图锚点：多段反应挂在**最后一条**气泡上（直播 == 刷新后）', () => {
  // 落库口径是**最后一条**：`attachImagesToMessage(pendingMessage.lastMsgId)` /
  // `attachToyImagesToMessage(target.lastMsgId)` 把图写进那一行的 `messages.images`，
  // 刷新后（rawToMessages）图就渲染在那条气泡后面。
  // 而直播以前只认 firstMsgId ⇒ 她的反应被分句成多条气泡时：直播时图挂在**第一条**后面、
  // 刷新一次又跳到最后一条（审查 finding：live 与 post-refresh 的锚点必须一致）。
  const multi = reactionImageUpdate({
    scene: 'chat',
    target: { firstMsgId: 11, lastMsgId: 13, rawId: 4 },
    images: ['/api/images/multi.png'],
  })
  assert.equal(multi.payload.msg_id, 13,
    '三段反应（气泡 11/12/13）的图必须指到第 13 条 —— 与 messages.images 那一行同一个锚点')

  // 单段回复（老调用点只传 firstMsgId）：两个 id 本来就是同一个 ⇒ 载荷逐字不变
  const single = reactionImageUpdate({ scene: 'chat', target: { firstMsgId: 9, rawId: 4 }, images: ['u'] })
  assert.deepEqual(single.payload, { msg_id: 9, raw_id: 4, images: ['u'] },
    '单段回复的私聊载荷形状不变（私聊只认 msg_id/raw_id/images）')

  // 群 payload 缺失时的兜底 id：同样锚最后一条
  const fallback = reactionImageUpdate({
    scene: 'group', groupPayload: null, target: { firstMsgId: 5, lastMsgId: 8 }, images: ['x'], groupId: 3,
  })
  assert.equal(fallback.payload.id, 8, '群兜底 payload 的 id 也要指到最后一条（与落库一致）')
  assert.equal(fallback.payload.group_id, 3)
})

test('④d 两条链的锚点一致（源码守卫：attach 用哪个 id，广播就得用哪个 id）', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  const touch = read('routes/touch.js')
  assert.match(touch,
    /attachImagesToMessage\(pendingMessage\.lastMsgId[\s\S]{0,700}?target: \{ lastMsgId: pendingMessage\.lastMsgId/,
    'touch.js 私聊补图：图写进 lastMsgId ⇒ 广播的 target 也必须带 lastMsgId')
  const intimate = read('routes/intimateActions.js')
  assert.match(intimate, /lastMsgId: written\.lastMsgId \|\| written\.firstMsgId/, '推进链的 target 要给 lastMsgId')
  assert.match(intimate, /attachToyImagesToMessage\(target\.lastMsgId/, '推进链 attach 用的就是 target.lastMsgId')
})
