/**
 * SSE 事件名守卫（task-3 追加，2026-10-02）
 *
 * ## 为什么有这条测试
 * `stores/unifiedStream.js` 的 `_connect()` 是一张**白名单**：只有列在里面的
 * 事件名才会 `_dispatch` 给 `onEvent` 订阅者；`api.connectUnifiedStream` 虽然是通用转发，
 * 但事件在进白名单之前就被丢掉了。于是出现了一类"静默死订阅"——
 * 后端 `broadcast('x')` 发得出来、前端 `onEvent('x')` 也写了，**就是永远不触发**。
 *
 * 本轮实测到的 4 条（都由本文件钉住）：
 *   · `program_day_rollover` ← `stores/newspaper.js`（世界翻篇后立刻拉新一期报纸）
 *   · `asset_generation_progress` ← `AssetGenerationModal.vue`（一键后台生成进度，另有 2.5s 轮询兜底）
 *   · `group_round_undone` ← `stores/groups.js`（群聊撤回一轮）
 *   · `item_ready` ← `stores/backpack.js`（宝箱 / 道具出图完成）
 *
 * ## 纪律
 * · 三个方向互相核对：**后端发的 / 白名单放行的 / 前端订阅的**；
 * · 源码扫描**先剥注释**（本仓踩过三次：被自己写在注释里的事件名骗过）；
 * · 钉行为不钉写法：断言的是"订阅名一定在白名单里"这个**行为前提**，
 *   不是"某一行必须长什么样"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url))
const BACKEND_ROOT = fileURLToPath(new URL('../../agent-core/src/', import.meta.url))
const UNIFIED_PATH = fileURLToPath(new URL('../src/stores/unifiedStream.js', import.meta.url))

/** 剥掉三种注释（HTML / 块 / 整行行内） */
function stripComments(src) {
  return String(src)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 递归收集某目录下的 .js / .vue */
function listSourceFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (/\.(js|vue)$/.test(entry.name)) out.push(full)
    }
  }
  return out
}

