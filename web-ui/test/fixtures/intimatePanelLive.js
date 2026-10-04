/* 亲密看板 · live 端到端样例（非产品代码）
 *
 * 与 intimatePanel.js（stub 版）的分工：
 *   - intimatePanel.js    ：globalThis.fetch 打桩，离线断言组件结构 / 皮肤 / 窄屏；
 *   - 本文件              ：**完全不拦截 fetch**，组件自己的 api 真打到 vite 代理 → agent-core :3099，
 *                           断言「真实后端数据 → 真实组件渲染」这条用户实际路径。
 *
 * 前置条件（由 %TEMP% 里的临时脚本准备，绝不写 agent-core/data/agent.db）：
 *   1. agent-core 以 DB_PATH=<%TEMP% 临时库> 起在 :3099；
 *   2. 已用 REST 预置：角色 + PUT profile（身高/三围/备注/敏感带/injectEnabled=true）+ POST log 若干笔；
 *   3. vite dev server 已启动（/api 代理到 :3099）。
 *
 * 查询参数只承载「期望值」（由预置脚本从后端读出来再传进来），面板上的数据一律由组件自己拉。
 * 结果写进 #result，用 Chrome --headless=new --virtual-time-budget=… --dump-dom 抓取。
 */
import { createApp } from 'vue'

import IntimatePanel from '../../src/components/character/IntimatePanel.vue'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import '../../src/styles/components.css'

/* ── 运行参数（期望值） ─────────────────────────────────────────── */
const query = new URLSearchParams(location.search)
const characterId = Number(query.get('characterId')) || 0
const expectName = query.get('name') || ''
const expectHeight = query.get('height') || ''
const expectNote = query.get('note') || ''
const expectZoneCount = Number(query.get('zones')) || 0
const expectZoneLabels = (query.get('zoneLabels') || '').split('|').filter(Boolean)
const expectActCount = Number(query.get('acts')) || 0
const expectLogCount = Number(query.get('logs')) || 0
const expectTotalActs = Number(query.get('totalActs')) || 0
const expectTotalActsUserChar = Number(query.get('totalActsUserChar')) || 0
const expectTopPosition = query.get('topPosition') || ''
const expectTopAct = query.get('topAct') || ''
const expectFirstAct = query.get('firstAct') || ''
const expectFirstDate = query.get('firstDate') || ''
const theme = query.get('theme') === 'dark' ? 'dark' : 'warm'

document.documentElement.dataset.theme = theme

/* ── 真实请求记录（只记录，不改写响应：这不是 stub） ────────────── */
const apiCalls = []
const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url || String(input))
  apiCalls.push(`${(init?.method || 'GET').toUpperCase()} ${url}`)
  return realFetch(input, init)
}

/* ── 页面自身异常也要给结论，而不是永远停在 Running… ───────────── */
const jsErrors = []
function reportFatal(detail) {
  const node = document.getElementById('result')
  if (node) node.textContent = `FAIL: 样例自身异常，自检未完成\n${detail}`
}
window.addEventListener('error', event => {
  jsErrors.push(`error: ${event.message}`)
  reportFatal(`${event.message}\n${event.error?.stack || ''}`)
})
window.addEventListener('unhandledrejection', event => {
  jsErrors.push(`unhandledrejection: ${String(event.reason?.message || event.reason)}`)
  reportFatal(String(event.reason?.stack || event.reason))
})

/* ── 自检框架：逐项捕获失败，最后统一出 PASS / FAIL 清单 ─────────── */
const result = document.getElementById('result')
const CHECKS = []
let pendingChecks = []

const fail = (message, fields) => {
  const error = new Error(message)
  Object.assign(error, fields || {})
  throw error
}
const expect = (condition, message, fields) => { if (!condition) throw fail(message, fields) }
const dash = value => (value === undefined || value === null || value === '' ? '—' : String(value))
const text = node => (node?.textContent || '').trim()
const count = selector => board().querySelectorAll(selector).length

function check(label, run) { pendingChecks.push({ label, run }) }

