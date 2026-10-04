/**
 * 催眠手机 · 睡眠控制区的纯逻辑单测（task-B）
 *
 * 用户口径：「催眠手机是全覆盖的」（睡眠控制要有入口）、「单独一个选项控制睡眠」。
 * 所以睡眠是**独立一区**：它不是催眠指令，状态来自睡眠服务
 * （后端形状 { characterId, isSleeping, sleepUntil, temporaryWakeUntil }）。
 *
 * 本文件只测不依赖 Vue 的纯函数与请求形状：
 *   1. 状态归一化（camelCase / snake_case / 挂在 GET /hypnosis 里的嵌套形状 / 0-1 与字符串）；
 *   2. 睡眠文案与两个按钮的开关判定（含"读不到状态"这一态）；
 *   3. 两个接口的 URL 与 body 形状；
 *   4. 睡眠动作**不混进**催眠指令集合（与 ACTION_DEFS / GROUP_BATCH_ACTIONS 分离）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { translateHypnosisError } from '../src/api/hypnosis.js'
import {
  ACTION_DEFS,
  GROUP_BATCH_ACTIONS,
  SLEEP_ACTIONS,
  SLEEP_SECTION_NOTE,
  SLEEP_TOAST,
  normalizeSleep,
  resolveSleep,
  sleepViewModel,
} from '../src/components/hypnosisLogic.js'

const UNKNOWN = { known: false, isSleeping: false, sleepUntil: null, temporaryWakeUntil: null }

// ── 1. 状态归一化 ──

test('normalizeSleep：camelCase / snake_case / 0-1 / 字符串 / 布尔都认', () => {
  const camel = normalizeSleep({ isSleeping: true, sleepUntil: '2026-09-29 06:00:00', temporaryWakeUntil: null })
  assert.deepEqual(camel, { known: true, isSleeping: true, sleepUntil: '2026-09-29 06:00:00', temporaryWakeUntil: null })

  const snake = normalizeSleep({ is_sleeping: 1, sleep_until: '2026-09-29 06:00:00', temporary_wake_until: '2026-09-28 02:00:00' })
  assert.equal(snake.known, true)
  assert.equal(snake.isSleeping, true)
  assert.equal(snake.sleepUntil, '2026-09-29 06:00:00')
  assert.equal(snake.temporaryWakeUntil, '2026-09-28 02:00:00')

  assert.equal(normalizeSleep({ is_sleeping: '1' }).isSleeping, true, 'SQLite 出来的字符串 "1"')
  assert.equal(normalizeSleep({ is_sleeping: '0' }).isSleeping, false)
  assert.equal(normalizeSleep({ is_sleeping: 0 }).isSleeping, false)
  assert.equal(normalizeSleep({ isSleeping: false }).isSleeping, false)
})

test('normalizeSleep：嵌套形状（挂在 GET /hypnosis 状态里）与"只给了 sleepUntil"', () => {
  // 后端同事可能把睡眠字段挂在既有状态里，两种都收
  const nested = normalizeSleep({ active: true, sleep: { isSleeping: true, sleepUntil: '2026-09-29 06:00:00' } })
  assert.equal(nested.known, true)
  assert.equal(nested.isSleeping, true)
  assert.equal(normalizeSleep({ sleepState: { is_sleeping: 1 } }).isSleeping, true)
  // 只有 sleep_until 没有标记 → 有值即视为在睡（后端只会给睡着的人写这个字段）
  assert.equal(normalizeSleep({ sleepUntil: '2026-09-29 06:00:00' }).isSleeping, true)
  assert.equal(normalizeSleep({ sleepUntil: '' }).isSleeping, false, '空值不算在睡')
})

test('normalizeSleep：没有任何睡眠信息时要如实说"不知道"', () => {
  for (const bad of [null, undefined, {}, 'nope', { name: '林晚' }, { active: true, gate: {} }]) {
    assert.equal(normalizeSleep(bad).known, false, `${JSON.stringify(bad)} 不该被当成已知的睡眠状态`)
  }
  // 未知时不能假装"她是醒着的"
  assert.equal(normalizeSleep({}).isSleeping, false)
  assert.equal(normalizeSleep({}).known, false)
})

test('resolveSleep：取第一个"真的有睡眠信息"的来源（操作返回 → 状态 → 角色行）', () => {
  const fromAction = { isSleeping: true, sleepUntil: 'A' }
  const fromState = { is_sleeping: 0 }
  const fromCharacter = { is_sleeping: 1 }
  assert.equal(resolveSleep(fromAction, fromState, fromCharacter).sleepUntil, 'A')
  assert.equal(resolveSleep({}, null, fromCharacter).isSleeping, true, '前面几个都没有信息时用角色行')
  assert.deepEqual(resolveSleep({}, null, undefined), UNKNOWN)
  assert.deepEqual(resolveSleep(), UNKNOWN)
})

// ── 2. 视图与按钮判定 ──

test('睡眠区视图：睡眠中 / 清醒 / 未知三态', () => {
  const now = Date.UTC(2026, 8, 28, 12, 0, 0)
  const sleeping = sleepViewModel({ isSleeping: true, sleepUntil: '2026-09-28 20:00:00' }, now)
  assert.equal(sleeping.statusText, '睡眠中')
  assert.equal(sleeping.isSleeping, true)
  assert.equal(sleeping.canSleep, false, '已经在睡就不给「睡觉」')
  assert.equal(sleeping.canWake, true)
  assert.match(sleeping.untilText, /预计 \d{2}-\d{2} \d{2}:\d{2} 醒来/, '要显示预计醒来时刻')
  // 没给 sleepUntil 时不显示时间行，不编造
  assert.equal(sleepViewModel({ isSleeping: true }, now).untilText, '')

  const awake = sleepViewModel({ isSleeping: false, sleepUntil: null }, now)
  assert.equal(awake.statusText, '清醒')
  assert.equal(awake.canSleep, true)
  assert.equal(awake.canWake, false)
  assert.equal(awake.untilText, '')

  const unknown = sleepViewModel(UNKNOWN, now)
  assert.equal(unknown.statusText, '未知')
  assert.equal(unknown.known, false)
  // 读不到状态 = 不知道她睡没睡：两个按钮都放开，让后端给出结果（不能因为读不到就卡死入口）
  assert.equal(unknown.canSleep, true)
  assert.equal(unknown.canWake, true)
  assert.equal(sleepViewModel({}, now).statusText, '未知', '空对象同样是未知')
})

test('睡眠区视图：临时唤醒（temporaryWakeUntil 在未来）只作补充说明', () => {
  const now = Date.UTC(2026, 8, 28, 12, 0, 0)
  const future = sleepViewModel({ isSleeping: false, temporaryWakeUntil: '2026-09-28 13:00:00' }, now)
  assert.equal(future.tempWoken, true)
  assert.match(future.tempWakeText, /被临时叫醒，醒着到 \d{2}-\d{2} \d{2}:\d{2}/)
  // 已经过期的临时唤醒不再展示（后端 is_sleeping 才是主判定）
  const past = sleepViewModel({ isSleeping: false, temporaryWakeUntil: '2026-09-28 09:00:00' }, now)
  assert.equal(past.tempWoken, false)
  assert.equal(past.tempWakeText, '')
  // 主判定永远听 is_sleeping：哪怕临时唤醒时间在未来，只要后端说睡着就还是"睡眠中"
  const odd = sleepViewModel({ isSleeping: true, temporaryWakeUntil: '2026-09-28 13:00:00' }, now)
  assert.equal(odd.statusText, '睡眠中')
})

// ── 3. 文案与"独立于催眠指令"的分界 ──

test('睡眠区：两个动作、文案与 toast 固定，且带"与催眠无关"的说明', () => {
  assert.deepEqual(SLEEP_ACTIONS.map(a => a.key), ['sleep', 'wakeUp'])
  assert.deepEqual(SLEEP_ACTIONS.map(a => a.label), ['睡觉', '唤醒'])
  assert.equal(SLEEP_TOAST.sleep, '她已经去睡了')
  assert.equal(SLEEP_TOAST.wakeUp, '她醒过来了')
  assert.match(SLEEP_SECTION_NOTE, /睡没睡/)
  assert.match(SLEEP_SECTION_NOTE, /催眠/)
})

test('睡眠动作不混进催眠指令集合：ACTION_DEFS / GROUP_BATCH_ACTIONS 保持原样', () => {
  const hypnoKeys = ACTION_DEFS.map(a => a.key)
  assert.deepEqual(hypnoKeys, ['hypnotize', 'wake', 'wakeMind', 'forcedClimax', 'forget'], '催眠按钮集合不许被睡眠动作污染')
  assert.deepEqual(GROUP_BATCH_ACTIONS.map(a => a.key), ['hypnotize', 'wake', 'wakeMind', 'forcedClimax'])
  for (const action of SLEEP_ACTIONS) {
    assert.ok(!hypnoKeys.includes(action.key), `睡眠动作 ${action.key} 不该出现在 ACTION_DEFS 里`)
    assert.ok(!GROUP_BATCH_ACTIONS.some(a => a.key === action.key), `睡眠动作 ${action.key} 不该混进批量催眠按钮`)
  }
})

// ── 4. 接口形状与错误翻译（fetch 打桩，不联网） ──

test('睡眠接口：POST /api/characters/:id/hypnosis/sleep|wake，均不带 mode', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body })
    return {
      ok: true,
      json: async () => ({ characterId: 7, isSleeping: true, sleepUntil: '2026-09-29 06:00:00', temporaryWakeUntil: null }),
    }
  }
  try {
    const api = await import('../src/api/hypnosis.js')
    const slept = await api.sleepCharacter(7)
    const woke = await api.wakeFromSleepCharacter(7)
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
      'POST /api/characters/7/hypnosis/sleep',
      'POST /api/characters/7/hypnosis/wake',
    ])
    // 关键：睡眠唤醒**不带 mode**（带 mode 就成了"解除催眠"，与睡眠是两件事）
    assert.deepEqual(JSON.parse(calls[0].body), {})
    assert.deepEqual(JSON.parse(calls[1].body), {})
    // 返回形状直接可喂给归一化
    assert.equal(normalizeSleep(slept).isSleeping, true)
    assert.equal(normalizeSleep(woke).isSleeping, true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('睡眠相关错误翻译：已经在睡 / 不在睡 / 不能睡，都翻成人话', () => {
  assert.equal(translateHypnosisError(409, 'already sleeping'), '她已经在睡了')
  assert.equal(translateHypnosisError(409, 'not sleeping'), '她现在是醒着的')
  assert.equal(translateHypnosisError(409, 'cannot sleep now'), '她现在不能睡（可能在日程中）')
  // 既有翻译不受影响
  assert.equal(translateHypnosisError(403, 'hypnosis gate not met'), '还不满足使用催眠手机的条件')
  assert.equal(translateHypnosisError(409, 'not hypnotized'), '她当前不在催眠状态')
})
