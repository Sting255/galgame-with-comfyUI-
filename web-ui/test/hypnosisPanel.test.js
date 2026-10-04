import { test } from 'node:test'
import assert from 'node:assert/strict'

import { translateHypnosisError } from '../src/api/hypnosis.js'
// 面板纯逻辑在 components/hypnosisLogic.js（api 层只管请求与错误翻译）
import {
  ACTION_DEFS,
  DEFAULT_MINUTES,
  GATE_CODES,
  MAX_MINUTES,
  MIN_MINUTES,
  RESTORE_TOAST_TEXT,
  WAKE_MIND_NOTICE,
  actionMatrix,
  canRestoreForgotten,
  clampMinutes,
  directiveText,
  forgetConfirmMessage,
  forgottenRows,
  forgottenStatusText,
  formatRemaining,
  formatRemainingWords,
  gateText,
  hypnosisViewModel,
  isPhoneMissing,
  parseBackendTime,
  formatWindowTime,
  remainingSeconds,
  resolveGateKind,
  restoreResultText,
} from '../src/components/hypnosisLogic.js'

// ── 时区缺陷回归（后端 SQLite 无时区 UTC 串）──

test('后端无时区 UTC 串必须按 UTC 解析（否则刚催眠就显示「已结束」）', () => {
  const until = '2026-09-28 05:55:59'                       // 后端真实格式（无 Z，UTC）
  const now = Date.UTC(2026, 8, 28, 5, 25, 59)              // 催眠后满 30 分钟的起点
  assert.equal(remainingSeconds(until, now), 1800, '按本地解析会得到 0/负数')
  assert.equal(formatRemaining(until, now), '30:00')
  assert.notEqual(formatRemaining(until, now), '已结束')

  // 三种写法必须解析成同一时刻（TZ 无关，换机器不会假红）
  const a = parseBackendTime('2026-09-28 05:55:59')
  const b = parseBackendTime('2026-09-28T05:55:59Z')
  const c = parseBackendTime('2026-09-28T13:55:59+08:00')
  assert.equal(a, b)
  assert.equal(a, c)

  // 展示格式与 UTC 解析一致（不硬编某个"本地时刻"）
  assert.equal(formatWindowTime('2026-09-28 05:55:59'), formatWindowTime('2026-09-28T05:55:59Z'))

  // 边界：空/非法/纯日期
  assert.ok(Number.isNaN(parseBackendTime(null)))
  assert.ok(Number.isNaN(parseBackendTime('')))
  assert.ok(Number.isNaN(parseBackendTime('abc')))
  assert.equal(remainingSeconds(null), 0)
  assert.equal(formatRemaining(null), '已结束')
  assert.equal(parseBackendTime('2026-09-28'), Date.UTC(2026, 8, 28))

  // 排序键也必须走 UTC 解析（用真实格式串，相差 1 小时）
  const rows = forgottenRows([
    { id: 1, fromAt: '2026-09-28 05:00:00', toAt: '2026-09-28 06:00:00', createdAt: '2026-09-28 05:00:00' },
    { id: 2, fromAt: '2026-09-28 07:00:00', toAt: '2026-09-28 08:00:00', createdAt: '2026-09-28 07:00:00' },
  ])
  assert.deepEqual(rows.map(r => r.id), [2, 1], 'createdAt 倒序（最新在前）')
})

// ── 时长 clamp ──

test('时长 clamp：1~720，空值/非数字回默认 30', () => {
  assert.equal(MIN_MINUTES, 1)
  assert.equal(MAX_MINUTES, 720)
  assert.equal(DEFAULT_MINUTES, 30)
  assert.equal(clampMinutes(30), 30)
  assert.equal(clampMinutes(1), 1)
  assert.equal(clampMinutes(720), 720)
  assert.equal(clampMinutes(9999), 720)
  assert.equal(clampMinutes(0), 1)
  assert.equal(clampMinutes(-5), 1)
  assert.equal(clampMinutes('45'), 45)
  assert.equal(clampMinutes('30.6'), 31)
  assert.equal(clampMinutes(''), 30)
  assert.equal(clampMinutes('   '), 30)
  assert.equal(clampMinutes('abc'), 30)
  assert.equal(clampMinutes(null), 30)
  assert.equal(clampMinutes(undefined), 30)
  assert.equal(clampMinutes(NaN), 30)
})

