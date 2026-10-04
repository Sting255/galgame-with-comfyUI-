// 浏览器回归样例：通过 Vite 打开 /test/fixtures/intimatePanel.html。
// 直接挂载真实 IntimatePanel.vue（Vite dev server 即时编译 SFC，与 whiteGaps.js 同一套做法），
// 后端用 globalThis.fetch 打桩（离线可跑，绝不连 3099）；
// 自检组件漂移、暖色·暗夜双主题的 token 溯源、360px 真实视口单列，页面显示 PASS / FAIL 清单。
import { createApp } from 'vue'
import IntimatePanel from '../../src/components/character/IntimatePanel.vue'
import { ZONE_MAX_LEVEL, zoneLevelLabel } from '../../src/components/character/intimateLogic.js'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import '../../src/styles/components.css'

/* 样例自身出异常时也要给出可读结论，而不是永远停在 Running… */
function reportFatal(detail) {
  const node = document.getElementById('result')
  if (node) node.textContent = `FAIL: 样例自身异常，自检未完成\n${detail}`
}
window.addEventListener('error', event => reportFatal(`${event.message}\n${event.error?.stack || ''}`))
window.addEventListener('unhandledrejection', event => reportFatal(String(event.reason?.stack || event.reason)))

/* ── 合成数据 + 后端打桩 ───────────────────────────────────────── */
const CHARACTER_ID = 424202
const CHARACTER = { id: CHARACTER_ID, display_name: '林晚' }

/** 词表：面板的初次行、统计 label、流水 label 都由它兜底 */
const VOCABULARY = {
  acts: [
    { key: 'vaginal', label: '性交' },
    { key: 'oral', label: '口交' },
    { key: 'hand', label: '手交' },
    { key: 'caress', label: '爱抚' },
    { key: 'anal', label: '肛交' },
  ],
  positions: [
    { key: 'missionary', label: '正常位', group: '面对面' },
    { key: 'doggy', label: '后背位', group: '背后' },
    { key: 'cowgirl', label: '骑乘位', group: '上位' },
    { key: 'spoon', label: '侧卧位', group: '侧躺' },
    { key: 'standing', label: '站立位', group: '站立' },
    { key: 'sitting', label: '对坐位', group: '坐姿' },
  ],
}

/** 看板数据：形状与后端 GET /api/characters/:id/intimate 契约一致 */
const PANEL = {
  characterId: CHARACTER_ID,
  profile: {
    height: '162 cm', bust: '86 cm', waist: '58 cm', hip: '88 cm', cup: 'C',
    note: '肩颈怕冷；耳后与腰侧最敏感。',
    injectEnabled: true,
    aiEditFields: ['stats'], viewScope: ['user'], backfillEnabled: true,
    // 六档全给（0~5），用来验证色带宽度随 level 单调；面板会按等级降序排列
    sensitiveZones: [
      { key: 'thigh', label: '大腿内侧', level: 5 },
      { key: 'neck', label: '脖颈', level: 4 },
      { key: 'ear', label: '耳后', level: 3 },
      { key: 'waist', label: '腰侧', level: 2 },
      { key: 'sole', label: '足心', level: 1 },
      { key: 'finger', label: '指尖', level: 0 },
    ],
  },
  // 两笔已落库里程碑：一笔人工、一笔自动派生；其余行为由面板渲染成「无记录」
  firsts: [
    { actKey: 'vaginal', label: '性交', firstAt: '2026-03-14', source: 'manual' },
    { actKey: 'oral', label: '口交', firstAt: '2026-05-02', source: 'derived' },
  ],
  stats: {
    totalActs: 42, totalClimax: 18, actKinds: 4,
    firstAt: '2026-03-14T00:00:00', lastAt: '2026-09-20T22:10:00',
    partnerKinds: ['user'],
    byAct: [
      { actKey: 'vaginal', label: '性交', count: 24, climax: 12 },
      { actKey: 'oral', label: '口交', count: 9, climax: 4 },
      { actKey: 'hand', label: '手交', count: 5, climax: 1 },
      { actKey: 'caress', label: '爱抚', count: 4, climax: 0 },
    ],
    // 末项 0 次：排行应过滤掉，只显示前 5
    byPosition: [
      { positionKey: 'missionary', label: '正常位', count: 18 },
      { positionKey: 'doggy', label: '后背位', count: 11 },
      { positionKey: 'cowgirl', label: '骑乘位', count: 7 },
      { positionKey: 'spoon', label: '侧卧位', count: 4 },
      { positionKey: 'standing', label: '站立位', count: 2 },
      { positionKey: 'sitting', label: '对坐位', count: 0 },
    ],
    byScene: [],
  },
  counts: { logs: 3 },
  // status=done：避免挂载后自动触发一次回填（样例不写库）
  backfill: { status: 'done', scanned: 12, inserted: 3, lastRawId: 42 },
}

const LOGS = [
  { id: 9001, actKey: 'vaginal', positionKey: 'missionary', actCount: 2, climaxCount: 1, occurredAt: '2026-09-20T22:10:00', source: 'auto', partnerKind: 'user' },
  { id: 9002, actKey: 'oral', positionKey: '', actCount: 1, climaxCount: 1, occurredAt: '2026-09-12T23:40:00', source: 'manual', partnerKind: 'user' },
  { id: 9003, actKey: 'hand', positionKey: '', actCount: 3, climaxCount: 0, occurredAt: '2026-08-30T21:05:00', source: 'auto', partnerKind: 'user' },
]

const INTIMATE_PATH = `/api/characters/${CHARACTER_ID}/intimate`
/** 打桩路由：只回样例需要的形状；样例不写库，其余接口一律空对象 */
function stubFor(path, method) {
  if (path === INTIMATE_PATH) return PANEL
  if (path === `${INTIMATE_PATH}/vocabulary`) return VOCABULARY
  if (path === `${INTIMATE_PATH}/log`) return method === 'POST' ? { log: LOGS[0] } : { logs: LOGS, total: LOGS.length }
  if (path === `${INTIMATE_PATH}/ai-edit/suggestions`) return { suggestions: [] }
  if (path === `${INTIMATE_PATH}/backfill`) return PANEL.backfill
  return {}
}

