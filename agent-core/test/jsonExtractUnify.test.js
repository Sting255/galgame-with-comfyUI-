/**
 * LLM JSON 容错解析统一口径 + 情绪评估那条静默失败（2026-10-01 第十八轮）
 *
 * ## 背景（真实日志里唯一一条 `[error]`）
 * ```
 * L4143: {"vad_delta":{"valence":0.05,"arousal":0.1,"dominance":-0.05},"dominant_emotion":"surprise",…}
 * L4147: [error] [emotionEngine] LLM evaluate failed: Unexpected non-whitespace character after JSON at position 169
 * L4158: │ 💬 (LLM 评估失败，返回零 delta)
 * ```
 * 同一毫秒里既有**可用的解析结果**、又宣布解析失败 —— 因为旧容错取的是
 * "第一个 `{` 到**最后**一个 `}`"，把**尾部多余字符**一起切进去，二次解析照样失败，
 * 于是落到外层 catch **静默返回零 delta**（那一轮好感度/情绪白丢，且日志只留一行 message）。
 *
 * ## 修法
 * 统一走 `jsonExtract.extractFirstJson`（括号配对扫描，**第一个配平处收手**）。
 * 顺带把扫描器从 `eventGenerator.js` 抽成独立小模块：本仓 `eventGenerator` import 时会连带拉起
 * 生图栈（`imageSkill` → `comfyClient` 会去打 ComfyUI `/object_info`），情绪评估不该被拖上那套依赖。
 * `eventGenerator` 仍原样再导出，13 处既有 import 不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-jsonex-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { extractFirstJson } = await import('../src/services/jsonExtract.js')

const readSrc = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

test('① 核心场景：合法 JSON + 尾部多余字符（真机那条 error 的成因）', () => {
  const scoped = '{"vad_delta":{"valence":0.05,"arousal":0.1,"dominance":-0.05},"dominant_emotion":"surprise"}'
  const parses = (s) => { try { JSON.parse(s); return true } catch { return false } }

  // A 类：尾部**还有花括号** ⇒ 旧写法（第一个 { 到最后一个 }）会把垃圾切进来 ⇒ 必然失败（真机就是这种）
  for (const tail of ['}', '}\n}', '} 以及一点解释', '}}\n']) {
    const raw = scoped + tail
    const oldWay = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    assert.equal(parses(oldWay), false, `A 类尾部要能复现旧写法的失败：${JSON.stringify(tail)}`)
    assert.equal(extractFirstJson(raw), scoped, `新口径在第一个配平处收手：${JSON.stringify(tail)}`)
  }

  // B 类：尾部没有花括号 ⇒ 旧写法恰好也能切对。新口径**结果必须一致**（不能为了修 A 类而改坏 B 类）
  for (const tail of [' extra text', '\n\n', ' 好的', '\t']) {
    const raw = scoped + tail
    const oldWay = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    assert.equal(parses(oldWay), true, `B 类尾部旧写法本来就能过：${JSON.stringify(tail)}`)
    assert.equal(extractFirstJson(raw), scoped, `B 类结果要与旧写法一致：${JSON.stringify(tail)}`)
  }
})

test('② 其它脏输出形态：前后带话 / 代码块 / 嵌套 / 字符串里的括号', () => {
  assert.equal(extractFirstJson('好的，这是结果：{"a":1}'), '{"a":1}', '前带话')
  assert.equal(extractFirstJson('```json\n{"a":1}\n```'), '{"a":1}', '代码块包裹')
  assert.equal(extractFirstJson('{"a":{"b":[1,2,{"c":3}]},"d":4} 谢谢'), '{"a":{"b":[1,2,{"c":3}]},"d":4}', '嵌套 + 尾话')
  assert.equal(extractFirstJson('{"a":"}"}'), '{"a":"}"}', '字符串里的 } 不能提前收手')
  assert.equal(extractFirstJson('{"a":"\\"}"}'), '{"a":"\\"}"}', '转义引号也要正确跳过')
  assert.equal(extractFirstJson('{"a":1'), null, '未闭合返回 null（调用方据此报错，别静默）')
  assert.equal(extractFirstJson('没有花括号'), null, '没有对象返回 null')
  assert.equal(extractFirstJson(''), null, '空串返回 null')
})

test('③ 情绪评估改走统一口径，且不再拖入生图依赖', () => {
  const emo = readSrc('services/emotionEngine.js')
  assert.match(emo, /import \{ extractFirstJson \} from '\.\/jsonExtract\.js'/, '要 import 小模块')
  assert.equal(
    /from '\.\/eventGenerator\.js'/.test(emo), false,
    '不许从 eventGenerator import（它 import 时就会去拉生图栈）'
  )
  assert.equal(
    /raw\.lastIndexOf\('}'\)/.test(emo), false,
    '旧写法（第一个 { 到最后一个 }）必须消失'
  )
  // 失败日志要能追查：头尾都要打（第八轮取证时只有一行 message，无从下手）
  assert.match(emo, /raw 长度=/, '失败日志要带头尾原文')
  assert.match(emo, /头 160=/, '要有头部片段')
  assert.match(emo, /尾 80=/, '要有尾部片段')
})

test('④ 抽出去之后：eventGenerator 仍再导出（13 处既有 import 不受影响）', () => {
  const gen = readSrc('services/eventGenerator.js')
  assert.match(gen, /export \{ extractFirstJson \} from '\.\/jsonExtract\.js'/, '要原样再导出')
  assert.equal(/export function extractFirstJson/.test(gen), false, '实现已搬走，不要再留一份')
  // 小模块必须自带零依赖（否则"抽出来"就没意义了）
  const small = readSrc('services/jsonExtract.js')
  assert.equal(/^import /m.test(small), false, 'jsonExtract.js 不许 import 任何东西（零依赖）')
})

test('⑤ 行为等价：抽样比对旧口径能过的输入，新口径结果一致', async () => {
  const { extractFirstJson: viaGenerator } = await import('../src/services/eventGenerator.js')
  const samples = ['{"a":1}', '前 {"a":1} 后', '{"a":{"b":2}}', '{"s":"{"}', '{"a":1']
  for (const s of samples) {
    assert.equal(viaGenerator(s), extractFirstJson(s), `再导出的行为要与小模块一致：${s}`)
  }
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