// ── 剩余时间 ──

test('剩余时间：mm:ss，过期与非法值都给「已结束」', () => {
  const now = new Date('2026-09-28T12:00:00Z').getTime()
  assert.equal(remainingSeconds(new Date(now + 90_000).toISOString(), now), 90)
  assert.equal(formatRemaining(new Date(now + 90_000).toISOString(), now), '1:30')
  assert.equal(formatRemaining(new Date(now + 600_000).toISOString(), now), '10:00')
  assert.equal(formatRemaining(new Date(now + 5_000).toISOString(), now), '0:05')
  // 12 小时上限：分钟数不截断，照样按 mm:ss 显示
  assert.equal(formatRemaining(new Date(now + 720 * 60_000).toISOString(), now), '720:00')
  assert.equal(formatRemaining(new Date(now - 1_000).toISOString(), now), '已结束')
  assert.equal(formatRemaining(new Date(now).toISOString(), now), '已结束')
  assert.equal(formatRemaining(null, now), '已结束')
  assert.equal(formatRemaining('not-a-date', now), '已结束')
  assert.equal(formatRemainingWords(new Date(now + 90_000).toISOString(), now), '1 分 30 秒')
  assert.equal(formatRemainingWords(new Date(now + 60_000).toISOString(), now), '1 分')
  assert.equal(formatRemainingWords(new Date(now + 20_000).toISOString(), now), '20 秒')
  assert.equal(formatRemainingWords(new Date(now - 20_000).toISOString(), now), '已结束')
})

// ── 状态视图（意志 / 身体 正交） ──

test('视图：未催眠时意志必然清醒、身体必然自由，不用残留标记', () => {
  const now = Date.now()
  const view = hypnosisViewModel({ active: false, mindAwake: false, bodyControlled: true, gate: { allowed: true } }, now)
  assert.equal(view.active, false)
  assert.equal(view.hypnotized, false)
  assert.equal(view.mindAwake, true)
  assert.equal(view.bodyControlled, false)
  assert.equal(view.statusText, '未催眠')
  assert.equal(view.mindText, '清醒')
  assert.equal(view.bodyText, '自由')
})

test('视图：只唤醒意志后显示「意志：清醒 / 身体：受控」', () => {
  const now = Date.now()
  const view = hypnosisViewModel({
    active: true, activeUntil: new Date(now + 300_000).toISOString(),
    mindAwake: true, bodyControlled: true, gate: { allowed: true },
  }, now)
  assert.equal(view.hypnotized, true)
  assert.equal(view.mindText, '清醒')
  assert.equal(view.bodyText, '受控')
  assert.equal(view.statusText, '催眠中 · 剩余 5:00')
})

test('视图：后端 active 但时间已走完 → 显示已结束，active 仍保留（否则清不掉状态）', () => {
  const now = Date.now()
  const view = hypnosisViewModel({
    active: true, activeUntil: new Date(now - 1_000).toISOString(), gate: { allowed: true },
  }, now)
  assert.equal(view.active, true)
  assert.equal(view.expired, true)
  assert.equal(view.hypnotized, false)
  assert.equal(view.statusText, '已结束')
})

// ── 按钮启用矩阵（gate 允许时） ──

function matrixFor(state, now = Date.now()) {
  return actionMatrix(hypnosisViewModel(state, now))
}