/** 记录被打桩的请求：既证明「打桩路径被真实调用」，也能抓到前端换了接口路径 */
const stubbedCalls = []
globalThis.fetch = async (url, options = {}) => {
  const path = String(url).split('?')[0].replace(/^[a-z]+:\/\/[^/]+/i, '')
  const method = String(options.method || 'GET').toUpperCase()
  stubbedCalls.push(`${method} ${path}`)
  return { ok: true, status: 200, json: async () => stubFor(path, method) }
}

/* ── 自检框架：逐项记录，不中断，最后给出 PASS / FAIL 清单 ───────── */
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

/** 登记一项自检（真正执行在 flushChecks，便于逐项捕获失败而不中断整页） */
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

/* ── 样式 / token 工具 ─────────────────────────────────────────── */
const setTheme = value => { document.documentElement.dataset.theme = value }
const styleOf = (element, property, pseudo) => getComputedStyle(element, pseudo || undefined).getPropertyValue(property).trim()
const sizeOf = (element, pseudo) => `${parseFloat(getComputedStyle(element, pseudo || undefined).width).toFixed(1)}×${parseFloat(getComputedStyle(element, pseudo || undefined).height).toFixed(1)}`
const matrixTx = transform => {
  const matched = /matrix\(([^)]+)\)/.exec(transform)
  return matched ? Number(matched[1].split(',')[4]) : NaN
}
const trackCount = element => styleOf(element, 'grid-template-columns').split(/\s+/).filter(Boolean).length

/** 冻结所有过渡/动画后执行：读出的是最终色 / 最终几何，而不是动画中间值。
 *  面板、开关、body 都带 0.3s 过渡，直接读会拿到过渡起点，断言就不确定了。 */
function frozen(run) {
  const freeze = document.createElement('style')
  freeze.textContent = '*, *::before { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; }'
  document.head.appendChild(freeze)
  try {
    // 冻结前仍在跑的过渡不会被新时长影响，先取消掉，让属性立刻落到目标值
    for (const animation of document.getAnimations?.() || []) animation.cancel()
    void document.body.offsetWidth
    return run()
  } finally {
    freeze.remove()
    void document.body.offsetWidth
  }
}

/** 切主题读取：冻结过渡 → 切主题 → 读值；切回当前主题也在冻结期内完成，避免又起一段过渡 */
function withFrozenTransitions(theme, run) {
  return frozen(() => {
    setTheme(theme)
    void document.body.offsetWidth
    try {
      return run()
    } finally {
      setTheme(currentTheme)
      void document.body.offsetWidth
    }
  })
}

/** 等待条件成立（有界轮询，最多 frames 帧；不依赖 rAF，避免后台标签页被节流后卡死） */
const rafTick = () => new Promise(resolve => setTimeout(resolve, 16))
async function until(condition, frames = 60) {
  for (let i = 0; i < frames; i++) {
    if (condition()) return true
    await rafTick()
  }
  return condition()
}

/** 从已加载样式表里取出 tokens.css 的 :root（暖色）与 [data-theme="dark"] 声明 */
function collectTokenRules() {
  const warm = new Map()
  const dark = new Map()
  for (const sheet of Array.from(document.styleSheets)) {
    let rules
    try { rules = sheet.cssRules } catch { continue } // 跨域样式表（字体等）读不到，跳过
    for (const rule of Array.from(rules || [])) {
      if (!rule.selectorText || !rule.style) continue
      const target = rule.selectorText.includes('[data-theme="dark"]') ? dark
        : (rule.selectorText.includes(':root') ? warm : null)
      if (!target) continue
      for (const name of Array.from(rule.style)) {
        if (name.startsWith('--')) target.set(name, rule.style.getPropertyValue(name).trim())
      }
    }
  }
  return { warm, dark }
}

/** 收集所有同源样式表的 CSS 文本：360px 容器要复刻完全一样的级联（含组件 scoped CSS） */
function collectCss() {
  const parts = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules || [])) parts.push(rule.cssText)
    } catch { continue }
  }
  return parts.join('\n')
}

/** 取某个源码文件对应的 Vite 注入样式表（dev 下 style 元素带 data-vite-dev-id） */
function sheetTextOf(fragment) {
  for (const sheet of Array.from(document.styleSheets)) {
    const id = sheet.ownerNode?.getAttribute?.('data-vite-dev-id') || ''
    if (!id.includes(fragment)) continue
    try { return Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('\n') } catch { return '' }
  }
  return ''
}

/** 组件样式表文本：优先按 data-vite-dev-id 精确取，取不到再按作用域规则兜底 */
function componentCssText() {
  const direct = sheetTextOf('IntimatePanel.vue')
  if (direct) return direct
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const text = Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('\n')
      if (/\[data-v-[0-9a-f]+\]/.test(text) && /\.ip-hero/.test(text)) return text
    } catch { continue }
  }
  return ''
}

/** 把 var(--token) 解析成浏览器实际使用的色值（hex → rgb(...) 归一化） */
function resolveToken(token, property = 'color') {
  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.left = '-9999px'
  probe.style.top = '0'
  probe.style.visibility = 'hidden'
  probe.style.setProperty(property, `var(${token})`)
  document.body.appendChild(probe)
  try { return getComputedStyle(probe).getPropertyValue(property).trim() } finally { probe.remove() }
}

/** 扫描文本里的颜色字面量：样例与组件样式只允许 var(--token) / color-mix(...) */
function colorLiterals(text) {
  const found = []
  const declaration = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g
  let matched
  while ((matched = declaration.exec(text))) {
    const literal = matched[2].match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?)\(/g)
    if (literal) found.push({ declaration: matched[1], value: matched[2].trim().slice(0, 60), literal: literal.join(' ') })
  }
  return found
}

/** 收集文本里引用的 token 名（var(--x)） */
function referencedTokens(text) {
  return Array.from(new Set(Array.from(text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g), matched => matched[1])))
}

