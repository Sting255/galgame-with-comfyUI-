/**
 * L6 浏览器点击验证（2026-10-02，Lead 集成验收）
 *
 * 验的是**我这轮亲手挂的三个入口**在真实页面里点得开：
 *   ① ChatView 的 ❤ 推进入口 → IntimateActionPanel 出现（体位胶囊/节奏分段/动作按钮）
 *   ② ChatView 的 🧸 玩具入口 → ToyPanel 出现（多件/模式/曲线都能渲染）
 *   ③ 设置页的程序时间面板 → 「角色此刻看到的时间」出现（含后端原样 timeTag）
 * 不验业务语义（那是后端测试与真链路接口验证的事），只验"点得开、渲染得出"。
 *
 * 用法：node e2e/check-panels.mjs   （需要后端已在 3199 跑着；用副本库）
 */
import { chromium } from 'playwright'

const BASE = process.env.PANEL_CHECK_BASE || 'http://127.0.0.1:3199'
const CHAT_URL = `${BASE}/#/chat/1`
const SETTINGS_URL = `${BASE}/#/settings`

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(String(e.message || e)))
// ⚠️ 只监听 pageerror 会漏掉**最要命的那一类**：Vue 在组件 setup 里 catch 掉异常、
//    改用 console.error 打印（真机案例：IntimateActionPanel 少 import 一个 onBeforeUnmount
//    ⇒ ReferenceError 只出现在 console 里，面板整块挂不出来，而这里却报"无页面 JS 报错" ⇒ 假绿）。
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })

/**
 * 关掉挡路的弹窗/遮罩。
 * 第一次跑时这里踩到：一进页面就有 `modal-overlay.linshe-modal-overlay`（更新提示/新手引导之类）
 * 挡住点击 ⇒ 后续 click 全部被拦（Playwright 会重试 48 次然后超时）。
 * 所以任何页面级点击检查前都要先清场。
 */
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const overlay = page.locator('.linshe-modal-overlay, .modal-overlay')
    if (await overlay.count() === 0) return
    // 优先点"关闭/知道了/以后再说"这类按钮，退而求其次按 Esc
    const closers = page.locator('.linshe-modal-close, [aria-label="关闭"], button:has-text("知道了"), button:has-text("关闭"), button:has-text("以后再说"), button:has-text("取消")')
    if (await closers.count() > 0) {
      await closers.first().click({ timeout: 2000 }).catch(() => {})
    } else {
      await page.keyboard.press('Escape').catch(() => {})
    }
    await page.waitForTimeout(600)
  }
}

try {
  // ── ① ❤ 推进入口 ──
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await dismissOverlays(page)
  const heart = page.locator('.intimate-icon-btn')
  record('① ❤ 入口渲染出来了', await heart.count() > 0, `count=${await heart.count()}`)
  if (await heart.count() > 0) {
    await heart.first().click()
    await page.waitForTimeout(1800)
    const panel = page.locator('.ia-panel, .ia-card, .ia-hud')
    const panelCount = await panel.count()
    const chipCount = await page.locator('.ia-chip').count()
    const hasPositionChip = await page.locator('.ia-pos-btn, .ia-position, [class*="ia-pos"]').count()
    record('① 面板打开并渲染出 HUD', panelCount > 0, `panel=${panelCount} chip=${chipCount}`)
    record('① 体位/节奏控件可见', hasPositionChip > 0 || chipCount >= 2, `pos=${hasPositionChip} chip=${chipCount}`)
    const bodyText = (await page.locator('body').innerText()).slice(0, 4000)
    record('① 面板文案含推进动作', /继续抽插|加速抽插|换姿势|进入她/.test(bodyText), bodyText.match(/继续抽插|加速抽插|换姿势|进入她/)?.[0] || '(未命中)')
    await page.keyboard.press('Escape').catch(() => {})
    await page.locator('.ia-close, [aria-label="关闭推进面板"]').first().click().catch(() => {})
    await page.waitForTimeout(500)
  }

  // ── ② 🧸 玩具入口 ──
  const toy = page.locator('.toy-icon-btn')
  record('② 🧸 入口渲染出来了', await toy.count() > 0, `count=${await toy.count()}`)
  if (await toy.count() > 0) {
    await toy.first().click()
    await page.waitForTimeout(2000)
    const panelVisible = await page.locator('.toy-panel, .tp-panel, [class*="toy-panel"]').count()
    const segCount = await page.locator('.linshe-tabs, [class*="linshe-tabs"]').count()
    const switchCount = await page.locator('.linshe-switch, [class*="linshe-switch"]').count()
    record('② 玩具面板打开', panelVisible > 0, `panel=${panelVisible} tabs=${segCount} switch=${switchCount}`)
    await page.keyboard.press('Escape').catch(() => {})
  }

  // ── ③ 程序时间面板 ──
  await page.goto(SETTINGS_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await dismissOverlays(page)
  const settingsText = await page.locator('body').innerText()
  record('③ 设置页有「程序时间」区块', /程序时间|世界钟|时间/.test(settingsText), '')
  const perceptionTab = page.getByText('她们看到的那一行', { exact: false })
  const hasPerception = await perceptionTab.count()
  record('③ 「角色此刻看到的时间」入口在', hasPerception > 0, `count=${hasPerception}`)
  if (hasPerception > 0) {
    await perceptionTab.first().click()
    await page.waitForTimeout(1500)
    const after = await page.locator('body').innerText()
    record('③ 显示的时间串像注入 prompt 的原串', /\[\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}/.test(after),
      after.match(/\[\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}[^\]]*\]/)?.[0] || '(未命中)')
  }
} catch (err) {
  record('脚本异常', false, String(err?.message || err))
} finally {
  record('无页面 JS 报错', errors.length === 0 && consoleErrors.length === 0,
    [...errors.slice(0, 2), ...consoleErrors.slice(0, 3)].join(' | '))
  // 单独再记一项：把 console 里的 error 单列出来，免得和真正的未捕获异常混在一起看不清
  record('无控制台 error（Vue 的 setup 报错会走这里）', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  await browser.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
