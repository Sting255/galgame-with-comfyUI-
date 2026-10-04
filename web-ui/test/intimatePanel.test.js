import { test } from 'node:test'
import assert from 'node:assert/strict'

import { translateIntimateError } from '../src/api/intimate.js'
import {
  AI_EDIT_FIELD_DEFS,
  AI_JUDGE_DAILY_LIMIT_MAX,
  ALL_VIEW_SCOPE,
  DEFAULT_AI_EDIT_FIELDS,
  DEFAULT_VIEW_SCOPE,
  actStatRows,
  addZone,
  aiEditResultText,
  aiJudgeQuotaNote,
  aiJudgeRunToast,
  backfillButtonText,
  backfillStatusText,
  clampDailyLimit,
  clampLevel,
  firstsRows,
  formatDateTime,
  formatSuggestionValue,
  fromDateInput,
  isAllViewScope,
  logRowText,
  normalizeAiEditFields,
  normalizeAiJudgeQuota,
  normalizeBackfill,
  normalizeSuggestions,
  normalizeViewScope,
  normalizeZones,
  partnerKindsToViewScope,
  removeZone,
  sourceLabel,
  statSummary,
  suggestionFieldLabel,
  toDateInput,
  toggleAiEditField,
  topPositions,
  viewScopeToPartnerKinds,
  viewScopeToggleResult,
  zoneLevelLabel,
  zoneLevelPercent,
  zoneLevelToken,
  zonesForSave,
} from '../src/components/character/intimateLogic.js'

// ── AI 修改权限 ──

test('AI 修改权限默认只开统计，非法值与重复项被清洗', () => {
  assert.deepEqual(normalizeAiEditFields(undefined), ['stats'])
  assert.deepEqual(normalizeAiEditFields(null), ['stats'])
  // 与后端 fail-closed 一致：显式空数组 = 用户把权限全关掉，脏值 = 不给权限
  assert.deepEqual(normalizeAiEditFields([]), [])
  assert.deepEqual(normalizeAiEditFields('body'), [])
  assert.deepEqual(normalizeAiEditFields(['body', 'body', 'hack']), ['body'])
  // 按清单顺序归一，而不是用户勾选顺序
  assert.deepEqual(normalizeAiEditFields(['stats', 'note', 'body']), ['body', 'note', 'stats'])
  assert.deepEqual(DEFAULT_AI_EDIT_FIELDS, ['stats'])
})

test('切换 AI 修改权限保持清单顺序，未知键无副作用', () => {
  assert.deepEqual(toggleAiEditField(['stats'], 'body'), ['body', 'stats'])
  assert.deepEqual(toggleAiEditField(['body', 'stats'], 'body'), ['stats'])
  assert.deepEqual(toggleAiEditField([], 'body'), ['body'])
  assert.deepEqual(toggleAiEditField(['body'], 'unknown'), ['body'])
  // 取消最后一个权限是允许的（AI 就不能改任何字段），不会回弹
  assert.deepEqual(toggleAiEditField(['stats'], 'stats'), [])
})

// ── 统计口径 ──

test('统计口径默认勾「用户↔角色 + 角色↔角色」（群聊可见），空值与非法值都回落到默认', () => {
  assert.deepEqual(DEFAULT_VIEW_SCOPE, ['user', 'character'])
  assert.deepEqual(normalizeViewScope(undefined), ['user', 'character'])
  assert.deepEqual(normalizeViewScope([]), ['user', 'character'])
  assert.deepEqual(normalizeViewScope(['npc', 'npc']), ['npc'])
  assert.deepEqual(normalizeViewScope(['bogus']), ['user', 'character'])
  assert.deepEqual(normalizeViewScope(['npc', 'user']), ['user', 'npc'])
})

test('取消最后一个口径不会归零，回退默认并给出 clamped 标记', () => {
  const last = viewScopeToggleResult(['user'], 'user')
  assert.deepEqual(last.scope, ['user', 'character'])
  assert.equal(last.clamped, true)

  const off = viewScopeToggleResult(['user', 'npc'], 'npc')
  assert.deepEqual(off.scope, ['user'])
  assert.equal(off.clamped, false)

  const on = viewScopeToggleResult(['user'], 'character')
  assert.deepEqual(on.scope, ['user', 'character'])
  assert.equal(on.clamped, false)
})

