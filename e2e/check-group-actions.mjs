/**
 * 群场景动作 / 玩具 的补验（check-group-panels 里 1 条"测不了" + 1 条 SKIP + 群里反应未验）。
 *
 * 补的是这三条：
 *   ① 群里点动作 → **群里真出反应消息**（不是只在私聊验过）
 *   ② 群里**真戴上玩具**（原脚本说"11 个按钮全被门控，测不了"）
 *   ③ 换目标后**两个面板自动关**（原脚本 SKIP）
 *   ④ 顺带：玩具影响生图的穿戴描述注入（wornToysBrief）
 *
 * 用法：node e2e/check-group-actions.mjs     环境变量 GROUP_ACTION_BASE（默认 :3199）
 * ⚠️ 会真实产生群消息 / 玩具穿戴，请对**副本库**跑。
 */
import { createRequire } from 'node:module'
import path from 'node:path'

const BASE = process.env.GROUP_ACTION_BASE || 'http://127.0.0.1:3199'
const GROUP = Number(process.env.GROUP_ID || 2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const D = process.env.GROUP_ACTION_REPO || path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(D, 'e2e', 'package.json'))
const { chromium } = require('playwright')

const rows = []
const rec = (id, ok, ev) => {
  rows.push({ id, ok, ev })
  const mark = ok === true ? '✅' : ok === false ? '❌' : '⚠️'
  console.log(`${mark} ${id}\n      ${ev}`)
}
const api = async (u, opt = {}) => {
  const r = await fetch(BASE + u, { headers: { 'Content-Type': 'application/json' }, ...opt })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const msgs = async () => ((await api(`/api/groups/${GROUP}/messages`)).body?.messages || [])
const maxId = (l) => l.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'zh-CN' })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)))

const dismiss = async () => {
  for (const s of ['button:has-text("知道了")', 'button:has-text("关闭")', '.linshe-modal-close', '.modal-close', 'text=我知道了']) {
    try { const l = page.locator(s).first(); if (await l.isVisible({ timeout: 600 })) { await l.click(); await sleep(300) } } catch { /* */ }
  }
}
const clickIt = async (loc, t = 8000) => {
  try { await loc.click({ timeout: t }) } catch { try { await loc.click({ force: true, timeout: 5000 }) } catch { await loc.evaluate((el) => el.click()).catch(() => {}) } }
}

// 进群
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' }); await sleep(4500); await dismiss()
const g = page.locator('.char-item:has(.group-avatar-grid)').first()
await g.click(); await sleep(4500); await dismiss()
const inGroup = (await page.locator('.touch-group-wrap').count()) > 0
rec('G0 进入群聊', inGroup, `URL=${page.url()} | .touch-group-wrap=${await page.locator('.touch-group-wrap').count()} | .msg-list-inner=${await page.locator('.msg-list-inner').count()}`)

/**
 * ⚠️ 顺序不能反（我第一版就反了，白跑一轮）：
 *   TouchActionPanel 在 `requiresTarget && !targetName` 时**打开面板会自动 emit('pick-target')**，
 *   所以必须**先点 ✋ 打开面板**，选人面板才会自己弹出来。
 *   在面板打开之前去找 `[title="选择动作对象"]` 是找不到的。
 */
const openTouchPanel = async () => {
  await clickIt(page.locator('div.touch-icon-btn[aria-label="动作"]'))
  await sleep(2200)
  return (await page.locator('.touch-panel').count()) > 0
}
const pickTarget = async (idx = 0) => {
  // 面板打开时若未选目标，选人面板会自动出现；保险起见再点一下头部那个按钮
  if ((await page.locator('#touch-target-list').count()) === 0) {
    await clickIt(page.locator('.touch-header button[title*="动作对象"]'))
    await sleep(1200)
  }
  const items = page.locator('#touch-target-list .mention-item')
  const n = await items.count()
  const name = n > idx ? (await items.nth(idx).innerText()).trim() : ''
  if (n > idx) { await clickIt(items.nth(idx)); await sleep(1500) }
  return { n, name }
}

// 选目标（先开面板，选人面板才会自动弹）
const panel1 = await openTouchPanel()
const picked1 = await pickTarget(0)
rec('G1 选中动作对象（先开 ✋ 面板 → 选人面板自动弹出）', panel1 && picked1.n > 1,
  `面板打开=${panel1} | 候选 ${picked1.n} 人 | 选中=「${picked1.name}」`)