test('按钮矩阵：五按钮四态的启用与置灰（强制高潮自 task-42 起不要求催眠）', () => {
  const now = Date.now()
  const gate = { allowed: true }
  const future = new Date(now + 600_000).toISOString()
  const past = new Date(now - 60_000).toISOString()

  // 未催眠（task-42）：能点「催眠」，也能点「强制高潮」——用户口径「强制高潮不需要催眠 随时都能触发」
  // forceToy 自 2026-10-01 起进矩阵：**在催眠中即可**（含刚结束的 active），未催眠时置灰
  assert.deepEqual(matrixFor({ active: false, gate }, now), {
    hypnotize: true, wake: false, wakeMind: false, forcedClimax: true, forget: false, forceToy: false,
  })

  // 深度催眠：除「催眠」外都可点
  assert.deepEqual(matrixFor({ active: true, activeUntil: future, mindAwake: false, bodyControlled: true, gate }, now), {
    hypnotize: false, wake: true, wakeMind: true, forcedClimax: true, forget: true, forceToy: true,
  })

  // 只唤醒意志：意志已清醒 → 「只唤醒意志」置灰，强制高潮仍可用
  assert.deepEqual(matrixFor({ active: true, activeUntil: future, mindAwake: true, bodyControlled: true, gate }, now), {
    hypnotize: false, wake: true, wakeMind: false, forcedClimax: true, forget: true, forceToy: true,
  })

  // 已过期：可重新催眠 / 可唤醒 / 可遗忘；强制高潮与催眠态无关，照样可点
  assert.deepEqual(matrixFor({ active: true, activeUntil: past, mindAwake: false, bodyControlled: true, gate }, now), {
    hypnotize: true, wake: true, wakeMind: false, forcedClimax: true, forget: true, forceToy: true,
  })
})

test('按钮矩阵：门控未满足时五个按钮全灰（含催眠）', () => {
  const now = Date.now()
  const gate = { allowed: false, reason: 'no hypnosis phone' }
  const blocked = { hypnotize: false, wake: false, wakeMind: false, forcedClimax: false, forget: false, forceToy: false }
  assert.deepEqual(matrixFor({ active: false, gate }, now), blocked)
  assert.deepEqual(matrixFor({
    active: true, activeUntil: new Date(now + 600_000).toISOString(), mindAwake: false, bodyControlled: true, gate,
  }, now), blocked)
})

test('按钮矩阵：强制高潮只受"有手机"门控约束，与催眠态无关（task-42）', () => {
  const now = Date.now()
  const future = new Date(now + 600_000).toISOString()
  const gate = { allowed: true }
  const states = [
    { active: false, gate },
    { active: true, activeUntil: future, mindAwake: false, bodyControlled: true, gate },
    { active: true, activeUntil: future, mindAwake: true, bodyControlled: true, gate },
    { active: true, activeUntil: new Date(now - 1_000).toISOString(), bodyControlled: true, gate },
  ]
  for (const state of states) {
    assert.equal(matrixFor(state, now).forcedClimax, true, JSON.stringify(state))
  }
  // 门控未通过（背包里没有手机）→ 仍然置灰
  assert.equal(matrixFor({ active: false, gate: { allowed: false, code: 'no_phone' } }, now).forcedClimax, false)
})

test('按钮矩阵：五个动作的文案与变体固定（遗忘是 danger；「身体控制」已按用户裁决移除）', () => {
  assert.deepEqual(ACTION_DEFS.map(a => a.key), ['hypnotize', 'wake', 'wakeMind', 'forcedClimax', 'forget'])
  assert.deepEqual(ACTION_DEFS.map(a => a.label), ['催眠', '唤醒', '只唤醒意志', '强制高潮', '遗忘被控制这段时间'])
  assert.equal(ACTION_DEFS[0].variant, 'primary')
  assert.equal(ACTION_DEFS[4].variant, 'danger')
  assert.ok(!ACTION_DEFS.some(a => a.key === 'bodyControl'), '面板不再提供「身体控制」（与催眠状态重复）')
  assert.match(WAKE_MIND_NOTICE, /身体仍旧不听使唤/)
  assert.match(forgetConfirmMessage('林晚'), /林晚/)
  assert.match(forgetConfirmMessage('林晚'), /让她恢复这段记忆/)
})