test('「全部」用三类全勾表达，query 永不提交空数组', () => {
  assert.deepEqual(ALL_VIEW_SCOPE, ['user', 'character', 'npc'])
  assert.equal(isAllViewScope(['user', 'character', 'npc']), true)
  assert.equal(isAllViewScope(['user', 'character']), false)
  assert.equal(viewScopeToPartnerKinds(['user']), 'user')
  assert.equal(viewScopeToPartnerKinds(['npc', 'user']), 'user,npc')
  assert.equal(viewScopeToPartnerKinds(['user', 'character', 'npc']), 'user,character,npc')
  // 空数组永远不落成空 query（后端会把空规范化回默认口径）
  assert.equal(viewScopeToPartnerKinds([]), 'user,character')
})

test('后端回显的 partnerKinds 能反向校准 chip 选中态', () => {
  assert.deepEqual(partnerKindsToViewScope('user,character'), ['user', 'character'])
  assert.deepEqual(partnerKindsToViewScope(['npc']), ['npc'])
  assert.deepEqual(partnerKindsToViewScope(''), ['user', 'character'])
  assert.deepEqual(partnerKindsToViewScope(null), ['user', 'character'])
  assert.deepEqual(partnerKindsToViewScope('all'), ['user', 'character', 'npc'])
})

// ── 敏感部位 ──

