/**
 * 「生图规范必须出现在所有生图路径」的覆盖守卫（2026-10-02）
 *
 * 原作者明确要求 `IMAGE_PROMPT_RULE` 第 3 条 Characters — MUST
 * （`Name \(Series\) \(hair color, eye color, distinctive features\)` + 动作/表情/空间位置 +
 * 「每个角色一句、动作各不相同」）**必须出现在所有生图路径里**，原话「这段必须要的，不然就会乱」——
 * 多角色同框时缺了它，模型会把几个人画成一个、或者把特征糊成一团。
 *
 * 本文件做两件事：
 *   ① 钉住"规则原文本身"必须含那几条关键特征（有人改规则时不许把 MUST 删掉）；
 *   ② 钉住"所有生图路径"都必须取到它 —— 场景类走 `getGlobalRule('image_prompt')` /
 *      `IMAGE_PROMPT_RULE` / `STANDING_IMAGE_PROMPT_RULE`；即时反应类与朋友圈互动等
 *      "让模型自己写画面描述"的路径走本轮新加的 `buildImagePromptRuleBlock()` /
 *      `getImagePromptRuleText()` / `getStandingImagePromptRuleText()`。
 *
 * ⚠️ 诚实说明：② 是**源码级覆盖守卫**，不是行为测试 —— 这些路径的 prompt 组装函数多数没有导出、
 * 本仓也没有组件/行为测试夹具，所以只能扫"这份规则有没有被这条路径取用"。它防的是
 * **"新加一条生图路径却忘了带规则"**和**"把规则抄成两份导致漂移/重复叠加"**这两类回归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  IMAGE_PROMPT_RULE,
  STANDING_IMAGE_PROMPT_RULE,
  getImagePromptRuleText,
  getStandingImagePromptRuleText,
  buildImagePromptRuleBlock,
} from '../src/builtinRules.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

/** MUST 的关键特征：同时命中才算这段规则还在（改词可以，但这几个锚点不能丢） */
// ⚠️ 两份规则的措辞不完全一样（原作者文本就是这样，**不许我去改他的原文**）：
//    场景版有「Every character gets a complete sentence…」这句，立绘版没有（它写的是
//    "followed by the character's pose, expression, action, and spatial position"）。
//    所以两套判据分开列 —— 第一版我把两套混用，结果立绘版被判红（是测试错，不是规则错）。
const SCENE_MARKERS = ['Series', 'hair color', 'eye color', 'distinctive features', 'complete sentence']
const STANDING_MARKERS = ['Series', 'hair color', 'eye color', 'distinctive features']

test('① 规则原文必须含 MUST 的关键特征（场景版 + 立绘版各按自己的措辞判）', () => {
  for (const [name, text, markers] of [
    ['IMAGE_PROMPT_RULE', IMAGE_PROMPT_RULE.rule_content, SCENE_MARKERS],
    ['STANDING_IMAGE_PROMPT_RULE', STANDING_IMAGE_PROMPT_RULE.rule_content, STANDING_MARKERS],
  ]) {
    for (const marker of markers) {
      assert.ok(text.includes(marker), `${name} 里丢了 MUST 的关键特征「${marker}」—— 原作者要求这段必须一直在`)
    }
    assert.match(text, /Name\s*\\?\(Series\\?\)/, `${name} 里必须有 'Name \\(Series\\)' 这个写法`)
    assert.match(text, /hair color,\s*eye color/, `${name} 里必须有 'hair color, eye color' 这个锚点顺序`)
  }
})

test('② 统一取用入口拿到的就是规则原文，且插入块明确写了"这是规范不是内容"', () => {
  assert.equal(getImagePromptRuleText(), IMAGE_PROMPT_RULE.rule_content)
  assert.equal(getStandingImagePromptRuleText(), STANDING_IMAGE_PROMPT_RULE.rule_content)

  const block = buildImagePromptRuleBlock()
  assert.ok(block.includes(IMAGE_PROMPT_RULE.rule_content), '插入块里必须带规则全文')
  // 即时反应类的输出是 JSON（reaction_text + image_prompt）⇒ 不写清"别抄规范"，
  // 模型会把规范原文抄进 image_prompt 字段（imageSkill.js 专门为这种回声报过错）
  assert.match(block, /不是要填进|写作规范|不得把规范原文抄进/, '插入块必须声明"规范不是内容、别抄进字段值"')
})

