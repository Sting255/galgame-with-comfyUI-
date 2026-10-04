/**
 * 动作出图概率：默认值调高 + 可整体缩放（2026-10-01，用户「需要把所有和生图相关的都看看 其他地方好像还是有限制」）
 *
 * ## 审计结论（生图链路上真正像"限制"的东西）
 * 1. **智能档概率**（本轮修）：`SMART_IMAGE_CHANCE = {2:0.25, 3:0.5, 4:0.6}`、Lv1 永不出图 ⇒
 *    点四下摸头才可能出一张图 —— 这是用户最容易感知的那条"限制"。现在调成 `{2:0.5, 3:0.75, 4:0.9}`
 *    并可由 `config.features.touchImageChanceScale` 整体缩放（调用方传参，模块保持零依赖）。
 * 2. **低优静默期** 180s / 低优兜底 10 分钟（`imageSkill`）：**不是拦截** —— 超过上限会"跳过静默期直接派发"，
 *    痛点是后台图排队久，属延迟问题，本轮不动（已在上轮文档里更正过口径）。
 * 3. **prompt 必须英文**：SD 的硬要求，不是可放宽的限制（要中文描述得先翻译，属另一件事）。
 * 4. **每会话判定配额**：上轮已从硬编码 3 改成可配、默认 6。
 *
 * ## 本文件钉住什么
 * - 概率默认值、"Lv1 永不出图"、always/never 短路、以及缩放系数（含非法值回落与上限夹 1）；
 * - 缩放系数必须**由调用方传入**（模块零依赖这条契约不能被破坏）；
 * - 配置侧默认值与注册。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-imgchance-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const svc = await import('../src/services/touchActionService.js')
const readSrc = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
/**
 * 扫源码前**先剥注释**。
 * 本仓已经在这上面栽了四次：注释里为了解释历史会写出被禁止的字符串本身
 * （`?? 3` / `matrix.body_control` / `new Date()` / `config.features`），
 * 结果"不许出现 X"的断言被自己的注释绊倒。凡是源码扫描，一律走这个函数。
 */
const readCode = (rel) => readSrc(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

test('① 默认概率已调高，且 Lv1 仍不出图（摸头不出特写是刻意的）', () => {
  assert.deepEqual({ ...svc.SMART_IMAGE_CHANCE }, { 2: 0.5, 3: 0.75, 4: 0.9 }, '默认概率要调高')
  assert.equal(svc.touchImageChanceFor(1), 0, 'Lv1 永不出图')
  assert.equal(svc.touchImageChanceFor(2), 0.5)
  assert.equal(svc.touchImageChanceFor(4), 0.9)
  assert.equal(svc.touchImageChanceFor(99), 0, '未定义的等级不出图')
})

test('② 缩放系数：合法值放大、非法值回落 1、结果夹到 1', () => {
  assert.equal(svc.touchImageChanceFor(2, 2), 1, '0.5×2 夹到 1')
  assert.equal(svc.touchImageChanceFor(2, 1.5), 0.75)
  assert.equal(svc.touchImageChanceFor(4, 0.5), 0.45, '调小也生效')
  for (const bad of [0, -3, NaN, 'abc', null, undefined, '']) {
    assert.equal(svc.touchImageChanceFor(2, bad), 0.5, `非法缩放 ${String(bad)} 应回落到 1`)
  }
  // Infinity/超大值：**按非法值回落到 1**（而不是夹到 1）。
  // 理由：配置写崩了不该静默变成"每次动作都出图"——那会把 ComfyUI 打爆。
  // 真想要每次都出，用三档开关的 always。
  assert.equal(svc.touchImageChanceFor(2, Infinity), 0.5, 'Infinity 按非法值回落，不夹到 1')
  assert.equal(svc.touchImageChanceFor(2, 1e9), 1, '有限的大数才夹到 1')
})

test('③ 零依赖契约：模块自己不许读 config，缩放必须由调用方传', () => {
  const code = readCode('services/touchActionService.js') // 必须剥注释，见文件头的教训
  const imports = code.match(/^import .*$/gm) || []
  assert.deepEqual(imports, [], `本模块设计上零依赖，不许出现 import，实际：${imports.join(' | ')}`)
  assert.equal(/config\.features/.test(code), false, '不许在模块里读 config（文件头写明了）')
  assert.match(code, /export function touchImageChanceFor\(level, scale = 1\)/, '缩放走参数')
  // 调用方必须把配置传进来
  const route = readCode('routes/touch.js')
  assert.match(route, /chanceScale: config\.features\?\.touchImageChanceScale/, 'routes/touch.js 要传缩放系数')
  assert.match(route, /shouldGenerateTouchImage\(\{[\s\S]{0,200}chanceScale:/, '传参位置要对')
})

test('④ 概率判定：random 可注入，边界按 <chance 判（等于概率值时不出）', () => {
  const L2 = svc.TOUCH_IMAGE_MODES
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'always', level: 1, random: () => 0.999 }), true, 'always 短路')
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'never', level: 4, random: () => 0.001 }), false, 'never 短路')
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0.49 }), true)
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0.5 }), false, '等于概率值不出')
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0.1, enabled: false }), false, '总开关关着一律不出')
  // 缩放 0.1 ⇒ Lv2 概率 0.05：0.04 出、0.06 不出
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0.04, chanceScale: 0.1 }), true, '缩放后 0.05 仍有 4% 命中')
  assert.equal(svc.shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0.06, chanceScale: 0.1 }), false, '超过缩放后概率就不出')
  assert.equal(L2.SMART, 'smart', '三态常量不变')
})

test('⑤ 配置侧：默认 1 + 注册进 SETTING_TO_CONFIG', async () => {
  assert.match(readSrc('config.js'), /touchImageChanceScale: Number\(process\.env\.FEATURE_TOUCH_IMAGE_CHANCE_SCALE \|\| 1\)/,
    'config.features 要有缩放系数，默认 1')
  assert.match(readSrc('db/settings.js'), /feature_touchImageChanceScale:\s*\{[^}]*key: 'touchImageChanceScale'[^}]*type: 'float'/,
    '要注册（否则设置页改了重启就丢）')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
