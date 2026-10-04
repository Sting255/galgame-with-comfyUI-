import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BREAKDOWN_CALIBRATED_NOTE,
  BREAKDOWN_TAGS,
  CONTEXT_LEVEL_THRESHOLDS,
  USAGE_SOURCE_LABELS,
  UsageRefreshGovernor,
  WINDOW_SOURCE_LABELS,
  clampPercent,
  contextLevel,
  formatPercent,
  formatTokenCount,
  formatUpdatedAt,
  isAssistantMessage,
  isCompressConflict,
  normalizeUsage,
  progressBarWidth,
  resolveConversationId,
  ringRatio,
  windowSourceText,
} from '../src/utils/contextUsage.js'

// ═══════════════════════════════════════════════════════
// 数字格式化：1.0K / 4.4K / 168K / 1.0M
// ═══════════════════════════════════════════════════════

test('formatTokenCount 千位以下原样显示，不做小数', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(1), '1')
  assert.equal(formatTokenCount(999), '999')
  assert.equal(formatTokenCount(12.4), '12')
})

test('formatTokenCount 千位进制带一位小数，整十进位省掉 .0', () => {
  assert.equal(formatTokenCount(1000), '1.0K')
  assert.equal(formatTokenCount(1500), '1.5K')
  assert.equal(formatTokenCount(1800), '1.8K')
  assert.equal(formatTokenCount(4408), '4.4K')
  assert.equal(formatTokenCount(10000), '10K')
  assert.equal(formatTokenCount(168000), '168K')
  assert.equal(formatTokenCount(168400), '168.4K')
})

test('formatTokenCount 百万位进制与跨档进位', () => {
  assert.equal(formatTokenCount(1000000), '1.0M')
  assert.equal(formatTokenCount(1044000), '1.0M')
  assert.equal(formatTokenCount(2500000), '2.5M')
  assert.equal(formatTokenCount(999999999), '1000M')
  assert.equal(formatTokenCount(1000000000), '1.0G')
})

test('formatTokenCount 异常输入统一回退为 —（不抛错、不显示 NaN）', () => {
  for (const bad of [null, undefined, '', NaN, Infinity, -Infinity, 'abc', '   ', {}, [], true, false]) {
    assert.equal(formatTokenCount(bad), '—', `${JSON.stringify(bad)} 应回退为 —`)
  }
  // 数字字符串按数字处理
  assert.equal(formatTokenCount('4408'), '4.4K')
  // 负数保留符号
  assert.equal(formatTokenCount(-1500), '-1.5K')
})

// ═══════════════════════════════════════════════════════
// 百分比与进度条颜色阈值
// ═══════════════════════════════════════════════════════

test('contextLevel 三档阈值：低=主色、中=警示、高=危险', () => {
  const { warn, danger } = CONTEXT_LEVEL_THRESHOLDS
  assert.equal(contextLevel(0), 'normal')
  assert.equal(contextLevel(33), 'normal')
  assert.equal(contextLevel(warn - 0.01), 'normal')
  assert.equal(contextLevel(warn), 'warn')
  assert.equal(contextLevel((warn + danger) / 2), 'warn')
  assert.equal(contextLevel(danger - 0.01), 'warn')
  assert.equal(contextLevel(danger), 'danger')
  assert.equal(contextLevel(100), 'danger')
})

test('contextLevel 与 clampPercent 对缺失数据不抛错', () => {
  assert.equal(contextLevel(null), 'normal')
  assert.equal(contextLevel(undefined), 'normal')
  assert.equal(contextLevel('abc'), 'normal')
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(140), 100)
  assert.equal(clampPercent(33.333), 33.333)
  assert.equal(clampPercent(null), null)
  assert.equal(clampPercent(NaN), null)
})