/* ── 抽样元素 → 期望来源 token ─────────────────────────────────── */
const COLOR_PROBES = [
  { label: '看板正文颜色', selector: '.ip', property: 'color', token: '--text-primary', varies: true },
  { label: '区块底色', selector: '.ip-sec', property: 'background-color', token: '--bg-secondary', varies: true },
  { label: '区块标题说明', selector: '.ip-sec-hint', property: 'color', token: '--text-secondary', varies: true },
  { label: '统计数值强调色', selector: '.ip-summary-value', property: 'color', token: '--accent', varies: true },
  { label: '行为统计数值', selector: '.ip-stat-value', property: 'color', token: '--accent', varies: true },
  { label: '排行次数', selector: '.ip-rank-count', property: 'color', token: '--accent', varies: true },
  { label: '排行进度条', selector: '.ip-rank-fill', property: 'background-color', token: '--accent', varies: true },
  { label: '爱心图标色', selector: '.ip-hero-icon', property: 'color', token: '--accent-4', varies: true },
  { label: '统计格底色', selector: '.ip-summary-cell', property: 'background-color', token: '--bg-sunken', varies: true },
  { label: '初次行底色', selector: '.ip-first-row', property: 'background-color', token: '--bg-sunken', varies: true },
  { label: '人工标记文字', selector: '.ip-tag.is-manual', property: 'color', token: '--accent', varies: true },
  { label: '自动标记文字', selector: '.ip-tag.is-auto', property: 'color', token: '--accent-3', varies: true },
  { label: '敏感带凹槽底色', selector: '.ip-zone-band', property: 'background-color', token: '--bg-tertiary', varies: true },
  { label: '排行轨道底色', selector: '.ip-rank-track', property: 'background-color', token: '--bg-sunken', varies: true },
  { label: '开关轨道底色（开）', selector: '.ls-switch--on .ls-switch__track', property: 'background-color', token: '--accent', varies: true },
  { label: '开关糖球底色', selector: '.ls-switch--on .ls-switch__track', pseudo: '::before', property: 'background-color', token: '--bg-secondary', varies: true },
  { label: '排行冠军名次色', selector: '.ip-rank-no.is-top', property: 'color', token: '--fun-gold', varies: false },
]

/** 敏感度等级 ↔ 面板文案：直接问组件自己的 intimateLogic 要映射，
 *  文案（无感/轻微/…）以后改了这里自动跟随，不写死；同时顺带校验渲染文案与映射一致 */
const LEVEL_BY_LABEL = Object.fromEntries(
  Array.from({ length: ZONE_MAX_LEVEL + 1 }, (_, level) => [zoneLevelLabel(level), level]),
)
const ZONE_LEVELS = Array.from({ length: ZONE_MAX_LEVEL + 1 }, (_, level) => level)

function readProbes() {
  const values = {}
  for (const probe of COLOR_PROBES) {
    const element = document.querySelector(probe.selector)
    if (!element) fail(`找不到抽样元素 ${probe.selector}`, { selector: probe.selector, expected: '元素存在', actual: '未找到' })
    values[probe.label] = styleOf(element, probe.property, probe.pseudo)
  }
  return values
}

/** 读取敏感度行：等级从「滑杆 value」与「等级文案」两侧对读，两处应一致 */
function zoneRows(doc) {
  return Array.from(doc.querySelectorAll('.ip-zone')).map(row => {
    const text = row.querySelector('.ip-zone-level-text')?.textContent.trim() || ''
    const slider = row.querySelector('.ip-zone-level input[type="range"]')
    const nameNode = row.querySelector('.ip-zone-name')
    return {
      label: nameNode?.value ?? nameNode?.textContent.trim() ?? '',
      level: LEVEL_BY_LABEL[text],
      levelText: text,
      sliderValue: slider ? Number(slider.value) : null,
      fill: row.querySelector('.ip-zone-band-fill'),
    }
  })
}

/* ── 挂载真实组件 ─────────────────────────────────────────────── */
const board = document.getElementById('board')
board.innerHTML = '<div class="sim-panel-shell"><div id="panel-host"></div></div>'
createApp(IntimatePanel, { character: CHARACTER }).mount('#panel-host')
// 等组件打完桩的接口、渲染出第一个区块（骨架消失）；失败时会出现 .ip-banner-error，交给自检报错
await until(() => !!board.querySelector('.ip-hero') || !!board.querySelector('.ip-banner-error'), 240)
const shell = board.querySelector('.sim-panel-shell')
const componentCss = componentCssText()
const fixtureCss = document.getElementById('fixture-style').textContent
const copiedCss = collectCss()
const tokenRules = collectTokenRules()

/* ── 窄屏模拟容器：360px 真实视口的 iframe ────────────────────── */
/** iframe 文档＝真实样式表 + 真实组件渲染出的 DOM 快照，
 *  这样 max-width:767px 按 iframe 自身视口命中，验的就是组件自己的响应式规则。 */
