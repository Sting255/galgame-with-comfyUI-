/**
 * 画面描述里的「生图规范回显」—— 2026-10-01 真机 bug（用户报：**图和文字描述完全都不一样**）
 *
 * 现场（logs/backend-2026-10-01.log:201 / :223）：
 *   奇遇返回的 JSON 里 `"prompt"` 是**规范原文 + 它自己写的场景**的拼接，
 *   代码原样把它送进 ComfyUI ⇒ CLIP 的起始 token 全是
 *   「Describe the image as a flowing, detailed scene in natural English… Follow this progression…」，
 *   出图自然和剧情无关。
 *
 * 两层修法各守一条：
 *   · **根因**（eventGenerator.js 的 formatPrompt）：规范正文不许再当成 JSON 示例值 —— 示例值必须
 *     是「怎么写」的要求 + 一段具体样例，并明确禁止照抄；否则模型一定照着示例抄。
 *   · **兜底**（groupImagePrompt.stripImagePromptRuleEcho + imageSkill._execute）：任何来源的
 *     画面描述在进 CLIP 之前都先剥一遍规范回显。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { stripImagePromptRuleEcho, isImageRuleEcho } = await import('../src/utils/groupImagePrompt.js')
const { isComfyUnreachable } = await import('../src/services/imageSkill.js')

/** 真机日志里那条 prompt 的逐字副本（前四节，已截去尾部） */
const REAL_LOG_PROMPT = 'Describe the image as a flowing, detailed scene in natural English — one continuous paragraph.\n\n'
  + 'Follow this progression:\n\n'
  + '1. Scene Setting — Open with the overall environment, framing, and mood. This is a nursing training room in an academy dormitory building at night: dim warm lamps, soft floor mats, adjustable practice beds, shelves of sanitized training tools, faint antiseptic and milk scent in the air.\n\n'
  + '2. Two people share the frame: Theresa Apocalypse (Honkai Impact 3rd) (silver-white hair, bright blue eyes, petite short stature, left-side braid, blue nun veil with white crown ornament, white sleeveless pleated top, large gold cross-circle chest ornament, blue long coat, white pantyhose, black garter strap on right thigh, white boots) sits upright on the edge of a practice bed with her school coat hanging open and her small chest partially exposed under a pair of pulling-type nipple clamps connected by a thin chain, her lips pressed together and her shoulders slightly drawn as a draft from the half-open window makes the chain sway.\n\n'
  + '3. Environment & Props — Around them: low shelves with rows of transparent storage boxes, folded white towels, a trolley with lubricant bottles and sterilizing wipes.\n\n'
  + '4. Lighting — Warm amber ceiling lamp light mixing with a cool spill from the corridor.'

const RULE_MARKERS_RE = /describe the image|follow this progression|scene setting|environment & props|hard rules|scene-appropriate clothing/i

test('真机日志里那条 prompt：剥掉规范回显，留下真正的画面', () => {
  const r = stripImagePromptRuleEcho(REAL_LOG_PROMPT)
  assert.equal(r.changed, true, '必须认得出来这是回显')
  assert.equal(r.isEmpty, false, '后面还有真正的场景，不能整条丢掉')
  assert.ok(r.droppedChars > 150, '应剥掉上百字的规范原文，实际=' + r.droppedChars)
  assert.equal(RULE_MARKERS_RE.test(r.prompt), false, '剥完不许残留任何规范特征词')
  // 画面本体必须还在（人物外观锚点 + 场景细节）
  assert.ok(r.prompt.includes('This is a nursing training room'), '场景开头要留下')
  assert.ok(r.prompt.includes('Theresa Apocalypse (Honkai Impact 3rd)'), '人物要留下')
  assert.ok(r.prompt.includes('nipple clamps'), '这一轮真正的画面细节要留下')
  assert.ok(r.prompt.includes('Around them: low shelves'), '第 3 节的正文要留下')
})

test('整条都是规范原文 ⇒ isEmpty，调用方据此放弃本次生图（比塞给 CLIP 强）', () => {
  const full = readFileSync(new URL('../src/builtinRules.js', import.meta.url), 'utf8')
  const ruleOnly = full.slice(full.indexOf('Describe the image as a flowing'))
  const r = stripImagePromptRuleEcho(ruleOnly.slice(0, ruleOnly.indexOf('`,')))
  assert.equal(r.isEmpty, true, '整条回显应判为空')
})