/** 白名单：`api.connectUnifiedStream({ ... }, { onClose })` 里 handler 对象的键（含 connected 特例） */
function whitelistNames() {
  const code = stripComments(fs.readFileSync(UNIFIED_PATH, 'utf8'))
  const block = /api\.connectUnifiedStream\(\{([\s\S]*?)\},\s*\{/.exec(code)
  assert.ok(block, 'unifiedStream.js 里必须能定位到传给 connectUnifiedStream 的 handler 名单')
  return new Set([...block[1].matchAll(/^[ \t]*([A-Za-z0-9_]+):/gm)].map(m => m[1]))
}

/** 前端订阅：`onEvent('x')` 以及别名（`onStreamEvent` / `onEvent as onStreamEvent`） */
function subscribedNames() {
  const found = new Map()
  for (const file of listSourceFiles(SRC_ROOT)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'))
    for (const m of code.matchAll(/\b([A-Za-z_]*Event|onEvent)\(\s*'([A-Za-z0-9_]+)'/g)) {
      const name = m[2]
      if (!found.has(name)) found.set(name, new Set())
      found.get(name).add(path.relative(SRC_ROOT, file).replace(/\\/g, '/'))
    }
  }
  return found
}

/** 后端广播的事件名：`broadcast('x', …)` / `broadcastToUnified('x', …)` / `broadcast(EVENT_CONST, …)` */
function broadcastNames() {
  const found = new Map()
  for (const file of listSourceFiles(BACKEND_ROOT)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'))
    const constants = new Map([...code.matchAll(/([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9_]+)'/g)].map(m => [m[1], m[2]]))
    for (const m of code.matchAll(/broadcast[A-Za-z_]*\(\s*(?:'([A-Za-z0-9_]+)'|([A-Z][A-Z0-9_]*))/g)) {
      const name = m[1] || constants.get(m[2])
      if (!name) continue
      if (!found.has(name)) found.set(name, new Set())
      found.get(name).add(path.relative(BACKEND_ROOT, file).replace(/\\/g, '/'))
    }
  }
  return found
}

const WHITELIST = whitelistNames()
const SUBSCRIBED = subscribedNames()
const BROADCAST = broadcastNames()

test('剥注释自检：注释里的事件名不算订阅（本仓踩过三次的坑）', () => {
  const raw = fs.readFileSync(UNIFIED_PATH, 'utf8')
  const code = stripComments(raw)
  assert.ok(raw.includes('替代 3 个独立 SSE 长连接'), '原始文件里确实有中文注释')
  assert.equal(code.includes('替代 3 个独立 SSE 长连接'), false, '剥注释后注释内容必须消失')
  assert.ok(WHITELIST.size >= 45, `白名单应当至少有 45 个事件名，实际 ${WHITELIST.size}`)
})

test('守卫：前端所有 onEvent 订阅名都必须在 unifiedStream 白名单里', () => {
  const missing = [...SUBSCRIBED.keys()].filter(name => !WHITELIST.has(name)).sort()
  const detail = missing.map(name => `${name}（订阅方：${[...SUBSCRIBED.get(name)].join('、')}）`).join('；')
  assert.deepEqual(missing, [],
    `有订阅但白名单没放行 ⇒ 永远收不到事件（后端发了也白发）：${detail}\n` +
    '修法：在 stores/unifiedStream.js 的 handler 名单里加一行 `事件名: d => _dispatch(\'事件名\', d),`')
})

test('回归钉：本轮修好的 4 条死订阅既被订阅、也在白名单里', () => {
  const expected = {
    program_day_rollover: 'stores/newspaper.js',
    asset_generation_progress: 'components/AssetGenerationModal.vue',
    group_round_undone: 'stores/groups.js',
    item_ready: 'stores/backpack.js',
  }
  for (const [name, where] of Object.entries(expected)) {
    assert.ok(WHITELIST.has(name), `${name} 必须在 unifiedStream 白名单里（订阅方 ${where}）`)
    assert.ok(SUBSCRIBED.has(name), `${name} 应当仍有订阅方（${where}）`)
    assert.ok(BROADCAST.has(name), `${name} 后端必须真的广播（否则白名单条目是死条目）`)
  }
})

test('反向核对：白名单里的每个事件名都得有出处（后端广播 / 前端订阅 / connected）', () => {
  const orphans = [...WHITELIST].filter(name =>
    name !== 'connected' && !SUBSCRIBED.has(name) && !BROADCAST.has(name)).sort()
  assert.deepEqual(orphans, [], `这些白名单条目既没人订阅、后端也不发（多半是拼错了）：${orphans.join('、')}`)
})

test('世界翻篇链路：后端广播名 = 白名单名 = newspaper 订阅名（三处同一个字符串）', () => {
  const EVENT = 'program_day_rollover'
  const rollover = stripComments(fs.readFileSync(path.join(BACKEND_ROOT, 'services/programDayRollover.js'), 'utf8'))
  assert.match(rollover, new RegExp(`broadcast\\('${EVENT}'`), '后端 programDayRollover 要广播这个名字')
  assert.ok(WHITELIST.has(EVENT), '白名单要放行')
  const newspaper = stripComments(fs.readFileSync(path.join(SRC_ROOT, 'stores/newspaper.js'), 'utf8'))
  assert.match(newspaper, new RegExp(`onEvent\\('${EVENT}'`), 'newspaper store 要订阅这个名字')
  assert.ok(BROADCAST.get(EVENT).has('services/programDayRollover.js'))
})

test('时间面板：调时页自己订阅的翻篇事件同样在白名单里', () => {
  const panel = stripComments(fs.readFileSync(path.join(SRC_ROOT, 'components/TimeControlPanel.vue'), 'utf8'))
  assert.match(panel, /onEvent\('program_day_rollover'/)
  assert.ok(WHITELIST.has('program_day_rollover'))
})
