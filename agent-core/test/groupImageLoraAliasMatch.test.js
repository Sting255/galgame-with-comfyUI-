/**
 * 成因 A3 回归：群聊「画面人物 ↔ 角色 LoRA」的匹配实际上在空转。
 *
 * 真机数据形状（真实库 agent.db，只读查过）：
 *   characters.name 是 **handle** —— `silverwolflv999` / `theresaapocalypse` / `hyacinthia` / `march7th`
 *   characters.display_name 是**中文** —— 银狼LV.999 / 德丽莎·阿波卡利斯 / 风瑾 / 三月七
 * 而 LLM 在英文画面描述里写的是 `Silver Wolf` / `Theresa Apocalypse`；
 * 旧 `matchCharactersInImagePrompt` 只把 `name` 归一化后要求它作为整词子串出现 ⇒ **永远匹配不到**。
 *
 * 后果链（真机日志 `完整/backend-2026-10-01.log:123-126`）：
 *   [group] forced speaker LoRA for 三月七(march7th): none
 *   [group] image prompt added speaker name fallback: march7th     ← 匹配为空 ⇒ 前置发图人名字
 *   [imageSkill] Final prompt: march7th, a dimly lit dorm room … silver-grey hair …   ← 画面描述的是银狼
 * 即"谁发图就画成谁"。
 *
 * 本文件钉四件事：
 *   ① 英文 prompt 里的口语名（handle / `Name (Series)` / display_name 的英文部分）能匹配到角色；
 *   ② 匹配为空时**不再**前置发图人 `name`；
 *   ③ 描述里真的出现发图人时，发图人 LoRA 仍按原优先级注入（功能没被修没）；
 *   ④ 别名不放松到会误命中（`silver-grey hair` 不得匹配银狼、`march forward` 不得匹配三月七）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('lora matcher fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const {
  buildCharacterAliases,
  matchCharactersInImagePrompt,
  applyGroupImageNameFallback,
  resolveGroupImageLoras,
  parseCharacterLoras,
} = await import('../src/services/groupImageLoraMatcher.js')

after(() => closeDb())

// ── 真实数据形状的夹具（handle 英文 + display_name 中文 + 英文外观段） ──
const SILVER_WOLF = {
  id: 10,
  name: 'silverwolflv999',
  display_name: '银狼LV.999',
  base_prompt: '你是银狼LV.999(Silver Wolf LV.999)，来自《崩坏：星穹铁道》。\n\n## 你的外观\nSilver Wolf LV.999 (Honkai: Star Rail) has long wavy silver-grey hair styled in a high ponytail with loose strands framing her face, sharp grey eyes, wearing a black cropped jacket with purple and silver accents.',
  short_prompt: '银狼LV.999(silverwolflv999)是来自《崩坏：星穹铁道》的星核猎手成员、朋克洛德天才骇客，把宇宙当游戏。',
  loras: JSON.stringify([{ path: 'silverwolf.safetensors', weight: 0.7, triggerWord: 'silverwolf' }]),
}
const MARCH_7TH = {
  id: 11,
  name: 'march7th',
  display_name: '三月七',
  base_prompt: '你是三月七(March 7th)，来自《崩坏：星穹铁道》。\n\n## 你的外观\nmasterpiece, best quality, Honkai: Star Rail, 1girl, March 7th, fair skin, short fluffy pink hair, bright pink eyes.',
  short_prompt: '三月七(march7th)是星穹列车的成员，从恒冰中苏醒、对过去一无所知的少女，随身带着照相机。',
  loras: JSON.stringify([{ path: 'march7th.safetensors', weight: 0.8, triggerWord: 'march7th' }]),
}
const HYACINTHIA = {
  id: 5,
  name: 'hyacinthia',
  display_name: '风瑾',
  base_prompt: '你是雅辛忒丝(Hyacinthia)，来自《崩坏：星穹铁道》。人们更常唤你风堇(Hyacine)。\n\n## 你的外观\n1girl, solo, Hyacine (Honkai: Star Rail), full body, standing, holding staff, fluffy pastel pink twin-tails.',
  short_prompt: '风瑾(hyacinthia)是来自《崩坏：星穹铁道》的昏光庭院首席医师。',
  loras: '[]',
}
const YUNLI = {
  id: 13,
  name: 'yunli',
  display_name: '云璃',
  base_prompt: '你是云璃(Yunli)，来自《崩坏：星穹铁道》。\n\n## 你的外观\nmasterpiece, best quality, Honkai: Star Rail, 1girl, Yunli, slender build, long dark blue hair, high ponytail.',
  short_prompt: '云璃(yunli)是仙舟「朱明」的剑士，师承剑首怀炎。',
  loras: '[]',
}
const OTHER_MEI = { id: 1, name: 'mei', display_name: 'Mei', base_prompt: '', short_prompt: '', loras: '[]' }

const CHARACTERS = [SILVER_WOLF, MARCH_7TH, HYACINTHIA, YUNLI]

/** 真机那条画面描述（`完整/backend-2026-10-01.log:126` 的英文正文，逐字）。 */
const REAL_PROMPT = 'a dimly lit dorm room at night, the main focus is a girl with long wavy silver-grey hair in a high ponytail lying back on a bed with one knee bent, her black cropped jacket and purple skirt set aside on the floor beside a pair of black thigh-high stockings, she wears only a dark purple crop top and black choker, one hand pressed over her lower belly and the other gripping the bedsheet, her expression tense and flushed with parted lips, soft cyan light from a handheld game console on the nightstand casts a cool glow over her bare thighs, a small pink-haired girl in a blue and white blouse kneels on the bed with a camera aimed at her, warm bedside lamp light mixes with the cyan glow, the scene conveys intimate chaos and playful pressure'