async function runOne(label, run) {
  const entry = { label, ok: false, selector: '', expected: '', actual: '' }
  try {
    const outcome = (await run()) || {}
    Object.assign(entry, outcome)
    entry.ok = true
  } catch (error) {
    entry.error = error.message
    entry.selector = error.selector || ''
    entry.expected = error.expected || ''
    entry.actual = error.actual || ''
  }
  CHECKS.push(entry)
}

async function flushChecks() {
  while (pendingChecks.length) {
    const batch = pendingChecks
    pendingChecks = []
    for (const item of batch) await runOne(item.label, item.run)
  }
}

/* ── 轮询工具（真实网络请求期间 virtual time 会暂停，所以能等到） ── */
function until(predicate, timeoutMs = 10000, interval = 50) {
  return new Promise(resolve => {
    const started = Date.now()
    const tick = async () => {
      let ok
      try { ok = !!(await predicate()) } catch { ok = false }
      if (ok) return resolve(true)
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, interval)
    }
    tick()
  })
}

/* ── DOM 读取工具 ───────────────────────────────────────────────── */
const board = () => document.getElementById('panel-host')
const sectionByTitle = title => Array.from(board().querySelectorAll('.ip-sec'))
  .find(sec => text(sec.querySelector('.ip-sec-title')) === title) || null
const fieldControl = label => {
  const field = Array.from(board().querySelectorAll('.ip-field'))
    .find(el => text(el.querySelector('.ip-field-label')) === label)
  return field?.querySelector('input, textarea') || null
}
const firstRowByLabel = label => Array.from(board().querySelectorAll('.ip-first-row'))
  .find(row => text(row.querySelector('.ip-first-label')) === label) || null

/* ── 挂载真实组件（不做任何 fetch 打桩） ─────────────────────────── */
const character = { id: characterId, display_name: expectName }
createApp(IntimatePanel, { character }).mount('#panel-host')

// 等到「加载完成」的两种终态：出内容 或 出错误横幅
const settled = await until(() => board().querySelector('.ip-hero') || board().querySelector('.ip-banner-error'), 20000)
// 再等一轮更细的数据（流水列表要有行或空态），避免个别请求晚到导致误判骨架
await until(() => board().querySelector('.ip-log-row') || board().querySelector('.ip-log-list .ip-empty'), 8000)

const SECTION_TITLES = ['统计口径', '身体信息', '初次 / 破处信息', '基础统计', '部位敏感度', '体位排行', 'AI 修改权限', '让 AI 整理档案', '历史回填', '流水明细']

/* ── 自检项 ───────────────────────────────────────────────────── */
check('运行参数：本页拿到角色 id 与期望值', () => {
  expect(characterId > 0, '缺少 ?characterId=，页面无法挂载真实角色', { selector: 'location.search', expected: 'characterId>0', actual: location.search })
  expect(!!expectName, '缺少 ?name=', { selector: 'location.search', expected: 'name 非空', actual: location.search })
  return { selector: 'location.search', expected: 'characterId / name / height 均存在', actual: `id=${characterId} name=${expectName} height=${expectHeight}` }
})

check('面板加载完成：没有停在骨架态，也没有报错横幅', () => {
  expect(settled, '组件始终没有进入已加载状态（既无 .ip-hero 也无错误横幅）', { selector: '#panel-host', expected: '.ip-hero 出现', actual: board().innerHTML.slice(0, 200) })
  const banner = board().querySelector('.ip-banner-error')
  expect(!banner, '面板报了加载错误', { selector: '.ip-banner-error', expected: '无', actual: text(banner) })
  const skeletons = count('.skeleton')
  expect(skeletons === 0, '组件仍残留骨架屏（真实接口没回或数据形状不符）', { selector: '.skeleton', expected: '0 个', actual: `${skeletons} 个` })
  return { selector: '.ip / .skeleton', expected: '根节点存在且 0 个骨架', actual: `根节点=${!!board().querySelector('.ip')}，骨架=${skeletons}，区块=${count('.ip-sec')}` }
})

check('十个区块文案齐全（含 AI 整理档案）', () => {
  const titles = Array.from(board().querySelectorAll('.ip-sec-title')).map(el => text(el))
  const missing = SECTION_TITLES.filter(title => !titles.includes(title))
  expect(missing.length === 0, `缺少区块标题：${missing.join('、')}`, { selector: '.ip-sec-title', expected: SECTION_TITLES.join('、'), actual: titles.join('、') })
  return { selector: '.ip-sec-title', expected: `${SECTION_TITLES.length} 个标题`, actual: titles.join('、') }
})