function phoneDocument(theme) {
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><style>${copiedCss}</style>`
    + `</head><body class="sim-phone-body">${shell.outerHTML}</body></html>`
}

async function buildPhoneFrame(theme) {
  const wrap = document.getElementById('phone-wrap')
  wrap.innerHTML = '<span class="sim-phone-label">窄屏模拟容器 · 360px 真实视口（iframe 内 max-width:767px 媒体查询生效；DOM 与样式表都来自真实组件）</span>'
  const frame = document.createElement('iframe')
  frame.id = 'phone-frame'
  frame.title = '窄屏模拟容器（360px）'
  // 用 box-shadow 描边而不是 border：iframe 的内容视口就等于 width，精确 360px
  frame.style.cssText = 'display:block;width:360px;height:900px;border:0;'
    + 'border-radius:var(--radius-lg);background:var(--bg-primary);box-shadow:0 0 0 1px var(--border)'
  frame.srcdoc = phoneDocument(theme)
  wrap.appendChild(frame)
  await Promise.race([
    new Promise(resolve => frame.addEventListener('load', resolve, { once: true })),
    new Promise(resolve => setTimeout(resolve, 3000)), // 兜底：不让页面永久挂起
  ])
  await until(() => {
    const doc = frame.contentDocument
    return !!doc && !!frame.contentWindow
      && frame.contentWindow.getComputedStyle(doc.documentElement).getPropertyValue('--accent').trim() !== ''
      && !!doc.querySelector('.ip-grid')
  }, 80)
  return frame
}

/* ── 自检项 ────────────────────────────────────────────────────── */
function runChecks(phoneDoc) {
  CHECKS.length = 0
  pendingChecks = []

  /* ① 挂载 / 数据形状 ── */
  check('真实组件挂载成功（无骨架 / 无加载错误 / character prop 生效）', () => {
    const banner = board.querySelector('.ip-banner-error')
    expect(!banner, `组件加载失败：${banner ? banner.textContent.trim() : ''}`,
      { selector: '#panel-host .ip-banner-error', expected: '不存在', actual: banner ? banner.textContent.trim() : '存在' })
    expect(!board.querySelector('.ip-skeleton'), '组件仍停在骨架态（接口未回或数据形状不符）',
      { selector: '#panel-host .ip-skeleton', expected: '骨架已消失', actual: '仍存在' })
    expect(board.querySelector('.ip'), '组件根节点 .ip 不存在',
      { selector: '#panel-host .ip', expected: '存在', actual: '未找到' })
    const label = board.querySelector('.ip-hero-label')?.textContent.trim() || ''
    expect(label.includes(CHARACTER.display_name), '顶部文案没有带上 character.display_name',
      { selector: '.ip-hero-label', expected: `含「${CHARACTER.display_name}」`, actual: label })
    return { selector: '#panel-host .ip', expected: `已渲染且文案含「${CHARACTER.display_name}」`, actual: label }
  })

  check('打桩后端被真实调用（面板 / 词表 / 流水 / 待确认提议）', () => {
    const expected = [
      `GET ${INTIMATE_PATH}`,
      `GET ${INTIMATE_PATH}/vocabulary`,
      `GET ${INTIMATE_PATH}/log`,
      `GET ${INTIMATE_PATH}/ai-edit/suggestions`,
    ]
    const missing = expected.filter(item => !stubbedCalls.includes(item))
    expect(missing.length === 0, `组件没有调用这些打桩接口：${missing.join('，')}`,
      { selector: 'globalThis.fetch', expected: expected.join('，'), actual: stubbedCalls.join('，') || '没有任何请求' })
    return { selector: 'globalThis.fetch', expected: `${expected.length} 个接口被调用`, actual: stubbedCalls.join('，') }
  })

  /* ② 组件漂移 ── */
  check('组件六区块齐备（知晓开关 / 身体信息 / 初次 / 基础统计 / 敏感度 / 排行）', () => {
    const blocks = [
      { label: '知晓开关', selector: '.ip-hero', ok: el => /知晓这些信息/.test(el.textContent) && !!el.querySelector('.ls-switch') },
      { label: '身体信息', selector: '.ip-grid', ok: el => el.querySelectorAll('.ip-field').length === 5 },
      { label: '初次信息', selector: '.ip-first-list', ok: el => el.querySelectorAll('.ip-first-row').length === VOCABULARY.acts.length },
      { label: '基础统计', selector: '.ip-summary', ok: el => el.querySelectorAll('.ip-summary-cell').length >= 3 },
      { label: '部位敏感度', selector: '.ip-zone-list', ok: el => el.querySelectorAll('.ip-zone').length === PANEL.profile.sensitiveZones.length },
      { label: '体位排行', selector: '.ip-rank-list', ok: el => el.querySelectorAll('.ip-rank-row').length === 5 },
    ]
    for (const block of blocks) {
      const element = board.querySelector(block.selector)
      expect(element, `区块「${block.label}」容器 ${block.selector} 不存在（组件结构可能改了）`,
        { selector: block.selector, expected: '存在', actual: '未找到' })
      expect(block.ok(element), `区块「${block.label}」内容不符合预期`,
        { selector: block.selector, expected: '内容齐备', actual: element.textContent.trim().slice(0, 60) })
    }
    const titles = Array.from(board.querySelectorAll('.ip-sec-title')).map(el => el.textContent.trim())
    const wanted = ['身体信息', '初次', '基础统计', '部位敏感度', '体位排行']
    const missing = wanted.filter(name => !titles.some(title => title.includes(name)))
    expect(missing.length === 0, `缺少区块标题：${missing.join('，')}`,
      { selector: '.ip-sec-title', expected: wanted.join(' / '), actual: titles.join(' / ') })
    return { selector: '六个区块', expected: '容器 + 标题 + 内容量齐备', actual: titles.join(' / ') }
  })

  check('组件渲染出的内联样式无硬编码色值', () => {
    const found = colorLiterals(shell.innerHTML)
    expect(found.length === 0, `${found.length} 处颜色字面量`,
      { selector: '#panel-host style="…"', expected: '0 处 #hex / rgb() / hsl()', actual: found.map(item => `${item.declaration}:${item.value}`).join('；') || '0 处' })
    return { selector: '#panel-host style="…"', expected: '0 处颜色字面量', actual: '0 处' }
  })

  check('组件样式表已加载且无硬编码色值', () => {
    expect(componentCss.length > 800, '没有取到 IntimatePanel.vue 的 scoped 样式表（挂载路径可能没加载组件样式）',
      { selector: 'data-vite-dev-id *= IntimatePanel.vue', expected: '> 800 字符', actual: `${componentCss.length} 字符` })
    const found = colorLiterals(componentCss)
    expect(found.length === 0, `组件样式表出现 ${found.length} 处颜色字面量（必须走 token）`,
      { selector: 'IntimatePanel.vue <style>', expected: '0 处 #hex / rgb() / hsl()', actual: found.map(item => `${item.declaration}:${item.value}`).join('；') })
    return { selector: 'IntimatePanel.vue <style>', expected: '0 处颜色字面量', actual: `${componentCss.length} 字符样式表，0 处字面量` }
  })

  check('组件样式引用的 token 都真实存在', () => {
    const declared = new Set([...tokenRules.warm.keys(), ...tokenRules.dark.keys()])
    const local = new Set(Array.from(componentCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g), matched => matched[1]))
    const referenced = referencedTokens(componentCss)
    const missing = referenced.filter(name => !declared.has(name) && !local.has(name))
    expect(missing.length === 0, `组件样式引用了不存在的 token：${missing.join('，')}`,
      { selector: 'IntimatePanel.vue var(--*)', expected: `${referenced.length} 个引用全部可解析`, actual: missing.length ? `缺失 ${missing.join('，')}` : `${referenced.length}/${referenced.length}` })
    return { selector: 'IntimatePanel.vue var(--*)', expected: '全部存在', actual: `${referenced.length} 个引用全部存在` }
  })

  check('样例外壳样式表无硬编码色值', () => {
    const found = colorLiterals(fixtureCss)
    expect(found.length === 0, `${found.length} 处颜色字面量`,
      { selector: '#fixture-style', expected: '0 处 #hex / rgb() / hsl()', actual: found.map(item => `${item.declaration}:${item.value}`).join('；') || '0 处' })
    return { selector: '#fixture-style', expected: '0 处颜色字面量', actual: '0 处' }
  })

  /* ③ 双主题 ── */
  check('tokens.css 双主题声明已读取', () => {
    expect(tokenRules.warm.size > 20 && tokenRules.dark.size > 20,
      '未从样式表读到 tokens.css 的 :root / [data-theme="dark"] 声明',
      { selector: ':root 与 [data-theme="dark"]', expected: '各 > 20 条 --* 声明', actual: `warm ${tokenRules.warm.size} / dark ${tokenRules.dark.size}` })
    const pairs = ['--bg-primary', '--bg-secondary', '--bg-sunken', '--text-primary', '--accent', '--border'].map(name => {
      const warm = tokenRules.warm.get(name)
      const dark = tokenRules.dark.get(name)
      expect(warm && dark, `token ${name} 在 tokens.css 中缺失`,
        { selector: `var(${name})`, expected: '两套主题都声明', actual: `warm=${dash(warm)} dark=${dash(dark)}` })
      expect(warm !== dark, `token ${name} 两套主题取值相同，主题切换不会生效`,
        { selector: `var(${name})`, expected: '暖色 ≠ 暗夜', actual: `warm=${warm} dark=${dark}` })
      return `${name}=${warm}/${dark}`
    })
    return { selector: ':root 与 [data-theme="dark"]', expected: '双主题取值不同', actual: pairs.join('；') }
  })

  const probeCheck = (theme, prefix) => () => {
    const { values, expected } = withFrozenTransitions(theme, () => ({
      values: readProbes(),
      expected: Object.fromEntries(COLOR_PROBES.map(probe => [probe.label, resolveToken(probe.token, probe.property)])),
    }))
    for (const probe of COLOR_PROBES) {
      expect(values[probe.label] === expected[probe.label], `${probe.label} 未使用 ${probe.token}`,
        { selector: probe.selector, expected: `${probe.token} → ${expected[probe.label]}`, actual: values[probe.label] })
    }
    return { selector: `${COLOR_PROBES.length} 个抽样元素`, expected: `${prefix}全部等于对应 token 解析值`, actual: '一致' }
  }
  check('关键元素颜色来自 token（暖色）', probeCheck('warm', '暖色下 '))
  check('关键元素颜色来自 token（暗夜）', probeCheck('dark', '暗夜下 '))

  check('暖色 / 暗夜两套主题都成立且互不相同', () => {
    const warm = withFrozenTransitions('warm', readProbes)
    const dark = withFrozenTransitions('dark', readProbes)
    for (const probe of COLOR_PROBES) {
      const same = warm[probe.label] === dark[probe.label]
      const message = probe.varies
        ? `${probe.label} 两套主题取值相同，没有跟随主题变化`
        : `${probe.label} 应为主题无关的功能色，但两套主题取值不同`
      expect(probe.varies ? !same : same, message,
        { selector: probe.selector, expected: probe.varies ? '暖色 ≠ 暗夜' : '暖色 = 暗夜（--fun-* 系不随主题）', actual: `warm=${warm[probe.label]} dark=${dark[probe.label]}` })
    }
    const varying = COLOR_PROBES.filter(probe => probe.varies).length
    return { selector: `${COLOR_PROBES.length} 个抽样元素`, expected: `${varying} 项随主题变化、${COLOR_PROBES.length - varying} 项保持同值`, actual: '符合' }
  })

  /* ④ 结构 / 布局（桌面） ── */
  check('身体信息：两列布局（<768px 降单列）', () => {
    const grid = board.querySelector('.ip-grid')
    const columns = styleOf(grid, 'grid-template-columns')
    const tracks = trackCount(grid)
    const wide = window.innerWidth >= 768
    const expected = wide ? 2 : 1
    expect(tracks === expected, `当前视口 ${window.innerWidth}px 下应为 ${expected} 列`,
      { selector: '.ip-grid', expected: `${expected} 列（视口 ≥768px 两列 / <768px 单列）`, actual: `${tracks} 列：${columns}` })
    return { selector: '.ip-grid', expected: `${expected} 列`, actual: columns, note: `当前视口 ${window.innerWidth}px` }
  })

  check('初次里程碑：人工 / 自动 / 无记录三态齐备（无记录行日期禁用）', () => {
    const count = selector => board.querySelectorAll(selector).length
    const manual = count('.ip-first-row .ip-tag.is-manual')
    const auto = count('.ip-first-row .ip-tag.is-auto')
    const empty = count('.ip-first-row .ip-tag.is-empty')
    expect(manual >= 1 && auto >= 1 && empty >= 1, '三态没有同时出现（打桩数据里有人工 + 自动 + 无记录）',
      { selector: '.ip-first-row .ip-tag', expected: '人工 ≥1 / 自动 ≥1 / 无记录 ≥1', actual: `人工 ${manual} / 自动 ${auto} / 无记录 ${empty}` })
    const rows = Array.from(board.querySelectorAll('.ip-first-row'))
    expect(rows.length === VOCABULARY.acts.length, '初次行数量与词表行为数不一致',
      { selector: '.ip-first-row', expected: `${VOCABULARY.acts.length} 行`, actual: `${rows.length} 行` })
    const dates = Array.from(board.querySelectorAll('input.ip-first-date'))
    const disabled = dates.filter(input => input.disabled)
    const enabled = dates.filter(input => !input.disabled)
    expect(disabled.length === empty && enabled.length === manual + auto, '日期输入的可填状态与「有无记录」不一致',
      { selector: 'input.ip-first-date', expected: `禁用 ${empty} / 可填 ${manual + auto}`, actual: `禁用 ${disabled.length} / 可填 ${enabled.length}` })
    const disabledBg = styleOf(disabled[0], 'background-color')
    expect(disabledBg === resolveToken('--bg-tertiary', 'background-color'), '禁用日期未走 LinsheInput 的禁用皮肤（--bg-tertiary）',
      { selector: 'input.ip-first-date:disabled', expected: `--bg-tertiary → ${resolveToken('--bg-tertiary', 'background-color')}`, actual: disabledBg })
    const filled = enabled.find(input => input.value)?.value || ''
    expect(filled === PANEL.firsts[0].firstAt, '已落库的初次日期没有回显到日期输入框',
      { selector: 'input.ip-first-date', expected: PANEL.firsts[0].firstAt, actual: filled || '（空）' })
    return { selector: '.ip-first-row', expected: '三态齐备、无记录禁用、日期回显', actual: `人工 ${manual} / 自动 ${auto} / 无记录 ${empty}；回显 ${filled}` }
  })

  check('基础统计：数值统一用 --accent 强调', () => {
    const accent = resolveToken('--accent')
    const nodes = Array.from(board.querySelectorAll('.ip-summary-value, .ip-stat-value'))
    expect(nodes.length > 0, '没有统计数值节点', { selector: '.ip-summary-value, .ip-stat-value', expected: '存在', actual: '0 个' })
    for (const node of nodes) {
      const color = styleOf(node, 'color')
      expect(color === accent, '统计数值未使用 --accent',
        { selector: `${node.className}（${node.textContent.trim()}）`, expected: `--accent → ${accent}`, actual: color })
    }
    return { selector: '.ip-summary-value, .ip-stat-value', expected: '全部为 --accent', actual: `${nodes.length} 个节点一致` }
  })

  check('部位敏感度：六档齐备 + 滑杆与等级文案一致 + 色带宽度随 level 递增', () => {
    const rows = zoneRows(board)
    expect(rows.length === ZONE_LEVELS.length, '敏感度档位不齐',
      { selector: '.ip-zone', expected: `${ZONE_LEVELS.length} 档（0~5）`, actual: `${rows.length} 档` })
    const levels = rows.map(row => row.level).sort((a, b) => a - b)
    expect(JSON.stringify(levels) === JSON.stringify(ZONE_LEVELS), '等级文案不是 0~5 六档',
      { selector: '.ip-zone-level-text', expected: ZONE_LEVELS.join(','), actual: `${rows.map(row => row.levelText).join(',')} → ${levels.join(',')}` })
    for (const row of rows) {
      expect(row.sliderValue === row.level, `「${row.label}」滑杆值 ${row.sliderValue} 与等级文案「${row.levelText}」不一致`,
        { selector: '.ip-zone-level input[type=range]', expected: `滑杆值 = ${row.level}`, actual: `滑杆 ${row.sliderValue} / 文案 ${row.levelText}` })
    }
    const measured = rows
      .map(row => ({ level: row.level, width: parseFloat(styleOf(row.fill, 'width')) }))
      .sort((a, b) => a.level - b.level)
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i].width > measured[i - 1].width, `level ${measured[i - 1].level} → ${measured[i].level} 的色带宽度没有变宽`,
        { selector: '.ip-zone-band-fill', expected: '宽度随 level 严格递增', actual: measured.map(item => `${item.level}:${item.width.toFixed(1)}px`).join(' ') })
    }
    return { selector: '.ip-zone-band-fill', expected: '滑杆与文案一致、宽度随 level 严格递增', actual: measured.map(item => `${item.level}:${item.width.toFixed(1)}px`).join(' ') }
  })

  check('部位敏感度：色阶只用 --fun-* 系 token 且六档各不相同', () => {
    const allowed = new Set(['--fun-neutral', '--fun-blue', '--fun-teal', '--fun-gold', '--fun-orange', '--fun-pink', '--accent']
      .map(name => resolveToken(name, 'background-color')))
    const used = zoneRows(board).map(row => ({ level: row.level, color: styleOf(row.fill, 'background-color'), declared: row.fill.getAttribute('style') || '' }))
    for (const item of used) {
      expect(allowed.has(item.color), `level ${item.level} 的色阶不是 --fun-* token`,
        { selector: `.ip-zone-band-fill（第 ${item.level} 档）`, expected: '取值属于 --fun-* / --accent', actual: `${item.color}（${item.declared}）` })
    }
    const distinct = new Set(used.map(item => item.color))
    expect(distinct.size === used.length, '六档色阶出现重复',
      { selector: '.ip-zone-band-fill', expected: `${used.length} 档颜色互不相同`, actual: `${distinct.size} 种颜色` })
    return { selector: '.ip-zone-band-fill', expected: '全部来自 --fun-* 且互不相同', actual: used.map(item => `${item.level}:${item.color}`).join(' ') }
  })

  check('体位排行：Top5、次数降序、过滤零次', () => {
    const rows = Array.from(board.querySelectorAll('.ip-rank-row'))
    expect(rows.length === 5, '排行不是 5 行',
      { selector: '.ip-rank-row', expected: '5 行（打桩给了 6 条，含 1 条 0 次）', actual: `${rows.length} 行` })
    const counts = rows.map(row => Number(row.querySelector('.ip-rank-count').textContent))
    const ranks = rows.map(row => Number(row.querySelector('.ip-rank-no').textContent))
    expect(JSON.stringify(ranks) === JSON.stringify([1, 2, 3, 4, 5]), '名次不是 1~5',
      { selector: '.ip-rank-no', expected: '1,2,3,4,5', actual: ranks.join(',') })
    expect(counts.every(count => count > 0), '排行里出现 0 次项',
      { selector: '.ip-rank-count', expected: '全部 > 0', actual: counts.join(',') })
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i] <= counts[i - 1], '排行次数没有降序',
        { selector: '.ip-rank-count', expected: '降序', actual: counts.join(',') })
    }
    return { selector: '.ip-rank-row', expected: '5 行、降序、无 0 次', actual: counts.join(' > ') }
  })

  check('知晓开关：两态几何不跳变且糖球位移增加', () => frozen(() => {
    const on = board.querySelector('.ip-first-row .ls-switch--on')
    const off = board.querySelector('.ip-first-row .ls-switch:not(.ls-switch--on)')
    expect(on, '初次行里没有「已开启」的开关（打桩数据应有一笔里程碑）',
      { selector: '.ip-first-row .ls-switch--on', expected: '存在', actual: '未找到' })
    expect(off, '初次行里没有「未开启」的开关（打桩数据应有「无记录」行）',
      { selector: '.ip-first-row .ls-switch:not(.ls-switch--on)', expected: '存在', actual: '未找到' })
    const read = label => {
      const box = label.querySelector('.ls-switch__box')
      const track = label.querySelector('.ls-switch__track')
      return {
        box: sizeOf(box),
        knob: sizeOf(track, '::before'),
        track: styleOf(track, 'background-color'),
        tx: matrixTx(styleOf(track, 'transform', '::before') || 'none'),
      }
    }
    const onState = read(on)
    const offState = read(off)
    expect(onState.box === offState.box, '两态开关盒子尺寸不一致（会跳变）',
      { selector: '.ls-switch__box', expected: '关/开等高同宽', actual: `关 ${offState.box} / 开 ${onState.box}` })
    expect(onState.knob === offState.knob, '两态糖球尺寸不一致（会跳变）',
      { selector: '.ls-switch__track::before', expected: '关/开同等大小', actual: `关 ${offState.knob} / 开 ${onState.knob}` })
    expect(onState.tx > offState.tx, '开启态糖球没有位移到右侧',
      { selector: '.ls-switch__track::before', expected: '开启后 translateX 增大', actual: `关 ${offState.tx} / 开 ${onState.tx}` })
    expect(offState.track === resolveToken('--bg-tertiary', 'background-color'), '关闭态轨道未使用 --bg-tertiary（中性糖）',
      { selector: '.ls-switch__track', expected: `--bg-tertiary → ${resolveToken('--bg-tertiary', 'background-color')}`, actual: offState.track })
    expect(onState.track === resolveToken('--accent', 'background-color'), '开启态轨道未使用 --accent（主题糖）',
      { selector: '.ls-switch__track', expected: `--accent → ${resolveToken('--accent', 'background-color')}`, actual: onState.track })
    return { selector: '.ls-switch', expected: '两态等高、糖球右移、关=--bg-tertiary 开=--accent', actual: `${offState.box} → ${onState.box}；translateX ${offState.tx} → ${onState.tx}` }
  }))

  /* ⑤ 360px 真实视口（iframe 里是真实组件 DOM + 真实样式表） ── */
  const needFrame = () => {
    expect(phoneDoc, '窄屏模拟容器未挂载', { selector: '#phone-frame', expected: 'iframe 存在', actual: '未挂载' })
  }

  check('窄屏容器（360px）：样式表已复制（含组件 scoped CSS）', () => {
    needFrame()
    const frameCss = Array.from(phoneDoc.querySelectorAll('style')).map(node => node.textContent).join('\n')
    expect(frameCss.length > 4000, '窄屏容器里的样式表太小，级联可能没复制完整',
      { selector: '#phone-frame <style>', expected: '> 4000 字符', actual: `${frameCss.length} 字符` })
    expect(/\[data-v-[0-9a-f]+\]/.test(frameCss), '窄屏容器里没有组件 scoped CSS（缺 [data-v-*] 规则）',
      { selector: '#phone-frame <style>', expected: '含 scoped 规则', actual: '未匹配到 [data-v-*]' })
    expect(!!phoneDoc.querySelector('.ip'), '窄屏容器里没有组件渲染出的 DOM 快照',
      { selector: '#phone-frame .ip', expected: '存在', actual: '未找到' })
    return { selector: '#phone-frame', expected: '样式表 + 组件 DOM 快照', actual: `${frameCss.length} 字符 CSS` }
  })

  check('窄屏容器（360px）：身体信息与行为统计降为单列', () => {
    needFrame()
    const view = phoneDoc.defaultView
    const actual = ['.ip-grid', '.ip-stat-grid'].map(selector => {
      const element = phoneDoc.querySelector(selector)
      expect(element, `窄屏容器内缺少 ${selector}`, { selector, expected: '元素存在', actual: '未找到' })
      const columns = view.getComputedStyle(element).gridTemplateColumns
      const tracks = columns.split(/\s+/).filter(Boolean).length
      expect(tracks === 1, `${selector} 在 360px 下不是单列`,
        { selector: `#phone-frame ${selector}`, expected: '1 列', actual: `${tracks} 列：${columns}` })
      return `${selector}=${tracks} 列`
    })
    return { selector: '#phone-frame .ip-grid / .ip-stat-grid', expected: '各 1 列', actual: actual.join('，') }
  })

  check('窄屏容器（360px）：无横向溢出', () => {
    needFrame()
    const view = phoneDoc.defaultView
    const targets = [
      { label: 'html', element: phoneDoc.documentElement },
      { label: 'body', element: phoneDoc.body },
      { label: '看板根', element: phoneDoc.querySelector('.ip') },
      { label: '知晓开关', element: phoneDoc.querySelector('.ip-hero') },
    ]
    for (const target of targets) {
      expect(target.element, `窄屏容器内找不到 ${target.label}`, { selector: `#phone-frame ${target.label}`, expected: '存在', actual: '未找到' })
      const overflow = target.element.scrollWidth - target.element.clientWidth
      expect(overflow <= 1, `${target.label} 出现横向溢出 ${overflow}px`,
        { selector: `#phone-frame ${target.label}`, expected: 'scrollWidth ≤ clientWidth', actual: `scrollWidth ${target.element.scrollWidth} / clientWidth ${target.element.clientWidth}` })
    }
    // 父页足够宽时 iframe 不会被 flex 压缩，此时应精确等于 360px；窄父页下只保证仍是窄屏档
    const exact = window.innerWidth >= 420
    const viewportOk = exact ? view.innerWidth === 360 : (view.innerWidth >= 300 && view.innerWidth <= 400)
    expect(viewportOk, `窄屏容器视口 ${view.innerWidth}px 不符合预期（父页 ${window.innerWidth}px）`,
      { selector: '#phone-frame', expected: exact ? '精确 360px' : '300~400px', actual: `${view.innerWidth}px` })
    return { selector: '#phone-frame', expected: '无横向溢出', actual: `视口 ${view.innerWidth}px，四层容器 scrollWidth ≤ clientWidth` }
  })

  check('窄屏容器（360px）：初次行日期整行铺开且不溢出', () => {
    needFrame()
    const row = phoneDoc.querySelector('.ip-first-row')
    const dateBox = row.querySelector('.ip-first-date')
    const style = phoneDoc.defaultView.getComputedStyle(dateBox)
    expect(style.gridColumnStart === '1' && style.gridColumnEnd === '-1', '日期没有铺满整行',
      { selector: '#phone-frame .ip-first-date', expected: 'grid-column: 1 / -1', actual: `${style.gridColumnStart} / ${style.gridColumnEnd}` })
    const overflow = row.scrollWidth - row.clientWidth
    expect(overflow <= 1, `初次行横向溢出 ${overflow}px`,
      { selector: '#phone-frame .ip-first-row', expected: 'scrollWidth ≤ clientWidth', actual: `scrollWidth ${row.scrollWidth} / clientWidth ${row.clientWidth}` })
    return { selector: '#phone-frame .ip-first-row', expected: '日期 1 / -1 且不溢出', actual: `grid-column ${style.gridColumnStart} / ${style.gridColumnEnd}` }
  })

  check('窄屏容器（360px）：token 与主题跟随父页', () => {
    needFrame()
    const inner = phoneDoc.defaultView.getComputedStyle(phoneDoc.documentElement).getPropertyValue('--accent').trim()
    const outer = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    expect(inner === outer, '窄屏容器里的 --accent 与父页不一致',
      { selector: '#phone-frame :root', expected: `--accent = ${outer}`, actual: inner })
    expect(phoneDoc.documentElement.dataset.theme === currentTheme, '窄屏容器主题与父页不一致',
      { selector: '#phone-frame html', expected: currentTheme, actual: phoneDoc.documentElement.dataset.theme })
    return { selector: '#phone-frame :root', expected: `--accent = ${outer}，data-theme = ${currentTheme}`, actual: `--accent = ${inner}` }
  })

  check('窄屏容器（360px）：敏感度色带仍随 level 递增', () => {
    needFrame()
    const rows = zoneRows(phoneDoc)
    expect(rows.length === ZONE_LEVELS.length, '窄屏容器内敏感度档位不齐',
      { selector: '#phone-frame .ip-zone', expected: `${ZONE_LEVELS.length} 档`, actual: `${rows.length} 档` })
    const measured = rows
      .map(row => ({ level: row.level, width: parseFloat(phoneDoc.defaultView.getComputedStyle(row.fill).width) }))
      .sort((a, b) => a.level - b.level)
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i].width > measured[i - 1].width, `窄屏下 level ${measured[i - 1].level} → ${measured[i].level} 的色带宽度没有变宽`,
        { selector: '#phone-frame .ip-zone-band-fill', expected: '宽度随 level 严格递增', actual: measured.map(item => `${item.level}:${item.width.toFixed(1)}px`).join(' ') })
    }
    return { selector: '#phone-frame .ip-zone-band-fill', expected: '宽度随 level 严格递增', actual: measured.map(item => `${item.level}:${item.width.toFixed(1)}px`).join(' ') }
  })
}

