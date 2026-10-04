/**
 * 玩具出图必须带角色本人（2026-10-02 真 bug 回归）
 *
 * ## 用户原话
 * 「玩具触发的图和角色完全无关」——真机日志铁证：所有玩具图的 Final prompt 都是
 * `english: a young woman…`（零角色名、零外观），而同一份日志里聊天/性爱面板的图全都带完整角色外观。
 *
 * ## 两段断链（缺一不可修）
 * ① `routes/toys.js` 的 `characterRow()` 只 SELECT `id, display_name, avatar_path`，
 *    **没查 `base_prompt`**；而这个对象一路传到 `generateToyImageForReaction`，
 *    那里靠 `buildCharacterAppearanceSection(character)` 从 `base_prompt` 里提 "## 你的外观" 段。
 * ② 即使①修好，角色卡没写外观段时外观仍然是空串 ⇒ 需要兜底（short 人格 / display_name）。
 *
 * ## 为什么这个测试要钉 wiring
 * 纯函数单测喂一个**合成**的 character 对象（自己带上 base_prompt）永远会绿 ——
 * 真实存储里 `base_prompt` 根本没被查出来，这正是"检测器输入在真实存储里不存在"的又一种形态
 * （第四种：输入在 SQL 里就没被查出来）。所以：
 *   · 第 1 组断言**扫源码**，钉住 `characterRow` 的 SELECT 含 `base_prompt`；
 *   · 第 2、3 组断言**走真函数**，钉住"外观进 prompt"与"没外观也不许只剩玩具"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-toyimg-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

/**
 * 出网一律立刻失败（本仓既有测试的统一做法）。
 *
 * 为什么必须打桩：导入 `toyService` 会连带拉起 `comfyClient` 的 ComfyUI 探测，
 * 而跑测试时真实 ComfyUI 通常关着。**而且本机的 8188 端口上坐着的是别的服务**
 * （`GameViewerServer`，它会接受 TCP 连接但不应答 HTTP）——不打桩的话那次探测会一直挂着，
 * 事件循环不空、`node --test` 就永远不退出（实测卡了 7 分钟以上、连一条 `ok` 都没打出来）。
 */
globalThis.fetch = async () => { throw new Error('toyImageCharacter.test: 测试不出网') }

const { getDb } = await import('../src/db/index.js')
getDb()   // 内存库懒初始化 + 跑迁移（本仓测试的统一起法，没有单独的 initDb）
const { generateToyImageForReaction } = await import('../src/services/toyService.js')

/** 捕获真正传给生图的 prompt（不真的出图） */
function captureRunner() {
  const seen = []
  return {
    seen,
    runner: async (prompt) => { seen.push(prompt); return { success: true, images: [] } },
  }
}

test('① wiring：characterRow 必须把 base_prompt 一起查出来（否则外观段永远为空）', () => {
  const src = fs.readFileSync(new URL('../src/routes/toys.js', import.meta.url), 'utf8')
  const m = src.match(/function characterRow\(characterId\)\s*\{[\s\S]{0,400}?\}/)
  assert.ok(m, '找不到 characterRow（改名了也要同步改这条测试）')
  const body = m[0]
  assert.match(body, /base_prompt/, 'characterRow 的 SELECT 必须包含 base_prompt —— 这是玩具图不带人的根因')
  assert.match(body, /short_prompt/, 'short_prompt 也要查（外观段为空时的兜底输入）')
  assert.match(body, /display_name/, 'display_name 当然要留（最后兜底至少把名字塞进 prompt）')
})

test('② 有外观段时：prompt = 画面描述 + 角色外观（不再是裸 a young woman）', async () => {
  const cap = captureRunner()
  const character = {
    id: 1,
    display_name: '纳西妲',
    base_prompt: '纳西妲\n\n## 你的身份\n你是草神。\n\n## 你的外观\n银白渐变绿的长发，翠绿瞳孔，白色与绿色相间的连衣裙。',
  }
  await generateToyImageForReaction({
    character,
    imagePrompt: 'a woman kneeling on the bed, the curved wand inside her',
    options: { generateImage: cap.runner },
  })
  assert.equal(cap.seen.length, 1, '应该真的调了一次生图')
  const prompt = cap.seen[0]
  assert.match(prompt, /the curved wand inside her/, 'LLM 写的画面描述必须保留')
  assert.match(prompt, /银白渐变绿的长发|翠绿瞳孔/, `角色外观段必须进 prompt，实际：${prompt.slice(0, 200)}`)
})

test('③ 角色卡没写外观段时：兜底也必须带人（short 人格或至少 display_name）', async () => {
  const cap = captureRunner()
  const character = {
    id: 1,
    display_name: '纳西妲',
    short_prompt: '你是须弥的草神，语气温和但有点跳脱。',
    base_prompt: '纳西妲\n\n## 你的身份\n你是草神。',   // 故意没有「## 你的外观」段
  }
  await generateToyImageForReaction({
    character,
    imagePrompt: 'a young woman pressing a small suction toy against her clit',
    options: { generateImage: cap.runner },
  })
  const prompt = cap.seen[0]
  assert.match(prompt, /须弥的草神|纳西妲/,
    `没有外观段时必须兜底带人（short 人格或 display_name），实际：${prompt.slice(0, 200)}`)
  assert.doesNotMatch(prompt, /^a young woman[^,]*,\s*$/, '不许出现"只有玩具、没有人"的最终 prompt')
})

test('④ 极端情况：什么都没有的角色也不能崩', async () => {
  const cap = captureRunner()
  await generateToyImageForReaction({
    character: { id: 1, display_name: '无名' },
    imagePrompt: 'a young woman with a toy',
    options: { generateImage: cap.runner },
  })
  assert.equal(cap.seen.length, 1)
  assert.match(cap.seen[0], /无名/, '至少要有名字')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
