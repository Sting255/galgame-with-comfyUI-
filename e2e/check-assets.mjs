/**
 * 静态资源体检（2026-10-02）：抓出页面上的 404 / 网络失败，并逐个 HTTP 校验字体分块。
 *
 * 跑法（在 e2e 目录）：..\runtime\nodejs\node.exe check-assets.mjs
 * 或从仓库根：         ..\runtime\nodejs\node.exe e2e\check-assets.mjs
 *
 * 前提：后端已在 http://127.0.0.1:3199 跑着（地址用环境变量 E2E_BASE 覆盖）。
 *      ⚠️ 端口要跟**你实际起服务的那个**一致：日常 launcher 起的是 3099，E2E 用 3399，
 *         本脚本默认 3199（早期交付包口径）。不对上会一路 404，看起来像产物坏了。
 *
 * 它做三件事：
 *   ① 浏览器侧：监听所有 response(status>=400) 与 requestfailed，走一遍「首页 → 私聊 → 玩具面板」，
 *      把**全部失败请求**连 URL / 状态 / 资源类型一起打出来（不看控制台文案，直接看网络层）。
 *   ② HTTP 侧：把产物目录里每个 .woff2 逐个请求 /assets/<文件名>，统计 200 与非 200 清单，
 *      并抽查若干块的内容长度 > 0。
 *   ③ 核对 index.html 引用的 /assets/*.js 与 *.css 是否真的 200（防"引用到旧哈希"）。
 *
 * 只读：不改源码、不写交付包；新文件只落在 e2e/ 下。
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3199'
// 产物目录必须**相对本脚本**定位（脚本在 <repo>/e2e/ ⇒ 仓库根是它的上一层）。
// 为什么：这里原本硬编码旧机器的交付目录 `C:/3.6.2-r/agent-core/public`，
// 换机器后该目录不存在 ⇒ 下面 L91 的 readdirSync(ASSET_DIR) 直接 ENOENT 崩掉，
// 整个"静态资源体检"在本机形同废纸。
const REPO = path.resolve(import.meta.dirname, '..')
const PUBLIC_DIR = path.join(REPO, 'agent-core', 'public')
const ASSET_DIR = path.join(PUBLIC_DIR, 'assets')
const INDEX = path.join(PUBLIC_DIR, 'index.html')

const failures = []   // { url, status, type, note }
const netFail = []    // 网络层失败（DNS/超时/被拒）

// ── ① 浏览器侧 ───────────────────────────────────────────────────────────
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

page.on('response', (res) => {
  const status = res.status()
  if (status >= 400) {
    failures.push({ url: res.url(), status, type: res.request().resourceType(), note: '' })
  }
})
page.on('requestfailed', (req) => {
  netFail.push({ url: req.url(), status: '-', type: req.resourceType(), note: req.failure()?.errorText || '' })
})
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

console.log('── ① 浏览器侧：首页 → 私聊 → 玩具面板 ─────────────────────')
// ⚠️ 不要用 networkidle：这个页面有 SSE + 轮询，永远等不到 networkidle（第一版就卡在这里 30 秒，
//    结果"没进成聊天"，玩具面板那一步也就点不到）。用 domcontentloaded + 显式等元素。
await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('  goto 警告：' + e.message.slice(0, 120)))
await page.waitForTimeout(3000)

// 进一次私聊（选择器与 e2e/probe-intimate.mjs 一致 —— 那套是真跑通过的）
const charItem = page.locator('.char-item, .character-item, [class*="char-card"]').first()
if (await charItem.count()) {
  await charItem.click().catch(() => {})
  await page.waitForTimeout(2000)
  console.log('  已尝试进入私聊')
} else {
  console.log('  ⚠️ 没找到角色列表项，跳过一次私聊步骤（不影响 404 抓取）')
}

// 开一次玩具面板（等它出现再点，别再干等 30 秒）
const toy = page.locator('.toy-icon-btn')
await toy.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
if (await toy.count()) {
  await toy.first().click({ timeout: 5000 }).catch((e) => console.log('  🧸 点击失败：' + e.message.slice(0, 90)))
  await page.waitForTimeout(1500)
  console.log('  玩具面板步骤完成（panel 数 = ' + (await page.locator('.toy-panel, [class*="toy-panel"]').count()) + '）')
}
// 开一次性爱面板（面板里也会拉头像/表情等资源）
const heart = page.locator('.intimate-icon-btn')
await heart.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
if (await heart.count()) {
  await heart.first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
  console.log('  性爱面板步骤完成（.ia-panel 数 = ' + (await page.locator('.ia-panel').count()) + '）')
}
await page.waitForTimeout(1500)
await browser.close()

console.log(`\n  浏览器侧失败请求 ${failures.length} 条 / 网络层失败 ${netFail.length} 条 / 页面 JS 报错 ${pageErrors.length} 条`)
if (pageErrors.length) for (const e of pageErrors.slice(0, 5)) console.log('    [pageerror] ' + e)
console.log('\n  ── 全部 HTTP >=400 ──')
if (!failures.length) console.log('    （没有）')
for (const f of failures) console.log(`    ${f.status}  ${f.type.padEnd(10)}  ${f.url}`)
console.log('\n  ── 全部网络层失败（DNS/超时/被拒）──')
if (!netFail.length) console.log('    （没有）')
for (const f of netFail) console.log(`    ${f.note.padEnd(28)} ${f.type.padEnd(10)}  ${f.url}`)

// ── ② 字体分块逐个校验 ──────────────────────────────────────────────────
console.log('\n── ② 字体分块逐个 HTTP 校验 ────────────────────────────────')
const woff2 = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.woff2'))
console.log(`  产物里 .woff2 共 ${woff2.length} 个`)

const bad = []
let ok200 = 0
let zeroLen = 0
const CONC = 16
let cursor = 0
async function worker() {
  while (cursor < woff2.length) {
    const name = woff2[cursor++]
    const url = `${BASE}/assets/${encodeURIComponent(name)}`
    try {
      const res = await fetch(url)
      const buf = await res.arrayBuffer()
      if (res.status !== 200) bad.push({ name, status: res.status, len: buf.byteLength })
      else { ok200 += 1; if (buf.byteLength === 0) zeroLen += 1 }
    } catch (e) {
      bad.push({ name, status: 'ERR', len: 0, err: e.message.slice(0, 80) })
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
console.log(`  200 = ${ok200} / ${woff2.length} | 非 200 = ${bad.length} | 内容长度 0 = ${zeroLen}`)
if (bad.length) { console.log('  非 200 清单：'); for (const b of bad.slice(0, 20)) console.log(`    ${b.status}  ${b.name}`) }

// 抽查 3 个分块的内容长度
console.log('  抽查内容长度（前 3 个）：')
for (const name of woff2.slice(0, 3)) {
  const buf = await (await fetch(`${BASE}/assets/${encodeURIComponent(name)}`)).arrayBuffer()
  console.log(`    ${name}  →  ${buf.byteLength} 字节  ${buf.byteLength > 0 ? '✓' : '✗'}`)
}

// ── ③ index.html 引用的 /assets/*.js|css 是否 200 ────────────────────────
console.log('\n── ③ index.html 引用核对 ──────────────────────────────────')
const html = fs.readFileSync(INDEX, 'utf8')
const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
for (const r of refs) {
  const res = await fetch(BASE + r)
  const buf = await res.arrayBuffer()
  const disk = path.join(PUBLIC_DIR, r.replace(/^\//, ''))
  const onDisk = fs.existsSync(disk)
  console.log(`    ${res.status}  ${String(buf.byteLength).padStart(9)} 字节  磁盘存在=${onDisk}  ${r}`)
}
const allRefsOk = (await Promise.all(refs.map(async (r) => (await fetch(BASE + r)).status === 200))).every(Boolean)
console.log(`  结论：${allRefsOk ? '✓ 全部 200，没有引用到旧哈希' : '✗ 有引用不是 200'}`)

// ── 汇总 ────────────────────────────────────────────────────────────────
// 断言（用户 2026-10-02 要求）：**产物类资源一个都不许 404**。
// 图片 404 是数据侧死链（库里 606 条 /images/** 引用指向已被清理的图）⇒ 允许存在；
// 但 js / css / woff2 一旦 404，就是"产物缺失或引用到旧哈希"，必须当场判红。
const ASSET_EXT = /\.(js|css|woff2|woff|ttf|otf|mjs|map)(\?|#|$)/i
const ASSET_TYPES = new Set(['script', 'stylesheet', 'font'])
const assetFailures = [...failures, ...netFail].filter((f) => ASSET_EXT.test(f.url) || ASSET_TYPES.has(f.type))
const imageFailures = failures.filter((f) => f.type === 'image')

console.log('\n══════════════════════════════════════════════════════')
console.log(`  404/4xx/5xx：${failures.length} 条（其中图片 ${imageFailures.length} 条）`)
console.log(`  网络层失败：${netFail.length} 条`)
console.log(`  字体分块：${ok200}/${woff2.length} 个 200，非 200 ${bad.length} 个，零长度 ${zeroLen} 个`)
console.log(`  index.html 引用：${refs.length} 个，${allRefsOk ? '全部 200' : '存在非 200'}`)
if (assetFailures.length) {
  console.log(`\n  ✗ 产物类资源出现失败（不被允许）：${assetFailures.length} 条`)
  for (const f of assetFailures.slice(0, 10)) console.log(`    ${f.status}  ${f.type}  ${f.url}`)
} else {
  console.log('  ✓ 产物类资源（js / css / woff2）零失败 —— 图片 404 属数据侧死链，按约定允许')
}
console.log('══════════════════════════════════════════════════════')

// 退出码：产物类资源出问题 / index 引用非 200 / 字体缺块 ⇒ 非 0（门禁脚本可直接判红）
if (assetFailures.length || !allRefsOk || bad.length > 0) process.exitCode = 1