test('progressBarWidth 夹在 0~100 且 0 不显示残留、极小值有可见宽度', () => {
  assert.equal(progressBarWidth(0), 0)
  assert.equal(progressBarWidth(-10), 0)
  assert.equal(progressBarWidth(0.4), 2)
  assert.equal(progressBarWidth(33.333), 33.3)
  assert.equal(progressBarWidth(100), 100)
  assert.equal(progressBarWidth(180), 100)
  assert.equal(progressBarWidth(null), 0)
})

test('ringRatio 与 formatPercent 口径', () => {
  assert.equal(ringRatio(0), 0)
  assert.equal(ringRatio(33), 0.33)
  assert.equal(ringRatio(140), 1)
  assert.equal(ringRatio(null), 0)
  assert.equal(formatPercent(33.4), '33%')
  assert.equal(formatPercent(0.4), '0%')
  assert.equal(formatPercent(100), '100%')
  assert.equal(formatPercent(null), '—')
})

// ═══════════════════════════════════════════════════════
// usage 归一化 / 空态兜底
// ═══════════════════════════════════════════════════════

const SAMPLE = {
  conversationId: 'char_2',
  model: 'cn:deepseek-v4-flash',
  contextWindow: 1000000,
  contextWindowSource: 'provider',
  usedTokens: 4408,
  usedPercent: 0.44,
  remainingTokens: 995592,
  source: 'last-request',
  updatedAt: '2026-09-28T23:20:00.000Z',
  breakdown: [
    { key: 'system', label: '系统提示词', tokens: 1800, chars: 3600 },
    { key: 'memory', label: '记忆与档案', tokens: 900, chars: 1800 },
    { key: 'transcript', label: '对话消息', tokens: 1500, chars: 3000 },
    { key: 'directive', label: '本轮指令', tokens: 200, chars: 400 },
  ],
}

test('normalizeUsage 正常响应逐字段映射（usedPercent 是 0~100 百分数）', () => {
  const u = normalizeUsage(SAMPLE)
  assert.equal(u.hasData, true)
  assert.equal(u.conversationId, 'char_2')
  assert.equal(u.model, 'cn:deepseek-v4-flash')
  assert.equal(u.contextWindow, 1000000)
  assert.equal(u.windowKnown, true)
  assert.equal(u.windowLabel, '1.0M')
  assert.equal(u.contextWindowSource, 'provider')
  assert.equal(u.percent, 0.44)
  assert.equal(u.percentLabel, '0%')
  assert.equal(u.level, 'normal')
  assert.equal(u.usedTokens, 4408)
  assert.equal(u.usedLabel, '4.4K')
  assert.equal(u.remainingTokens, 995592)
  assert.equal(u.source, 'last-request')
  assert.equal(u.sourceLabel, '来自上一次请求')
  assert.equal(u.updatedAt, '2026-09-28T23:20:00.000Z')
  assert.equal(u.breakdown.length, 4)
  assert.deepEqual(u.breakdown[0], { key: 'system', label: '系统提示词', tokens: 1800, tokensLabel: '1.8K' })
  assert.deepEqual(u.breakdown[3], { key: 'directive', label: '本轮指令', tokens: 200, tokensLabel: '200' })
})

test('normalizeUsage 沿用接口给的 usedPercent，不自行重算', () => {
  // 用户截图那种 33%：168K / 512K 左右的量级
  const u = normalizeUsage({ contextWindow: 512000, usedTokens: 168000, usedPercent: 33 })
  assert.equal(u.percent, 33)
  assert.equal(u.percentLabel, '33%')
  assert.equal(u.usedLabel, '168K')
  assert.equal(u.windowLabel, '512K')
  assert.equal(u.level, 'normal')
})

test('normalizeUsage 缺 usedPercent 时用 usedTokens / contextWindow 推算', () => {
  const u = normalizeUsage({ contextWindow: 1000000, usedTokens: 4408 })
  assert.ok(Math.abs(u.percent - 0.4408) < 1e-9)
  assert.equal(u.remainingTokens, 995592)
})