/* ── 报告 ──────────────────────────────────────────────────────── */
function renderReport() {
  const failed = CHECKS.filter(item => !item.ok)
  const head = `${failed.length ? 'FAIL' : 'PASS'} ${CHECKS.length - failed.length}/${CHECKS.length}`
  const lines = CHECKS.map(item => {
    const note = item.ok && item.note ? `（${item.note}）` : ''
    const detail = item.ok
      ? ` | ${dash(item.selector)} | 期望 ${dash(item.expected)} | 实测 ${dash(item.actual)}`
      : `\n        失败项定位 selector=${dash(item.selector)}\n        期望：${dash(item.expected)}\n        实测：${dash(item.actual)}\n        原因：${dash(item.error)}`
    return `[${item.ok ? 'PASS' : 'FAIL'}] ${item.label}${note}${detail}`
  })
  result.textContent = `${head}\n${lines.join('\n')}\n\n${JSON.stringify(CHECKS, null, 2)}`
}

/* ── 启动 ──────────────────────────────────────────────────────── */
// 与既有样例一致：支持用查询参数固定起始状态（/test/fixtures/intimatePanel.html?theme=dark）
const query = new URLSearchParams(location.search)
let currentTheme = query.get('theme') === 'dark' ? 'dark' : 'warm'
let showPhone = true
let phoneDoc = null

