/**
 * 敏感度 → 高潮的「强度」与「频率」（2026-10-02）
 *
 * 用户原话：「敏感度越高角色高潮的强度越高 也越频繁 性爱的频率也会越频繁」。
 *
 * 拆成两半，各自钉住：
 *   · **频率**：climaxThreshold（门槛只降不升：极度敏感 45 / 很敏感 54 / 其余 60）
 *             climaxResidual（高潮后不回 0：越敏感起点越高 ⇒ 下一轮更快到）
 *   · **强度**：climaxStrength（1~5，与分档一一对应）→ ①prompt 的演出要求 ②她这一下涨多少敏感度
 *             余韵加成 afterglowMultiplier（冷淡 ~1.05 · 敏感 1.4 · 极度敏感 ~1.9）
 *
 * ## 为什么这些断言长这样（上一轮的教训）
 * 我第一版把门槛写成 `60 / 倍率`（冷淡 ⇒ 80）：既有用例 `「一起到」：没到边缘被拒；到边缘后成功`
 * 直接红，而当时已经没余量逐行核它 —— 只能回滚、把这件事留到这一轮。
 * 现在的口径是"**只降不升**"：冷淡档靠"增益 ×0.75 + 高潮更轻 + 没有余韵加成"体现差别，
 * 门槛不抬（新角色默认就是冷淡档，抬门槛等于把新角色的第一次变得很磨人）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const S = await import('../src/services/intimateActionService.js')
const { stimulusPlan } = await import('../src/services/intimateStimulus.js')

/** 五档的倍率（与 sensitivityService.SENSITIVITY_TIERS 同源；改了那边这里会红） */
const M = { cold: 0.75, normal: 0.9, warm: 1, high: 1.15, extreme: 1.35 }

test('① 门槛：只降不升，且随敏感度单调不增', () => {
  assert.equal(S.climaxThreshold(M.warm), S.CLIMAX_MIN_ACCUMULATION, '敏感档（×1.0）必须还是老的 60')
  assert.equal(S.climaxThreshold(M.cold), 60, '冷淡档**不许**把门槛抬到 60 以上（会磨死人）')
  assert.equal(S.climaxThreshold(M.normal), 60)
  assert.ok(S.climaxThreshold(M.high) < 60, '很敏感要更早点得动')
  assert.equal(S.climaxThreshold(M.extreme), S.CLIMAX_THRESHOLD_MIN, '极度敏感到下限 45')
  const seq = [M.cold, M.normal, M.warm, M.high, M.extreme].map(v => S.climaxThreshold(v))
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1], `门槛不许反向：${JSON.stringify(seq)}`)
  // 脏输入 / 缺省：按 1 处理，绝不炸
  assert.equal(S.climaxThreshold(undefined), 60)
  assert.equal(S.climaxThreshold('x'), 60)
  assert.equal(S.climaxThreshold(99), S.CLIMAX_THRESHOLD_MIN, '倍率被夹到 1.5 的上限内')
})

test('② 高潮后起点：普通及以下回 0，越敏感起点越高（= 下一次来得更快）', () => {
  assert.equal(S.climaxResidual(M.cold), 0)
  assert.equal(S.climaxResidual(M.warm), 0)
  assert.ok(S.climaxResidual(M.high) > 0)
  assert.ok(S.climaxResidual(M.extreme) > S.climaxResidual(M.high))
  assert.ok(S.climaxResidual(M.extreme) <= 16, '起点不能太高，否则"连着到"就不值钱了')
})

test('③ 强度：五档一一对应 1~5，且单调不减', () => {
  assert.deepEqual(
    [M.cold, M.normal, M.warm, M.high, M.extreme].map(v => S.climaxStrength(v)),
    [1, 2, 3, 4, 5],
    '冷淡 1 / 普通 2 / 敏感 3 / 很敏感 4 / 极度敏感 5',
  )
  assert.equal(S.climaxStrength(undefined), 3, '缺省按敏感档')
})

test('④ 余韵加成随她浮动：冷淡最低、极度敏感最高，且都夹在合理区间', () => {
  const cold = S.afterglowMultiplier(M.cold)
  const warm = S.afterglowMultiplier(M.warm)
  const extreme = S.afterglowMultiplier(M.extreme)
  assert.equal(warm, S.AFTERGLOW_SENSITIVITY, '敏感档保持原口径 1.4（老行为不变）')
  assert.ok(cold < warm && warm < extreme, `要单调：${cold} < ${warm} < ${extreme}`)
  assert.ok(cold >= 1.05 && extreme <= 2)
})

