/**
 * 先发文本、图后补（2026-10-02 结构性改造，规划 §一-1 的最后一件事）
 *
 * ## 改之前是什么样
 * `proactiveChatScheduler` 两条链（正常主动聊天 + 强制触发）都是：
 * ```
 * writeProactiveMessage(...)                 // 文本已落库
 * imageUrls = await generateImageForGreeting(...)   // ← 卡在这里几十秒（ComfyUI 慢/关着更久）
 * broadcastProactiveMessage({ ...images })   // 文本和图一起才上屏
 * ```
 * ⇒ ComfyUI 一慢或没开，**她已经写好的那句话在界面上就是不出现**；这轮直接失败的话什么都收不到。
 *
 * ## 改之后
 * `writeProactiveMessage` → **立刻广播文本**（`images: []`）→ 生成图 → 用既有事件
 * `proactive_message_update` 把图**补挂**到那条已上屏的气泡上（前端按 `msg_id` 找气泡；
 * 与触摸反应后台配图用的是同一套机制，见 `routes/touch.js` 的同名广播）。
 *
 * ## 为什么出图仍在 tick 内 await（不是完全丢后台）
 * 紧随其后的**亲密看板记账**依赖"prompt 已写回 raw"这个锚点，而那一步正是出图函数干的
 * （`generateImageForGreeting` 里 `UPDATE raw_messages SET prompt`）。
 * 用户侧延迟已由"先广播"解决；调度器自己多等一会不影响任何人。
 *
 * ## 本文件钉住什么（源码顺序守卫）
 * 1. 两条链里 `broadcastProactiveMessage` 必须在 `await generateImageForGreeting` **之前**；
 * 2. 不许再出现"用 imageUrls 拼进首次广播"的旧写法（会变成等图才上屏）；
 * 3. 图好了必须有 `proactive_message_update` 补挂（否则图永远不显示）；
 * 4. 补挂失败只 warn，不能影响已上屏的文本；
 * 5. 朋友圈那侧**本来就不阻塞出图**（momentScheduler 里没有任何出图调用）——这条也钉住，防止以后有人加进去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-lazyimg-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const readSrc = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
/** 扫源码前先剥注释（本仓踩过的坑：注释里会写出被禁止的字符串本身） */
const readCode = (rel) => readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('① 主动聊天两条链：文本广播必须早于出图（顺序守卫）', () => {
  const code = readCode('services/proactiveChatScheduler.js')
  const lines = code.split('\n')
  const broadcasts = []
  const images = []
  lines.forEach((l, i) => {
    if (l.includes('broadcastProactiveMessage({')) broadcasts.push(i)
    if (l.includes('await generateImageForGreeting(')) images.push(i)
  })
  assert.equal(broadcasts.length, 2, `两条链各一次文本广播，实际 ${broadcasts.length} 处`)
  assert.equal(images.length, 2, `两条链各一次出图，实际 ${images.length} 处`)
  for (const b of broadcasts) {
    const after = images.filter(i => i > b)
    assert.ok(after.length >= 1, `第 ${b + 1} 行的广播之后必须还有出图调用（说明顺序是"先发文本"）`)
  }
  for (const i of images) {
    const before = broadcasts.filter(b => b < i)
    assert.ok(before.length >= 1, `第 ${i + 1} 行的出图之前必须已经广播过文本`)
  }
})

test('② 不许再用"等图才上屏"的旧写法；图好后必须补挂', () => {
  const code = readCode('services/proactiveChatScheduler.js')
  assert.equal(/images: imageUrls \|\| \[\]/.test(code), false, '旧写法（首次广播就带图）必须消失')
  assert.match(code, /broadcast\('proactive_message_update', \{ msg_id: firstMsgId, raw_id: rawId, images: imageUrls \}\)/,
    '图好后要用既有事件补挂到那条气泡')
  const updates = (code.match(/proactive_message_update/g) || []).length
  assert.equal(updates, 2, `两条链都要补挂，实际 ${updates} 处`)
  // 补挂失败不能影响已上屏的文本
  assert.match(code, /catch \(err\) \{[\s\S]{0,140}配图补挂广播失败（文字已上屏，不影响）/, '补挂要自己吞异常')
  assert.match(code, /import \{ broadcast \} from '\.\/unifiedStreamBus\.js'/, '要用统一广播入口')
})

test('③ 首次广播必须带空图数组（前端据此立刻上屏）', () => {
  const code = readCode('services/proactiveChatScheduler.js')
  const emptyImages = (code.match(/^\s*images: \[\],$/gm) || []).length
  assert.equal(emptyImages, 2, `两条链的首次广播都要显式 images: []，实际 ${emptyImages} 处`)
})

test('④ 记账锚点不能被改坏：出图仍在记账之前（它负责把 prompt 写回 raw）', () => {
  const code = readCode('services/proactiveChatScheduler.js')
  const imgAt = code.indexOf('await generateImageForGreeting(')
  // 第二链（带亲密看板记账的那条）里，记账必须仍在出图之后
  const recordAt = code.lastIndexOf('recordFromConversationTail(')
  assert.ok(imgAt > 0 && recordAt > 0, '两处都要在')
  const lastImg = code.lastIndexOf('await generateImageForGreeting(')
  assert.ok(recordAt > lastImg, '记账必须在出图之后（否则锚点"最后一条带 prompt 的 assistant raw"还不存在）')
})

test('⑤ 朋友圈本来就不阻塞出图（钉住这个事实，防止以后有人加进去）', () => {
  const moments = readCode('services/momentScheduler.js')
  assert.equal(/generateImage|await .*[Ii]mage/.test(moments), false,
    'momentScheduler 里不该有出图调用（本轮核对结论：朋友圈发布不依赖出图）')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
