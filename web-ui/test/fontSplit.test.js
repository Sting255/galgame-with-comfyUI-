/**
 * 字体分块回归守卫（2026-10-02）
 *
 * 背景（用户 2026-10-02：「前端要下 8.6 MB 字体」）：
 *   原来 fonts.css 直接引两个整包（Regular 4.26 MB + Bold 4.37 MB）⇒ 首屏全下。
 *   现在改成 cn-font-split 切出的 unicode-range 分块：只下用到的字所在的那几块。
 *
 * 这个测试守住三件事（都是"改回去就悄悄变慢"的那类退化）：
 *   ① fonts.css 引的是分块 CSS，**不能**再直接引整包 woff2；
 *   ② 每条 @font-face 都带 unicode-range（有裸 face 就会匹配所有字符 ⇒ 又把整包拖下来）；
 *   ③ CSS 里 url() 指向的每个分块文件都真的存在（缺块 = 那批字变方块）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const FONT_DIR = path.join(here, '..', 'src', 'assets', 'fonts')
const read = (p) => fs.readFileSync(p, 'utf8')

test('① fonts.css 引分块 CSS，不再引整包字体', () => {
  const css = read(path.join(FONT_DIR, 'fonts.css'))
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')   // 注释里会提到整包文件名，先去掉
  assert.match(code, /@import\s+['"]\.\/split\/Regular\/harmony-regular\.css['"]/, '要 import 分块 CSS（Regular）')
  assert.match(code, /@import\s+['"]\.\/split\/Bold\/harmony-bold\.css['"]/, '要 import 分块 CSS（Bold）')
  assert.doesNotMatch(code, /url\(['"]?\.\/HarmonyOS_Sans_SC_(Regular|Bold)\.woff2/, '不许再直接引整包 woff2（会让首屏下 8.6 MB）')
})

for (const weight of ['Regular', 'Bold']) {
  const cssFile = path.join(FONT_DIR, 'split', weight, `harmony-${weight.toLowerCase()}.css`)

  test(`② ${weight}：每条 @font-face 都带 unicode-range（没有裸 face）`, () => {
    const css = read(cssFile)
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) || []
    assert.ok(faces.length > 50, `${weight} 应当是分块产物（>50 条 face），实际 ${faces.length}`)
    const bare = faces.filter((f) => !/unicode-range\s*:/.test(f))
    assert.equal(bare.length, 0, `有 ${bare.length} 条 face 没写 unicode-range ⇒ 浏览器会把整包下下来`)
    for (const f of faces) {
      assert.match(f, /font-family\s*:\s*["']HarmonyOS Sans SC["']/, `${weight} 的 family 必须与原来一致`)
    }
    assert.match(faces[0], new RegExp(`font-weight\\s*:\\s*${weight === 'Bold' ? 700 : 400}`), `${weight} 的字重要对`)
  })

  test(`③ ${weight}：CSS 里 url() 指向的分块文件都存在`, () => {
    const css = read(cssFile)
    const urls = [...css.matchAll(/url\(["']?\.\/([^"')]+)["']?\)/g)].map((m) => m[1])
    assert.ok(urls.length > 50, `${weight} 应当引用了分块文件，实际 ${urls.length}`)
    const missing = urls.filter((u) => !fs.existsSync(path.join(FONT_DIR, 'split', weight, u)))
    assert.equal(missing.length, 0, `缺 ${missing.length} 个分块文件：${missing.slice(0, 3).join(', ')}`)
    // 单块体积上限：出现"整包大小"的块就说明切片退化了
    const big = urls
      .map((u) => ({ u, size: fs.statSync(path.join(FONT_DIR, 'split', weight, u)).size }))
      .filter((x) => x.size > 400 * 1024)
    assert.equal(big.length, 0, `有 ${big.length} 个分块超过 400 KB（切片退化，首屏又变慢）：${big.map((b) => b.u).join(', ')}`)
  })
}
