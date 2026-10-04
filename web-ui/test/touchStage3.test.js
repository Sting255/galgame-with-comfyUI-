/**
 * SLG 动作系统 · 阶段三前端：统计面板 + 出图档位 + 立绘表情联动
 *
 * Lead 2026-09-30 裁决：
 *   · 出图档位键 features.touchImageMode ∈ always|smart|never（默认 smart），走通用 PUT /api/config/features；
 *   · 立绘表情由**后端**加钩子（前端没有改立绘表情的入口），前端不写表情代码；
 *   · 统计面板挂角色详情弹窗（CharacterDetailModal.vue），端点未落地前先空态 + 标注。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { reactive } from 'vue'

import {
  DEFAULT_TOUCH_IMAGE_MODE,
  TOUCH_IMAGE_MODES,
  TOUCH_IMAGE_MODE_KEY,
  normalizeTouchImageMode,
  touchImageModeLabel,
} from '../src/components/touchActionLogic.js'
import {
  annoyanceTierOf,
  formatLastSeen,
  likeTierOf,
  normalizeTouchStats,
} from '../src/components/touchStatsLogic.js'

const settingsFile = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const settings = parseSfc(settingsFile).descriptor
const settingsScript = settings.scriptSetup.content
const settingsTemplate = settings.template.content
const settingsNodes = parseJs(settingsScript, { sourceType: 'module' }).program.body

const panelFile = readFileSync(new URL('../src/components/TouchStatsPanel.vue', import.meta.url), 'utf8')
const panel = parseSfc(panelFile).descriptor
const panelTemplate = panel.template.content
const panelScript = panel.scriptSetup.content

const detailFile = readFileSync(new URL('../src/components/CharacterDetailModal.vue', import.meta.url), 'utf8')
const chatScript = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content

function fnSource(nodes, name) {
  const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
  return node ? settingsScript.slice(node.start, node.end) : ''
}

// ── 1. 出图档位：常量与归一化 ──

test('出图档位：三档 always/smart/never，文案 总是/智能/从不，默认 smart', () => {
  assert.equal(TOUCH_IMAGE_MODE_KEY, 'touchImageMode')
  assert.equal(DEFAULT_TOUCH_IMAGE_MODE, 'smart')
  assert.deepEqual(TOUCH_IMAGE_MODES.map(mode => mode.value), ['always', 'smart', 'never'])
  assert.deepEqual(TOUCH_IMAGE_MODES.map(mode => mode.label), ['总是', '智能', '从不'])
})

test('出图档位：非法值一律回落 smart（与后端同口径）', () => {
  for (const bad of [undefined, null, '', 'SMART', 'force', 'off', 0, {}, []]) {
    assert.equal(normalizeTouchImageMode(bad), 'smart', String(bad) + ' 应回落 smart')
  }
  assert.equal(normalizeTouchImageMode('always'), 'always')
  assert.equal(normalizeTouchImageMode('never'), 'never')
  assert.equal(touchImageModeLabel('always'), '总是')
  assert.equal(touchImageModeLabel('never'), '从不')
  assert.equal(touchImageModeLabel('nonsense'), '智能')
})

// ── 2. 出图档位：设置页接线 ──

test('设置页用 LinsheTabs 做三档（不自造分段控件），选项与常量同源', () => {
  assert.ok(settingsTemplate.includes('<linshe-tabs'), '必须用 LinsheTabs')
  assert.ok(settingsTemplate.includes(':options="TOUCH_IMAGE_MODES"'), '选项直接吃常量表')
  assert.ok(settingsTemplate.includes('normalizeTouchImageMode(features.touchImageMode)'), '展示值要归一化')
  assert.ok(settingsTemplate.includes('@update:model-value="saveTouchImageMode"'))
  assert.doesNotMatch(settingsTemplate, /role="tablist"/, '不许自造分段控件')
  assert.ok(settingsScript.includes('touchImageMode: DEFAULT_TOUCH_IMAGE_MODE'), 'features 初值同源')
  assert.ok(settingsScript.includes('updateFeatureFlag(TOUCH_IMAGE_MODE_KEY, next)'), '走通用 features PUT')
})

test('出图档位保存：成功 toast、失败回滚上一档、同档不重复 PUT', async () => {
  const src = fnSource(settingsNodes, 'saveTouchImageMode')
  assert.ok(src, 'saveTouchImageMode 应存在')

  function build(impl, initial) {
    const toasts = []
    const puts = []
    const state = {
      features: reactive({ touchImageMode: initial }),
      updateFeatureFlag: (key, value) => { puts.push([key, value]); return impl() },
      toastFn: (msg, type) => toasts.push({ msg, type }),
      TOUCH_IMAGE_MODE_KEY,
      normalizeTouchImageMode,
      touchImageModeLabel,
    }
    const run = new Function('state', 'with (state) { ' + src + ' return saveTouchImageMode }')(state)
    return { run, state, toasts, puts }
  }

  const ok = build(() => Promise.resolve({}), 'smart')
  await ok.run('always')
  assert.deepEqual(ok.puts, [['touchImageMode', 'always']])
  assert.equal(ok.state.features.touchImageMode, 'always')
  assert.equal(ok.toasts[0].type, 'success')
  assert.ok(ok.toasts[0].msg.includes('总是'))

  const bad = build(() => Promise.reject(new Error('后端炸了')), 'smart')
  await bad.run('never')
  assert.equal(bad.state.features.touchImageMode, 'smart', '失败必须回滚到上一档')
  assert.equal(bad.toasts[0].type, 'error')
  assert.ok(bad.toasts[0].msg.includes('后端炸了'))

  const same = build(() => Promise.resolve({}), 'always')
  await same.run('always')
  assert.equal(same.puts.length, 0, '同档不该发请求')

  // 非法值先归一到 smart；因为和当前档（never）不同，所以应当发一次 smart
  const illegal = build(() => Promise.resolve({}), 'never')
  await illegal.run('nonsense')
  assert.deepEqual(illegal.puts, [['touchImageMode', 'smart']], '非法值归一成 smart 后再 PUT')
  assert.equal(illegal.state.features.touchImageMode, 'smart')
})

// ── 3. 统计：归一化与档位文案 ──

test('统计：空 / 坏响应 → 无数据、全零（面板走空态，不伪造数字）', () => {
  for (const bad of [null, undefined, {}, { actions: [] }, 'nope']) {
    const stats = normalizeTouchStats(bad)
    assert.equal(stats.hasData, false)
    assert.equal(stats.total, 0)
    assert.deepEqual(stats.rows, [])
    assert.deepEqual(stats.levels.map(level => level.count), [0, 0, 0, 0], '§十 后共四级（Lv1~Lv4）')
    assert.equal(stats.peakAnnoyance, 0)
  }
})

test('统计：吃真实形状（totals/byAction/byLevel）→ 总数 / 等级分布 / 降序 / 档位文案', () => {
  const stats = normalizeTouchStats({
    totals: { events: 12, peakAnnoyance: 85, images: 4, intimateActs: 2 },
    byAction: [
      { actionKey: 'hug', label: '抱抱', level: 2, count: 3, currentAnnoyance: 20, likeRatio: 1.4 },
      { actionKey: 'pat_head', label: '摸头', level: 1, count: 7, currentAnnoyance: 85, likeRatio: 0.5 },
      { actionKey: 'touch_breast', label: '摸胸', level: 3, count: 2, currentAnnoyance: 55, likeRatio: 1.0 },
    ],
    byLevel: [{ level: 1, label: '日常', count: 7 }, { level: 3, label: '敏感', count: 2 }],
    recent: [{ createdAt: '2026-09-30 10:00:00' }],
  })
  assert.equal(stats.hasData, true)
  assert.equal(stats.total, 12)
  assert.deepEqual(stats.rows.map(row => row.key), ['pat_head', 'hug', 'touch_breast'], '按次数降序')
  assert.deepEqual(stats.rows.map(row => row.label), ['摸头', '抱抱', '摸胸'], '中文名从动作表补全')
  assert.deepEqual(stats.levels.map(level => [level.label, level.count]), [['日常', 7], ['敏感', 2]], '优先用服务端 byLevel')
  // 档位文案而不是原始数值
  assert.equal(stats.rows[0].likeTier, '有点腻了')
  assert.equal(stats.rows[0].annoyanceTier, '有点腻了')
  assert.equal(stats.rows[1].likeTier, '很喜欢')
  assert.equal(stats.rows[2].annoyanceTier, '有点烦了')
  assert.equal(stats.peakAnnoyance, 85)
  assert.equal(stats.images, 4, '出图数来自 totals.images')
  assert.equal(stats.intimateActs, 2)
  assert.equal(stats.lastAt, '2026-09-30 10:00:00', '最近一次来自 recent[0].createdAt')
})

test('统计：宽容形状（byAction 是数组、或 stats 映射表 / uses / like_ratio / updated_at 都认）', () => {
  const stats = normalizeTouchStats({
    stats: {
      pat_head: { uses: 4, like_ratio: 1.3, maxAnnoyance: 12, updated_at: '2026-09-30 09:00:00' },
      hug: { count: 1 },
    },
  })
  assert.equal(stats.total, 5, 'total 缺失时按各项求和')
  assert.equal(stats.rows[0].key, 'pat_head')
  assert.equal(stats.rows[0].count, 4)
  assert.equal(stats.rows[0].likeTier, '很喜欢')
  assert.equal(stats.lastAt, '2026-09-30 09:00:00', 'updated_at 参与最近一次')
  // byAction 是数组时，绝不能被当成对象按下标遍历（第一版就踩了这个）
  const arr = normalizeTouchStats({ byAction: [{ actionKey: 'hug', count: 2 }] })
  assert.deepEqual(arr.rows.map(row => row.key), ['hug'])
  assert.equal(arr.total, 2)
})

test('偏好 / 腻烦档位阈值（专题 §3.3 不暴露原始数值；§2.3 阈值 50/80）', () => {
  assert.equal(likeTierOf(1.5), '很喜欢')
  assert.equal(likeTierOf(1.15), '很喜欢')
  assert.equal(likeTierOf(1), '一般')
  assert.equal(likeTierOf(0.85), '有点腻了')
  assert.equal(likeTierOf(undefined), '一般')
  assert.equal(annoyanceTierOf(0), '还好')
  assert.equal(annoyanceTierOf(49), '还好')
  assert.equal(annoyanceTierOf(50), '有点烦了')
  assert.equal(annoyanceTierOf(80), '有点腻了')
  assert.equal(annoyanceTierOf(undefined), '还好')
})

test('最近一次按 UTC 解析（走 parseBackendTime 收口，不许差 8 小时）', () => {
  const now = Date.parse('2026-09-30T10:05:00Z')
  assert.equal(formatLastSeen('2026-09-30 10:00:00', now), '5 分钟前')
  assert.equal(formatLastSeen('2026-09-30T09:00:00Z', now), '1 小时前')
  assert.equal(formatLastSeen('2026-09-30', now), '10 小时前')
  assert.equal(formatLastSeen('', now), '')
  assert.equal(formatLastSeen(null, now), '')
  assert.equal(formatLastSeen('不是时间', now), '')
})

// ── 4. 统计面板：模板与视觉 ──

test('统计面板：空态 / 加载态齐备，且已挂进角色详情弹窗', () => {
  const compiled = compileTemplate({ source: panelTemplate, filename: 'TouchStatsPanel.vue', id: 'touch-stats-panel' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(panelTemplate.includes('还没有触摸互动记录'), '要有中性空态')
  assert.ok(panelTemplate.includes('读取中'), '要有加载态')
  assert.ok(panelTemplate.includes('v-if="stats.hasData"'))
  assert.ok(detailFile.includes("import TouchStatsPanel from './TouchStatsPanel.vue'"))
  assert.ok(detailFile.includes('<TouchStatsPanel :character="character" />'), '挂在角色详情弹窗')
  assert.ok(detailFile.includes('触摸互动'), '小节标题')
})

test('统计面板：无裸 button、0.3s 过渡、双主题 token、移动端断点、不硬编码颜色', () => {
  assert.doesNotMatch(panelTemplate, /<button/, '禁止裸 button')
  const style = panelFile.slice(panelFile.indexOf('<style'))
  assert.ok(style.includes('transition: opacity 0.3s ease'), '0.3s 过渡（AGENTS.md）')
  assert.ok(style.includes('@media (max-width: 767px)'), '移动端断点')
  for (const token of ['var(--bg-sunken)', 'var(--text-bright)', 'var(--text-secondary)', 'var(--tint-subtle)', 'var(--accent)']) {
    assert.ok(style.includes(token), '要用 token：' + token)
  }
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(style), false, '样式里不该出现硬编码 hex 颜色（双主题靠 token）')
})

// ── 5. 立绘表情：前端不写代码，渲染归服务端既有通道 ──

test('立绘表情：前端没有改立绘表情的入口，触摸链路也不碰立绘', () => {
  const apiFile = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
  // 前端只有这两个立绘接口（服务端独占表情，见 agent-core/src/services/standingDisplay.js 的 publishStandingKeys）
  assert.ok(apiFile.includes("request('/standing-display/state')"))
  assert.ok(apiFile.includes("request('/standing-display/active'"))
  assert.equal(apiFile.includes('standing-display/expression'), false, '前端没有设表情的接口')

  // 触摸回调不自己动立绘（渲染由既有立绘通道负责）
  const actionSrc = chatScript.slice(chatScript.indexOf('async function onTouchAction'), chatScript.indexOf('async function onTouchAction') + 1200)
  assert.equal(actionSrc.includes('standing'), false, 'onTouchAction 不该碰立绘')
  assert.equal(actionSrc.includes('messages'), false, '也不该自己插消息')
})


test('统计形状与后端一致（task-19）：byAction / byLevel / totals.events + 出图数', (t) => {
  let src
  try {
    src = readFileSync(new URL('../../agent-core/src/services/touchStatsService.js', import.meta.url), 'utf8')
  } catch {
    return t.skip('后端源码不可读（独立检出？）')
  }
  // 注意：export function 在 AST 里是 ExportNamedDeclaration 包着 FunctionDeclaration
  const ast = parseJs(src, { sourceType: 'module' }).program.body
    .map(node => (node.type === 'ExportNamedDeclaration' && node.declaration) ? node.declaration : node)
  const fn = ast.find(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'getTouchStats')
  assert.ok(fn, '要能找到 getTouchStats')
  const ret = fn.body.body.find(s => s.type === 'ReturnStatement')
  assert.ok(ret, 'getTouchStats 要有 return')
  const keys = ret.argument.properties.map(p => p.key.name || p.key.value)
  for (const k of ['totals', 'byAction', 'byLevel', 'recent']) {
    assert.ok(keys.includes(k), 'stats 顶层要有 ' + k)
  }
  // totals 字面量里要有 events / peakAnnoyance；images / intimateActs 是后面赋值上去的
  const totalsDecl = fn.body.body.find(s => s.type === 'VariableDeclaration'
    && s.declarations.some(d => d.id.name === 'totals'))
  assert.ok(totalsDecl, '要有 totals 变量')
  const totalsKeys = totalsDecl.declarations[0].init.properties.map(p => p.key.name || p.key.value)
  for (const k of ['events', 'peakAnnoyance']) {
    assert.ok(totalsKeys.includes(k), 'totals 要有 ' + k)
  }
  assert.ok(src.includes('totals.images = images'), 'totals.images 要赋值（面板显示出图数）')
  assert.ok(src.includes('totals.intimateActs = intimateActs'))
  // 路由在位
  const routeSrc = readFileSync(new URL('../../agent-core/src/routes/touch.js', import.meta.url), 'utf8')
  assert.ok(routeSrc.includes("router.get('/:id/touch/stats'"), '统计路由要在位')
});

test('立绘表情：后端钩子断言（钩子落地前明确 skip，不假装通过）', (t) => {
  let src
  try {
    src = readFileSync(new URL('../../agent-core/src/routes/touch.js', import.meta.url), 'utf8')
  } catch {
    return t.skip('后端源码不可读（独立检出？）')
  }
  if (!src.includes('publishStandingKeys')) {
    return t.skip('后端立绘钩子尚未落地（Lead 裁决 (A)：由后端补；落地后本测试应转绿）')
  }
  // 复用既有通道（不新造）：与 chat.js 同一套 getStandingDisplay + publishStandingKeys
  assert.ok(src.includes("import { getStandingDisplay, publishStandingKeys } from '../services/standingDisplay.js'"), '复用既有立绘通道')
  assert.ok(src.includes('function driveStandingExpression(characterId, facialExpression)'), '按 facial_expression 驱动')
  assert.ok(src.includes('publishStandingKeys(turn, [hit])'), '实际调用既有发布函数')
  // 安全回退：没表情直接跳过；匹配不到也不报错（不猜、不炸）
  assert.ok(src.includes('if (!label) return null'), '空表情要安全跳过')
  assert.ok(src.includes('const hit') && src.includes('return null'), '匹配不到要回落 null')
})