test('normalizeUsage 警告 / 危险档位随占用升高', () => {
  assert.equal(normalizeUsage({ usedPercent: 71, contextWindow: 1000 }).level, 'warn')
  assert.equal(normalizeUsage({ usedPercent: 95, contextWindow: 1000 }).level, 'danger')
})

test('normalizeUsage contextWindow 为 null → 窗口未知，但仍显示已用 token', () => {
  const u = normalizeUsage({ conversationId: 'char_2', contextWindow: null, usedTokens: 4408, usedPercent: 0, source: 'estimate' })
  assert.equal(u.windowKnown, false)
  assert.equal(u.windowLabel, '—')
  assert.equal(u.hasData, true)
  assert.equal(u.usedLabel, '4.4K')
  assert.equal(u.sourceLabel, '估算值（还没有真实请求）')
})

test('normalizeUsage breakdown 为空数组 / 非数组 / 脏项都能兜底', () => {
  assert.deepEqual(normalizeUsage({ ...SAMPLE, breakdown: [] }).breakdown, [])
  assert.deepEqual(normalizeUsage({ ...SAMPLE, breakdown: null }).breakdown, [])
  assert.deepEqual(normalizeUsage({ ...SAMPLE, breakdown: 'oops' }).breakdown, [])
  const dirty = normalizeUsage({
    usedTokens: 1,
    breakdown: [null, 'x', { key: 'system', tokens: 'abc' }, { label: '对话消息', tokens: 1500 }],
  })
  assert.equal(dirty.breakdown.length, 1)
  // key 缺失时用「过滤后」的下标兜底，只保证唯一
  assert.equal(dirty.breakdown[0].key, 'item-1')
  assert.equal(dirty.breakdown[0].label, '对话消息')
  assert.equal(dirty.breakdown[0].tokensLabel, '1.5K')
})

test('normalizeUsage 过滤 tokens 为 0 的固定分段（服务端固定返回 5 段）', () => {
  const u = normalizeUsage({
    usedTokens: 4408,
    contextWindow: 128000,
    breakdown: [
      { key: 'system', label: '系统提示词', tokens: 1800, chars: 3600 },
      { key: 'memory', label: '记忆与档案', tokens: 0, chars: 0 },
      { key: 'transcript', label: '对话消息', tokens: 1500, chars: 3000 },
      { key: 'directive', label: '本轮指令', tokens: 0, chars: 0 },
      { key: 'other', label: '其他', tokens: 0, chars: 0 },
    ],
  })
  assert.deepEqual(u.breakdown.map(item => item.key), ['system', 'transcript'])
})

test('normalizeUsage 完全空响应 → 未知态而不是 0%，也不抛错', () => {
  const u = normalizeUsage(null)
  assert.equal(u.hasData, false)
  assert.equal(u.percent, null)
  assert.equal(u.percentLabel, '—')
  assert.equal(u.windowLabel, '—')
  assert.equal(u.usedLabel, '—')
  assert.equal(u.barWidth, 0)
  assert.equal(u.level, 'normal')
  assert.deepEqual(u.breakdown, [])

  assert.equal(normalizeUsage(undefined).hasData, false)
  assert.equal(normalizeUsage({}).hasData, false)
  assert.equal(normalizeUsage({ conversationId: 'char_1' }).hasData, false)
  assert.equal(normalizeUsage('nope').hasData, false)
})

test('normalizeUsage 对越界与负数 token 做夹取，不产生负进度', () => {
  const u = normalizeUsage({ contextWindow: 1000, usedTokens: -5, usedPercent: 300, remainingTokens: -20 })
  assert.equal(u.usedTokens, null)        // 负数 token 不参与显示
  assert.equal(u.percent, 100)            // 300% 夹到 100%
  assert.equal(u.barWidth, 100)
  assert.equal(u.level, 'danger')
  assert.equal(u.remainingTokens, null)   // 负数剩余量不显示成 -20
  assert.equal(u.usedLabel, '—')
})

