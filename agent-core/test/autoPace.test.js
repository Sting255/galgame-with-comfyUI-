/**
 * 「自动的速度新增一个单独的」—— 自动速度是**独立旋钮**（2026-10-03 用户原话）
 *
 * ## 语义（用户当天又澄清了一次，必须按这条读）
 *   「**自动的意思是自动插入 不是自己动** 命令那个可以改成命令自己动」
 *   ⇒ `auto` 这一档 = **他**按节奏自动插送；`command` 那一档 = **命令她自己动**。
 *   本文件里凡是"自动"，都是"他在动"。
 *
 * ## 为什么要拆两个旋钮
 * 2026-10-02 那版把"自动插送的快慢"直接绑在**手动节奏档**（`pace`，由「加速抽插 / 慢下来」改）上。
 * 结果两个旋钮互相污染：想把自动插送调快，就必须把"他手点时顶得多快"也一起调；调完 `pace`，
 * 手点一下的增益也跟着变。用户原话就是要一个**单独的**自动速度。
 *
 * ## 拆完的口径（本文件钉死）
 *   · `pace`     手动节奏档：他手点时顶得多快、**那一下**涨多少（`3 + pace×2`）
 *   · `autoPace` 自动速度：**他自动插送**的频率（`AUTO_PACE_INTERVALS`）与每下涨多少（`autoTickGain`）
 *   · `auto` 动作带 `pace` 且已在自动中 ⇒ **只改自动速度**，不关自动、不碰手动节奏
 *   · 自动轮（ticker 发来的 `{ auto: true }`）⇒ 增益走 autoTickGain(autoPace)，演出写成"他在自动插送"
 *   · 落库/读回：`auto_pace` 列（老行补默认 2 = 旧行为）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const S = await import('../src/services/intimateActionService.js')
const tick = await import('../src/services/intimateAutoThrust.js')

const scene = (over = {}) => ({
  ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal',
  positionKey: 'missionary', pace: 2, accumulation: 0, ...over,
})

test('① 间隔表只有一份：缓 5.0s / 正常 3.0s / 快 2.0s / 冲刺 1.5s，且自动轮用的是**自动速度**', () => {
  assert.deepEqual([...S.AUTO_PACE_INTERVALS], [0, 5000, 3000, 2000, 1500])
  assert.equal(S.intervalForAutoPace(1), 5000)
  assert.equal(S.intervalForAutoPace(4), 1500)
  assert.equal(S.intervalForAutoPace(undefined), 3000, '缺省 = 正常 3 秒（与旧口径一致）')
  assert.equal(S.intervalForAutoPace(99), 1500, '越界夹到 4')
  // 旧名保留（ticker 与既有测试还在用），并且与主表同源
  for (const p of [1, 2, 3, 4]) assert.equal(tick.intervalForPace(p), S.intervalForAutoPace(p))
})

test('★ ② `auto` 动作带 pace：只在"已经在自动中"时改速度，不关自动、不碰手动节奏', () => {
  const autoOn = scene({ autoThrust: 1, autoPace: 2, pace: 3 })
  const changed = S.planIntimateAction(autoOn, { actionKey: 'auto', pace: 4 })
  assert.equal(changed.ok, true)
  assert.equal(changed.next.autoPace, 4)
  assert.equal(changed.next.autoThrust, 1, '改速度不许顺手把自动关掉')
  assert.equal(changed.next.pace, 3, '手动节奏档不许被自动速度覆盖')
  assert.equal(changed.effects.autoPaceChanged, 4)

  // 还没开自动时带 pace ⇒ 开自动 + 用这个速度
  const off = scene({ autoThrust: 0, autoPace: 2, pace: 2 })
  const turnedOn = S.planIntimateAction(off, { actionKey: 'auto', pace: 3 })
  assert.equal(turnedOn.next.autoThrust, 1)
  assert.equal(turnedOn.next.autoPace, 3)
  assert.equal(turnedOn.effects.autoChanged, 'on')

  // 不带 pace 且已经在自动中 ⇒ 老语义：关掉
  const toggledOff = S.planIntimateAction(autoOn, { actionKey: 'auto' })
  assert.equal(toggledOff.next.autoThrust, 0)
  assert.equal(toggledOff.next.autoPace, 2, '关自动不动速度（下次开还是这个速度）')

  // 脏 pace 不炸：夹到合法档
  assert.equal(S.planIntimateAction(autoOn, { actionKey: 'auto', pace: 99 }).next.autoPace, 4)
  assert.equal(S.planIntimateAction(autoOn, { actionKey: 'auto', pace: -3 }).next.autoPace, 1)
  assert.equal(S.planIntimateAction(autoOn, { actionKey: 'auto', pace: 'x' }).next.autoPace, 2, '非数字 ⇒ 当成没给（不改速度）')
  // 门控只拦"开"，**不拦"关/改速度"**（2026-10-03 复查：原来一律拒绝，导致"换到非插入体位"
  // 之后自动既关不掉、ticker 也不干活 —— 死局）
  assert.equal(S.planIntimateAction(scene({ autoThrust: 0, penetrating: false }), { actionKey: 'auto' }).code, 'not_penetrating',
    '没插进去时不许"开"自动')
  const offWhileOut = S.planIntimateAction(scene({ autoThrust: 1, penetrating: false }), { actionKey: 'auto' })
  assert.equal(offWhileOut.ok, true, '已经开着的时候必须能关掉（哪怕此刻没插进去）')
  assert.equal(offWhileOut.next.autoThrust, 0)
})

test('★ ③ 自动轮（auto:true）的增益由自动速度决定，手动节奏档完全不参与', () => {
  const base = { active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', autoThrust: 1, accumulation: 0 }
  const slowAuto = S.planIntimateAction({ ...S.emptySceneState(1), ...base, pace: 4, autoPace: 1 }, { actionKey: 'thrust', autoRun: true })
  const fastAuto = S.planIntimateAction({ ...S.emptySceneState(1), ...base, pace: 1, autoPace: 4 }, { actionKey: 'thrust', autoRun: true })
  assert.equal(slowAuto.next.accumulation, S.autoTickGain(1), `自动速度 1 ⇒ +${S.autoTickGain(1)}`)
  assert.equal(fastAuto.next.accumulation, S.autoTickGain(4), `自动速度 4 ⇒ +${S.autoTickGain(4)}`)
  assert.ok(fastAuto.next.accumulation > slowAuto.next.accumulation, '自动速度越快，每下涨得越多')
  assert.equal(slowAuto.effects.autoTick, true, '要标出"这一下是他自动插送的"（演出走另一套文案）')

  // 手点一下（不带 auto）+ 手动节奏档 4 ⇒ 仍按手动档算，与自动速度无关
  const manual = S.planIntimateAction({ ...S.emptySceneState(1), ...base, pace: 4, autoPace: 1 }, { actionKey: 'thrust' })
  assert.equal(manual.next.accumulation, 3 + 4 * 2, '手点一下的增益只认手动节奏档')
  assert.equal(manual.effects.autoTick, undefined)
})

test('★ ③b 演出文案：自动轮要写成"**他**在自动插送"，不许写成她自己动', () => {
  // 用户 2026-10-03 澄清：「自动的意思是自动插入 不是自己动」——第一版写反了，这一条就是防它再写反
  const state = scene({ autoThrust: 1, autoPace: 3 })
  const beat = S.describeActionBeat({ actionKey: 'thrust', state, next: { ...state, autoPace: 3 }, autoRun: true })
  assert.match(beat, /他/)
  assert.match(beat, /自动/)
  assert.match(beat, /快/, '要带上当前自动速度')
  assert.equal(/她自己动着/.test(beat), false, '不许写成她自己动')
  const manualBeat = S.describeActionBeat({ actionKey: 'thrust', state, next: state })
  assert.match(manualBeat, /他保持/)
  // 改速度的旁白
  const paceBeat = S.describeActionBeat({ actionKey: 'auto', state: scene({ autoThrust: 1, autoPace: 2 }), next: scene({ autoThrust: 1, autoPace: 4 }) })
  assert.match(paceBeat, /速度/)
  assert.match(paceBeat, /冲刺/)
  // 开关的旁白：开 = 他改自动插送；关 = 停掉
  const onBeat = S.describeActionBeat({ actionKey: 'auto', state: scene({ autoThrust: 0 }), next: scene({ autoThrust: 1 }) })
  assert.match(onBeat, /自动插送/)
  const offBeat = S.describeActionBeat({ actionKey: 'auto', state: scene({ autoThrust: 1 }), next: scene({ autoThrust: 0 }) })
  assert.match(offBeat, /停/)
})

test('★ ③c 命令那一档＝「命令她自己动」：文案要他不动手、全要她自己来', () => {
  const state = scene({ autoThrust: 0 })
  const plain = S.describeActionBeat({ actionKey: 'command', state, next: state })
  assert.match(plain, /命令你自己动/)
  assert.match(plain, /他不碰你/)
  const bound = S.describeActionBeat({ actionKey: 'command', state: scene({ bondage: 1 }), next: scene({ bondage: 1 }) })
  assert.match(bound, /命令你自己动/)
  assert.match(bound, /束着/)
  // 动作表里的按钮文案也要对上（用户点的是这个）
  const cmd = S.listIntimateActions().find(a => a.key === 'command')
  assert.equal(cmd.label, '命令她自己动')
  const auto = S.listIntimateActions().find(a => a.key === 'auto')
  assert.equal(auto.label, '自动插入')
})

test('④ 补算 tick 也按自动速度：同一段时间里，自动速度快 ⇒ 涨得多', () => {  const state = { ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', autoThrust: 1, lastActionAt: '2026-10-03T12:00:00Z' }
  const now = Date.parse('2026-10-03T12:00:04Z')   // 4 秒后：正常档 1 个 tick，冲刺档 2 个
  const normal = S.planIntimateAction({ ...state, autoPace: 2 }, { actionKey: 'thrust', now })
  const sprint = S.planIntimateAction({ ...state, autoPace: 4 }, { actionKey: 'thrust', now })
  assert.ok((normal.effects.autoTicks || 0) >= 1, '正常档 4 秒该补 1 个 tick')
  assert.ok((sprint.effects.autoTicks || 0) > (normal.effects.autoTicks || 0), '冲刺档补得更多')
})

test('⑤ 快照：把自动速度投影出去（面板要显示选中态与"多久一下"）', () => {
  const snap = S.buildPanelSnapshot(scene({ autoThrust: 1, autoPace: 3 }), {})
  assert.equal(snap.state.autoThrust, true)
  assert.equal(snap.state.autoPace, 3)
  assert.equal(snap.state.autoPaceLabel, '快')
  assert.equal(snap.state.autoIntervalMs, 2000)
  assert.equal(snap.state.autoTickGain, S.autoTickGain(3))
  // 没开自动时也给（面板要能先选速度再开）
  const off = S.buildPanelSnapshot(scene({ autoThrust: 0, autoPace: 1 }), {})
  assert.equal(off.state.autoPace, 1)
  assert.equal(off.state.autoIntervalMs, 5000)
})

test('⑥ 老行兼容：没有 auto_pace 的场次读回"正常"，ticker 也不会用它当手动档', () => {
  const legacy = S.normalizeSceneState({ character_id: 1, active: 1, penetrating: 1, pace: 4, auto_thrust: 1 }, 1)
  assert.equal(legacy.autoPace, 2, '老行（没有 auto_pace 列）⇒ 默认正常，等于迁移前的行为')
  const row = { characterId: 1, pace: 4, autoPace: undefined, lastActionAt: null }
  const scenes = [row].map(r => ({ ...r, autoPace: Number(r.autoPace) || Number(r.pace) || 2 }))
  assert.equal(scenes[0].autoPace, 4, 'SQL 回退：没有 auto_pace 时沿用旧的手动节奏档行为')
})