test('部位等级夹取到 0~5，文案与色带宽度单调递增', () => {
  assert.equal(clampLevel(-3), 0)
  assert.equal(clampLevel(2.4), 2)
  assert.equal(clampLevel(9), 5)
  assert.equal(clampLevel('x'), 0)
  assert.equal(zoneLevelLabel(0), '未评级')
  assert.equal(zoneLevelLabel(5), '极强')
  assert.equal(zoneLevelPercent(0), 4)
  assert.equal(zoneLevelPercent(5), 100)
  assert.ok(zoneLevelPercent(3) > zoneLevelPercent(2))
  // 色阶只引用 token，不能出现硬编码色值
  for (let lv = 0; lv <= 5; lv += 1) {
    assert.match(zoneLevelToken(lv), /^var\(--/)
  }
})

test('部位列表增删：追加空行、按 key 删除、空行不进落库载荷', () => {
  const base = [
    { key: 'neck', label: '脖颈', level: 2 },
    { key: 'chest', label: '胸部', level: 5 },
  ]
  const added = addZone(base)
  assert.equal(added.length, 3)
  assert.equal(added[2].label, '')
  assert.notEqual(added[2].key, '')
  assert.equal(base.length, 2, 'addZone 不应改动入参数组')

  const removed = removeZone(added, added[2].key)
  assert.deepEqual(removed.map(z => z.key), ['chest', 'neck'])
  // key 缺省时不删任何东西
  assert.equal(removeZone(removed).length, 2)
})

test('部位列表归一：等级降序、中文名生成 key、重复 key 自动加序号', () => {
  const list = normalizeZones([
    { label: '脖颈', level: 1 },
    { label: '胸部', level: 5 },
    { key: 'x', label: '腰', level: 5 },
  ])
  assert.deepEqual(list.map(z => z.label), ['胸部', '腰', '脖颈'])
  assert.deepEqual(list.map(z => z.key), ['胸部', 'x', '脖颈'])

  const duplicated = zonesForSave([
    { label: '胸部', level: 3 },
    { label: '胸部', level: 2 },
    { label: '', level: 4 },
  ])
  assert.equal(duplicated.length, 2, '空行不进落库载荷')
  assert.deepEqual(duplicated.map(z => z.key), ['胸部', '胸部-2'])
  assert.deepEqual(duplicated.map(z => z.level), [3, 2])
})

// ── 统计与排行 ──

test('体位排行取 Top5：过滤零次、按次数降序', () => {
  const byPosition = [
    { positionKey: 'a', label: '正常位', count: 3 },
    { positionKey: 'b', label: '后背位', count: 9 },
    { positionKey: 'c', label: '骑乘位', count: 0 },
    { positionKey: 'd', label: '侧位', count: 5 },
    { positionKey: 'e', label: '立位', count: 2 },
    { positionKey: 'f', label: '对面座位', count: 1 },
    { positionKey: 'g', label: '屈曲位', count: 4 },
  ]
  const top = topPositions(byPosition, 5)
  assert.deepEqual(top.map(p => p.label), ['后背位', '侧位', '屈曲位', '正常位', '立位'])
  assert.equal(top.length, 5)
  assert.equal(topPositions(null).length, 0)
  assert.equal(topPositions([{ label: 'x', count: 0 }]).length, 0)

  // 噪声缓解：有 ≥2 次的条目时，一次性条目（噪声词的典型形态）不进排行——即使 limit 很大
  const withNoise = topPositions([
    { label: '后背位', count: 7 },
    { label: '瓷砖跪口交', count: 1 },
    { label: '侧位', count: 2 },
  ], 10)
  assert.deepEqual(withNoise.map(p => p.label), ['后背位', '侧位'])

  // 全部只有 1 次时退回显示（新角色不至于看到空排行）
  const allOnce = topPositions([{ label: '正常位', count: 1 }, { label: '立位', count: 1 }], 10)
  assert.equal(allOnce.length, 2)

  // 只有一条 ≥2 次时，也只显示它（不让一次性条目混进来）
  const singleRepeated = topPositions([
    { label: '正常位', count: 3 },
    { label: '照镜子', count: 1 },
    { label: '办公室', count: 1 },
  ], 10)
  assert.deepEqual(singleRepeated.map(p => p.label), ['正常位'])
})

test('基础统计行使用后端 label，并保留高潮与概要数值', () => {
  const rows = actStatRows({
    byAct: [
      { actKey: 'vaginal', label: '插入', count: 12, climax: 4, firstAt: '2026-01-02T00:00:00.000Z' },
      { actKey: 'oral', customLabel: '口交', count: '3', climax: 0 },
      { actKey: 'hand' },
    ],
  })
  assert.deepEqual(rows.map(r => r.label), ['插入', '口交', 'hand'])
  assert.deepEqual(rows.map(r => r.count), [12, 3, 0])
  assert.equal(rows[0].climax, 4)
  assert.equal(rows[0].firstAt, '2026-01-02T00:00:00.000Z')

  const summary = statSummary({ totalActs: '9', totalClimax: 2, actKinds: 3, lastAt: '2026-02-01T10:00:00.000Z' })
  assert.equal(summary.totalActs, 9)
  assert.equal(summary.totalClimax, 2)
  assert.equal(summary.actKinds, 3)
  assert.equal(summary.lastAt, '2026-02-01T10:00:00.000Z')
  assert.equal(statSummary(null).totalActs, 0)
})

// ── 初次信息 / 流水 ──

test('初次信息行由词表与已存里程碑合并，人工标记保留', () => {
  const acts = [{ key: 'vaginal', label: '插入' }, { key: 'oral', label: '口交' }]
  const firsts = [
    { actKey: 'vaginal', firstAt: '2026-01-01T00:00:00.000Z', source: 'manual', note: '生日那天' },
    { actKey: 'anal', label: '肛交', firstAt: '2026-03-01T00:00:00.000Z', source: 'derived' },
  ]
  const rows = firstsRows(acts, firsts)
  assert.deepEqual(rows.map(r => r.actKey), ['vaginal', 'oral', 'anal'])
  assert.equal(rows[0].manual, true)
  assert.equal(rows[1].firstAt, '')
  assert.equal(rows[2].manual, false)
  assert.equal(firstsRows(null, null).length, 0)
})

test('流水行文案走词表兜底，来源转中文', () => {
  const vocab = {
    acts: [{ key: 'vaginal', label: '插入' }],
    positions: [{ key: 'doggy', label: '后背位' }],
  }
  const row = logRowText({
    actKey: 'vaginal', positionKey: 'doggy', actCount: 2, climaxCount: 1,
    occurredAt: '2026-05-06T07:08:09.000Z', source: 'auto',
  }, vocab)
  assert.equal(row.actLabel, '插入')
  assert.equal(row.positionLabel, '后背位')
  assert.equal(row.actCount, 2)
  assert.equal(row.climaxCount, 1)
  assert.equal(row.source, '自动')

  const custom = logRowText({ actKey: 'weird', customLabel: '自定义', actCount: 'x' }, vocab)
  assert.equal(custom.actLabel, '自定义')
  assert.equal(custom.actCount, 0)
  assert.equal(logRowText({ actKey: 'weird', source: 'manual' }).source, '人工')
  assert.equal(sourceLabel('derived'), '自动')
})

test('日期与时间格式化：空值安全、date 输入往返一致', () => {
  assert.equal(toDateInput('2026-01-02T03:04:05.000Z'), '2026-01-02')
  assert.equal(toDateInput(''), '')
  assert.equal(toDateInput(null), '')
  assert.equal(fromDateInput('2026-01-02'), '2026-01-02')
  assert.equal(fromDateInput(''), null)
  assert.equal(formatDateTime('not-a-date'), '—')
  const formatted = formatDateTime('2026-01-02T03:04:05.000Z')
  assert.match(formatted, /^\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('无时区 SQLite 串必须按 UTC 解析：与 ISO 串代表同一时刻（存量 ai-judge 裸串的时区回归）', () => {
  // 两种写法代表同一时刻（2026-01-02 03:04:05 UTC）：显示必须一致
  const fromIso = formatDateTime('2026-01-02T03:04:05.000Z')
  const fromSqlite = formatDateTime('2026-01-02 03:04:05')
  assert.equal(fromSqlite, fromIso, `SQLite 串按本地解析会偏移时区（${fromSqlite} vs ${fromIso}）`)
  assert.match(fromSqlite, /^\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.notEqual(fromSqlite, '—', '合法 SQLite 串不该显示占位符')
})

// ── 回填 ──

test('回填状态归一与按钮 / 状态文案', () => {
  assert.deepEqual(normalizeBackfill(null), { status: 'idle', scanned: 0, inserted: 0, lastRawId: 0 })
  assert.deepEqual(normalizeBackfill({ status: 'RUNNING', scanned: '7', inserted: 3 }), {
    status: 'running', scanned: 7, inserted: 3, lastRawId: 0,
  })
  // 引擎可能新增状态值：原样保留，别误报成 idle（否则会重复触发回填、文案也说成「待开始」）
  assert.equal(normalizeBackfill({ status: 'paused' }).status, 'paused')
  assert.equal(backfillButtonText({ status: 'running' }), '回填中…')
  assert.equal(backfillButtonText({ status: 'done' }), '重新回填')
  assert.equal(backfillButtonText({ status: 'idle' }), '开始 / 继续回填')
  assert.equal(backfillStatusText({ status: 'running' }), '正在回填…')
  assert.equal(backfillStatusText({ status: 'done' }), '回填已完成')
  assert.equal(backfillStatusText({ status: 'error' }), '回填出错，可重试')
  assert.equal(backfillStatusText({ status: 'idle' }, false), '已关闭')
  // 引擎实际会产出的另外两态（task-9 验收发现曾回落到英文原文）
  assert.equal(backfillStatusText({ status: 'partial' }), '未扫完，可继续回填')
  assert.equal(backfillStatusText({ status: 'blocked' }), '已暂停：该角色未授权 AI 写入统计')
  assert.equal(backfillStatusText({ status: 'paused' }), '状态：paused')
})

// ── 接口错误转译 ──

test('功能总开关关闭（409）转成可读文案，其它错误原样透出', () => {
  assert.equal(translateIntimateError(409, 'intimate feature disabled'), '看板功能当前已关闭')
  assert.equal(translateIntimateError(409, undefined), '看板功能当前已关闭')
  assert.equal(translateIntimateError(500, 'intimate feature disabled'), '看板功能当前已关闭')
  assert.equal(translateIntimateError(500, 'database is locked'), 'database is locked')
  assert.equal(translateIntimateError(500, ''), '请求失败 (500)')
})

test('未配置 LLM（503）转成中文，不把 SDK 英文原文抛给用户', () => {
  assert.equal(translateIntimateError(503, 'llm not configured'), '尚未配置 LLM，无法整理')
  assert.equal(translateIntimateError(503, undefined), '尚未配置 LLM，无法整理')
  assert.equal(translateIntimateError(200, 'LLM Not Configured'), '尚未配置 LLM，无法整理')
})

test('提议已被处理 / 角色不存在这两条 404 也转成中文', () => {
  assert.equal(translateIntimateError(404, 'suggestion not found'), '这条提议已不存在，可能已被处理过')
  assert.equal(translateIntimateError(404, 'character not found'), '角色不存在或已被删除')
  assert.equal(translateIntimateError(400, 'invalid character id'), '角色不存在或已被删除')
})

// ── AI 整理档案：待确认提议（task-13） ──

test('提议字段名转中文，未知字段原样透出', () => {
  assert.equal(suggestionFieldLabel('body'), '身体信息')
  assert.equal(suggestionFieldLabel('sensitiveZones'), '敏感带')
  assert.equal(suggestionFieldLabel('note'), '备注')
  assert.equal(suggestionFieldLabel('firsts'), '初次')
  assert.equal(suggestionFieldLabel('weird'), 'weird')
  assert.equal(suggestionFieldLabel(''), '未知字段')
  assert.equal(suggestionFieldLabel(null), '未知字段')
})

test('提议值渲染成人话：身体 JSON / 敏感带 / 初次 / 纯文本', () => {
  // body：后端存 JSON 串，渲染成「身高 168cm、胸围 88cm」，空子键不出现
  assert.equal(
    formatSuggestionValue('body', '{"height":"168cm","bust":"88cm","waist":"","cup":""}'),
    '身高 168cm、胸围 88cm',
  )
  assert.equal(formatSuggestionValue('body', { height: '170cm' }), '身高 170cm')
  assert.equal(formatSuggestionValue('body', '{"height":""}'), '（空）')

  // 敏感带：label + 等级文案
  assert.equal(
    formatSuggestionValue('sensitiveZones', '[{"key":"neck","label":"脖颈","level":3},{"key":"chest","label":"胸部","level":5}]'),
    '脖颈（较强）、胸部（极强）',
  )
  assert.equal(formatSuggestionValue('sensitiveZones', '[]'), '（空）')

  // 初次：actKey 用词表兜底成中文，日期只取 YYYY-MM-DD
  assert.equal(
    formatSuggestionValue('firsts', '[{"actKey":"vaginal","firstAt":"2026-01-02T00:00:00.000Z"}]', {
      actLabels: { vaginal: '插入' },
    }),
    '插入 2026-01-02',
  )
  assert.equal(formatSuggestionValue('firsts', '[{"actKey":"oral"}]'), 'oral')

  // 纯文本：空值占位、超长截断
  assert.equal(formatSuggestionValue('note', '  '), '（空）')
  assert.equal(formatSuggestionValue('note', '体质偏寒'), '体质偏寒')
  assert.equal(formatSuggestionValue('note', 'x'.repeat(200)).length, 121)
})

test('待确认提议清洗：兼容 snake_case、只留 pending、id 缺失时用下标', () => {
  const list = normalizeSuggestions([
    { id: 7, field: 'body', currentValue: '{"height":""}', suggestion: '{"height":"168cm"}', status: 'pending', reason: '对话提到身高' },
    { id: 8, field: 'note', current_value: '旧备注', suggestion: '新备注', status: 'accepted' },
    { sid: 9, field: 'firsts', suggestion: '[{"actKey":"vaginal","firstAt":"2026-01-02"}]', status: 'PENDING' },
    { field: 'sensitiveZones', suggestion: '[]' },
  ])
  assert.equal(list.length, 3, 'accepted 的提议不进待确认列表')
  assert.deepEqual(list.map(s => s.id), [7, 9, 3])
  assert.deepEqual(list.map(s => s.fieldLabel), ['身体信息', '初次', '敏感带'])
  assert.equal(list[0].currentText, '（空）')
  assert.equal(list[0].suggestionText, '身高 168cm')
  assert.equal(list[0].reason, '对话提到身高')
  assert.equal(list[1].suggestionText, 'vaginal 2026-01-02')
  assert.equal(list[2].suggestionText, '（空）')
  assert.deepEqual(normalizeSuggestions(null), [])
  assert.deepEqual(normalizeSuggestions('nope'), [])
})

test('后端已给可读预览串时原样透出，不再二次解析', () => {
  // 后端 rowToSuggestion 返回的 suggestion / currentValue 已经是人话预览，fieldLabel 也是中文
  const [row] = normalizeSuggestions([{
    id: 3,
    field: 'sensitiveZones',
    fieldLabel: '敏感带',
    currentValue: '脖颈(较强)',
    suggestion: '脖颈(很强)、胸部(极强)',
    status: 'pending',
  }])
  assert.equal(row.fieldLabel, '敏感带')
  assert.equal(row.currentText, '脖颈(较强)')
  assert.equal(row.suggestionText, '脖颈(很强)、胸部(极强)')
})

test('整理结果文案：已应用项数 / 待确认 / 素材不足', () => {
  assert.equal(aiEditResultText({ empty: true }), '最近的对话内容太少，暂时整理不出档案')
  assert.equal(aiEditResultText({ applied: [{ field: 'body' }, { field: 'note' }] }), '已更新 2 项档案')
  assert.equal(aiEditResultText({ applied: [], suggestions: [{ id: 1 }] }), '有字段需要你确认，已放进待确认提议')
  assert.equal(aiEditResultText({ applied: [], suggestions: [] }), '整理完成，没有可更新的档案')
  assert.equal(aiEditResultText(null), '整理完成，没有可更新的档案')
})

// ═══════════════════════════════════════════════════════
// AI 判断行为：每日配额（GET /api/config 顶层 aiJudge）
// ═══════════════════════════════════════════════════════

test('normalizeAiJudgeQuota 有限上限 / 不限制 / 未读到三种情形', () => {
  const limited = normalizeAiJudgeQuota({ dailyLimit: 20, usedToday: 3, remaining: 17, unlimited: false })
  assert.deepEqual(limited, {
    known: true, dailyLimit: 20, usedToday: 3, remaining: 17, unlimited: false, exhausted: false,
  })

  const unlimited = normalizeAiJudgeQuota({ dailyLimit: 0, usedToday: 4, remaining: null, unlimited: true })
  assert.equal(unlimited.known, true)
  assert.equal(unlimited.unlimited, true)
  assert.equal(unlimited.remaining, null)
  assert.equal(unlimited.exhausted, false)

  // 读不到（接口还没上 / 请求失败）时 known=false，页面不许编「已用 0 次」
  for (const bad of [undefined, null, 'nope', 42, []]) {
    const q = normalizeAiJudgeQuota(bad)
    assert.equal(q.known, false, `${JSON.stringify(bad)} 应是 known=false`)
    assert.equal(q.remaining, null)
    assert.equal(q.exhausted, false)
  }
})

test('normalizeAiJudgeQuota 缺 unlimited / remaining 时按契约推断', () => {
  // dailyLimit === 0 或未给 unlimited → 不限制
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 0, usedToday: 2 }).unlimited, true)
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 5, usedToday: 2 }).unlimited, false)
  // remaining 缺失时用 dailyLimit - usedToday 推
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 5, usedToday: 2 }).remaining, 3)
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 5, usedToday: 9 }).remaining, 0)
  // 后端给的 remaining 为负数也夹到 0
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 5, usedToday: 9, remaining: -2 }).remaining, 0)
  // dailyLimit 脏值 → 0（不限制）
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 'abc', usedToday: 1 }).dailyLimit, 0)
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: -3, usedToday: 1 }).dailyLimit, 0)
})