// ── 门控文案 ──

test('gate.reason → 顶部提示文案，并识别「没有手机」', () => {
  assert.equal(gateText({ allowed: true }), '')
  assert.equal(gateText({ allowed: false, reason: 'no hypnosis phone' }), '还没有催眠手机，先领一部再来。')
  assert.equal(gateText({ allowed: false, reason: '没有手机' }), '还没有催眠手机，先领一部再来。')
  assert.equal(gateText({ allowed: false, reason: 'affinity too low', affinity: 42 }), '和 TA 还不够亲近（当前 42），好感度再高一些就能用了。')
  assert.equal(gateText({ allowed: false, reason: 'oath required' }), '需要先和 TA 立下誓约，才能使用催眠手机。')
  // 未知原因原样透出，不吞（便于联调时发现后端新原因）
  assert.equal(gateText({ allowed: false, reason: 'weird backend reason' }), 'weird backend reason')
  assert.equal(gateText(null), '还不能使用催眠手机。')

  assert.equal(isPhoneMissing({ allowed: false, reason: 'no hypnosis phone' }), true)
  assert.equal(isPhoneMissing({ allowed: false, reason: 'affinity too low' }), false)
  assert.equal(isPhoneMissing({ allowed: true, reason: 'no hypnosis phone' }), false)
})

test('门控机器码优先：gate.code 命中时不再看文案措辞', () => {
  assert.deepEqual([...GATE_CODES], ['ok', 'no_phone', 'affinity_low', 'not_oath'])

  // code='no_phone' → 出现领取按钮（文案故意写成不含"手机"的错字，仍必须识别）
  const noPhone = { allowed: false, code: 'no_phone', reason: '背包里没有那台机器' }
  assert.equal(resolveGateKind(noPhone), 'no_phone')
  assert.equal(isPhoneMissing(noPhone), true)
  assert.equal(gateText(noPhone), '还没有催眠手机，先领一部再来。')

  // code='affinity_low' → 不出现领取按钮（reason 里带"手机"字样也必须以机器码为准）
  const lowAffinity = { allowed: false, code: 'affinity_low', reason: '手机还没解锁', affinity: 40 }
  assert.equal(resolveGateKind(lowAffinity), 'affinity_low')
  assert.equal(isPhoneMissing(lowAffinity), false)
  assert.equal(gateText(lowAffinity), '和 TA 还不够亲近（当前 40），好感度再高一些就能用了。')

  // code='not_oath'
  const notOath = { allowed: false, code: 'not_oath', reason: '尚未缔结誓约' }
  assert.equal(resolveGateKind(notOath), 'not_oath')
  assert.equal(isPhoneMissing(notOath), false)
  assert.equal(gateText(notOath), '需要先和 TA 立下誓约，才能使用催眠手机。')

  // code='ok' 且门控通过 → 无提示
  assert.equal(resolveGateKind({ allowed: true, code: 'ok' }), 'ok')
  assert.equal(gateText({ allowed: true, code: 'ok' }), '')
  assert.equal(isPhoneMissing({ allowed: true, code: 'ok' }), false)
})