const namesOf = chars => chars.map(character => character.name)

// ── ① 多路别名匹配 ────────────────────────────────────────────────────────────

test('① handle 与 `Name (Series)` 形态都能匹配（旧实现只认 handle，`Silver Wolf` 永远匹配不到）', () => {
  assert.deepEqual(
    namesOf(matchCharactersInImagePrompt('Silver Wolf (Honkai: Star Rail) lying on a bed', CHARACTERS)),
    ['silverwolflv999'],
    '`Silver Wolf (Honkai: Star Rail)` 必须匹配到 handle 为 silverwolflv999 的角色',
  )
  // handle 原样写（旧行为，不能退化）
  assert.deepEqual(namesOf(matchCharactersInImagePrompt('silverwolflv999 lying on a bed', CHARACTERS)), ['silverwolflv999'])
  // 只写名字、不带括号系列名（LLM 现实里最常见的写法）
  assert.deepEqual(namesOf(matchCharactersInImagePrompt('Silver Wolf lying on a bed', CHARACTERS)), ['silverwolflv999'])
  // 短名形态
  assert.deepEqual(namesOf(matchCharactersInImagePrompt('March 7th takes a selfie', CHARACTERS)), ['march7th'])
  assert.deepEqual(namesOf(matchCharactersInImagePrompt('Theresa Apocalypse (Honkai Impact 3rd) raises her cross', CHARACTERS)), [])
  assert.deepEqual(namesOf(matchCharactersInImagePrompt('Yunli unsheathes her blade', CHARACTERS)), ['yunli'])
  assert.deepEqual(namesOf(matchCharactersInImagePrompt('a Hyacine in a white blouse tends to a patient', CHARACTERS)), ['hyacinthia'])
  // 两个角色同框：都要匹配到
  assert.deepEqual(
    namesOf(matchCharactersInImagePrompt(
      'March 7th (Honkai: Star Rail) takes a selfie while Silver Wolf (Honkai: Star Rail) plays on the bed',
      CHARACTERS,
    )).sort(),
    ['march7th', 'silverwolflv999'],
  )
})

