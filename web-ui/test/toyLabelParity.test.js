/**
 * 玩具文案契约（2026-10-02 用户截图事故的回归）
 *
 * ## 事故是什么
 * 用户截图里，**第二批 6 件玩具在面板上显示的是英文 key**（`clit_sucker` / `anal_beads` /
 * `g_spot_vibe` / `nipple_sucker` / `chain_clamp` / `thigh_vibe`），背包胶囊还出现
 * 「clit_sucker · · 最多 5 档」这种**双点**（label 与 part 双双为空 ⇒ 回落显示 key）。
 * 成因：面板的玩具信息（label/part）走**前端镜像表** `toyLogic.js` 查，而那一版产物里
 * 镜像表还没有这 6 件（服务端 `catalog` 已经有 ⇒ 面板列得出来、查不到名字）。
 * 另一个真 bug：项圈是**象征物**（`maxIntensity: 0` 是刻意的），模板却直写
 * 「最多 {{ maxIntensity }} 档」⇒ 显示成「项圈 · 颈部 · 最多 0 档」，看起来像坏了。
 *
 * ## 这份测试钉什么
 * ① 前端镜像的 label / part **必须是中文**（正则挡英文 key 漏进文案层）；
 * ② 前端镜像与**后端 catalog 逐字段一致**（key/label/part/maxIntensity）——
 *    后端是唯一事实来源，镜像漏一件就红（这次事故正是"漏了一件"）；
 * ③ 没有强度档的玩具（项圈）文案要说清"它不是靠档位玩的"，且面板必须走同一个 helper；
 * ④ 后端自己的 label 也要是中文（双保险，谁漏都红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { TOYS, EXTRA_TOYS, ALL_TOYS, intensityCapText, maxIntensityOf, hasIntensity } from '../src/components/toyLogic.js'

const HAN = /[\u4e00-\u9fff]/
// 后端源码目录必须**相对本测试文件**定位，不许写绝对路径。
// 为什么：这里原本硬编码了开发机的 `<ComfyUI 安装目录>`，
// 换机器（迁移到 <项目根>）后该路径不存在 ⇒ import 期 ENOENT ⇒ 本文件 5 个用例全灭、
// 前端总数从 662 掉到 658。改成 URL 相对后与仓库放在哪个盘无关（同文件 L116 已是这个写法）。
// 注意结尾斜杠：parseBackendToys 传的是相对片段（'toyService.js' / 'toy/catalog.js'）。
const CORE = new URL('../../agent-core/src/services/', import.meta.url)

/**
 * 从后端源码里抠出每件玩具的关键字段。
 * 只按既有排版取（每件的 `key: 'x', label: '…'` 一行、`maxIntensity: N` 紧跟在后面几行内），
 * 抠不出预期条数就直接失败 —— 免得排版一变测试变成"永远绿"。
 */
function parseBackendToys(relPath) {
  const src = fs.readFileSync(new URL(relPath, CORE), 'utf8')
  const lines = src.split(/\r?\n/)
  const out = new Map()
  let current = null
  for (const line of lines) {
    const head = line.match(/key:\s*'([a-z_0-9]+)'\s*,\s*label:\s*'([^']+)'/)
    if (head) {
      current = { key: head[1], label: head[2], part: null, maxIntensity: null }
      out.set(current.key, current)
      const partInline = line.match(/part:\s*'([^']+)'/)
      if (partInline) current.part = partInline[1]
      continue
    }
    if (!current) continue
    if (current.part == null) {
      const p = line.match(/part:\s*'([^']+)'/)
      if (p) { current.part = p[1]; continue }
    }
    if (current.maxIntensity == null) {
      const m = line.match(/maxIntensity:\s*(\d+)/)
      if (m) { current.maxIntensity = Number(m[1]); current = null }
    }
  }
  // `catalog.js` 里的 `STIMULUS_KINDS`（刺激类型：`key: 'vibration', label: '震动'`）排版与玩具**一模一样**，
  // 会被上面一起抠进来 —— 它们的特征是**没有 `maxIntensity`**，按这个滤掉。
  for (const [key, toy] of [...out]) {
    if (toy.maxIntensity == null) out.delete(key)
  }
  return out
}