check('知晓开关：渲染出真实角色名，且按后端 injectEnabled=true 处于开启态', () => {
  const label = text(board().querySelector('.ip-hero-label'))
  expect(label.includes(expectName), `知晓开关文案里没有真实角色名「${expectName}」`, { selector: '.ip-hero-label', expected: `包含「让 ${expectName} 知晓这些信息」`, actual: label })
  expect(!!board().querySelector('.ip-hero .ls-switch--on'), 'injectEnabled=true 但开关没有处于开启态', { selector: '.ip-hero .ls-switch', expected: '开启（.ls-switch--on）', actual: text(board().querySelector('.ip-hero')) })
  return { selector: '.ip-hero-label', expected: `让 ${expectName} 知晓这些信息 + 开关开启`, actual: label }
})

check('身体信息：后端预置的身高与备注真的渲染进输入框', () => {
  const heightInput = fieldControl('身高')
  expect(!!heightInput, '找不到身高输入框', { selector: '.ip-field 身高', expected: '存在 input', actual: board().querySelector('.ip-grid')?.innerHTML?.slice(0, 160) })
  expect(heightInput.value === expectHeight, '身高与后端预置值不一致', { selector: '.ip-field 身高 input', expected: expectHeight, actual: heightInput.value })
  const noteBox = board().querySelector('.ip-field-full textarea')
  expect(!!noteBox, '找不到备注文本域', { selector: '.ip-field-full textarea', expected: '存在', actual: '缺失' })
  expect(noteBox.value.includes(expectNote), '备注与后端预置值不一致', { selector: '.ip-field-full textarea', expected: `包含「${expectNote}」`, actual: noteBox.value })
  return { selector: '.ip-field 身高 input / 备注 textarea', expected: `身高=${expectHeight}；备注含「${expectNote}」`, actual: `身高=${heightInput.value}；备注=${noteBox.value}` }
})

check('部位敏感度：条数与后端预置的敏感带一致，名称逐条命中', () => {
  const zoneCount = count('.ip-zone')
  expect(zoneCount === expectZoneCount, '敏感带条数与后端不一致', { selector: '.ip-zone', expected: `${expectZoneCount} 条`, actual: `${zoneCount} 条` })
  const names = Array.from(board().querySelectorAll('input.ip-zone-name')).map(el => el.value.trim())
  const missing = expectZoneLabels.filter(label => !names.includes(label))
  expect(missing.length === 0, `敏感带缺少预置部位：${missing.join('、')}`, { selector: 'input.ip-zone-name', expected: expectZoneLabels.join('、'), actual: names.join('、') })
  const levels = Array.from(board().querySelectorAll('.ip-zone-level-text')).map(el => text(el))
  return { selector: 'input.ip-zone-name', expected: `${expectZoneCount} 条：${expectZoneLabels.join('、')}`, actual: `${zoneCount} 条：${names.join('、')}｜等级文案：${levels.join('、')}` }
})

check('初次/破处：人工里程碑的日期与「人工」标记渲染正确，行为行数来自真实词表', () => {
  const rows = count('.ip-first-row')
  expect(rows === expectActCount, '初次信息行数与后端词表行为数量不一致', { selector: '.ip-first-row', expected: `${expectActCount} 行`, actual: `${rows} 行` })
  const row = firstRowByLabel(expectFirstAct)
  expect(!!row, `词表里没有「${expectFirstAct}」这一行`, { selector: '.ip-first-label', expected: expectFirstAct, actual: Array.from(board().querySelectorAll('.ip-first-label')).map(el => text(el)).join('、') })
  const dateValue = row.querySelector('input.ip-first-date')?.value || ''
  expect(dateValue === expectFirstDate, '人工初次日期与后端预置值不一致', { selector: `初次行「${expectFirstAct}」input.ip-first-date`, expected: expectFirstDate, actual: dateValue })
  expect(!!row.querySelector('.ls-switch--on'), '该行有初次记录但开关是关的', { selector: `初次行「${expectFirstAct}」.ls-switch`, expected: '开启', actual: text(row) })
  expect(text(row.querySelector('.ip-tag')) === '人工', '人工里程碑没有「人工」标记', { selector: `初次行「${expectFirstAct}」.ip-tag`, expected: '人工', actual: text(row.querySelector('.ip-tag')) })
  return { selector: `.ip-first-row「${expectFirstAct}」`, expected: `日期 ${expectFirstDate} + 人工标记`, actual: `日期 ${dateValue} + ${text(row.querySelector('.ip-tag'))}` }
})

