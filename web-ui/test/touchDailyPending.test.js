/**
 * task-25 ② P2-1 统计按天曲线 + ③ 待回应提示（pendingCount）
 *
 * ② 后端 GET /api/characters/:id/touch/stats 已返回 daily:[{date,count}]，前端此前只画次数/等级/档位。
 * ③ 后端（另一条线）会在 GET /api/characters/:id/touch/state 加 pendingCount ⇒ 动作条上方显示
 *    「还有 N 个动作等她回应」，N>0 才显示。**未落地前按该形状写并标注**（读不到一律当 0，不弹错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

import { normalizeTouchStats, normalizeDaily, buildDailyPoints, buildDailyTicks, dailyLabel } from '../src/components/touchStatsLogic.js'
import { pendingHintOf } from '../src/components/touchActionLogic.js'

const panelFile = readFileSync(new URL('../src/components/TouchStatsPanel.vue', import.meta.url), 'utf8')
const panel = parseSfc(panelFile).descriptor
const panelTemplate = panel.template.content
const panelStyle = panelFile.slice(panelFile.indexOf('<style'))

// 交互改版：待回应提示从常驻条搬到了 TouchActionPanel（入口角标在页面里，面板顶部同一句）
const barFile = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const bar = parseSfc(barFile).descriptor
const barTemplate = bar.template.content
const barScript = bar.scriptSetup.content

const chat = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor
const chatTemplate = chat.template.content
const chatScript = chat.scriptSetup.content

// ── ② 按天曲线 ──

test('normalizeDaily：只留合法日期、按日期升序、次数取非负整数', () => {
  assert.deepEqual(normalizeDaily(null), [])
  assert.deepEqual(normalizeDaily('nope'), [])
  assert.deepEqual(normalizeDaily([{ count: 3 }]), [], '没日期就丢掉')
  const rows = normalizeDaily([
    { date: '2026-09-30', count: 2 },
    { date: '2026-09-28', count: 5 },
    { date: '2026-09-29', count: '4' },
    { date: '2026-09-27', count: -3 },
  ])
  assert.deepEqual(rows.map(r => r.date), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'], '按日期升序')
  assert.deepEqual(rows.map(r => r.count), [0, 5, 4, 2], '负数夹到 0、字符串转数字')
})

test('buildDailyPoints：少于两点画不出线；两点起按最大值归一化到画布内', () => {
  assert.equal(buildDailyPoints([]), '')
  assert.equal(buildDailyPoints([{ date: '2026-09-30', count: 3 }]), '', '一个点画不出折线')
  const pts = buildDailyPoints(
    [{ date: '2026-09-29', count: 0 }, { date: '2026-09-30', count: 10 }],
    { width: 100, height: 40, pad: 4 },
  ).split(' ')
  assert.equal(pts.length, 2)
  const [x0, y0] = pts[0].split(',').map(Number)
  const [x1, y1] = pts[1].split(',').map(Number)
  assert.equal(x0, 4, '第一个点贴左边内边距')
  assert.equal(x1, 96, '最后一个点贴右边内边距')
  assert.equal(y0, 36, 'count=0 落在底部')
  assert.equal(y1, 4, '最大值落在顶部')
})

test('dailyLabel：YYYY-MM-DD → MM-DD；畸形输入原样返回', () => {
  assert.equal(dailyLabel('2026-09-30'), '09-30')
  assert.equal(dailyLabel('2026-1-5'), '01-05')
  assert.equal(dailyLabel(''), '')
  assert.equal(dailyLabel('怪东西'), '怪东西')
})

test('normalizeTouchStats 透出 daily 与 dailyTotal（缺字段不炸）', () => {
  const withDaily = normalizeTouchStats({ totals: { events: 3 }, daily: [{ date: '2026-09-30', count: 3 }] })
  assert.deepEqual(withDaily.daily, [{ date: '2026-09-30', count: 3 }])
  assert.equal(withDaily.dailyTotal, 3)
  const without = normalizeTouchStats({ totals: { events: 0 } })
  assert.deepEqual(without.daily, [], '没有 daily 时给空数组')
  assert.equal(without.dailyTotal, 0)
})

test('统计面板画出按天折线：SVG + polyline + 非缩放描边 + 空态兜底', () => {
  const compiled = compileTemplate({ source: panelTemplate, filename: 'TouchStatsPanel.vue', id: 'p' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(panelTemplate.includes('<svg'), '要有自绘 SVG（不引新图表库）')
  assert.ok(panelTemplate.includes('<polyline'), '折线用 polyline')
  assert.ok(panelTemplate.includes(':points="dailyPoints"'), '点串走纯函数')
  assert.ok(panelTemplate.includes('vector-effect="non-scaling-stroke"'), '拉伸时描边不变形')
  assert.ok(panelTemplate.includes('preserveAspectRatio="none"'), '按容器宽度拉伸')
  assert.ok(panelTemplate.includes('v-if="dailyPoints"'), '没点时不画')
  assert.ok(panelTemplate.includes('攒够两天'), '不足两天给中性说明')
  assert.ok(panelStyle.includes('stroke: var(--accent)'), '颜色走 token')
  assert.ok(panelStyle.includes('transition'), '保留 0.3s 过渡')
  assert.doesNotMatch(panelTemplate, /<button/)
})

// ── ③ 待回应提示 ──

test('pendingHintOf：N>0 才给文案，0 / 负数 / 非法一律空串', () => {
  assert.equal(pendingHintOf(3), '还有 3 个动作等她回应')
  assert.equal(pendingHintOf(1), '还有 1 个动作等她回应')
  assert.equal(pendingHintOf(0), '')
  assert.equal(pendingHintOf(-2), '')
  assert.equal(pendingHintOf(null), '')
  assert.equal(pendingHintOf(undefined), '')
  assert.equal(pendingHintOf('abc'), '')
  assert.equal(pendingHintOf('2'), '还有 2 个动作等她回应', '后端给字符串也认')
})

test('动作条：接 pendingCount prop，N>0 时在条上方显示提示', () => {
  const compiled = compileTemplate({ source: barTemplate, filename: 'TouchActionPanel.vue', id: 'b' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(barScript.includes('pendingCount'), '要有 pendingCount prop')
  assert.ok(barTemplate.includes('touch-pending'), '提示行有自己的类名')
  assert.ok(barTemplate.includes('v-if="pendingHint"'), '有文案才显示（mode 感知）')
  assert.ok(barTemplate.includes('{{ pendingHint }}'), '文案由 pendingHintByMode 出')
  assert.match(barTemplate, /<Transition name="touch-overlay">/, '弹层 0.3s 过渡')
  // 提示必须在动作胶囊之前（视觉上在「上方」）
  assert.ok(
    barTemplate.indexOf('touch-pending') < barTemplate.indexOf('touch-card'),
    '提示行要排在动作胶囊前面',
  )
})

test('聊天页：拉 touch/state 的 pendingCount 并传下去，读不到当 0', () => {
  assert.ok(chatScript.includes('fetchTouchState'), '要调 fetchTouchState')
  assert.ok(chatTemplate.includes(':pending-count="touchPendingCount"'), '要传给动作条')
  assert.ok(/pendingCount/.test(chatScript), '要从响应里取 pendingCount')
  // 端点未落地 / 字段缺失 → 0，不弹错、不阻塞
  assert.ok(/touchPendingCount/.test(chatScript))
  assert.ok(/\|\|\s*0|\?\?\s*0/.test(chatScript), '缺字段要回落 0')
  assert.equal(chatScript.includes('touchPendingCount.value = Math.'), false, '别自作聪明做运算')
})
// ── C1（规划-下一步）：按天曲线的横轴日期刻度 ──

test('buildDailyTicks：均匀取样、首尾必在、最多 maxTicks 个、位置 0~100%', () => {
  assert.deepEqual(buildDailyTicks([]), [], '无数据给空数组（面板走空态）')
  assert.deepEqual(buildDailyTicks(null), [])

  const one = buildDailyTicks([{ date: '2026-09-30', count: 1 }])
  assert.equal(one.length, 1, '只有一个点时只给一个刻度')
  assert.equal(one[0].label, '09-30')
  assert.equal(one[0].percent, 0)

  const week = [0, 1, 2, 3, 4, 5, 6].map(i => ({ date: '2026-09-' + String(24 + i), count: i }))
  const ticks = buildDailyTicks(week, 4)
  assert.equal(ticks.length, 4, '最多 maxTicks 个')
  assert.deepEqual(ticks.map(t => t.percent), [0, 33.3, 66.7, 100], '位置按索引均匀分布（与折线同一套归一化）')
  assert.deepEqual(ticks.map(t => t.label), ['09-24', '09-26', '09-28', '09-30'], '首尾必在、中间均分')
  assert.equal(new Set(ticks.map(t => t.date)).size, ticks.length, '不许出重复刻度')

  // 5 个点取 4 个刻度：last*i/(limit-1) 会出现 .33/.67 ⇒ 这一例能区分 round 与 floor
  const five = week.slice(0, 5)
  const fiveTicks = buildDailyTicks(five, 4)
  assert.deepEqual(fiveTicks.map(t => t.percent), [0, 25, 75, 100], '索引 4/3→1、8/3→3（round）；floor 会得到 2 ⇒ 这一例会红')
  assert.deepEqual(fiveTicks.map(t => t.label), ['09-24', '09-25', '09-27', '09-28'], '首尾必在、中间四舍五入')

  const two = buildDailyTicks(week.slice(0, 2), 4)
  assert.equal(two.length, 2, '点比 maxTicks 少时不做重复取样')
  assert.deepEqual(two.map(t => t.percent), [0, 100])
})

test('统计面板：横轴改成一排日期刻度（不是只有首尾两个字）', () => {
  assert.ok(panelTemplate.includes('class="touch-stats__tick"'), '要有刻度元素')
  assert.ok(panelTemplate.includes('v-for="tick in dailyTicks"'), '刻度由纯函数算出来')
  assert.ok(panelTemplate.includes('tick.percent'), '按百分比定位')
  assert.ok(panelTemplate.includes('{{ tick.label }}'), '显示 MM-DD')
  assert.equal(panelTemplate.includes('dailyFirstLabel'), false, '旧的「只有首尾两个标签」已移除')
  assert.ok(panelStyle.includes('.touch-stats__tick'), '刻度样式要在')
  assert.ok(panelStyle.includes('position: absolute'), '刻度绝对定位到百分比')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(panelStyle), false, '仍然不许出现硬编码 hex 颜色（双主题靠 token）')
})

