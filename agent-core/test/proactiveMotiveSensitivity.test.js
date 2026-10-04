/**
 * 敏感度 → 「性爱的频率也会越频繁」（2026-10-02）
 *
 * 用户原话：「敏感度越高角色高潮的强度越高 也越频繁 性爱的频率也会越频繁」。
 * **强度与单场频率**在 `climaxSensitivity.test.js` 里钉（门槛 / 强度 / 高潮后起点）；
 * 本文件钉的是"她**多久想一次**"这一半：主动聊天的动机池按敏感度加权（越敏感越容易挑"想要"的那几个）。
 *
 * 实现是**加权**而不是新增动机：池子里多塞几份 NSFW 动机 ⇒ 选中概率变高，动机文案与随机多样性都不动；
 * 冷淡/普通档一份不加 ⇒ 逐字保持旧行为（这是"不许为了新玩法改老行为"的底线）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { pickMotive } = await import('../src/services/proactiveChatScheduler.js')

/** 确定性伪随机（LCG）：统计口径用固定序列，测试不会随机红 */
function lcg(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

/** 用固定随机源抽 n 次，返回「想要 / 深夜发情 / 睡前撩拨…」这类 NSFW 动机的占比 */
function nsfwShare(n, her, { seed = 42, affinity = 95, isOath = true } = {}) {
  const realRandom = Math.random
  const rnd = lcg(seed)
  Math.random = rnd
  try {
    let hit = 0
    for (let i = 0; i < n; i += 1) {
      const m = pickMotive(affinity, 0, isOath, her)
      if (/撒娇|深夜发情|想要被占有|事后温存|发送涩图暗示|睡前撩拨/.test(m.name)) hit += 1
    }
    return hit / n
  } finally {
    Math.random = realRandom
  }
}

test('① 冷淡 / 普通档：动机池与加权前**逐字一致**（不许为了新玩法改老行为）', () => {
  const base = nsfwShare(600, { sensitivity: 0 })
  const normal = nsfwShare(600, { sensitivity: 39 })
  const warm = nsfwShare(600, { sensitivity: 59 })
  assert.equal(base, normal)
  assert.equal(base, warm)
  assert.ok(base > 0 && base < 1, `她本来就会偶尔想（基线 ${base}）`)
})

test('★ 越敏感越容易主动"想要"：占比单调上升，发情模式最高', () => {
  const cold = nsfwShare(800, { sensitivity: 0 })
  const high = nsfwShare(800, { sensitivity: 60 })
  const extreme = nsfwShare(800, { sensitivity: 80 })
  const heat = nsfwShare(800, { sensitivity: 100, heat: true })
  assert.ok(cold < high, `60 档要比基线更容易：${cold} → ${high}`)
  assert.ok(high < extreme, `80 档要更高：${high} → ${extreme}`)
  assert.ok(extreme < heat, `发情模式最高：${extreme} → ${heat}`)
  assert.ok(heat <= 0.95, `再敏感也不是"每次都是那种话题"：${heat}`)
})

test('② 好感 / 誓约的门槛不受影响：没到线的人一条 NSFW 动机都不会出现', () => {
  const realRandom = Math.random
  Math.random = () => 0.999999      // 取池子最后一个
  try {
    // 好感不够 / 没誓约 ⇒ 池子里根本没有 NSFW 动机（哪怕敏感度拉满）
    assert.ok(!/撒娇|深夜发情|想要被占有|发送涩图暗示|睡前撩拨/.test(pickMotive(50, 0, false, { sensitivity: 100, heat: true }).name))
    assert.ok(!/撒娇|深夜发情|想要被占有|发送涩图暗示|睡前撩拨/.test(pickMotive(95, 0, false, { sensitivity: 100, heat: true }).name))
    // 到了线 + 誓约 ⇒ 敏感度拉满时最后一条一定是想 NSFW 的
    assert.ok(/撒娇|深夜发情|想要被占有|事后温存|发送涩图暗示|睡前撩拨/.test(pickMotive(95, 0, true, { sensitivity: 80 }).name))
  } finally {
    Math.random = realRandom
  }
})

test('③ 脏输入 / 缺参数不炸（主动聊天绝不能因为数值系统挂掉）', () => {
  assert.ok(pickMotive(95, 0, true).name, '不传 her 也要能挑')
  assert.ok(pickMotive(95, 0, true, null).name, 'null 也要能挑')
  assert.ok(pickMotive(95, 0, true, { sensitivity: 'x', heat: 'yes' }).name)
  assert.ok(pickMotive(95, 0, true, { sensitivity: 999, heat: true }).name)
  assert.ok(pickMotive(0, 0, false, { sensitivity: 0 }).name)
})