check('基础统计：总次数与后端聚合一致，行为 label 用后端给的', () => {
  const statSec = sectionByTitle('基础统计')
  expect(!!statSec, '找不到基础统计区块', { selector: '基础统计', expected: '存在', actual: '缺失' })
  const cells = Array.from(statSec.querySelectorAll('.ip-summary-cell'))
  const totalCell = cells.find(cell => text(cell.querySelector('.ip-summary-label')) === '总次数')
  expect(!!totalCell, '找不到「总次数」格子', { selector: '.ip-summary-label', expected: '总次数', actual: cells.map(cell => text(cell.querySelector('.ip-summary-label'))).join('、') })
  const total = Number(text(totalCell.querySelector('.ip-summary-value')))
  expect(total === expectTotalActs, '总次数与后端聚合不一致', { selector: '.ip-summary-value', expected: String(expectTotalActs), actual: String(total) })
  const actLabels = Array.from(statSec.querySelectorAll('.ip-stat-label')).map(el => text(el))
  expect(actLabels.length > 0, '基础统计没有按行为展开的条目', { selector: '.ip-stat-grid', expected: '≥1 条 byAct', actual: '0 条' })
  expect(actLabels.some(label => label.includes(expectTopAct)), `统计里没有后端给出的行为 label「${expectTopAct}」`, { selector: '.ip-stat-label', expected: `包含 ${expectTopAct}`, actual: actLabels.join('、') })
  return { selector: '.ip-summary-value / .ip-stat-label', expected: `总次数=${expectTotalActs}；含「${expectTopAct}」`, actual: `总次数=${total}；行为=${actLabels.join('、')}` }
})

check('体位排行：Top5 首位 label 与次数来自后端聚合，且次数降序', () => {
  const rows = Array.from(board().querySelectorAll('.ip-rank-row'))
  expect(rows.length > 0, '体位排行没有数据', { selector: '.ip-rank-row', expected: '≥1 行', actual: '0 行' })
  const first = text(rows[0].querySelector('.ip-rank-label'))
  expect(first === expectTopPosition, '排行首位与后端 byPosition 首位不一致', { selector: '.ip-rank-label', expected: expectTopPosition, actual: first })
  const counts = rows.map(row => Number(text(row.querySelector('.ip-rank-count'))))
  for (let i = 1; i < counts.length; i++) {
    expect(counts[i] <= counts[i - 1], `排行次数不是降序：${counts.join('>')}`, { selector: '.ip-rank-count', expected: '降序', actual: counts.join('、') })
  }
  return { selector: '.ip-rank-list', expected: `首位=${expectTopPosition}，次数降序`, actual: rows.map(row => `${text(row.querySelector('.ip-rank-no'))}.${text(row.querySelector('.ip-rank-label'))}=${text(row.querySelector('.ip-rank-count'))}`).join(' ') }
})

check('流水明细：条数与后端 counts.logs 一致，行为 label 渲染出来', () => {
  const logSec = sectionByTitle('流水明细')
  expect(!!logSec, '找不到流水明细区块', { selector: '流水明细', expected: '存在', actual: '缺失' })
  const hint = text(logSec.querySelector('.ip-sec-hint'))
  const hinted = Number((hint.match(/共\s*(\d+)\s*条/) || [])[1])
  expect(hinted === expectLogCount, '流水条数与后端 counts.logs 不一致', { selector: '流水明细 .ip-sec-hint', expected: `共 ${expectLogCount} 条`, actual: hint })
  const rowCount = logSec.querySelectorAll('.ip-log-row').length
  expect(rowCount > 0, '流水列表没有渲染出任何行', { selector: '.ip-log-row', expected: '≥1 行', actual: `${rowCount} 行` })
  const actTexts = Array.from(logSec.querySelectorAll('.ip-log-act')).map(el => text(el))
  expect(actTexts.some(label => label.includes(expectTopAct)), `流水里没有行为「${expectTopAct}」`, { selector: '.ip-log-act', expected: `包含 ${expectTopAct}`, actual: actTexts.join('、') })
  return { selector: '流水明细 .ip-sec-hint / .ip-log-act', expected: `共 ${expectLogCount} 条且含「${expectTopAct}」`, actual: `${hint}｜行数=${rowCount}｜${actTexts.slice(0, 4).join('、')}` }
})