test('normalizeAiJudgeQuota 识别配额耗尽', () => {
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 8, usedToday: 8, remaining: 0 }).exhausted, true)
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 8, usedToday: 7, remaining: 1 }).exhausted, false)
  // 不限制永远不算耗尽
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 0, usedToday: 999, unlimited: true }).exhausted, false)
  // remaining 缺失但上限已知时照样能推出来（已用超上限 = 耗尽）
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 8, usedToday: 9, remaining: null }).exhausted, true)
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 8, usedToday: 3, remaining: null }).exhausted, false)
  // 后端（run 回执的 quota）直接给了 exhausted 就以它为准
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 8, usedToday: 3, remaining: 5, exhausted: true }).exhausted, true)
  assert.equal(normalizeAiJudgeQuota({ dailyLimit: 8, usedToday: 8, remaining: 0, exhausted: false }).exhausted, false)
})

test('clampDailyLimit 把输入框的脏值收成合法上限', () => {
  assert.equal(clampDailyLimit(0), 0)
  assert.equal(clampDailyLimit(20), 20)
  assert.equal(clampDailyLimit('20'), 20)
  assert.equal(clampDailyLimit(20.9), 20)
  assert.equal(clampDailyLimit(-5), 0)
  assert.equal(clampDailyLimit(''), 0)
  assert.equal(clampDailyLimit('abc'), 0)
  assert.equal(clampDailyLimit(undefined), 0)
  assert.equal(clampDailyLimit(Infinity), 0)
  assert.equal(clampDailyLimit(AI_JUDGE_DAILY_LIMIT_MAX + 100), AI_JUDGE_DAILY_LIMIT_MAX)
  assert.equal(AI_JUDGE_DAILY_LIMIT_MAX, 100000)
})

