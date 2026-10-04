/**
 * 触摸即时反应的生图规范接线（2026-10-02）
 *
 * 背景：原作者要求的那段 `MUST`（IP 角色写成 `Name \(Series\) \(hair color, eye color, distinctive features\)`
 * + 每个角色一句完整、各自不同的动作）必须进到"让模型现写英文画面描述"的提示词里，否则多人/多元素时画面会乱。
 *
 * 难点：`services/touchActionService.js` 是**零依赖纯函数模块**（守卫 `test/touchActionService.test.js:503`
 * 盯着"服务层不许 import 任何东西"）⇒ 它不能自己 import `builtinRules.js` 取规则 ⇒
 * 改成**由调用方 `routes/touch.js` 取好、经 `shared.imagePromptRule` 传进去**。
 *
 * 这个文件钉两件事：
 *   ① **不传规则时零回归**：system 与改动前**逐字节一致**（不是"大概一样"）；
 *      传规则时**恰好**等于"原 system + 空行 + 规则全文"（纯后缀，既不多也不改既有文字）。
 *   ② 调用方的注入点必须让**两条分支**（conversation / 快速版）都拿得到。
 *
 * ⚠️ 这条测试是补上"我曾说过'实现上是全短路，所以没问题'——但**我信不算证据**"这个缺口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReactionPrompt, buildConversationReactionPrompt } from '../src/services/touchActionService.js'
import { buildImagePromptRuleBlock } from '../src/builtinRules.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8')

// pat_head 是既有测试在用、确认合法的动作键（无效键会让构造器直接返回空 system）
const BASE = { actionKey: 'pat_head', persona: '（测试用人格：刻薄、话少）', characterName: '刻晴', userName: 'Tester' }

test('① 不传 imagePromptRule ⇒ system 逐字节等于改动前；传了 ⇒ 恰好多一段且含 MUST 特征', () => {
  const rule = buildImagePromptRuleBlock()
  const cases = [
    ['快速版 buildReactionPrompt', buildReactionPrompt],
    ['对话版 buildConversationReactionPrompt', buildConversationReactionPrompt],
  ]
  for (const [name, build] of cases) {
    const without = build({ ...BASE }).system
    assert.ok(without.length > 0, `${name}：没拿到 system（actionKey 非法？）`)

    const withRule = build({ ...BASE, imagePromptRule: rule }).system
    // 唯一差别就是末尾追加的空行 + 规则 ⇒ 逐字节相等。这样以后谁在 system 中间乱插东西，这条会红。
    assert.equal(withRule, `${without}\n\n${rule.trim()}`,
      `${name}：带规则时应当**恰好**等于"原 system + 空行 + 规则全文"（纯后缀，不许改动既有文字）`)

    // 反向钉：规则真的进去了，且是原作者要的那段。
    // ⚠️ 特征词别用 `(Series)` 这种带括号的写法 —— 规则原文里是**转义形态**（`\(Series\)`），
    //    带括号做子串匹配会假红（我第一版就这么红的）。用不会随转义变形的词。
    for (const mark of ['Series', 'hair color', 'eye color', 'distinctive', 'Every character gets a complete sentence']) {
      assert.ok(withRule.includes(mark), `${name}：规则没生效（system 里找不到 ${mark}）`)
    }
    // 不传时不许出现规范原文（否则就是"偷偷带上了"，会让'不传=旧行为'的结论失真）
    assert.ok(!without.includes('Every character gets a complete sentence'),
      `${name}：不传规则时 system 里不该出现规范原文`)
  }
})

test('② 调用方 routes/touch.js 的注入点在两条分支之前 ⇒ conversation 与快速版都拿得到', () => {
  const src = readSrc('routes/touch.js')
  // 取用点：由调用方取规则（这也是覆盖守卫第③条会去找的那一处）
  assert.match(src, /buildImagePromptRuleBlock\s*\(/, 'routes/touch.js 应当调用 buildImagePromptRuleBlock() 取规则')
  // 注入方式：塞进 shared（两个构造器共用它）
  assert.match(src, /shared\.imagePromptRule\s*=\s*buildImagePromptRuleBlock\(\)/,
    '应当写成 shared.imagePromptRule = buildImagePromptRuleBlock()（两条分支共用 shared）')
  // 位置：必须在 reactionMode 三元之前，否则只有一条分支拿得到
  // ⚠️ 锚点必须写全（`const prompt = reactionMode === 'conversation'`）—— 只写 `reactionMode === 'conversation'`
  //    会先命中文件更早处的同名表达式，导致"注入点排在它后面"的假红（我第一版就这么红的）。
  const injectAt = src.indexOf('shared.imagePromptRule')
  const ternaryAt = src.indexOf("const prompt = reactionMode === 'conversation'")
  assert.ok(ternaryAt >= 0, '没找到 reactionMode 三元的赋值行 —— 锚点写错了，先核对源码再改这条测试')
  assert.ok(injectAt >= 0 && ternaryAt > injectAt,
    '注入点必须排在 `const prompt = reactionMode === …` 之前 —— 否则 conversation / 快速版 里必有一条拿不到规则')
  // 两个分支确实都在用 shared
  assert.match(src, /buildReactionPrompt\(shared\)/, '快速版分支应当调用 buildReactionPrompt(shared)')
  assert.match(src, /buildConversationReactionPrompt\(\{[\s\S]{0,200}?\.\.\.shared/,
    '对话版分支应当展开 shared（这样 imagePromptRule 才会跟着传进去）')
})