check('AI 整理档案：入口可用、待确认提议为空态（后端未预置提议）', () => {
  const aiSec = sectionByTitle('让 AI 整理档案')
  expect(!!aiSec, '找不到 AI 整理档案区块', { selector: '让 AI 整理档案', expected: '存在', actual: '缺失' })
  const button = aiSec.querySelector('.ip-ai-btn')
  expect(!!button, '缺少「让 AI 根据最近的对话整理档案」按钮', { selector: '.ip-ai-btn', expected: '存在', actual: aiSec.innerHTML.slice(0, 160) })
  expect(!button.disabled, 'AI 整理按钮在初始状态就被禁用', { selector: '.ip-ai-btn', expected: '可用', actual: `disabled=${button.disabled}` })
  const emptyText = text(aiSec.querySelector('.ip-empty'))
  expect(emptyText === '没有待确认的提议', '待确认提议空态文案不对', { selector: '让 AI 整理档案 .ip-empty', expected: '没有待确认的提议', actual: dash(emptyText) })
  const aiTag = text(aiSec.querySelector('.ip-sug-head .ip-tag'))
  expect(aiTag !== '读取中…', '待确认提议还停在读取中（接口没回）', { selector: '.ip-sug-head .ip-tag', expected: '暂无 / N 条', actual: aiTag })
  return { selector: '.ip-ai-btn / .ip-ai-empty', expected: '按钮可用 + 空态文案', actual: `按钮可用，空态「${emptyText}」，标记「${aiTag}」` }
})

check('真实接口调用：组件确实打了后端（没有任何打桩）', () => {
  const base = `GET /api/characters/${characterId}/intimate`
  const wanted = [
    { label: '看板数据', ok: apiCalls.some(call => call === base) },
    { label: '行为/体位词表', ok: apiCalls.some(call => call === `${base}/vocabulary`) },
    { label: '流水明细', ok: apiCalls.some(call => call.startsWith(`${base}/log?`)) },
    { label: '待确认提议', ok: apiCalls.some(call => call === `${base}/ai-edit/suggestions`) },
  ]
  const missing = wanted.filter(item => !item.ok).map(item => item.label)
  expect(missing.length === 0, `组件没有调用这些接口：${missing.join('、')}`, { selector: 'window.fetch', expected: wanted.map(item => item.label).join('、'), actual: apiCalls.join('、') || '没有任何请求' })
  return { selector: 'window.fetch', expected: '4 类接口各至少 1 次', actual: apiCalls.join('、') }
})

/* 冻结过渡/动画后再读色值：面板、body 都带 0.3s 过渡，直接读会拿到过渡起点，
   而且切换 data-theme 后必须强制一次 reflow，否则可能读到切换前的计算值。 */
function frozen(run) {
  const freeze = document.createElement('style')
  freeze.textContent = '*, *::before { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; }'
  document.head.appendChild(freeze)
  try {
    for (const animation of document.getAnimations?.() || []) animation.cancel()
    void document.body.offsetWidth
    return run()
  } finally {
    freeze.remove()
    void document.body.offsetWidth
  }
}

function measureTheme(value) {
  return frozen(() => {
    document.documentElement.dataset.theme = value
    void document.body.offsetWidth
    const rootStyles = getComputedStyle(document.documentElement)
    return {
      bg: rootStyles.getPropertyValue('--bg-primary').trim(),
      secondary: rootStyles.getPropertyValue('--bg-secondary').trim(),
      accent: rootStyles.getPropertyValue('--accent').trim(),
      text: rootStyles.getPropertyValue('--text-primary').trim(),
      sectionColor: getComputedStyle(board().querySelector('.ip-sec')).backgroundColor,
      heroColor: getComputedStyle(board().querySelector('.ip-hero')).backgroundColor,
      bodyColor: getComputedStyle(document.body).backgroundColor,
    }
  })
}