test('aiJudgeQuotaNote 旁注文案：已用次数 / 剩余次数 / 未读到', () => {
  assert.equal(
    aiJudgeQuotaNote({ dailyLimit: 20, usedToday: 3, remaining: 17, unlimited: false }),
    '0 = 不限制；当前已用 3 次，今日还剩 17 次',
  )
  assert.equal(
    aiJudgeQuotaNote({ dailyLimit: 0, usedToday: 3, remaining: null, unlimited: true }),
    '0 = 不限制；当前已用 3 次',
  )
  assert.equal(
    aiJudgeQuotaNote({ dailyLimit: 8, usedToday: 8, remaining: 0 }),
    '0 = 不限制；当前已用 8 次，今日还剩 0 次',
  )
  // 读不到只是少一句话，不能编数字
  assert.equal(aiJudgeQuotaNote(null), '0 = 不限制')
})

test('aiJudgeRunToast 正常回执走 success，并带上判断轮数与补记笔数', () => {
  assert.deepEqual(
    aiJudgeRunToast({ judged: 6, recorded: 4, errors: [] }),
    { text: '已判断 6 轮，补记 4 笔', type: 'success' },
  )
  // 部分轮次失败 → warning，追加第一条原因
  assert.deepEqual(
    aiJudgeRunToast({ judged: 6, recorded: 2, errors: ['第 3 轮超时'] }),
    { text: '已判断 6 轮，补记 2 笔；第 3 轮超时', type: 'warning' },
  )
  // 空对象也能给出人话（不显示 undefined）
  assert.equal(aiJudgeRunToast(null).text, '已判断 0 轮，补记 0 笔')
})