test('正常画面描述：零副作用（快路径原样返回）', () => {
  const clean = 'march7th, a dimly lit dorm room at night, a girl with long wavy silver-grey hair lies back on the bed while another girl kneels beside her with a camera, warm lamp light'
  const r = stripImagePromptRuleEcho(clean)
  assert.equal(r.changed, false)
  assert.equal(r.prompt, clean)
  assert.equal(isImageRuleEcho(clean), false, '正常描述不该被误判成规范回显')
})

test('标点变体也要认出来：破折号被抄成普通连字符、弯引号被抄成直引号', () => {
  // 规范原文用的是 `—`（em dash）。模型回显时经常写成 `-`：不归一化就会「差一个字符 ⇒
  // 整句认不出来、被留在 CLIP 开头」。这是实测发现并补上的稳健性缺口。
  const variant = REAL_LOG_PROMPT.replace(/—/g, '-')
  const r = stripImagePromptRuleEcho(variant)
  assert.equal(r.changed, true)
  assert.equal(RULE_MARKERS_RE.test(r.prompt), false, '破折号变体也必须剥干净')
  assert.ok(r.prompt.includes('This is a nursing training room'), '场景仍要留下')
  assert.ok(r.prompt.includes('nipple clamps'), '画面细节仍要留下')
})

test('根因守卫：eventGenerator 的 formatPrompt 不许把规范正文当 JSON 示例值', () => {
  const src = readFileSync(new URL('../src/services/eventGenerator.js', import.meta.url), 'utf8')
  // 反例（旧写法）：`"prompt": "${imagePromptInstruction}${weatherHint}${multiPersonImageNote}",`
  assert.equal(/"prompt":\s*"\$\{imagePromptInstruction\}/.test(src), false,
    '规范正文不能再直接当 prompt 的示例值 —— 模型会照着示例把它抄进 JSON')
  assert.ok(/【prompt 字段的写作规范】/.test(src), '规范要挪到 JSON 之外单独说明')
  assert.ok(/\$\{imagePromptInstruction\}/.test(src), '规范内容仍要提供给模型（只是位置换到 JSON 之外）')
  assert.ok(/绝对不要把它原文抄进 JSON/.test(src), '要显式禁止照抄')
  assert.ok(/"prompt": "（这里填/.test(src), 'prompt 的示例值要换成「怎么写」的要求 + 具体样例')
})

test('兜底挂在唯一入口：imageSkill._execute 对每个调用方都生效', () => {
  const src = readFileSync(new URL('../src/services/imageSkill.js', import.meta.url), 'utf8')
  const exec = src.slice(src.indexOf('async function _execute('), src.indexOf('function processLowQueue()'))
  assert.ok(exec.includes('stripImagePromptRuleEcho('), '_execute 里要先剥回显')
  assert.ok(exec.includes('sanitized.isEmpty'), '剥空时要明确失败，而不是把规范塞给 CLIP')
  const iStrip = exec.indexOf('stripImagePromptRuleEcho(')
  const iPrep = exec.indexOf('prepareImagePrompt(')
  assert.ok(iStrip > 0 && iStrip < iPrep, '剥离必须在 prepareImagePrompt 之前（否则知识库会拿规范原文去检索）')
})

test('「生不出来」的成因分流：连不上 vs 被拒（只有前者值得拉长重试）', () => {
  for (const msg of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:8188', 'socket hang up', 'Request timeout', 'The operation was aborted']) {
    assert.equal(isComfyUnreachable(msg), true, msg + ' 应判为「连不上」')
  }
  for (const msg of ['Prompt outputs failed validation', 'Cannot execute because node does not exist', 'Value not in list: lora_name']) {
    assert.equal(isComfyUnreachable(msg), false, msg + ' 是「被拒」，重试再多次也没用')
  }
  const src = readFileSync(new URL('../src/services/imageSkill.js', import.meta.url), 'utf8')
  assert.ok(/unreachableRetries/.test(src), '连不上时必须给更多重试次数（现场是约 5 秒就放弃）')
  assert.ok(/ComfyUI 连不上/.test(src), '日志/错误里要能一眼看出是「没启动」而不是「prompt 被拒」')
})