const previews = document.getElementById('previews')
const toolbar = document.getElementById('toolbar')
previews.innerHTML = '<div class="sim-phone-wrap" id="phone-wrap"></div>'

toolbar.innerHTML = '<div class="sim-toolbar">'
  + '<button type="button" class="sim-btn" id="btn-theme" aria-pressed="false"></button>'
  + '<button type="button" class="sim-btn is-active" id="btn-phone" aria-pressed="true">收起窄屏预览（360px）</button>'
  + '</div>'
document.getElementById('btn-theme').addEventListener('click', () => {
  currentTheme = currentTheme === 'warm' ? 'dark' : 'warm'
  sync()
})
// 收放只切 CSS 类，不卸载 iframe：一旦脱离布局，360px 视口会塌掉，窄屏自检就失去意义
document.getElementById('btn-phone').addEventListener('click', () => {
  showPhone = !showPhone
  document.getElementById('phone-wrap').classList.toggle('is-collapsed', !showPhone)
  updateToolbar()
})

function updateToolbar() {
  const themeButton = document.getElementById('btn-theme')
  themeButton.textContent = `切换主题（当前：${currentTheme === 'warm' ? '暖色' : '暗夜'}）`
  themeButton.setAttribute('aria-pressed', String(currentTheme === 'dark'))
  const phoneButton = document.getElementById('btn-phone')
  phoneButton.textContent = showPhone ? '收起窄屏预览（360px）' : '展开窄屏预览（360px）'
  phoneButton.setAttribute('aria-pressed', String(showPhone))
  phoneButton.classList.toggle('is-active', showPhone)
}

async function sync() {
  setTheme(currentTheme)
  updateToolbar()
  const frame = await buildPhoneFrame(currentTheme)
  phoneDoc = frame.contentDocument
  setTheme(currentTheme) // 自检内部会切主题取快照，这里确保收尾回到当前主题
  runChecks(phoneDoc)
  await flushChecks()
  renderReport()
}

await until(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() !== '', 80)
await sync()