// ═══════════════════════════════════════════════════════
// 当前会话 id
// ═══════════════════════════════════════════════════════

test('resolveConversationId 私聊 / 群聊各自前缀', () => {
  assert.equal(resolveConversationId({ path: '/chat/2', activeCharId: 2 }), 'char_2')
  assert.equal(resolveConversationId({ path: '/chat', activeCharId: 2 }), 'char_2')
  assert.equal(resolveConversationId({ path: '/group/7', activeGroupId: 7 }), 'group_7')
})

test('resolveConversationId 群聊页优先群会话，私聊页忽略遗留的 group', () => {
  assert.equal(resolveConversationId({ path: '/group/7', activeCharId: 2, activeGroupId: 7 }), 'group_7')
  assert.equal(resolveConversationId({ path: '/chat/2', activeCharId: 2, activeGroupId: 7 }), 'char_2')
})

test('resolveConversationId 非聊天页与空会话都给空串（浮层显示 —）', () => {
  assert.equal(resolveConversationId({ path: '/settings', activeCharId: 2, activeGroupId: 7 }), '')
  assert.equal(resolveConversationId({ path: '/chat/2', activeCharId: null }), '')
  assert.equal(resolveConversationId({ path: '/group/7', activeGroupId: null }), '')
  assert.equal(resolveConversationId(), '')
  // 角色 id 0 在数据库里不存在，但 null/undefined 必须排除
  assert.equal(resolveConversationId({ path: '/group/7', activeGroupId: undefined }), '')
})

// ═══════════════════════════════════════════════════════
// 刷新节流器 / 事件判定
// ═══════════════════════════════════════════════════════

test('UsageRefreshGovernor 同会话 minInterval 内合并请求，超时后放行', async () => {
  const g = new UsageRefreshGovernor({ minIntervalMs: 3000 })
  let calls = 0
  const task = () => { calls++; return Promise.resolve(calls) }

  const first = g.run('char_2', task, 1000)
  const second = g.run('char_2', task, 1500)   // 复用进行中的 Promise
  assert.equal(first, second)
  assert.equal(await first, 1)
  assert.equal(calls, 1)

  await g.run('char_2', task, 2000)            // 3s 内 → 被节流
  assert.equal(calls, 1)

  await g.run('char_2', task, 4000)            // 满 3s → 放行
  assert.equal(calls, 2)
})

test('UsageRefreshGovernor 切会话立即放行，不受 minInterval 限制', async () => {
  const g = new UsageRefreshGovernor({ minIntervalMs: 10000 })
  let calls = 0
  const task = () => { calls++; return Promise.resolve() }

  await g.run('char_2', task, 1000)
  await g.run('group_7', task, 1001)
  assert.equal(calls, 2)
  assert.equal(g.lastKey, 'group_7')
})

test('UsageRefreshGovernor 上一个会话的请求还在飞时，切会话仍能立即刷新', async () => {
  const g = new UsageRefreshGovernor({ minIntervalMs: 10000 })
  const calls = []
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  let releaseFirst
  // run() 把 task 放到微任务里执行，因此这里用「调用即入队」的包装来观察实际发起的请求
  const spy = (key, task) => g.run(key, () => { calls.push(key); return task() })

  const first = spy('char_2', () => new Promise(resolve => { releaseFirst = () => resolve('first') }))
  await tick()
  assert.deepEqual(calls, ['char_2'])

  // 上一个会话还在飞，切会话必须立刻放行（不能复用它那个 Promise）
  const second = spy('group_7', () => Promise.resolve('second'))
  await tick()
  assert.notEqual(second, first)
  assert.deepEqual(calls, ['char_2', 'group_7'])
  assert.equal(await second, 'second')

  releaseFirst()
  assert.equal(await first, 'first')
  await tick()
  assert.equal(g.inflight, null)
})