check('双主题：页面按 ?theme 生效，且暖色与暗夜的 token / 面板底色确实不同', () => {
  const warm = measureTheme('warm')
  const dark = measureTheme('dark')
  const current = measureTheme(theme) // 量完两套后回到本页运行主题
  const palette = theme === 'dark' ? dark : warm
  expect(document.documentElement.dataset.theme === theme, '页面主题与 ?theme 不一致', { selector: 'html[data-theme]', expected: theme, actual: document.documentElement.dataset.theme })
  expect(!!warm.bg && !!dark.bg, 'tokens.css 没有提供 --bg-primary', { selector: ':root / [data-theme=dark]', expected: '两套 --bg-primary', actual: `warm=${dash(warm.bg)} dark=${dash(dark.bg)}` })
  expect(warm.bg !== dark.bg && warm.accent !== dark.accent, '暖色与暗夜的关键 token 取值相同，双主题不成立', { selector: ':root / [data-theme=dark]', expected: '--bg-primary / --accent 两套不同', actual: `warm=${warm.bg},${warm.accent}；dark=${dark.bg},${dark.accent}` })
  expect(warm.sectionColor !== dark.sectionColor, '面板区块底色在两套主题下相同（组件没有跟随主题）', { selector: '.ip-sec background-color', expected: 'warm ≠ dark', actual: `warm=${warm.sectionColor} dark=${dark.sectionColor}` })
  expect(warm.heroColor !== dark.heroColor, '知晓开关区块底色在两套主题下相同（组件没有跟随主题）', { selector: '.ip-hero background-color', expected: 'warm ≠ dark', actual: `warm=${warm.heroColor} dark=${dark.heroColor}` })
  expect(current.sectionColor === palette.sectionColor, `面板区块底色没有跟随 ${theme} 主题`, { selector: '.ip-sec background-color', expected: `${palette.sectionColor}（${theme}）`, actual: `${current.sectionColor}（本页主题 ${theme}）` })
  return {
    selector: 'html[data-theme] / .ip-sec / .ip-hero',
    expected: `${theme}；warm≠dark（--bg-primary / --accent / 区块底色）`,
    actual: `theme=${theme}；--bg-primary warm=${warm.bg} / dark=${dark.bg}；--bg-secondary warm=${warm.secondary} / dark=${dark.secondary}；.ip-sec warm=${warm.sectionColor} / dark=${dark.sectionColor}；.ip-hero warm=${warm.heroColor} / dark=${dark.heroColor}`,
  }
})

check('无 JS 报错：window.onerror / unhandledrejection 都是空的', () => {
  expect(jsErrors.length === 0, `页面出现 ${jsErrors.length} 条 JS 报错`, { selector: 'window.onerror / unhandledrejection', expected: '0 条', actual: jsErrors.join(' || ') })
  return { selector: 'window.onerror / unhandledrejection', expected: '0 条', actual: '0 条' }
})