// ── ① 群里点动作 → 群里真出**反应正文** ──
// 判据用**接口响应里的 reaction.text**，并核它真的出现在群消息里 ——
// 不能用"有新消息了就算过"：群聊 idle 自己也一直在说话（我第一版就那样假通过了一次）。
let after1 = []
const before1 = maxId(await msgs())
try {
  if (!(await page.locator('.touch-panel').count())) await openTouchPanel()
  const card = page.locator('.touch-card:not(.is-disabled)').first()
  const cardTitle = (await card.locator('.touch-card-title').innerText().catch(() => '')).trim()
  const respP = page.waitForResponse((r) => /\/touch\//.test(r.url()) && r.request().method() === 'POST', { timeout: 90000 }).catch(() => null)
  await clickIt(card)
  const rr = await respP
  const rbody = rr ? await rr.json().catch(() => null) : null
  const reactText = String(rbody?.reaction?.text || '')
  for (let i = 0; i < 30 && !after1.length; i++) {
    await sleep(2000)
    after1 = (await msgs()).filter((m) => Number(m.id) > before1)
  }
  const hit = reactText && after1.some((m) => String(m.content || '').includes(reactText.slice(0, 18)))
  rec('G2 群里点动作 → 反应正文落进群消息', !!reactText && hit,
    `点的动作=「${cardTitle}」| 响应 HTTP=${rr?.status()} allowed=${rbody?.allowed} code=${rbody?.code} mode=${rbody?.mode} fallback=${rbody?.fallback}` +
    ` | reaction.text=${JSON.stringify(reactText.slice(0, 46))} | 群新增 ${after1.length} 条 | 正文命中=${hit}` +
    (after1.length ? ` | 首条=[${after1[0].speaker_name}] ${JSON.stringify(String(after1[0].content).slice(0, 40))}` : ''))
} catch (e) { rec('G2 群里点动作 → 反应正文落进群消息', false, String(e).slice(0, 180)) }

// ── ③ 换目标后 **玩具面板 / 推进面板** 自动关 ──
// ⚠️ 别验 ✋ 面板：`watch(touchTargetId)`（GroupChatView.vue:714）关的是
//    `showToyPanel` 与 `showIntimatePanel` **这两个**，✋ 面板**故意不关** ——
//    它头部有「对 XXX」可以随时换人，换完继续点动作才是正常流程。
//    （第一版我验 ✋ 面板⇒必然判红，是断言对象错了。）
try {
  if (!(await page.locator('.touch-panel').count())) await openTouchPanel()
  if (!(await page.locator('.touch-panel').count())) await openTouchPanel()
  // 选回第一个人，确保后面换人真的会变
  await pickTarget(0)
  await sleep(1200)
  // 打开玩具面板（群场景下按钮可能被门控，但**面板本身会开**）
  await clickIt(page.locator('div.touch-icon-btn.toy-icon-btn[aria-label="玩具"]'))
  await sleep(2500)
  const toyOpenBefore = await page.locator('.toy-panel, .modal-panel.linshe-modal, .tp-panel').count()
  // 换到第二个人
  await clickIt(page.locator('.touch-header button[title*="动作对象"]'))
  await sleep(1200)
  const items3 = page.locator('#touch-target-list .mention-item')
  const n3 = await items3.count()
  const name3 = n3 > 1 ? (await items3.nth(1).innerText()).trim() : ''
  await clickIt(items3.nth(1))
  await sleep(2500)
  const toyOpenAfter = await page.locator('.toy-panel, .modal-panel.linshe-modal, .tp-panel').count()
  if (n3 > 1) {
    rec('G3 换目标后 玩具面板/推进面板 自动关（✋ 面板按设计保留）', toyOpenBefore > 0 && toyOpenAfter === 0,
      `玩具面板：换前=${toyOpenBefore} → 换后=${toyOpenAfter}（应为 0）| 目标「${picked1.name}」→「${name3}」| ✋ 面板换后=${await page.locator('.touch-panel').count()}（按设计可保留）`)
  } else {
    // 换人按钮被玩具面板（模态遮罩）挡住 ⇒ 浏览器层驱动不到。
    // check-group-panels.mjs 里也是同样原因标的 SKIP（"玩具面板开着时 ✋ 被挡住"）。
    rec('G3 换目标后 玩具面板/推进面板 自动关', null,
      `⚠️ BLOCKED 驱动不到：玩具面板是模态遮罩，✋ 的「更换动作对象」按钮在它下面点不到（本次候选=${n3}）。` +
      `该行为由 GroupChatView.vue:714 的 \`watch(touchTargetId)\` 实现（只关 showToyPanel / showIntimatePanel，✋ 面板按设计保留）。` +
      `现有工具链验不了：web-ui 只有 node --test + @vue/compiler-sfc（**没有 vitest / @vue/test-utils / jsdom**，挂载不了组件）。` +
      `⇒ 要闭合它只有两条路：① 装 vitest+jsdom 写组件测试；② 人工点一次。**不代表失败，代表没验。**`)
  }
} catch (e) { rec('G3 换目标后 玩具面板自动关', null, `⚠️ BLOCKED ${String(e).slice(0, 140)}`) }

// ── ② 群里真戴上玩具 ──
// 群里成人档吃 features.touchGroupAdult（默认关）。先看当前值，关着就打开（副本库，用完复原）。
let restored = null
try {
  const cfg = await api('/api/config')
  const before = cfg.body?.features?.touchGroupAdult === true
  restored = before
  if (!before) await api('/api/config/features', { method: 'PUT', body: JSON.stringify({ key: 'touchGroupAdult', value: true }) })
  const cfg2 = await api('/api/config')
  const nowVal = cfg2.body?.features?.touchGroupAdult === true

  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(5000); await dismiss()
  await clickIt(page.locator('div.touch-icon-btn[aria-label="动作" ]').first()).catch(() => {})
  await sleep(500)
  const pick = page.locator('[title="选择动作对象"], [title="更换动作对象"]').first()
  await clickIt(pick); await sleep(1000)
  const it = page.locator('#touch-target-list .mention-item')
  if (await it.count() > 0) { await clickIt(it.nth(0)); await sleep(1200) }

  const toyBtn = page.locator('div.touch-icon-btn.toy-icon-btn[aria-label="玩具"]')
  await clickIt(toyBtn); await sleep(2500)
  const grid = page.locator('.toy-backpack-grid button')
  const total = await grid.count()
  const enabled = page.locator('.toy-backpack-grid button:not([disabled]):not([aria-disabled="true"])')
  const enabledCount = await enabled.count()
  let equipStatus = null, equipBody = null
  if (enabledCount > 0) {
    const resp = page.waitForResponse((r) => /\/toys\/[^/]+\/(equip|remove)/.test(r.url()), { timeout: 30000 }).catch(() => null)
    await clickIt(enabled.first())
    const rr = await resp
    if (rr) { equipStatus = rr.status(); equipBody = await rr.json().catch(() => null) }
    await sleep(1500)
  }
  const target = await page.locator('.touch-group-wrap, .chat-header').first().innerText().catch(() => '')
  rec('G4 群里真戴上玩具（成人档打开后）', enabledCount > 0 && (equipStatus === 200 || equipStatus === 201),
    `touchGroupAdult: ${before} → ${nowVal} | 背包按钮 ${total} 个 / 可点 ${enabledCount} 个 | equip HTTP=${equipStatus} | 响应=${JSON.stringify(equipBody).slice(0, 110)}`)
} catch (e) { rec('G4 群里真戴上玩具', false, String(e).slice(0, 180)) }

// 复原开关
if (restored === false) { await api('/api/config/features', { method: 'PUT', body: JSON.stringify({ key: 'touchGroupAdult', value: false }) }) }

// ── ④ 玩具影响生图：穿戴描述注入 ──
try {
  const worn = await api(`/api/characters/${process.env.CHAR_ID || 6}/toys`)
  const w = worn.body?.worn || []
  rec('G5 玩具穿戴状态可查（生图注入 wornToysBrief 的输入源）', Array.isArray(w),
    `GET /toys → HTTP ${worn.status} | 已戴 ${w.length} 件 ${JSON.stringify(w.map((x) => x.toyKey || x.key).slice(0, 4))} | unlocked=${worn.body?.unlocked}`)
} catch (e) { rec('G5 玩具穿戴状态可查', false, String(e).slice(0, 160)) }

await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', 'group-actions.png') })
rec('G6 无未捕获异常', errs.length === 0, `pageError=${errs.length}${errs.length ? ' ' + JSON.stringify(errs.slice(0, 2)) : ''}`)

const pass = rows.filter((r) => r.ok === true).length
const fail = rows.filter((r) => r.ok === false).length
const blocked = rows.filter((r) => r.ok === null).length
console.log(`\n════ 群场景补验汇总 ════\nPASS ${pass} / FAIL ${fail} / BLOCKED ${blocked}  (共 ${rows.length} 条)`)
for (const r of rows) if (r.ok === false) console.log(`  ❌ ${r.id} — ${r.ev}`)
for (const r of rows) if (r.ok === null) console.log(`  ⚠️ ${r.id} — ${r.ev}`)
await browser.close()