test('门控兼容路径：没有 code（旧后端）时退回中文文案关键词', () => {
  // 后端 task-28 的真实散文 reason
  const legacy = { allowed: false, reason: '背包里没有催眠手机' }
  assert.equal(resolveGateKind(legacy), 'no_phone')
  assert.equal(isPhoneMissing(legacy), true, 'code 缺失时仍要能识别出「没有手机」')
  assert.equal(gateText(legacy), '还没有催眠手机，先领一部再来。')

  assert.equal(resolveGateKind({ allowed: false, reason: '好感度不足（当前 40 / 需要 85）', affinity: 40 }), 'affinity_low')
  assert.equal(isPhoneMissing({ allowed: false, reason: '好感度不足（当前 40 / 需要 85）' }), false)
  assert.equal(gateText({ allowed: false, reason: '好感度不足（当前 40 / 需要 85）', affinity: 40 }),
    '和 TA 还不够亲近（当前 40），好感度再高一些就能用了。')
  assert.equal(resolveGateKind({ allowed: false, reason: '尚未缔结誓约' }), 'not_oath')
  // 未知 code + 未知文案 → unknown，原样透出 reason（联调时能一眼看到后端新原因）
  assert.equal(resolveGateKind({ allowed: false, code: 'brand_new_code', reason: '别的原因' }), 'unknown')
  assert.equal(gateText({ allowed: false, code: 'brand_new_code', reason: '别的原因' }), '别的原因')
})

test('门控 code 白名单化：非法/大小写/空值都不会被当成有效机器码', () => {
  assert.equal(resolveGateKind({ allowed: false, code: 'NO_PHONE', reason: '' }), 'no_phone', '大写也要能白名单化')
  assert.equal(resolveGateKind({ allowed: false, code: 'bogus', reason: '背包里没有催眠手机' }), 'no_phone', '未知 code → 退回关键词')
  assert.equal(resolveGateKind({ allowed: false, code: '', reason: '尚未缔结誓约' }), 'not_oath')
  assert.equal(resolveGateKind(null), 'unknown')
})

// ── 遗忘记录 ──

test('遗忘记录：倒序排列 + 状态文案 + 可恢复性', () => {
  const rows = forgottenRows([
    { id: 1, fromRawId: 10, toRawId: 20, fromAt: '2026-09-27T10:00:00Z', toAt: '2026-09-27T10:30:00Z', memoriesArchived: 3, status: 'active', createdAt: '2026-09-27T10:31:00Z' },
    { id: 3, fromRawId: 40, toRawId: 50, fromAt: '2026-09-28T09:00:00Z', toAt: '2026-09-28T09:10:00Z', memoriesArchived: 0, status: 'active', createdAt: '2026-09-28T09:11:00Z' },
    { id: 2, fromRawId: 30, toRawId: 30, fromAt: '2026-09-28T08:00:00Z', toAt: '2026-09-28T08:01:00Z', memoriesArchived: 1, status: 'restored', createdAt: '2026-09-28T08:02:00Z' },
  ])
  assert.deepEqual(rows.map(r => r.id), [3, 2, 1], '按 createdAt 倒序')
  assert.equal(rows[0].archivedText, '没有可归档的记忆')
  assert.equal(rows[2].archivedText, '归档 3 条记忆')
  assert.equal(rows[1].statusText, '已恢复')
  assert.equal(rows[1].canRestore, false, '已恢复的行不再给恢复按钮')
  assert.equal(rows[0].canRestore, true)
  assert.equal(rows[0].rangeText, '#40 ~ #50')
  assert.match(rows[0].timeText, /^\d{2}-\d{2} \d{2}:\d{2} → \d{2}-\d{2} \d{2}:\d{2}$/)
})

test('遗忘记录：createdAt 缺失时按 id 倒序，非法时间给占位', () => {
  const rows = forgottenRows([
    { id: 5, fromAt: 'bad-date', toAt: null, status: 'active' },
    { id: 9, fromAt: '2026-09-28T00:00:00Z', toAt: '2026-09-28T00:10:00Z', status: 'active' },
    { id: 7, status: 'active' },
  ])
  assert.deepEqual(rows.map(r => r.id), [9, 7, 5])
  assert.equal(rows[2].timeText, '— → —')
  assert.deepEqual(forgottenRows(null), [])
  assert.deepEqual(forgottenRows('nope'), [])
})

