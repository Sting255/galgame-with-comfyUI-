/**
 * 审查 §2.3 前端一半：上下文面板显示「稳定前缀指纹 vs 上一轮」
 *
 * 后端契约（GET /api/context/usage 顶层，**纯加法、可为 null**，键序锁定）：
 *   … updatedAt, stablePrefixHash, fullPrefixHash, requestHash, breakdown, breakdownCalibrated
 * 显示口径（后端写手）：与**上一轮同会话**比 ——
 *   · stablePrefixHash 变 → 「稳定前缀变化」（要重新算前缀，缓存不命中）
 *   · 只有 requestHash 变、stablePrefixHash 不变 → 「仅动态尾部变化」（不破坏前缀缓存）
 * 基准：**后端下发值做前端内存缓存**，刷新页面丢缓存属正常，**不做持久化**（否则误报变化）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

import { prefixFingerprintVerdict, normalizeUsage } from '../src/utils/contextUsage.js'

const panelFile = readFileSync(new URL('../src/components/ContextUsagePanel.vue', import.meta.url), 'utf8')
const panel = parseSfc(panelFile).descriptor
const panelTemplate = panel.template.content
const panelScript = panel.scriptSetup.content
const panelStyle = panelFile.slice(panelFile.indexOf('<style'))

const ok = (stablePrefixHash, fullPrefixHash, requestHash) => ({ stablePrefixHash, fullPrefixHash, requestHash })

test('无指纹（旧后端 / 首轮）→ unknown，不给结论、不误报', () => {
  assert.equal(prefixFingerprintVerdict(null, null).state, 'unknown')
  assert.equal(prefixFingerprintVerdict(undefined, ok(null, null, null)).state, 'unknown')
  assert.equal(prefixFingerprintVerdict(ok(null, null, null), ok(null, null, null)).state, 'unknown')
  assert.equal(prefixFingerprintVerdict(ok(null, null, null), ok(null, null, null)).text, '', '不显示')
})

test('有本轮但没上轮 → first（首轮，不误报成变化）', () => {
  const v = prefixFingerprintVerdict(null, ok('aaa', 'bbb', 'ccc'))
  assert.equal(v.state, 'first')
  assert.ok(v.text.includes('首轮'))
})

test('stablePrefixHash 变 → stable-changed（缓存会不命中）', () => {
  const v = prefixFingerprintVerdict(ok('old', 'f1', 'r1'), ok('new', 'f1', 'r2'))
  assert.equal(v.state, 'stable-changed')
  assert.ok(v.text.includes('稳定前缀变化'))
})

test('stablePrefixHash 不变、只有 requestHash 变 → tail-only（不破坏前缀缓存）', () => {
  const v = prefixFingerprintVerdict(ok('same', 'f1', 'r1'), ok('same', 'f1', 'r2'))
  assert.equal(v.state, 'tail-only')
  assert.ok(v.text.includes('仅动态尾部变化'))
})

test('三个都一致 → same', () => {
  const v = prefixFingerprintVerdict(ok('s', 'f', 'r'), ok('s', 'f', 'r'))
  assert.equal(v.state, 'same')
  assert.ok(v.text.includes('一致'))
})

test('fullPrefixHash 变而 stablePrefixHash 没变 → 也算稳定前缀变化（整段前缀动了）', () => {
  const v = prefixFingerprintVerdict(ok('s', 'f1', 'r1'), ok('s', 'f2', 'r1'))
  assert.equal(v.state, 'stable-changed')
  assert.ok(v.detail.includes('fullPrefixHash'))
})

test('指纹字段缺失 / 类型怪 → 不炸，走 unknown 或保守分支', () => {
  assert.doesNotThrow(() => prefixFingerprintVerdict({}, {}))
  assert.equal(prefixFingerprintVerdict({}, {}).state, 'unknown')
  assert.equal(prefixFingerprintVerdict(ok(1, 2, 3), ok(1, 2, 3)).state, 'same', '非字符串也按值比较')
})

test('normalizeUsage 透传三个指纹字段（纯加法，缺失保持 null）', () => {
  const u = normalizeUsage({ usedTokens: 10, stablePrefixHash: 'a', fullPrefixHash: 'b', requestHash: 'c' })
  assert.equal(u.stablePrefixHash, 'a')
  assert.equal(u.fullPrefixHash, 'b')
  assert.equal(u.requestHash, 'c')
  const empty = normalizeUsage({ usedTokens: 10 })
  assert.equal(empty.stablePrefixHash, null, '旧后端没这三字段 → null，不报错')
  assert.equal(empty.fullPrefixHash, null)
  assert.equal(empty.requestHash, null)
})

test('面板：模板里有一行指纹结论，且带结论状态类名（便于按状态上色）', () => {
  const compiled = compileTemplate({ source: panelTemplate, filename: 'ContextUsagePanel.vue', id: 'cu' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(panelTemplate.includes('ctx-usage__fingerprint'), '要有指纹那一行')
  assert.ok(panelTemplate.includes('fingerprint.text'), '文案来自纯函数')
  assert.ok(panelTemplate.includes('fingerprint.state'), '状态进类名')
})

test('面板：内存缓存上一轮，按会话隔离，切会话不串；不落 localStorage', () => {
  assert.ok(panelScript.includes('prefixFingerprintVerdict'), '要用纯函数')
  assert.ok(/conversationId/.test(panelScript))
  assert.equal(/localStorage|sessionStorage/.test(panelScript), false, '基准不许持久化（会误报变化）')
  assert.ok(/prevUsage|lastUsage|previousUsage/.test(panelScript), '要有「上一轮」缓存')
})

test('面板：双主题 + 不硬编码颜色', () => {
  assert.ok(panelStyle.includes('ctx-usage__fingerprint'), '要有样式')
  assert.ok(panelStyle.includes('ctx-usage__fingerprint'), '样式在')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(panelStyle.slice(panelStyle.indexOf('ctx-usage__fingerprint'), panelStyle.indexOf('ctx-usage__fingerprint') + 600)), false, '指纹那几行不许硬编码 hex')
})