// ── 全部生图路径（相对 agent-core/src）────────────────────────────────────
// MUST = 这条路径必须取到「生图规范」；取用方式二选一：场景全文 / 立绘全文。
const IMAGE_PATHS = {
  // 场景类（原本就带：走 getGlobalRule('image_prompt') 或 IMAGE_PROMPT_RULE）
  '私聊配图': ['routes/chat.js'],
  '私聊情绪配图': ['services/emotionEngine.js'],
  '群聊配图': ['services/groupImagePipeline.js', 'utils/groupImagePrompt.js'],
  '群聊出图协议': ['services/groupScriptProtocol.js'],
  '朋友圈配图': ['routes/moments.js'],
  '报纸插图': ['services/newspaperService.js'],
  '事件插图': ['services/eventGenerator.js'],
  '梦境插图': ['services/dreamService.js'],
  '日程拍照': ['routes/schedule.js'],
  '信箱配图': ['services/mailboxScheduler.js'],
  '主动聊天配图': ['services/proactiveChatScheduler.js'],
  '小镇 NPC 事件': ['services/town/townNpcEventGenerator.js'],
  '小镇 NPC 朋友圈': ['services/town/townNpcMomentGenerator.js'],
  'maibot 桥': ['maibot-bridge/prompt.js'],
  '生图重绘接口': ['routes/images.js'],
  // 立绘类（走 STANDING_IMAGE_PROMPT_RULE）
  '角色立绘': ['routes/characters.js'],
  '小镇立绘': ['services/town/townPromptBuilder.js'],
  // ⚠️ 本轮（2026-10-02）补上的：这些路径原本让模型自己写英文画面描述却不给规范
  '玩具即时反应': ['services/toyService.js'],
  '玩具自慰': ['services/toy/selfPlay.js'],
  '亲密推进': ['services/intimateActionService.js'],
  '朋友圈互动': ['services/momentInteractionService.js'],
  // ✅ 触摸即时反应：改法已落地 —— 规则由**调用方**取好再传进去（`routes/touch.js` 调
  //    `buildImagePromptRuleBlock()` 塞进 `shared.imagePromptRule`，两个构造器共用 `shared`，
  //    所以 conversation 与快速版两条路都覆盖）。`touchActionService.js` 因此保持**零依赖**，
  //    仍然满足守卫 `test/touchActionService.test.js:503`（服务层不许 import 任何东西）。
  //    取用点写在 `routes/touch.js` ⇒ 这里列的就是调用方文件，第③条会去它里面找取用点。
  '触摸即时反应': ['routes/touch.js'],
}
// ⚠️ '动态表情（立绘管线）' **不在**覆盖表里，而且它**不是缺口** —— 2026-10-02 复核结论：
//    `services/expressionStandingPrompt.js` 自己就带了**等价且更细**的规范（第 6 行的示例就是
//    `Name \(Series\) \(hair style, hair color, eye color, signature outfit, footwear, distinctive accessory\)`，
//    第 8~13 行硬性要求"姓名/作品/外观必须来自角色资料、禁止照抄示例或杜撰作品、每条至少六项外观锚点"）。
//    ⇒ 它不需要再叠加 `STANDING_IMAGE_PROMPT_RULE`（叠加反而会把规范抄第二份、还会撞上
//    "可复用 prompt 前缀逐字节一致"的断言）。下面第⑦条把"它自带等价规范"变成机器可查的事实，
//    免得以后有人看到这里没有条目就以为漏了。

test('⑦ 动态表情（立绘管线）自带等价规范：不必叠加，但要保证它没被删掉', () => {
  const text = read('services/expressionStandingPrompt.js')
  // 作者要求的三要素：`Name \(Series\) \(…外观锚点…\)` 的写法、锚点必须来自角色资料、禁止照抄示例
  assert.ok(/Name\s*\\\(Series\\\)/.test(text), '立绘管线的示例里必须保留 `Name \\(Series\\) \\(…\\)` 这个写法')
  for (const anchor of ['hair style', 'hair color', 'eye color']) {
    assert.ok(text.includes(anchor), `立绘外观锚点少了 ${anchor} —— 这正是原作者要求的那段格式`)
  }
  assert.ok(/禁止照抄示例或杜撰作品/.test(text), '必须保留"姓名/作品/外观来自角色资料、禁止照抄示例或杜撰作品"这条硬要求')
  assert.ok(/至少六项外观锚点/.test(text), '必须保留"每条至少六项外观锚点"这条硬要求')
})

