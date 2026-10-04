/**
 * 「程序时间」面板纯逻辑单测（现实模拟时钟）
 *
 * 用户口径：「可以控制程序里的时间 控制是白天黑夜 是第一天还是第二天…我要完全控制时间…给我一个按钮
 * 我可以让所有角色 过了一天了 或者是很多天…现实模拟游戏」。
 *
 * 本文件只测不依赖 Vue 的纯函数与请求形状：
 *   1. 展示格式化（日期 → 2026年9月28日、时刻 → HH:MM、时段 → 白天/黑夜、第几天/累计天数）；
 *   2. 输入清洗（快进天数 1~3650、非法值回落 1）；
 *   3. 状态归一化（period 缺失时按时刻推断、ISO 日期、脏数据不炸且不编造）；
 *   4. 设定弹窗的 datetime 拼装 / 拆分，以及四个接口的 URL 与 body 形状。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { translateTimeError } from '../src/api/timeControl.js'
import {
  DAY_ADVANCE_DEFAULT,
  DAY_ADVANCE_MAX,
  DAY_ADVANCE_MIN,
  PERIODS,
  TIME_RECALC_NOTICE,
  TIME_SCOPE_NOTES,
  clampAdvanceDays,
  composeDatetime,
  dayProgressText,
  formatProgramClock,
  formatProgramDate,
  inferPeriodFromClock,
  normalizePeriod,
  normalizeProgramClock,
  normalizeProgramDate,
  offsetText,
  periodText,
  programTimeViewModel,
  realTimeText,
  recalculationText,
  resetConfirmMessage,
  splitDatetime,
  timeActionResultText,
  weekdayOfDateKey,
  weekdayText,
} from '../src/components/timeControlLogic.js'

// ── 1. 展示格式化 ──

test('日期格式化：ISO / 斜杠 / 补零都收敛成「2026年9月28日」', () => {
  assert.equal(formatProgramDate('2026-09-28'), '2026年9月28日')
  assert.equal(formatProgramDate('2026-09-28T13:00:00Z'), '2026年9月28日', 'ISO 串也要认')
  assert.equal(formatProgramDate('2026/9/8'), '2026年9月8日', '斜杠与不补零都收敛')
  assert.equal(formatProgramDate('2026/09/08'), '2026年9月8日')
  assert.equal(normalizeProgramDate('2026-9-8'), '2026-09-08')
  // 非法值不编造日期
  assert.equal(formatProgramDate(''), '未知日期')
  assert.equal(formatProgramDate('abc'), '未知日期')
  assert.equal(formatProgramDate(null), '未知日期')
  assert.equal(normalizeProgramDate('2026-13-01'), '', '非法月份')
  assert.equal(normalizeProgramDate('2026-00-10'), '', '非法月份')
})

test('时刻格式化：HH:MM / HH:MM:SS / H:M 都收敛成 HH:MM', () => {
  assert.equal(formatProgramClock('14:05'), '14:05')
  assert.equal(formatProgramClock('14:05:00'), '14:05', '带秒也要认')
  assert.equal(formatProgramClock('9:5'), '09:05', '不补零也收敛')
  assert.equal(formatProgramClock('00:00'), '00:00')
  assert.equal(formatProgramClock('23:59'), '23:59')
  // 非法值给占位
  assert.equal(formatProgramClock(''), '--:--')
  assert.equal(formatProgramClock('24:00'), '--:--')
  assert.equal(formatProgramClock('12:60'), '--:--')
  assert.equal(formatProgramClock(null), '--:--')
  assert.equal(normalizeProgramClock('bad'), '')
})

test('时段文案：白天 / 黑夜（含大小写与中文输入），未知给空串', () => {
  assert.deepEqual([...PERIODS], ['day', 'night'])
  assert.equal(periodText('day'), '白天')
  assert.equal(periodText('DAY'), '白天')
  assert.equal(periodText('白天'), '白天')
  assert.equal(periodText('night'), '黑夜')
  assert.equal(periodText('黑夜'), '黑夜')
  assert.equal(periodText(''), '')
  assert.equal(periodText('dusk'), '')
  assert.equal(normalizePeriod('DUSK'), '')
})

test('时段缺失时按时刻推断：06:00~17:59 白天，其余黑夜', () => {
  assert.equal(inferPeriodFromClock('06:00'), 'day')
  assert.equal(inferPeriodFromClock('12:00'), 'day')
  assert.equal(inferPeriodFromClock('17:59'), 'day')
  assert.equal(inferPeriodFromClock('18:00'), 'night')
  assert.equal(inferPeriodFromClock('23:30'), 'night')
  assert.equal(inferPeriodFromClock('05:59'), 'night')
  assert.equal(inferPeriodFromClock(''), '')
  // 后端给了 period 就以后端为准（推断只在缺失时兜底）
  assert.equal(programTimeViewModel({ date: '2026-09-28', time: '23:30', period: 'day' }).period, 'day')
  assert.equal(programTimeViewModel({ date: '2026-09-28', time: '23:30' }).period, 'night')
})

test('第几天 / 累计天数：有就给中文读数，缺字段给占位而不是编造', () => {
  assert.equal(dayProgressText(3, 12), '第 3 天 · 累计 12 天')
  assert.equal(dayProgressText(3), '第 3 天')
  assert.equal(dayProgressText('5', '5'), '第 5 天 · 累计 5 天')
  assert.equal(dayProgressText(null, null), '第 — 天')
  assert.equal(dayProgressText(0, 0), '第 — 天', '0 不是合法天数')
  assert.equal(dayProgressText('abc', 'abc'), '第 — 天')
})

// ── 2. 快进天数清洗 ──

test('快进天数清洗：1~3650，空 / 非数字回落 1 天', () => {
  assert.equal(DAY_ADVANCE_MIN, 1)
  assert.equal(DAY_ADVANCE_MAX, 3650)
  assert.equal(DAY_ADVANCE_DEFAULT, 1)
  assert.equal(clampAdvanceDays(1), 1)
  assert.equal(clampAdvanceDays(3), 3)
  assert.equal(clampAdvanceDays(3650), 3650)
  assert.equal(clampAdvanceDays(99999), 3650)
  assert.equal(clampAdvanceDays(0), 1)
  assert.equal(clampAdvanceDays(-5), 1)
  assert.equal(clampAdvanceDays('30'), 30)
  assert.equal(clampAdvanceDays('30.6'), 31)
  // 输入框被清空时不要变成"快进 0 天"
  assert.equal(clampAdvanceDays(''), 1)
  assert.equal(clampAdvanceDays('   '), 1)
  assert.equal(clampAdvanceDays('abc'), 1)
  assert.equal(clampAdvanceDays(null), 1)
  assert.equal(clampAdvanceDays(undefined), 1)
  assert.equal(clampAdvanceDays(NaN), 1)
})

// ── 3. 视图归一化 ──

test('视图：后端完整形状 → 面板直接可渲染', () => {
  const view = programTimeViewModel({
    date: '2026-09-28',
    time: '14:05',
    weekday: '周一',
    phase: 'day',
    dayIndex: 3,
    totalDays: 12,
    epochDate: '2026-09-26',
    offsetMs: 2 * 86400000,
    real: { date: '2026-09-26', time: '14:05' },
  })
  assert.equal(view.ok, true)
  assert.equal(view.dateText, '2026年9月28日')
  assert.equal(view.clockText, '14:05')
  assert.equal(view.periodText, '白天')
  assert.equal(view.weekday, '周一')
  assert.equal(view.dayText, '第 3 天 · 累计 12 天')
  assert.equal(view.dayIndex, 3)
  assert.equal(view.totalDays, 12)
  assert.equal(view.epochDate, '2026-09-26')
  assert.equal(view.offsetText, '比现实时间快 2 天')
  assert.equal(view.realText, '2026-09-26 14:05')
})

test('时段字段：后端叫 phase（交付口径写 period），两个都收且 phase 优先', () => {
  assert.equal(programTimeViewModel({ date: '2026-09-28', time: '23:30', phase: 'day' }).period, 'day')
  assert.equal(programTimeViewModel({ date: '2026-09-28', time: '12:00', period: 'night' }).period, 'night', '旧口径 period 也认')
  assert.equal(
    programTimeViewModel({ date: '2026-09-28', time: '23:30', phase: 'day', period: 'night' }).period,
    'day',
    '两个都有时以 phase 为准（后端权威字段）',
  )
})

test('星期：后端给了就校验白名单，没给就按日期推算', () => {
  assert.equal(weekdayText('周一'), '周一')
  assert.equal(weekdayText('星期一'), '', '非白名单不猜')
  assert.equal(weekdayText(''), '')
  assert.equal(weekdayOfDateKey('2026-09-28'), '周一', '2026-09-28 是周一')
  assert.equal(weekdayOfDateKey('2026-09-26'), '周六')
  assert.equal(weekdayOfDateKey('bad'), '')
  assert.equal(programTimeViewModel({ date: '2026-09-28' }).weekday, '周一', '后端没给 weekday 时按日期补')
  assert.equal(programTimeViewModel({ date: '2026-09-28', weekday: '周七' }).weekday, '周一', '脏值退回推算')
})

test('与现实时间的差距：0 明说一致，整天说天，零头说小时', () => {
  assert.equal(offsetText({ offsetMs: 0 }), '与现实时间一致')
  assert.equal(offsetText({ offsetMs: 86400000 }), '比现实时间快 1 天')
  assert.equal(offsetText({ offsetMs: -3 * 86400000 }), '比现实时间慢 3 天')
  assert.equal(offsetText({ offsetMs: 3600000 * 2.5 }), '比现实时间快 2.5 小时')
  assert.equal(offsetText({ offsetMs: -30 * 60000 }), '比现实时间慢 30 分钟')
  // 退化到后端也可能只给 offsetDays / offsetHours
  assert.equal(offsetText({ offsetDays: 2 }), '比现实时间快 2 天')
  assert.equal(offsetText({ offsetHours: -3 }), '比现实时间慢 3 小时')
  // 什么都没有 → 不编造
  assert.equal(offsetText({}), '')
  assert.equal(offsetText(null), '')
})

test('现实世界时间：只认后端给的 real（拿不到就给空串）', () => {
  assert.equal(realTimeText({ real: { date: '2026-09-26', time: '14:05' } }), '2026-09-26 14:05')
  assert.equal(realTimeText({ real: { date: '2026-09-26' } }), '2026-09-26 --:--')
  assert.equal(realTimeText({}), '')
  assert.equal(realTimeText(null), '')
})

test('视图：空 / 脏数据不炸，也不假装"时间是有效的"', () => {
  for (const bad of [null, undefined, {}, 'nope', 0]) {
    const view = programTimeViewModel(bad)
    assert.equal(view.ok, false, `${JSON.stringify(bad)} 应判为无有效程序时间`)
    assert.equal(view.dateText, '未知日期')
    assert.equal(view.clockText, '--:--')
    assert.equal(view.periodText, '', '时段未知时给空串，由面板显示「时段未知」')
    assert.equal(view.dayText, '第 — 天')
  }
  // 只有 date 或只有 time 也算"有效"（部分字段缺失不该整块报废）
  assert.equal(programTimeViewModel({ date: '2026-09-28' }).ok, true)
  assert.equal(programTimeViewModel({ time: '08:00' }).ok, true)
  // 脏的天数不编造成 0
  assert.equal(programTimeViewModel({ date: '2026-09-28', dayIndex: 'x' }).dayIndex, null)
})

// ── 4. 设定弹窗：datetime 拼装 / 拆分 ──

test('composeDatetime：本地日期 + 时刻 → "YYYY-MM-DD HH:MM:SS"，任一非法给空串', () => {
  assert.equal(composeDatetime('2026-09-28', '14:05'), '2026-09-28 14:05:00')
  assert.equal(composeDatetime('2026/9/8', '9:5'), '2026-09-08 09:05:00')
  assert.equal(composeDatetime('2026-09-28', ''), '')
  assert.equal(composeDatetime('', '14:05'), '')
  assert.equal(composeDatetime('abc', '14:05'), '')
  assert.equal(composeDatetime(null, null), '')
})

test('splitDatetime：把当前程序时间拆成弹窗初始值（可往返）', () => {
  const { date, time } = splitDatetime({ date: '2026-09-28', time: '14:05:00' })
  assert.deepEqual({ date, time }, { date: '2026-09-28', time: '14:05' })
  assert.equal(composeDatetime(date, time), '2026-09-28 14:05:00', '拆开再拼回去必须一致')
  assert.deepEqual(splitDatetime(null), { date: '', time: '' })
  assert.deepEqual(splitDatetime({ date: 'bad', time: 'bad' }), { date: '', time: '' })
})

// ── 5. 结果文案与口径说明 ──

test('结果文案：各操作都带上"已重算所有角色日程/睡眠"与新时间', () => {
  const now = { date: '2026-09-28', time: '14:05', phase: 'day', dayIndex: 3, totalDays: 12, weekday: '周一' }
  const advance = timeActionResultText('advance', now, { days: 3 })
  assert.match(advance, /已快进 3 天/)
  assert.match(advance, /2026年9月28日 14:05/)
  assert.match(advance, /白天/)
  assert.ok(advance.includes(TIME_RECALC_NOTICE))

  const period = timeActionResultText('period', now, { period: 'night' })
  assert.match(period, /已切到黑夜/)
  assert.ok(period.includes(TIME_RECALC_NOTICE))

  const set = timeActionResultText('set', now)
  assert.match(set, /已设定程序时间/)
  assert.ok(set.includes(TIME_RECALC_NOTICE))

  const reset = timeActionResultText('reset', now)
  assert.match(reset, /已回到真实时间/)
  assert.ok(reset.includes(TIME_RECALC_NOTICE))

  // 天数默认值不炸
  assert.match(timeActionResultText('advance', now), /已快进 1 天/)
})

test('重算明细：后端 applied 里有几个角色就写几个，拿不到就不编造', () => {
  assert.equal(recalculationText(null), TIME_RECALC_NOTICE)
  assert.equal(recalculationText({}), TIME_RECALC_NOTICE)
  assert.equal(recalculationText({ characters: [{ id: 1 }, { id: 2 }], skippedTempWakes: [] }), `${TIME_RECALC_NOTICE}，共 2 个角色`)
  assert.equal(
    recalculationText({ characters: [{ id: 1 }], skippedTempWakes: [3, 5] }),
    `${TIME_RECALC_NOTICE}，共 1 个角色，同时收掉 2 个过期的临时唤醒窗口`,
  )
  // 明细进到操作文案里（后端把 applied 挂在同一个返回对象上）
  const text = timeActionResultText('advance', { date: '2026-09-28', time: '14:05', applied: { characters: [{ id: 1 }] } }, { days: 2 })
  assert.match(text, /共 1 个角色/)
  assert.match(timeActionResultText('advance', { date: '2026-09-28', time: '14:05', applied: { characters: [{ id: 1 }, { id: 2 }, { id: 3 }] } }, { days: 2 }), /共 3 个角色/)
})

test('回到真实时间的确认文案：讲清"第 1 天重锚今天"与重算', () => {
  const text = resetConfirmMessage()
  assert.match(text, /真实时间对齐/)
  assert.match(text, /第 1 天/)
  assert.match(text, /日程与睡眠/)
})

test('口径说明：会跟着变 / 仍按真实时间走 两侧都写清楚（不能糊成一句）', () => {
  assert.ok(TIME_SCOPE_NOTES.changes.length >= 2)
  assert.ok(TIME_SCOPE_NOTES.unchanged.length >= 2)
  const changes = TIME_SCOPE_NOTES.changes.join('\n')
  const unchanged = TIME_SCOPE_NOTES.unchanged.join('\n')
  assert.match(changes, /日程/)
  assert.match(changes, /睡眠/)
  assert.match(changes, /白天 \/ 黑夜/)
  // 不变那侧必须点明"真实时间的定时器"与"写库时间戳仍是真实瞬间"（后端口径）
  assert.match(unchanged, /真实时间的定时器/)
  assert.match(unchanged, /临时唤醒/)
  assert.match(unchanged, /真实瞬间/)
  // 两侧不能互相矛盾：聊天记录 / 备份日期属于"不变"那侧
  assert.ok(!changes.includes('聊天记录'), '聊天记录的时间戳属于"不变"那侧')
  assert.match(unchanged, /聊天记录|备份/)
})

// ── 6. 接口形状（fetch 打桩，不联网） ──

test('五个接口的 URL 与 body 形状（真实路径 /api/schedule/time*，与后端 routes/time.js 对齐）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body })
    return {
      ok: true,
      json: async () => ({ date: '2026-09-28', time: '14:05', phase: 'day', dayIndex: 3, totalDays: 12 }),
    }
  }
  try {
    const api = await import('../src/api/timeControl.js')
    await api.getProgramTime()
    await api.advanceProgramTime(3)
    await api.setProgramTime('2026-09-28 14:05:00')
    await api.setProgramPeriod('night')
    await api.resetProgramTime()

    assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'POST', 'POST', 'POST'])
    assert.deepEqual(calls.map(c => c.url), [
      '/api/schedule/time',
      '/api/schedule/time/advance',
      '/api/schedule/time/set',
      '/api/schedule/time/period',
      '/api/schedule/time/reset',
    ])
    assert.equal(calls[0].body, undefined, 'GET 不带 body')
    assert.deepEqual(JSON.parse(calls[1].body), { days: 3 })
    assert.deepEqual(JSON.parse(calls[2].body), { datetime: '2026-09-28 14:05:00' })
    // 时段键名：后端 `req.body.period ?? req.body.phase`，两个都收（他的注释写明"前端两个都带"）
    assert.deepEqual(JSON.parse(calls[3].body), { period: 'night', phase: 'night' })
    assert.deepEqual(JSON.parse(calls[4].body), {})
  } finally {
    globalThis.fetch = realFetch
  }
})

test('错误翻译：非法参数 / 功能关闭 / 后端还没接口 / 未知原样透出', () => {
  assert.equal(translateTimeError(400, 'invalid days'), '时间参数不合法')
  assert.equal(translateTimeError(400, 'invalid datetime'), '时间参数不合法')
  assert.equal(translateTimeError(400, 'invalid period'), '时间参数不合法')
  assert.equal(translateTimeError(409, 'time control disabled'), '程序时间功能当前已关闭')
  assert.equal(translateTimeError(404, ''), '后端还没有时间接口（等更新）')
  assert.equal(translateTimeError(500, 'database is locked'), 'database is locked')
  assert.equal(translateTimeError(500, ''), '请求失败 (500)')
})