const backendLegacy = parseBackendToys('toyService.js')       // 首期 5 件（在 toyService 里）
const backendExtra = parseBackendToys('toy/catalog.js')       // 第二批 6 件（在 catalog 里）
const backendAll = new Map([...backendLegacy, ...backendExtra])

test('① 前端镜像的 label / part 必须是中文（英文 key 不许漏进文案层）', () => {
  for (const [key, toy] of Object.entries(ALL_TOYS)) {
    assert.match(toy.label, HAN, `${key} 的 label 必须是中文，实际「${toy.label}」`)
    assert.match(toy.part, HAN, `${key} 的 part 必须是中文，实际「${toy.part}」`)
  }
  assert.equal(Object.keys(TOYS).length, 5, '首期 5 件不许动')
  assert.equal(Object.keys(EXTRA_TOYS).length, 6, '第二批 6 件')
  assert.equal(Object.keys(ALL_TOYS).length, 11, '合起来 11 件')
})

test('② 后端 catalog 的 label / part 也必须是中文', () => {
  assert.equal(backendAll.size, 11, `后端应能解析出 11 件，实际 ${backendAll.size}（排版改了要同步改本测试的抠法）`)
  for (const [key, toy] of backendAll) {
    assert.match(toy.label, HAN, `后端 ${key} 的 label 必须是中文，实际「${toy.label}」`)
    assert.match(toy.part || '', HAN, `后端 ${key} 的 part 必须是中文，实际「${toy.part}」`)
  }
})

test('③ 镜像与后端逐字段一致（漏一件/改一处就红 —— 用户截图事故正因"漏了 6 件"）', () => {
  for (const [key, backend] of backendAll) {
    const mirror = ALL_TOYS[key]
    assert.ok(mirror, `前端镜像缺 ${key}（后端有、前端没有 ⇒ 面板会回落显示英文 key）`)
    assert.equal(mirror.label, backend.label, `${key} 的 label 不一致`)
    assert.equal(mirror.part, backend.part, `${key} 的 part 不一致`)
    assert.equal(mirror.maxIntensity, backend.maxIntensity, `${key} 的 maxIntensity 不一致`)
  }
  for (const key of Object.keys(ALL_TOYS)) {
    assert.ok(backendAll.has(key), `前端多了后端没有的 ${key}`)
  }
})

test('④ 没有强度档的玩具（项圈）文案要说清，而不是报 0 档', () => {
  assert.equal(maxIntensityOf('collar'), 0, '项圈的 0 是刻意的（象征物）')
  assert.equal(hasIntensity('collar'), false)
  assert.equal(intensityCapText('collar'), '象征物 · 无强度档')
  assert.equal(intensityCapText({ key: 'collar', maxIntensity: 0 }), '象征物 · 无强度档')
  assert.equal(intensityCapText('vibe_egg'), '最多 5 档')
  assert.equal(intensityCapText({ key: 'clit_sucker', maxIntensity: 5 }), '最多 5 档')
  for (const key of Object.keys(ALL_TOYS)) {
    const text = intensityCapText(key)
    assert.doesNotMatch(text, /最多 0 档/, `${key} 不许显示"最多 0 档"`)
    assert.ok(text.length > 0)
  }
})

test('⑤ 面板必须走同一个 helper（不许再在模板里直写"最多 {{ N }} 档"）', () => {
  const panel = fs.readFileSync(new URL('../src/components/ToyPanel.vue', import.meta.url), 'utf8')
  const code = panel.replace(/<!--[\s\S]*?-->/g, '')
  assert.match(code, /intensityCapText\(/, '背包胶囊要用 intensityCapText')
  assert.doesNotMatch(code, /最多 \{\{/, '不许直写"最多 {{ … }} 档"（项圈会显示成 0 档）')
})