test('① 别名不会放松到误命中（错配会把无关 LoRA 塞到链首，比漏配更糟）', () => {
  // 第一版把 `Silver Wolf LV.999` 逐词前缀展开出单字别名 `silver` ⇒ 命中 `silver-grey hair`
  assert.deepEqual(matchCharactersInImagePrompt('a girl with long wavy silver-grey hair in a high ponytail', CHARACTERS), [])
  assert.deepEqual(matchCharactersInImagePrompt('a girl with a silver necklace and silver boots', CHARACTERS), [])
  // `march` 同理（单字别名会把 `march forward` 当成三月七）
  assert.deepEqual(matchCharactersInImagePrompt('she will march forward into the light', CHARACTERS), [])
  // 太短的 handle 别名不进别名表（`mei` 只有 3 个字母）
  assert.deepEqual(buildCharacterAliases(OTHER_MEI), [], '短别名应被丢弃')
  assert.deepEqual(matchCharactersInImagePrompt('a meido waitress portrait', [OTHER_MEI]), [])
  // 场景/物件描述不该匹配任何角色
  assert.deepEqual(matchCharactersInImagePrompt('a convenience store shelf filled with colorful drinks', CHARACTERS), [])
})

test('① buildCharacterAliases 别名表符合预期形状（含中文显示名不进别名表）', () => {
  const silver = buildCharacterAliases(SILVER_WOLF)
  assert.ok(silver.includes('silverwolflv999'), 'handle 必须在别名表里')
  assert.ok(silver.includes('silver wolf'), '`Silver Wolf` 形态必须在别名表里')
  assert.ok(!silver.includes('silver'), '单字前缀不得进别名表')
  assert.ok(!silver.includes('银狼'), '中文显示名不得作为英文 prompt 的匹配别名')
  assert.ok(silver.includes('silverwolf'), 'LoRA triggerWord 也要进别名表')
  assert.ok(buildCharacterAliases(HYACINTHIA).includes('hyacine'), '卡片里的 `Hyacine (Honkai: Star Rail)` 形态要能进别名表')
  assert.deepEqual(buildCharacterAliases(null), [])
})

// ── ② 匹配为空不再前置发图人 ──────────────────────────────────────────────────

test('② 匹配为空时不得把发图人 name 前置（真机那条日志的根因）', () => {
  const prepared = applyGroupImageNameFallback(REAL_PROMPT, [], { name: 'march7th', display_name: '三月七' })
  assert.equal(prepared.prompt, REAL_PROMPT, '正文必须原样返回，不得前置 march7th')
  assert.equal(prepared.prompt.startsWith('march7th'), false, '不得再以发图人名字开头')
  assert.equal(prepared.fallbackApplied, true, '仍要回报"画面里有人但一个角色都没认出来"供诊断')
})

test('② 场景/物件描述与有主描述的空匹配行为一致（都不动正文）', () => {
  const scenery = 'a convenience store shelf filled with colorful drinks'
  assert.deepEqual(
    applyGroupImageNameFallback(scenery, [], { name: 'chinatsu' }),
    { prompt: scenery, fallbackApplied: false },
    '没人物的描述连 fallbackApplied 都不该标',
  )
  const noSpeaker = applyGroupImageNameFallback('a lonely girl by the window', [], null)
  assert.equal(noSpeaker.prompt, 'a lonely girl by the window')
  assert.equal(noSpeaker.fallbackApplied, false)
})

test('② 旧行为是"前置发图人"，这条用例把它钉成反向（防回退）', () => {
  const prepared = applyGroupImageNameFallback('a shy young girl taking a selfie', [], { name: 'chinatsu' })
  assert.notEqual(prepared.prompt, 'chinatsu, a shy young girl taking a selfie', '旧的 `${speaker.name}, ${text}` 不允许回来')
  assert.equal(prepared.prompt, 'a shy young girl taking a selfie')
})

// ── ③ 发图人真的出现在描述里时照旧注入 ────────────────────────────────────────