test('UsageRefreshGovernor 请求失败也会释放 inflight，不会卡死后续刷新', async () => {
  const g = new UsageRefreshGovernor({ minIntervalMs: 0 })
  const boom = () => Promise.reject(new Error('network'))
  await assert.rejects(() => g.run('char_2', boom, 1000))
  assert.equal(g.inflight, null)
  assert.equal(await g.run('char_2', () => Promise.resolve('ok'), 2000), 'ok')
})

test('isAssistantMessage 只在 assistant 消息上触发刷新', () => {
  assert.equal(isAssistantMessage({ role: 'assistant' }), true)
  assert.equal(isAssistantMessage({ role: 'user' }), false)
  assert.equal(isAssistantMessage(null), false)
  assert.equal(isAssistantMessage('assistant'), false)
})

test('isCompressConflict 识别 409「正在压缩中」', () => {
  assert.equal(isCompressConflict({ status: 409 }), true)
  assert.equal(isCompressConflict({ code: 'compression in progress' }), true)
  assert.equal(isCompressConflict(new Error('请求失败 (500)')), false)
  assert.equal(isCompressConflict(null), false)
})

// ═══════════════════════════════════════════════════════
// 持久化快照来源 + 更新时间（本轮新增）
// ═══════════════════════════════════════════════════════

test('USAGE_SOURCE_LABELS 覆盖 snapshot，且措辞如实说是「上次」而不是「刚刚」', () => {
  assert.equal(Object.keys(USAGE_SOURCE_LABELS).length, 4)
  assert.equal(USAGE_SOURCE_LABELS.snapshot, '上次请求（已持久化）')
  assert.equal(USAGE_SOURCE_LABELS['last-request'], '来自上一次请求')
  assert.equal(USAGE_SOURCE_LABELS.estimate, '估算值（还没有真实请求）')
  assert.equal(USAGE_SOURCE_LABELS.none, '暂无数据')
  for (const text of Object.values(USAGE_SOURCE_LABELS)) {
    assert.ok(!/刚刚|实时/.test(text), `${text} 不该暗示「刚刚」`)
  }
})

test('normalizeUsage source=snapshot 原样透出，并按持久化口径给文案', () => {
  const u = normalizeUsage({ ...SAMPLE, source: 'snapshot' })
  assert.equal(u.source, 'snapshot')
  assert.equal(u.sourceLabel, '上次请求（已持久化）')
})

test('normalizeUsage updatedAt 为 null / 非法时不给假时间', () => {
  for (const bad of [null, undefined, '', 12345, {}]) {
    const u = normalizeUsage({ ...SAMPLE, updatedAt: bad })
    assert.equal(u.updatedAt, '')
    assert.equal(u.updatedAtLabel, '')
  }
  // 保留原始 ISO 字符串（浮层只负责展示，不改写后端给的值）
  assert.equal(normalizeUsage(SAMPLE).updatedAt, '2026-09-28T23:20:00.000Z')
})

test('formatUpdatedAt 同天只说时刻，跨天补月日，跨年补完整日期', () => {
  const now = new Date(2026, 8, 28, 12, 0)
  assert.equal(formatUpdatedAt(new Date(2026, 8, 28, 9, 26).toISOString(), now), '更新于 09:26')
  assert.equal(formatUpdatedAt(new Date(2026, 8, 28, 9, 5).toISOString(), now), '更新于 09:05')
  assert.equal(formatUpdatedAt(new Date(2026, 8, 27, 23, 59).toISOString(), now), '更新于 09-27 23:59')
  assert.equal(formatUpdatedAt(new Date(2025, 11, 31, 8, 3).toISOString(), now), '更新于 2025-12-31 08:03')
})

test('formatUpdatedAt 空值 / 脏值 / 非法 now 都不抛错', () => {
  for (const bad of [null, undefined, '', '   ', 'not-a-date', 42, {}]) {
    assert.equal(formatUpdatedAt(bad), '')
  }
  // now 非法时退回真实当前时间，至少仍是一句合法文案
  const label = formatUpdatedAt('2026-09-28T01:26:00.000Z', new Date('nope'))
  assert.match(label, /^更新于 /)
})

