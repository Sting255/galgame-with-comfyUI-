/**
 * 「再导出 ≠ 本地绑定」守卫（2026-10-02，来自真机日志的一条 error）
 *
 * 真事：`eventGenerator.js` 里有
 *     export { extractFirstJson } from './jsonExtract.js';   // 只是**再导出**
 * 而同一个文件里 533 / 1042 / 1346 行**直接调用** `extractFirstJson(...)`。
 * 再导出**不会**在本文件产生绑定 ⇒ 运行时 `extractFirstJson is not defined`，
 * 真机表现是「多人事件生成直接失败」（模型其实已经回了完整 JSON，白瞎一次调用），
 * 日志里同时出现 `[eventGen] LLM generation failed` 与 `[eventScheduler] Failed`。
 *
 * 为什么既有测试没抓到：测试都是 `import { extractFirstJson } from eventGenerator.js` —— 走的是
 * **再导出**那条路，永远是好的；没人从**本文件内部**的调用点走一遍。
 *
 * 本测试扫全仓源码：**凡是被本地调用的名字，必须在本地有真实 import**（不管它有没有被再导出）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return walk(p)
  return e.name.endsWith('.js') ? [p] : []
})

/** 去掉注释与字符串，避免把说明文字/日志里的调用当成真调用 */
const strip = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')

test('再导出的名字如果在本文件里被调用，必须有本地 import（否则就是 "X is not defined"）', () => {
  const problems = []
  for (const file of walk(SRC)) {
    const raw = fs.readFileSync(file, 'utf8')
    const code = strip(raw)

    // 本文件所有 export { A, B } from '…' 里的名字
    const reexported = new Set()
    for (const m of code.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) reexported.add(name)
      }
    }
    if (reexported.size === 0) continue

    // 本文件真实 import 进来的名字
    const imported = new Set()
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name)
      }
    }
    for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]+['"]/g)) imported.add(m[1])

    for (const name of reexported) {
      if (imported.has(name)) continue
      // 在本文件里被调用？（排除 export 语句自身与 import 语句）
      const body = code
        .replace(/export\s*\{[^}]+\}\s*from\s*['"][^'"]+['"]/g, '')
        .replace(/import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"]/g, '')
      const used = new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'm').test(body)
      if (used) {
        problems.push(`${path.relative(SRC, file)}：本地调用了 ${name}()，但只有再导出、没有 import ⇒ 运行时会 ReferenceError`)
      }
    }
  }
  assert.equal(problems.length, 0, problems.join('\n  '))
})

test('eventGenerator：extractFirstJson 有本地 import（这次真机事故的定点回归）', () => {
  const code = fs.readFileSync(path.join(SRC, 'services', 'eventGenerator.js'), 'utf8')
  assert.match(code, /import\s*\{[^}]*extractFirstJson[^}]*\}\s*from\s*['"]\.\/jsonExtract\.js['"]/,
    'eventGenerator.js 必须本地 import extractFirstJson（本文件里有直接调用）')
  // 再导出还得留着：13 处既有 `from './eventGenerator.js'` 的 import 靠它
  assert.match(code, /export\s*\{[^}]*extractFirstJson[^}]*\}\s*from\s*['"]\.\/jsonExtract\.js['"]/,
    '再导出不能删（别的模块还从 eventGenerator 取它）')
  // ⚠️ 别顺手把 repairJson 也 import 进来：这个文件里 repairJson 是**本地定义**的，
  //    再 import 一次就是 `Identifier already declared` 语法错误（我第一版就这么挂的）。
  assert.doesNotMatch(code, /import\s*\{[^}]*repairJson[^}]*\}\s*from\s*['"]\.\/jsonExtract\.js['"]/,
    'repairJson 在本文件里是本地定义，不要再 import（会重复声明）')
})