test('★ 频率：极度敏感的她 45 就能「一起到」，普通敏感度的她还不行', () => {
  const state = { ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', accumulation: 45 }
  const normal = S.planIntimateAction(state, { actionKey: 'climax', sensitivity: M.warm, affinity: 60 })
  assert.equal(normal.ok, false, '普通档 45 还没到 60，点不动')
  assert.equal(normal.code, 'not_edge')
  assert.match(normal.message, /到 60 才能一起到/, '拒绝理由里的门槛必须是**她自己的**门槛')

  const extreme = S.planIntimateAction(state, { actionKey: 'climax', sensitivity: M.extreme, affinity: 60 })
  assert.equal(extreme.ok, true, '极度敏感的她这时候已经可以到了')
  assert.equal(extreme.effects.climaxed, true)
  assert.equal(extreme.effects.climaxStrength, 5, '强度要跟着报出来')
  assert.equal(extreme.next.accumulation, S.climaxResidual(M.extreme), '高潮后不是回 0，而是回到她的起点')
  assert.ok(extreme.next.accumulation > 0)
})

test('★ 强度：同一个 100 顶到自动高潮，冷淡与极度敏感拿到的强度不同', () => {
  const state = { ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', accumulation: S.MAX_ACCUMULATION - 2, pace: 4 }
  const cold = S.planIntimateAction(state, { actionKey: 'thrust', sensitivity: M.cold })
  assert.equal(cold.effects.climaxed, true)
  assert.equal(cold.effects.climaxStrength, 1)
  assert.equal(cold.next.accumulation, 0, '冷淡的她高潮之后回到 0')

  const extreme = S.planIntimateAction(state, { actionKey: 'thrust', sensitivity: M.extreme })
  assert.equal(extreme.effects.climaxed, true)
  assert.equal(extreme.effects.climaxStrength, 5)
  assert.ok(extreme.next.accumulation > 0, '极度敏感的她高潮之后还有余量')
})

test('★ 禁止高潮解开的那一瞬间也算她的一次高潮（强度 / 起点同口径）', () => {
  const state = {
    ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal',
    positionKey: 'missionary', accumulation: 150, denial: 1,
  }
  const out = S.planIntimateAction(state, { actionKey: 'denial', sensitivity: M.extreme })
  assert.equal(out.ok, true)
  assert.equal(out.effects.climaxed, true)
  assert.equal(out.effects.climaxStrength, 5)
  assert.equal(out.effects.denialRelease.peak, 150)
  assert.equal(out.next.accumulation, S.climaxResidual(M.extreme))
})

test('⑤ prompt：强度越高，高潮那一下的演出要求越重（写进模型能看见的地方）', () => {
  const state = { ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', accumulation: 60 }
  const next = { ...state, accumulation: 0, climaxCount: 1 }
  const build = (sensitivity) => S.buildIntimateActionPrompt({
    actionKey: 'climax', state, next, persona: '你是测试角色。', characterName: '她', userName: '他', sensitivity,
  }).system

  const cold = build(M.cold)
  const extreme = build(M.extreme)
  assert.match(cold, /并不算重/, '冷淡档要明说"这一下不算重"')
  assert.match(extreme, /最重的一下/, '极度敏感要写足量级')
  // 老文案不许消失：普通档仍走原来那句
  const warm = build(M.warm)
  assert.match(warm, /绞紧、抽气、叫出声、短暂失神/)
})

test('⑥ 刺激下游：高潮那一下即便累积没涨，也要落到心情与记忆里', () => {
  const state = { accumulation: 0, denial: 0, bondage: 0 }
  const plain = stimulusPlan(state, { source: 'intimate', amount: 0 })
  assert.equal(plain.moodDelta, null, '普通推进（amount 0）不产生心情增量 —— 老口径')
  assert.equal(plain.memorable, false)

  const climax = stimulusPlan(state, { source: 'intimate', amount: 0, climax: 5 })
  assert.ok(climax.moodDelta, '高潮必须给心情一笔（否则"她到了"在心情里等于没发生）')
  assert.ok(climax.moodDelta.arousal > 0 && climax.moodDelta.dominance < 0)
  assert.equal(climax.memorable, true, '她到了一次永远值得记一条记忆')
  assert.equal(climax.climaxStrength, 5)

  // 强度越高，心情那一笔越大
  const weak = stimulusPlan(state, { source: 'intimate', amount: 0, climax: 1 })
  assert.ok(climax.moodDelta.valence > weak.moodDelta.valence)
  // 脏值夹住
  assert.equal(stimulusPlan(state, { climax: 99 }).climaxStrength, 5)
  assert.equal(stimulusPlan(state, { climax: -3 }).climaxStrength, 0)
  assert.equal(stimulusPlan(state, { climax: 'x' }).climaxStrength, 0)
})

test('⑦ 面板快照：暴露她自己的门槛与敏感度（"一起到"的置灰必须与真点一致）', () => {
  const state = { ...S.emptySceneState(1), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', accumulation: 50 }
  const info = { value: 88, tier: { key: 'extreme', label: '极度敏感' }, multiplier: M.extreme, heat: true }
  const snap = S.buildPanelSnapshot(state, { sensitivity: M.extreme, sensitivityInfo: info, affinity: 60 })
  const climaxAction = snap.actions.find(a => a.key === 'climax')
  assert.equal(snap.state.climaxThreshold, 45, '门槛要投影出去（前端不许写死 60）')
  assert.equal(climaxAction.available, true, '累积 50 > 45 ⇒ 面板上「一起到」必须是可点的')
  assert.equal(snap.her.sensitivity.value, 88)
  assert.equal(snap.her.sensitivity.tierLabel, '极度敏感')
  assert.equal(snap.her.sensitivity.climaxStrength, 5)
  assert.equal(snap.her.sensitivity.heat, true)

  // 对照：同样 50，普通敏感度的她应该是灰的（预演真的用了她的敏感度）
  const coldSnap = S.buildPanelSnapshot(state, { sensitivity: M.normal })
  assert.equal(coldSnap.actions.find(a => a.key === 'climax').available, false)
  assert.equal(coldSnap.state.climaxThreshold, 60)
})
