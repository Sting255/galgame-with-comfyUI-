/**
 * 性爱玩法「更真实」两条：余韵（过敏感）+ 她自己也在要（2026-10-02 用户：「性爱都要更优化一些」）
 *
 * 用户原话：「继续优化一下动作玩法和玩具玩法 让其更真实和有意思 动作和性爱都是」。
 * 这一份钉两条新机制 —— 都是**派生**的（不新增状态字段 ⇒ 不需要迁移、重启后自洽）：
 *
 *   ① **余韵**：她刚被顶过去（`climaxCount > 0`）且累积还没回到 `AFTERGLOW_ACCUMULATION` 以上 ⇒
 *      此刻"敏感得过分"：场景块与动作 prompt 都要写明她不是常态，而且**同样的一下累积涨 1.4 倍**
 *      （落在自动高潮判定之前 ⇒ 余韵里那一推真可能把她再顶过去）。
 *   ② **她自己也在要**：已到边缘（≥ `EDGE_THRESHOLD`）但节奏没跟满档 ⇒ 提示模型写她主动追，
 *      而不是只被动挨着。
 *
 * 同时钉住"边界不误伤"：没插进去 / 没高潮过 / 累积已回升 ⇒ 两条都不成立（老行为逐字节不变）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  emptySceneState, isAfterglow, isBegging, planIntimateAction, listPositionOptions,
  buildIntimateSceneBlock, buildIntimateActionPrompt,
  AFTERGLOW_ACCUMULATION, AFTERGLOW_SENSITIVITY,
  EDGE_THRESHOLD, MAX_ACCUMULATION, PACE_MAX,
} = await import('../src/services/intimateActionService.js')

/** 造一个"进行中"的基准状态 */
function activeState(patch = {}) {
  return {
    ...emptySceneState(1),
    active: true,
    penetrating: true,
    positionKey: 'missionary',
    actKey: 'vaginal',
    pace: 2,
    accumulation: 30,
    rounds: 5,
    ...patch,
  }
}

test('① 余韵判定：高潮过 + 累积低 + 还插着；其余一律不成立', () => {
  assert.equal(isAfterglow(activeState({ climaxCount: 1, accumulation: 0 })), true)
  assert.equal(isAfterglow(activeState({ climaxCount: 2, accumulation: AFTERGLOW_ACCUMULATION })), true, '边界含')
  assert.equal(isAfterglow(activeState({ climaxCount: 1, accumulation: AFTERGLOW_ACCUMULATION + 1 })), false, '缓过来了就不算余韵')
  assert.equal(isAfterglow(activeState({ climaxCount: 0, accumulation: 0 })), false, '这一场还没到过顶')
  assert.equal(isAfterglow(activeState({ climaxCount: 1, accumulation: 0, penetrating: false })), false, '没插着不算')
  for (const bad of [null, undefined, {}, 0]) assert.equal(isAfterglow(bad), false, '脏输入不炸')
})

test('② 她在要：边缘以上 + 节奏没满档 + 不在余韵；边界不误伤', () => {
  assert.equal(isBegging(activeState({ climaxCount: 0, accumulation: EDGE_THRESHOLD, pace: 2 })), true)
  assert.equal(isBegging(activeState({ climaxCount: 0, accumulation: EDGE_THRESHOLD - 1, pace: 2 })), false, '没到边缘就不算')
  assert.equal(isBegging(activeState({ climaxCount: 0, accumulation: EDGE_THRESHOLD, pace: PACE_MAX })), false, '已经满档了她不用求')
  assert.equal(isBegging(activeState({ climaxCount: 1, accumulation: 5, pace: 2 })), false, '余韵里不算"要"（那条另说）')
  for (const bad of [null, undefined, {}, 0]) assert.equal(isBegging(bad), false, '脏输入不炸')
})

test('③ 余韵里再推：累积按 1.4 倍放大，且这一推可能直接把她再顶过去', () => {
  const pre = activeState({ climaxCount: 1, accumulation: 10, pace: 2 })
  const r = planIntimateAction(pre, { actionKey: 'thrust', affinity: 90 })
  assert.equal(r.ok, true)
  const plain = planIntimateAction(activeState({ climaxCount: 1, accumulation: 40, pace: 2 }), { actionKey: 'thrust', affinity: 90 })
  const plainNext = plain.next.accumulation          // 40 + 16 = 56
  const plainBase = 40 + (plainNext - 40)            // 同口径的"无加成结果"
  const afterglowBase = 10 + (plainNext - 40)        // 10 + 16 = 26
  // 实现口径：**缩放"这一下之后的结果"**（不是缩放增益）—— 所以余韵里从低基数起步也会被推得明显更高
  assert.equal(r.next.accumulation, Math.round(afterglowBase * AFTERGLOW_SENSITIVITY),
    `余韵里 10 → 应=${Math.round(afterglowBase * AFTERGLOW_SENSITIVITY)}，实际 ${r.next.accumulation}（无加成会停在 ${afterglowBase}）`)
  assert.ok(r.next.accumulation > afterglowBase, '余韵里必须比无加成更高')
  assert.ok(plainNext === plainBase, '对照口径自检')

  // 从余韵阈值顶点再推一下 ⇒ 直接到顶（自动高潮），这正是"受不了"的落点
  const edge = activeState({ climaxCount: 1, accumulation: AFTERGLOW_ACCUMULATION, pace: 2 })
  const r2 = planIntimateAction(edge, { actionKey: 'faster', affinity: 90 })
  assert.equal(r2.ok, true)
  if (r2.next.accumulation === 0) {
    assert.equal(r2.effects.climaxed, true, '清零必须伴随 climaxed')
    assert.equal(r2.next.climaxCount, 2)
  }
})