test('遗忘状态词：未知状态原样透出；已恢复的三种写法都不给按钮', () => {
  assert.equal(forgottenStatusText('restored'), '已恢复')
  assert.equal(forgottenStatusText('active'), '已遗忘')
  assert.equal(forgottenStatusText(''), '已遗忘')
  assert.equal(forgottenStatusText('paused'), 'paused')
  assert.equal(canRestoreForgotten({ status: 'restored' }), false)
  assert.equal(canRestoreForgotten({ status: 'active', restored: true }), false)
  assert.equal(canRestoreForgotten({ status: 'active', restoredAt: '2026-09-28T00:00:00Z' }), false)
  assert.equal(canRestoreForgotten({ status: 'active' }), true)
  assert.equal(canRestoreForgotten({}), true)
})

// ── 恢复（她恢复这段记忆） ──

test('恢复成功文案：restored>0 与 restored===0 必须区分', () => {
  assert.equal(
    restoreResultText({ restored: 3, pendingDirective: 'memory_restore' }),
    '已还原 3 条记忆，她会在下一次对话中想起',
  )
  assert.equal(
    restoreResultText({ restored: 0, pendingDirective: 'memory_restore' }),
    '这段时间没有抽取到长期记忆，但上下文屏蔽已解除',
  )
  assert.equal(restoreResultText({}), '这段时间没有抽取到长期记忆，但上下文屏蔽已解除')
  assert.equal(RESTORE_TOAST_TEXT, '她想起了这段时间的记忆')
})

test('指令 token → 中文，未知指令原样透出', () => {
  assert.equal(directiveText('memory_restore'), '恢复记忆')
  assert.equal(directiveText('body_control'), '身体控制')
  assert.equal(directiveText('wake_reaction'), '唤醒反应')
  assert.equal(directiveText('forced_climax'), '强制高潮')
  assert.equal(directiveText(''), '')
  assert.equal(directiveText(null), '')
  assert.equal(directiveText('brand_new_command'), 'brand_new_command')
})

// ── 错误翻译 ──

test('错误串翻译：门控 / 未催眠 / 功能关闭 / 参数 / 未知', () => {
  assert.equal(translateHypnosisError(403, 'hypnosis gate not met'), '还不满足使用催眠手机的条件')
  assert.equal(translateHypnosisError(409, 'not hypnotized'), '她当前不在催眠状态')
  assert.equal(translateHypnosisError(403, 'hypnosis feature disabled'), '催眠手机功能当前已关闭')
  assert.equal(translateHypnosisError(404, 'character not found'), '角色不存在或已被删除')
  assert.equal(translateHypnosisError(400, 'invalid minutes'), '参数不合法')
  // 未知错误原样透出；无 message 时按状态码兜底
  assert.equal(translateHypnosisError(500, 'database is locked'), 'database is locked')
  assert.equal(translateHypnosisError(403, ''), '还不满足使用催眠手机的条件')
  assert.equal(translateHypnosisError(409, ''), '她当前不在催眠状态')
  assert.equal(translateHypnosisError(500, ''), '请求失败 (500)')
})

// ── 遗忘记录列表：URL 形状（restored 行必须能看到）──

test('listForgottenWindows 默认不过滤 status：不带 ?status=，恢复后的记录不能从面板消失', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ windows: [] }) }
  }
  try {
    const { listForgottenWindows } = await import('../src/api/hypnosis.js')
    await listForgottenWindows(7)
    await listForgottenWindows(7, { status: 'active' })
    // 默认：显式 ?status=（空串 = 后端不过滤；不带 query 时后端默认只回 active，恢复后的记录会消失）
    assert.ok(calls[0].endsWith('?status='), `默认请求应带空 status（不过滤），实际 ${calls[0]}`)
    // 显式传 active：带 ?status=active
    assert.ok(calls[1].endsWith('?status=active'), `显式 status 应拼进 URL，实际 ${calls[1]}`)
  } finally {
    globalThis.fetch = realFetch
  }
})