test('normalizeUsage 把更新时间一起归一成 updatedAtLabel（浮层直接渲染）', () => {
  const iso = new Date(2026, 8, 28, 9, 26).toISOString()
  const u = normalizeUsage({ ...SAMPLE, updatedAt: iso })
  assert.equal(u.updatedAt, iso)
  assert.equal(u.updatedAtLabel, formatUpdatedAt(iso))
  assert.match(u.updatedAtLabel, /^更新于 /)
  // 就是当前时刻 → 只给时刻，不补日期
  assert.match(normalizeUsage({ updatedAt: new Date().toISOString() }).updatedAtLabel, /^更新于 \d{2}:\d{2}$/)
})

// ═══════════════════════════════════════════════════════
// 窗口来源文案（declared / provider / default）
// ═══════════════════════════════════════════════════════

test('windowSourceText 三种来源都给人话，未知来源返回空串', () => {
  assert.deepEqual(WINDOW_SOURCE_LABELS, {
    declared: '手动声明',
    provider: '服务端探测',
    default: '默认值',
  })
  assert.equal(windowSourceText('declared'), '窗口来源：手动声明')
  assert.equal(windowSourceText('provider'), '窗口来源：服务端探测')
  assert.equal(windowSourceText('default'), '窗口来源：默认值')
  assert.equal(windowSourceText('guess'), '')
  assert.equal(windowSourceText(null), '')
  assert.equal(windowSourceText(undefined), '')
})

test('normalizeUsage 透出 windowSourceText，三种来源都不落空', () => {
  for (const source of ['declared', 'provider', 'default']) {
    const u = normalizeUsage({ ...SAMPLE, contextWindowSource: source })
    assert.equal(u.contextWindowSource, source)
    assert.equal(u.windowSourceText, windowSourceText(source))
  }
  // 后端没给来源时不硬凑一句话
  assert.equal(normalizeUsage({ ...SAMPLE, contextWindowSource: '' }).windowSourceText, '')
})

// ═══════════════════════════════════════════════════════
// 分项标定（tokensCalibrated / breakdownCalibrated）
// ═══════════════════════════════════════════════════════

const CALIBRATED_SAMPLE = {
  ...SAMPLE,
  breakdownCalibrated: true,
  breakdown: [
    { key: 'system', label: '系统提示词', tokens: 1800, tokensCalibrated: 1840, chars: 3600 },
    { key: 'transcript', label: '对话消息', tokens: 1500, tokensCalibrated: 1560, chars: 3000 },
  ],
}

test('有标定值时按分项标定值展示，并标注「已标定」', () => {
  const u = normalizeUsage(CALIBRATED_SAMPLE)
  assert.equal(u.breakdownCalibrated, true)
  assert.equal(u.breakdownTag, BREAKDOWN_TAGS.calibrated)
  assert.equal(u.breakdownTag, '已标定')
  assert.equal(u.breakdownNote, BREAKDOWN_CALIBRATED_NOTE)
  assert.equal(u.breakdownNote, '分项已按真实总量标定')

  const first = u.breakdown[0]
  assert.equal(first.tokens, 1840)
  assert.equal(first.tokensCalibrated, 1840)
  assert.equal(first.tokensLabel, '1.8K')
  assert.equal(first.calibrated, true)
  // 估算值仍留着，悬停时可以对照
  assert.equal(first.estimateTokens, 1800)
  assert.equal(first.estimateLabel, '1.8K')
})

test('没有标定值时用估算值 + 标「估算」，且不多挂标定字段', () => {
  const u = normalizeUsage(SAMPLE)
  assert.equal(u.breakdownCalibrated, false)
  assert.equal(u.breakdownTag, '估算')
  assert.equal(u.breakdownNote, '')
  assert.deepEqual(u.breakdown[1], { key: 'memory', label: '记忆与档案', tokens: 900, tokensLabel: '900' })
  assert.equal('calibrated' in u.breakdown[1], false)
  assert.equal('tokensCalibrated' in u.breakdown[1], false)
})

