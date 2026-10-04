/**
 * 两笔技术债的收口回归（2026-10-02）
 *
 * ## 债 1：`buildUserInfoBlock` 有两份实现
 * 私聊/群聊主链用 `characterPersona.buildUserInfoBlock`，叫醒/延迟回复用 `wakeService.buildUserInfoBlock`，
 * 各自拼字段、各自写约束句 ⇒ 一个概念两处写，迟早"改一处漏一处"（persona 就是这么被漏掉的：
 * 两条非主链只推 nickname/gender/appearance，玩家的自我描述整条丢失）。
 * 现在：**唯一实现在 characterPersona**，wakeService 只剩"包标签 + 空值门控"的适配层。
 *
 * ## 债 2：short 变体读库里那份旧 `short_prompt`
 * 库里的 `short_prompt` 是旧裁剪口径（LLM 浓缩 ~200 字、还可能切在半句上）的产物
 * ⇒ 群聊成员资料卡 / 梦境 / 多角色参考吃不到 `cropPersonalityForEmotion` 的修复
 * （真实数据：德丽莎整卡 2212 字 ⇒ 实际只用 200 字 = 9%）。
 * 现在：**运行时从 base_prompt 现裁**（不写库、不迁移），`base_prompt` 为空时才退回库里那份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { config } = await import('../src/config.js')
const { buildUserInfoBlock: buildPersonaUserInfoBlock, buildCharacterPersona } = await import('../src/services/characterPersona.js')
const { buildUserInfoBlock: buildWakeUserInfoBlock } = await import('../src/services/wakeService.js')
const { cropPersonalityForEmotion } = await import('../src/services/personalityCrop.js')

const REAL = { nickname: 'Tester', gender: '男', appearance: '', persona: '学校的老师' }
const CONSTRAINT = /以上是玩家本人的真实设定[^。]*。/

test('债①-a：四条链产出的"遵从约束句"逐字相同（含末尾标点）', () => {
  // 私聊链：characterPersona + style:'chat'（routes/chat.js 的 <user_info> 用的就是它）
  const chat = buildPersonaUserInfoBlock(REAL, { style: 'chat', displayName: 'Tester' })
  // 群聊链：同一实现 + style:'group'（groupChatEngine 的「用户信息：」）
  const group = buildPersonaUserInfoBlock(REAL, { style: 'group', displayName: 'Tester' })
  // 叫醒链 / 延迟回复链：wakeService 的适配层（replyQueueScheduler 直接 import 它）
  Object.assign(config.user, { nickname: '', gender: '', appearance: '', persona: '' }, REAL)
  const wake = buildWakeUserInfoBlock('Tester')
  const queue = buildWakeUserInfoBlock('Tester')

  const sentences = [chat, group, wake, queue].map((s) => (String(s).match(CONSTRAINT) || [''])[0])
  assert.ok(sentences[0], '约束句必须存在（钉行为，不钉行号）')
  for (const s of sentences) {
    assert.equal(s, sentences[0], '四条链的约束句必须逐字一致 —— 否则模型在不同场景收到不同口径，用户感知仍是"时灵时不灵"')
  }
})

test('债①-b：适配层确实委托给唯一实现（不是又抄了一份）', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services')
  const wake = fs.readFileSync(path.join(dir, 'wakeService.js'), 'utf8')
  assert.match(wake, /import\s*\{[^}]*buildUserInfoBlock\s+as\s+\w+[^}]*\}\s*from\s*'\.\/characterPersona\.js'/,
    'wakeService 必须从 characterPersona 引入唯一实现（并改名，否则会自己调自己）')
  assert.match(wake, /buildPersonaUserInfoBlock\s*\(/, '适配层体内要真的调用它')
  // 反向：characterPersona 不许反向依赖 wakeService（否则成环）
  const persona = fs.readFileSync(path.join(dir, 'characterPersona.js'), 'utf8')
  assert.doesNotMatch(persona, /from\s*'\.\/wakeService\.js'/, 'characterPersona 不能 import wakeService（成环）')
  // 人格裁剪必须是零依赖叶子：emotionEngine 反过来 import characterPersona，不能让两边成环
  const crop = fs.readFileSync(path.join(dir, 'personalityCrop.js'), 'utf8')
  assert.doesNotMatch(crop.replace(/\/\*[\s\S]*?\*\//g, ''), /^\s*import\s/m, 'personalityCrop.js 必须零 import（它是叶子，专为避免成环）')
})

test('债①-c：适配层保留历史契约（包标签 / 全空返回 null / 空值不留空壳）', () => {
  Object.assign(config.user, { nickname: '', gender: '', appearance: '', persona: '' }, REAL)
  const tagged = buildWakeUserInfoBlock('Tester')
  assert.ok(tagged.startsWith('<user_info>') && tagged.endsWith('</user_info>'), '叫醒/延迟回复链要的是整块（含标签）')
  assert.match(tagged, /其他说明：学校的老师/)
  assert.doesNotMatch(tagged, /外观特征：/, '外观为空时不许留空壳')

  Object.assign(config.user, { nickname: '', gender: '', appearance: '', persona: '' })
  assert.equal(buildWakeUserInfoBlock('Tester'), null, '四个字段全空 ⇒ null（调用方据此不推这一段）')
  Object.assign(config.user, { nickname: '', gender: '', appearance: '', persona: '只有自我描述' })
  assert.match(buildWakeUserInfoBlock('Tester'), /其他说明：只有自我描述/, '只有 persona 时也必须出块（这正是原先被整块跳过的情形）')
})

test('债②-a：short 变体走运行时现裁，彻底无视库里那份旧的 short_prompt', () => {
  const stale = '纳西妲是草神。'   // 假装这是库里那份被浓缩坏掉的 200 字版本
  const card = [
    '你是纳西妲，来自《原神》的草神。',
    '',
    '## 你的身份',
    '你是须弥的草神，智慧而温柔，习惯用提问引导别人自己得出结论。',
    '',
    '## 你的性格',
    '你说话慢条斯理，喜欢用比喻，从不居高临下。',
    '',
    '## 你的着装',
    '你穿着白色与绿色相间的长裙。',
  ].join('\n')
  const out = buildCharacterPersona({ id: 6, display_name: '纳西妲', short_prompt: stale, base_prompt: card }, { outfits: null })
  assert.ok(!out.includes(stale), '库里那份 short_prompt 不许再出现在输出里（它吃不到裁剪修复）')
  assert.match(out, /须弥的草神/, '现裁结果要保留"决定她怎么说话"的设定（身份段）')
  assert.match(out, /慢条斯理/, '性格段也要保留')
  assert.ok(!out.includes('你的着装'), '外观类小节不进人格（归生图链的 characterPersona 负责）')
  assert.ok(out.length > stale.length, `现裁应当比旧浓缩版长（旧 ${stale.length} 字 ⇒ 新 ${out.length} 字）`)
})

test('债②-b：base_prompt 为空才退回库里的 short_prompt（有总比没有好）', () => {
  const out = buildCharacterPersona({ id: 6, display_name: '纳西妲', short_prompt: '纳西妲是草神。', base_prompt: '' }, { outfits: null })
  assert.equal(out, '纳西妲是草神。', '没有整卡时退回库里那份，不许返回空串')
})

test('债②-c：开场白「你是X，来自…」不再被替换成「X是X，来自…」（提示词噪音）', () => {
  const out = cropPersonalityForEmotion('你是小满，来自邻舍镇的面包店店员。', '小满')
  assert.equal(out, '小满，来自邻舍镇的面包店店员。', '整体替换「你是X」⇒「X」，而不是把「你」单独换掉留下重复')
  assert.ok(!out.includes('小满是小满'), '不许出现"X是X"这种重复写法')
  // 默认名（向后兼容）与空输入照旧
  assert.ok(cropPersonalityForEmotion('你是小满，来自邻舍镇。').includes('assistant'), '不传名字时默认仍是 assistant')
  assert.equal(cropPersonalityForEmotion('', '小满'), '')
})