// 口径切换（真实写 + 真实聚合 + 重新渲染）放在只读断言之后
check('统计口径切换（写路径）：取消「小镇NPC」→ PUT settings → 面板总次数按新口径掉数', () => {
  const scopeSec = sectionByTitle('统计口径')
  expect(!!scopeSec, '找不到统计口径区块', { selector: '统计口径', expected: '存在', actual: '缺失' })
  const chip = Array.from(scopeSec.querySelectorAll('button')).find(node => text(node) === '小镇NPC')
  expect(!!chip, '找不到「小镇NPC」口径 chip', { selector: '统计口径 button', expected: '小镇NPC', actual: Array.from(scopeSec.querySelectorAll('button')).map(node => text(node)).join('、') })
  expect(expectTotalActsUserChar > 0 && expectTotalActsUserChar < expectTotalActs, '样例缺少口径掉数的期望值', { selector: 'location.search', expected: `totalActsUserChar < ${expectTotalActs}`, actual: String(expectTotalActsUserChar) })
  chip.click()
  return until(() => apiCalls.some(call => call === `PUT /api/characters/${characterId}/intimate/settings`), 8000)
    .then(wrote => {
      expect(wrote, '点击口径后没有写回后端设置（PUT settings 未发出）', { selector: 'window.fetch', expected: `PUT /api/characters/${characterId}/intimate/settings`, actual: apiCalls.join('、') })
      return until(async () => {
        const res = await realFetch(`/api/characters/${characterId}/intimate`)
        const data = await res.json()
        const totalCell = sectionByTitle('基础统计')?.querySelector('.ip-summary-cell .ip-summary-value')
        return Number(text(totalCell)) === Number(data.stats?.totalActs) && Number(data.stats?.totalActs) === expectTotalActsUserChar
      }, 10000)
    })
    .then(settledScope => {
      const totalCell = sectionByTitle('基础统计')?.querySelector('.ip-summary-cell .ip-summary-value')
      expect(settledScope, '关掉 npc 口径后面板总次数没有按新口径刷新', { selector: '基础统计 .ip-summary-value', expected: `总次数=${expectTotalActsUserChar}（user+character）`, actual: `面板=${text(totalCell)}` })
      return { selector: '统计口径 chip → PUT settings → 基础统计', expected: `总次数从 ${expectTotalActs} 掉到 ${expectTotalActsUserChar}`, actual: `已按新口径刷新为 ${text(totalCell)}` }
    })
})

// 写路径放最后：它会改掉腰围，避免影响上面的只读断言。
// 标记按主题区分：两次 Chrome 共用同一个后端库，用同一个值会让「是否落库」瞬间为真，
// 从而在防抖 PUT 发出之前就通过断言（假绿灯）。
check('编辑落库（写路径）：改腰围 → 400ms 防抖 PUT → 后端真的存上了', () => {
  const waistInput = fieldControl('腰围')
  expect(!!waistInput, '找不到腰围输入框', { selector: '.ip-field 腰围 input', expected: '存在', actual: '缺失' })
  const marker = `LIVE-WAIST-${theme === 'dark' ? 'DARK' : 'WARM'}`
  waistInput.value = marker
  waistInput.dispatchEvent(new Event('input', { bubbles: true }))
  return until(async () => {
    const res = await realFetch(`/api/characters/${characterId}/intimate`)
    const data = await res.json()
    return data?.profile?.waist === marker
  }, 10000).then(persisted => {
    const putSeen = apiCalls.some(call => call === `PUT /api/characters/${characterId}/intimate/profile`)
    expect(persisted, '面板里改的腰围没有落到后端（防抖保存链路断了）', { selector: 'PUT /intimate/profile', expected: `后端 profile.waist = ${marker}`, actual: `PUT 调用=${putSeen}，后端未反映该值` })
    expect(putSeen, '没有观察到 PUT profile 请求', { selector: 'window.fetch', expected: `PUT /api/characters/${characterId}/intimate/profile`, actual: apiCalls.join('、') })
    return { selector: '.ip-field 腰围 input → PUT /intimate/profile', expected: `后端 profile.waist = ${marker}`, actual: `已持久化，PUT 请求已发出` }
  })
})

await flushChecks()

/* ── 报告 ───────────────────────────────────────────────────────── */
function renderReport() {
  const failed = CHECKS.filter(item => !item.ok)
  const head = `${failed.length ? 'FAIL' : 'PASS'} ${CHECKS.length - failed.length}/${CHECKS.length}`
  const lines = CHECKS.map(item => {
    const detail = item.ok
      ? ` | ${dash(item.selector)} | 期望 ${dash(item.expected)} | 实测 ${dash(item.actual)}`
      : `\n        失败项定位 selector=${dash(item.selector)}\n        期望：${dash(item.expected)}\n        实测：${dash(item.actual)}\n        原因：${dash(item.error)}`
    return `[${item.ok ? 'PASS' : 'FAIL'}] ${item.label}${detail}`
  })
  document.title = `亲密看板 live · ${head}`
  result.textContent = `主题：${theme}｜角色 id=${characterId}（${expectName}）\n${head}\n${lines.join('\n')}\n\n${JSON.stringify(CHECKS, null, 2)}`
}

renderReport()