test('分项自带标定值但顶层没给 breakdownCalibrated 时，照样按「已标定」说', () => {
  const u = normalizeUsage({
    usedTokens: 3400,
    breakdown: [
      { key: 'system', label: '系统提示词', tokens: 1800, tokensCalibrated: 1840 },
      { key: 'memory', label: '记忆与档案', tokens: 900 },
    ],
  })
  assert.equal(u.breakdownCalibrated, true)
  assert.equal(u.breakdownTag, '已标定')
  // 只有带标定值的行挂标定字段，没带的那行仍是估算形状
  assert.equal(u.breakdown[0].calibrated, true)
  assert.equal('calibrated' in u.breakdown[1], false)
  assert.equal(u.breakdown[1].tokensLabel, '900')
})

test('顶层 breakdownCalibrated=true 时认「已标定」，但分项行仍不多挂标定字段', () => {
  const u = normalizeUsage({ ...SAMPLE, breakdownCalibrated: true })
  assert.equal(u.breakdownCalibrated, true)
  assert.equal(u.breakdownTag, '已标定')
  assert.equal(u.breakdownNote, BREAKDOWN_CALIBRATED_NOTE)
  // 顶层只说明「整张分项已标定」，不代表每一项都单独给了标定值
  for (const item of u.breakdown) {
    assert.equal('calibrated' in item, false)
    assert.equal('tokensCalibrated' in item, false)
  }
  // 顶层明确说没标定、分项也没给标定值 → 老实说「估算」
  assert.equal(normalizeUsage({ ...SAMPLE, breakdownCalibrated: false }).breakdownTag, '估算')
  // 脏值不算标定
  assert.equal(normalizeUsage({ ...SAMPLE, breakdownCalibrated: 'true' }).breakdownTag, '估算')
  assert.equal(normalizeUsage({ ...SAMPLE, breakdownCalibrated: 0 }).breakdownTag, '估算')
})

test('标定值不合法（字符串 / 负数 / null）时回落到估算值', () => {
  const u = normalizeUsage({
    usedTokens: 3000,
    breakdown: [
      { key: 'system', label: '系统提示词', tokens: 1800, tokensCalibrated: 'abc' },
      { key: 'memory', label: '记忆与档案', tokens: 900, tokensCalibrated: -1 },
      { key: 'transcript', label: '对话消息', tokens: 1500, tokensCalibrated: null },
    ],
  })
  assert.deepEqual(u.breakdown.map(item => item.tokensLabel), ['1.8K', '900', '1.5K'])
  assert.equal(u.breakdownCalibrated, false)
  assert.equal(u.breakdownTag, '估算')
  for (const item of u.breakdown) assert.equal(item.calibrated, undefined)
})

test('标定值让原本估算为 0 的分项重新可见', () => {
  const u = normalizeUsage({
    usedTokens: 500,
    breakdownCalibrated: true,
    breakdown: [
      { key: 'system', label: '系统提示词', tokens: 1800, tokensCalibrated: 1900 },
      { key: 'other', label: '其他', tokens: 0, tokensCalibrated: 240 },
      { key: 'directive', label: '本轮指令', tokens: 0, tokensCalibrated: 0 },
    ],
  })
  assert.deepEqual(u.breakdown.map(item => item.key), ['system', 'other'])
  assert.equal(u.breakdown[1].tokensLabel, '240')
})

test('标定字段走空响应兜底：不抛错、估算标签照常', () => {
  const u = normalizeUsage(null)
  assert.equal(u.breakdownCalibrated, false)
  assert.equal(u.breakdownTag, '估算')
  assert.equal(u.breakdownNote, '')
  assert.equal(u.updatedAtLabel, '')
  assert.equal(u.windowSourceText, '')
})