test('③ 描述里出现发图人时，发图人仍在 matchedCharacters 里（下游照旧把他的 LoRA 排到链首）', () => {
  const prompt = 'March 7th (Honkai: Star Rail) takes a selfie in a dorm room'
  const matched = matchCharactersInImagePrompt(prompt, CHARACTERS)
  assert.deepEqual(namesOf(matched), ['march7th'])
  const prepared = applyGroupImageNameFallback(prompt, matched, { name: 'march7th' })
  assert.equal(prepared.prompt, prompt, '匹配到了就不走兜底，正文原样')
  assert.equal(prepared.fallbackApplied, false, '匹配到了 ⇒ fallbackApplied=false（原优先级不变）')
})

test('③ 发图人 LoRA 的解析与排序口径没变（parseCharacterLoras 逐字段）', () => {
  assert.deepEqual(parseCharacterLoras(MARCH_7TH), [
    { path: 'march7th.safetensors', weight: 0.8, triggerWord: 'march7th' },
  ])
  assert.deepEqual(parseCharacterLoras({ loras: '[]' }), [])
  assert.deepEqual(parseCharacterLoras({ loras: 'not json' }), [])
  assert.deepEqual(parseCharacterLoras({ loras: JSON.stringify([{ weight: 0.5 }]) }), [], '没有 path 的条目要滤掉')
})

// ── ④ 真库路径（内存库） ──────────────────────────────────────────────────────

function seedCharacters() {
  const db = getDb()
  db.prepare('DELETE FROM characters').run()
  const insert = db.prepare(
    'INSERT INTO characters (id, name, display_name, base_prompt, short_prompt, loras) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const character of CHARACTERS) {
    insert.run(character.id, character.name, character.display_name, character.base_prompt, character.short_prompt, character.loras)
  }
}

test('④ resolveGroupImageLoras（真库路径）：画面描述里的人是银狼时，不再被塞发图人名字', () => {
  seedCharacters()
  const result = resolveGroupImageLoras(REAL_PROMPT, { id: 11, name: 'march7th', display_name: '三月七' })

  assert.equal(result.prompt, REAL_PROMPT, '不得前置 march7th')
  assert.equal(result.fallbackApplied, true, '这条描述确实没写角色名 ⇒ 记为未识别')
  assert.deepEqual(result.matchedCharacters.map(character => character.name), [], '没人写名字 ⇒ 匹配为空（这是数据事实，不是 bug）')
  assert.deepEqual(result.loras, [], '匹配为空 ⇒ 不注入任何被描述角色的 LoRA')
})

test('④ resolveGroupImageLoras（真库路径）：写了 `Silver Wolf` 就能拿到银狼的角色行与 LoRA', () => {
  seedCharacters()
  const prompt = 'Silver Wolf (Honkai: Star Rail) lounging on a bed while March 7th (Honkai: Star Rail) holds a camera'
  const result = resolveGroupImageLoras(prompt, { id: 11, name: 'march7th', display_name: '三月七' })

  assert.equal(result.prompt, prompt, '匹配到时正文必须逐字不变（不前置、不追加）')
  assert.equal(result.fallbackApplied, false)
  assert.deepEqual(result.matchedCharacters.map(character => character.name).sort(), ['march7th', 'silverwolflv999'])
  assert.deepEqual(result.loras.map(lora => lora.path).sort(), ['march7th.safetensors', 'silverwolf.safetensors'])
})

test('④ resolveGroupImageLoras（真库路径）：描述里出现发图人本人时照旧命中他/她', () => {
  seedCharacters()
  const prompt = 'March 7th (Honkai: Star Rail) takes a selfie in a dorm room'
  const result = resolveGroupImageLoras(prompt, { id: 11, name: 'march7th', display_name: '三月七' })

  assert.deepEqual(result.matchedCharacters.map(character => character.name), ['march7th'])
  assert.deepEqual(result.loras.map(lora => lora.path), ['march7th.safetensors'])
  assert.equal(result.fallbackApplied, false)
})