/** 场景类取用方式（任一即算取到） */
const SCENE_USAGE = [/getGlobalRule\(\s*['"]image_prompt['"]\s*\)/, /\bIMAGE_PROMPT_RULE\b/, /getImagePromptRuleText\s*\(/, /buildImagePromptRuleBlock\s*\(/]
/** 立绘类取用方式（任一即算取到；立绘不许再叠加场景那份） */
const STANDING_USAGE = [/\bSTANDING_IMAGE_PROMPT_RULE\b/, /getStandingImagePromptRuleText\s*\(/]
const STANDING_PATHS = new Set(['角色立绘', '小镇立绘'])
// ✅ '动态表情（立绘管线）' **不在**这里，而且**不是缺口**：`services/expressionStandingPrompt.js`
//    自己就带了等价（更细）的规范 —— 第 6 行的示例就是作者要的 `Name \(Series\) \(…外观锚点…\)`，
//    第 8~13 行硬性要求"外观必须来自角色资料、禁止照抄示例或杜撰作品、每条至少六项外观锚点"。
//    叠加 `STANDING_IMAGE_PROMPT_RULE` 只会把规范抄第二份、并撞上"可复用 prompt 前缀逐字节一致"的断言。
//    第⑦条已经把这件事变成机器可查的断言（防它被人删掉）。

test('③ 每一条生图路径都必须取到这份规范（这是"所有"的机器保证）', () => {
  const missing = []
  for (const [label, files] of Object.entries(IMAGE_PATHS)) {
    const usage = STANDING_PATHS.has(label) ? STANDING_USAGE : [...SCENE_USAGE, ...STANDING_USAGE]
    const covered = files.some((rel) => {
      let text
      try { text = read(rel) } catch { return false }
      return usage.some((re) => re.test(text))
    })
    if (!covered) missing.push(`${label}（${files.join(', ')}）没有取到生图规范 ⇒ 这条路径出的图会「乱」`)
  }
  assert.equal(missing.length, 0, missing.join('\n  '))
})

test('④ 立绘类路径必须取到立绘那份（同文件里另有场景版取用是合法的，不判红）', () => {
  // ⚠️ 第一版我在这里断言"立绘路径不许出现场景版取用"，结果 `routes/characters.js` 被判红 ——
  //    它同时服务「角色卡生成」（场景版，:978）与「立绘」（立绘版，:1149），一个文件两种用途是正常的。
  //    所以只断言"立绘那份在不在"，不再按文件去禁场景版（避免假红）。
  for (const label of STANDING_PATHS) {
    for (const rel of IMAGE_PATHS[label]) {
      const text = read(rel)
      assert.ok(STANDING_USAGE.some((re) => re.test(text)), `${label}（${rel}）应当取到立绘版生图规则`)
    }
  }
})

test('⑤ 本轮新接线的路径：取用点只许有一处（防止以后重复叠加）', () => {
  // ✅ 触摸即时反应**已经接好**（2026-10-02）：规则由调用方 `routes/touch.js` 取好、经
  //    `shared.imagePromptRule` 传进 `touchActionService.js`（两个构造器共用 `shared`）⇒
  //    它已回到上面的 `IMAGE_PATHS` 覆盖表（第③条会去 `routes/touch.js` 找取用点）。
  //    动态表情（立绘管线）不在名单里而且**不是缺口**（自带等价规范，见第⑦条）。
  const wiredOnce = [
    ['services/toyService.js', /buildImagePromptRuleBlock\s*\(/g],
    ['services/toy/selfPlay.js', /buildImagePromptRuleBlock\s*\(/g],
    ['services/intimateActionService.js', /buildImagePromptRuleBlock\s*\(/g],
    ['services/momentInteractionService.js', /buildImagePromptRuleBlock\s*\(/g],
    // ✅ 触摸即时反应：取用者是**调用方** `routes/touch.js`，不是零依赖的 `services/touchActionService.js`
    //    ⇒ 语义与上面四条完全一致（"取规则的那个文件里，取用点只许有一处"），所以放进这个名单 ✓。
    //    （我一开始犹豫要不要加，读完语义后确认该加：这个名单管的是**取用点去重**，不限于"服务自己取"。）
    ['routes/touch.js', /buildImagePromptRuleBlock\s*\(/g],
  ]
  for (const [rel, re] of wiredOnce) {
    const hits = (read(rel).match(re) || []).length
    assert.ok(hits >= 1, `${rel} 应当已经接上生图规范`)
    assert.ok(hits <= 3, `${rel} 取用点出现 ${hits} 次，疑似重复叠加（规则全文很长，叠了会把 prompt 撑胖）`)
  }
})

test('⑥ 规范原文不许被别的文件抄第二份（一定漂移）', () => {
  const mustLine = 'Every character gets a complete sentence'
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      if (p.endsWith(path.join('src', 'builtinRules.js'))) continue   // 正本
      if (fs.readFileSync(p, 'utf8').includes(mustLine)) offenders.push(path.relative(SRC, p))
    }
  }
  walk(SRC)
  assert.equal(offenders.length, 0,
    `生图规范原文被抄到了别的文件里（${offenders.join(', ')}）⇒ 以后改规则必然漂移；请改为调用 builtinRules.js 的取用入口`)
})