test('aiJudgeRunToast 配额耗尽时直接用后端 message / errors 里的人话', () => {
  const exhausted = aiJudgeRunToast({
    judged: 0,
    recorded: 0,
    message: '今日 AI 判断次数已用完（20/20），明天恢复',
    quota: { dailyLimit: 20, usedToday: 20, remaining: 0, unlimited: false },
  })
  assert.deepEqual(exhausted, { text: '今日 AI 判断次数已用完（20/20），明天恢复', type: 'warning' })

  // 没有 message 时退到 errors 第一条
  assert.deepEqual(
    aiJudgeRunToast({
      message: '',
      errors: ['今日配额已用尽，本次未执行'],
      quota: { dailyLimit: 20, usedToday: 20, remaining: 0, unlimited: false },
    }),
    { text: '今日配额已用尽，本次未执行', type: 'warning' },
  )

  // 两者都没有时给一句不撒谎的兜底
  assert.deepEqual(
    aiJudgeRunToast({ quota: { dailyLimit: 8, usedToday: 8, remaining: 0, unlimited: false } }),
    { text: '今日 AI 判断次数已用完（上限 8 次）', type: 'warning' },
  )

  // 不限制（配额对象在，但 unlimited）不算耗尽，仍走正常文案
  assert.deepEqual(
    aiJudgeRunToast({
      judged: 3,
      recorded: 3,
      message: '已完成',
      quota: { dailyLimit: 0, usedToday: 30, remaining: null, unlimited: true },
    }),
    { text: '已判断 3 轮，补记 3 笔', type: 'success' },
  )
})

test('aiJudgeRunToast 刚好用掉最后一次：先报本轮结果，再补一句配额已用完', () => {
  // 真实后端：这一轮跑成了，但返回的 quota.remaining === 0
  assert.deepEqual(
    aiJudgeRunToast({
      judged: 2,
      recorded: 2,
      errors: ['今日 AI 判断配额已用完（8/8），本次未调用模型'],
      quota: { dailyLimit: 8, usedToday: 8, remaining: 0, unlimited: false },
    }),
    { text: '已判断 2 轮，补记 2 笔；今日 AI 判断配额已用完（8/8），本次未调用模型', type: 'warning' },
  )
  // errors 为空也要说清「配额已用完」，不能只报成功
  assert.deepEqual(
    aiJudgeRunToast({
      judged: 1,
      recorded: 1,
      quota: { dailyLimit: 1, usedToday: 1, remaining: 0, unlimited: false },
    }),
    { text: '已判断 1 轮，补记 1 笔；今日配额已用完', type: 'warning' },
  )
})
