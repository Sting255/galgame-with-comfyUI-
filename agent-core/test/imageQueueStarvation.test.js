/**
 * 图片队列的「低优饿死」回归测试（2026-10-01，用户真机日志里那场 52 分钟冻结）
 *
 * ## 日志实证的因果链
 * ```
 * 04:55:17  朋友圈配文生成完（5 秒）
 * 05:47:23  才开始构建这条朋友圈的**配图提示词**      ← 中间 52 分钟
 * 05:05–05:47  momentScheduler 连续跳过 5 个 tick
 *              eventScheduler / 主动聊天 Line A 同样卡住（一个 32 分钟、一个 42 分钟）
 * 05:47:27–05:47:41  三者一起解冻（差 14 秒）
 * ```
 * 这 52 分钟里系统串行出了 106 张图（约 13.5 秒/张），而**用户一直在玩**：
 * 高优任务（聊天/触摸配图）不断刷新 `lastHighTime`，低优任务要求「距上次高优 ≥180 秒」才派发
 * ⇒ **只要用户在玩，后台图永远排不上**；三个调度器都在 await 那张图,于是三个玩法一起冻结。
 *
 * ## 修法（本文件钉住的）
 * 1. 低优任务最多等 `LOW_QUEUE_MAX_WAIT`（10 分钟）；超过就不再遵守静默期（仍不与正在生成的那张抢），
 *    并打一条 warn 让它在日志里可见 —— 策略抽成纯函数 `decideLowDispatch` 以便测试。
 * 2. `processLowQueue` 在"有任务在跑"时**必须排复查**：以前直接 return 且不排，
 *    此后若没有高优任务再触发，整个低优队列会永久停摆（第二条饿死路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { decideLowDispatch } = await import('../src/services/imageSkill.js')

const MIN = 60_000
const QUIET = 180_000
const CAP = 10 * MIN
const T0 = 1_800_000_000_000

test('用户空闲够久 → 立刻派发（原行为不变）', () => {
  const r = decideLowDispatch(T0, T0 - 5 * MIN, T0, QUIET, CAP)
  assert.equal(r.dispatch, true)
  assert.equal(r.starved, false)
  assert.equal(r.waitMs, 0)
})

test('用户刚做过高优任务 + 低优刚入队 → 继续等（礼貌性静默，不能丢）', () => {
  const r = decideLowDispatch(T0, T0 - 10_000, T0 - 5_000, QUIET, CAP)
  assert.equal(r.dispatch, false, '刚入队就该让路')
  assert.ok(r.waitMs > 0, '要给出复查时间')
})

test('★ 用户在玩但低优已经等了 11 分钟 → 必须放行（这就是那 52 分钟的病根）', () => {
  // 用户 10 秒前刚聊过（静默期远没到），但这张后台图已排队 11 分钟
  const r = decideLowDispatch(T0, T0 - 10_000, T0 - 11 * MIN, QUIET, CAP)
  assert.equal(r.dispatch, true, '等过头了就必须放行，否则后台玩法会被无限冻住')
  assert.equal(r.starved, true, '要标记成"饿死放行"，调用方据此打 warn')
})

test('★ 场景复演：用户每分钟都活跃一次、持续 30 分钟', () => {
  const enqueuedAt = T0
  let dispatchedAt = null
  for (let m = 1; m <= 30; m++) {
    const now = T0 + m * MIN
    const lastHigh = now - 10_000          // 每分钟都刚做过高优任务
    const r = decideLowDispatch(now, lastHigh, enqueuedAt, QUIET, CAP)
    if (r.dispatch) { dispatchedAt = m; break }
  }
  assert.ok(dispatchedAt !== null, '持续活跃时也必须最终派发，而不是永远等下去')
  assert.ok(dispatchedAt <= 12, `应在 ~10 分钟内放行，实际第 ${dispatchedAt} 分钟`)
})

test('源码级：两条早退路径都必须排复查（不许再出现"return 了但没人再叫它"）', () => {
  const src = fs.readFileSync(new URL('../src/services/imageSkill.js', import.meta.url), 'utf8')
  const at = src.indexOf('function processLowQueue() {')
  assert.ok(at > 0)
  const body = src.slice(at, src.indexOf('\n}', at))
  assert.match(body, /if \(activeTaskCount > 0\) \{ scheduleLowRetry\(/, '有任务在跑时要排复查')
  assert.match(body, /if \(!verdict\.dispatch\) \{ scheduleLowRetry\(/, '还在静默期时要排复查')
  assert.equal(/if \(activeTaskCount > 0\) return;/.test(body), false, '不许再"直接 return 不排复查"')
  // 入队必须带时间戳，否则没法算等待时长
  const pushes = src.match(/lowQueue\.push\([^)]*\)/g) || []
  assert.ok(pushes.length >= 2, 'generateImage / generateImageRaw 两个入口都要入队')
  for (const p of pushes) assert.match(p, /enqueuedAt: Date\.now\(\)/, '每个入队点都要记 enqueuedAt')
})
