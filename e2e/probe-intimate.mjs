/** 最小探针：❤ 入口点击到底有没有生效（2026-10-02，复现"性爱按钮点不出来"） */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3199'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 200)) })

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 找到第一个角色并进聊天
const charItem = page.locator('.char-item, .character-item, [class*="char-card"]').first()
if (await charItem.count()) { await charItem.click().catch(() => {}); await page.waitForTimeout(1500) }

const heart = page.locator('.intimate-icon-btn')
console.log('❤ 入口数量 =', await heart.count())
if (await heart.count()) {
  const box = await heart.first().boundingBox()
  console.log('  boundingBox =', JSON.stringify(box))
  // 看它中心点上"最上层"的元素是谁 —— 被遮挡是这类"点了没反应"的头号原因
  if (box) {
    const topEl = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return el ? (el.tagName + '.' + String(el.className || '').slice(0, 80)) : 'null'
    }, [box.x + box.width / 2, box.y + box.height / 2])
    console.log('  中心点最上层元素 =', topEl)
  }
  const before = await page.locator('.ia-panel').count()
  await heart.first().click({ timeout: 3000 }).catch((e) => console.log('  ✗ click 抛错：' + String(e.message).slice(0, 120)))
  await page.waitForTimeout(1200)
  const after = await page.locator('.ia-panel').count()
  console.log(`  .ia-panel：点击前=${before} 点击后=${after}`)
  const html = await page.locator('.ia-panel').first().innerHTML().catch(() => '(取不到)')
  console.log('  面板 HTML 片段 =', String(html).replace(/\s+/g, ' ').slice(0, 160))
  const chips = await page.locator('.ia-chip').count()
  console.log('  .ia-chip 数量 =', chips)
  // 强制派发一次点击（绕过 Playwright 的可操作性检查）看是不是遮挡问题
  if (after === 0) {
    await heart.first().dispatchEvent('click').catch(() => {})
    await page.waitForTimeout(1000)
    console.log('  强制 dispatchEvent 后 .ia-panel =', await page.locator('.ia-panel').count())
  }
}
console.log('页面错误 =', errs.length ? errs.slice(0, 5) : '无')
await browser.close()