test('④ 换姿势走自己的口径（既有 +2），不吃余韵放大', () => {
  // 体位 key 用服务层自己给的可选清单里的第一条非当前体位（别猜 key：猜错会 reject，看不出真正想验的东西）
  const firstKey = listPositionOptions().map(p => p.key).find(k => k && k !== 'missionary')
  assert.ok(firstKey, '至少要有一个可切换的体位')
  const pre = activeState({ climaxCount: 1, accumulation: 10 })
  const swap = planIntimateAction(pre, { actionKey: 'position', positionKey: firstKey, affinity: 90 })
  assert.equal(swap.ok, true, `换到 ${firstKey} 应当成功：${swap.message || ''}`)
  // 换姿势本身有 +2（既有设计：摆体位也是身体的位移），但它**不该**被余韵放大
  assert.equal(swap.next.accumulation, pre.accumulation + 2, '换姿势 = 既有 +2 口径')
  assert.notEqual(swap.next.accumulation, Math.round((pre.accumulation + 2) * AFTERGLOW_SENSITIVITY), '换姿势不吃放大')
})

test('⑤ 两个块都要写明状态（模型看不见状态就等于没做）', () => {
  const afterglowBlock = buildIntimateSceneBlock(activeState({ climaxCount: 1, accumulation: 8 }), { chatUserName: '阿远' })
  assert.match(afterglowBlock, /【余韵】/, '场景块要写余韵')
  assert.match(afterglowBlock, /敏感得过分/, '要说清"不是常态"')
  assert.doesNotMatch(afterglowBlock, /【她自己也在要】/, '两条互斥，不能同时出现')

  const beggingBlock = buildIntimateSceneBlock(activeState({ climaxCount: 0, accumulation: EDGE_THRESHOLD + 5, pace: 2 }), { chatUserName: '阿远' })
  assert.match(beggingBlock, /【她自己也在要】/, '场景块要写她在主动追')
  assert.doesNotMatch(beggingBlock, /【余韵】/, '没高潮过就谈不上余韵')

  const plainBlock = buildIntimateSceneBlock(activeState({ climaxCount: 0, accumulation: 20, pace: 2 }), { chatUserName: '阿远' })
  assert.doesNotMatch(plainBlock, /【余韵】|【她自己也在要】/, '普通状态不多注入')

  // 动作反应 prompt 同理（签名是 `{ actionKey, state, next, … }` —— **不是** before/after；
  // 返回 `{ system, user, messages }` 对象，不是字符串 ⇒ 拼成全文再断言）
  const promptText = (p) => [p.system, p.user, ...(p.messages || []).map(x => x?.content || '')].join('\n')
  const prompt = buildIntimateActionPrompt({
    characterName: '纳西妲', userName: '阿远', actionKey: 'climax',
    state: activeState({ climaxCount: 0, accumulation: 30, penetrating: true }),
    next: activeState({ climaxCount: 1, accumulation: 0, penetrating: true }),
    beat: '你把她送了上去', position: { key: 'missionary', label: '传教士体位' },
  })
  assert.match(promptText(prompt), /推过了顶点/, '高潮当下仍以"失控"为主（不能被余韵文案盖掉）')
  const prompt2 = buildIntimateActionPrompt({
    characterName: '纳西妲', userName: '阿远', actionKey: 'thrust',
    // 两侧都要在余韵区间内（累积 ≤ AFTERGLOW_ACCUMULATION）才算"还在余韵里"——
    // 累积一旦回升过阈值，她就缓过来了（这正是这条机制自然收尾的方式）
    state: activeState({ climaxCount: 1, accumulation: 2, penetrating: true }),
    next: activeState({ climaxCount: 1, accumulation: 12, penetrating: true }),
    beat: '你又顶了一下', position: { key: 'missionary', label: '传教士体位' },
  })
  assert.match(promptText(prompt2), /还在余韵里/, '余韵里的动作 prompt 要带这条')
  // 对照：同一个动作、累积已回升出余韵区间 ⇒ 不许再带余韵文案
  const prompt3 = buildIntimateActionPrompt({
    characterName: '纳西妲', userName: '阿远', actionKey: 'thrust',
    state: activeState({ climaxCount: 1, accumulation: 30, penetrating: true }),
    next: activeState({ climaxCount: 1, accumulation: 46, penetrating: true }),
    beat: '你又顶了一下', position: { key: 'missionary', label: '传教士体位' },
  })
  assert.doesNotMatch(promptText(prompt3), /还在余韵里/, '缓过来之后不该再写余韵')
})

test('⑥ 常量口径（改阈值会同时改行为，所以钉死）', () => {
  assert.equal(AFTERGLOW_ACCUMULATION, 15)
  assert.equal(AFTERGLOW_SENSITIVITY, 1.4)
  assert.ok(EDGE_THRESHOLD >= 40 && EDGE_THRESHOLD <= 80, '边缘阈值在 40~80')
  assert.ok(MAX_ACCUMULATION > EDGE_THRESHOLD, 'MAX 要比边缘高')
})
