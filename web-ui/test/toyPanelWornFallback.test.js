/**
 * ToyPanel 的**已戴清单回落**回归守卫（2026-10-04 真机 bug）。
 *
 * ## 起因（用户原话：「点玩具的一键摘下 没有反馈 而且前端也没变化」）
 *
 * 浏览器实测抓到的铁证：
 *   `POST /toys/batch` → `{"applied":["collar","vibe_egg"],"worn":[]}`
 *   `GET  /toys`       → `{"unlocked":true,"worn":[], ...}`
 *   **但面板从 +400ms 到 +8000ms 一直显示「项圈 / 跳蛋 / 2 件」** —— 服务端说摘光了，UI 死抱旧数据。
 *
 * ## 根因：把 `.length` 当成"服务端有没有答复"
 *
 * ```js
 * const wornList = computed(() => {
 *   if (liveWorn.value.length) return liveWorn.value                     // ← 空数组是 falsy
 *   return Array.isArray(props.wornToys) ? props.wornToys : []           // ← 掉这里，用父组件的【旧】清单
 * })
 * ```
 *
 * **空数组 = "她一件都没戴" 是有效答案，不是"还没拿到答案"。** 用 `.length` 判据就表达不了它。
 *
 * ## 为什么藏了这么久
 *
 * 单件摘下时 `liveWorn` 至少还剩 1 件（非空）⇒ 走服务端分支 ⇒ 一切正常。
 * **只有"一次全摘光"才会掉进回落分支** —— 而「批量装卸」是第一个能一次摘光的入口，
 * 所以这个 bug 是**被新功能引爆的老坑**，不是批量功能自己写错。
 *
 * ## 这个文件能测什么、不能测什么
 *
 * `web-ui` 只有 `node --test` + `@vue/compiler-sfc`，**没有 jsdom / @vue/test-utils**，
 * 挂载不了组件做真正的渲染断言。所以这里做**源码级契约守卫**（与同目录
 * `sseNoDeadBroadcast.test.js`、`timeControlSseWhitelist.test.js` 一个路子）：
 * 钉住"判据必须是显式标志，不许再用数组长度"，并确认标志在两条路径上都被正确维护。
 * **真正的渲染行为由 `e2e/run-e2e.mjs` 的 A14 系列 + 人工点击覆盖。**
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'components', 'ToyPanel.vue'), 'utf8')

test('① wornList 的判据必须是显式标志 serverWornReady，**不许**用数组长度', () => {
  const i = SRC.indexOf('const wornList = computed(')
  assert.ok(i > 0, '找不到 wornList 的 computed')
  const body = SRC.slice(i, SRC.indexOf('})', i) + 2)

  assert.match(body, /serverWornReady\.value/, 'wornList 要用 serverWornReady 做判据')
  // 这两条是本次 bug 的**原文**，任何一条复活就是把 bug 带回来
  assert.equal(
    /if\s*\(\s*liveWorn\.value\.length\s*\)/.test(body), false,
    'wornList 不许再用 `liveWorn.value.length` 当判据 —— 空数组是 falsy，'
    + '"她一件都没戴"会被误判成"还没拿到服务端数据"，于是回落到父组件的旧清单（2026-10-04 真机 bug）',
  )
  assert.match(body, /props\.wornToys/, '仍然要保留"服务端没答复过就用父组件那份"的回落')
})

test('② serverWornReady 必须是显式声明的 ref，且初值为 false', () => {
  assert.match(SRC, /const serverWornReady = ref\(false\)/, 'serverWornReady 要显式声明为 ref(false)')
})

test('③ adopt() 拿到 `worn` 数组（**含空数组**）就要立标志', () => {
  const i = SRC.indexOf('function adopt(')
  assert.ok(i > 0, '找不到 adopt()')
  const body = SRC.slice(i, SRC.indexOf('\n}', i) + 2)
  assert.match(body, /Array\.isArray\(payload\.worn\)/, 'adopt 要判断 payload.worn 是不是数组')
  assert.match(body, /liveWorn\.value\s*=\s*payload\.worn/, 'adopt 要把 worn 并进 liveWorn')
  assert.match(body, /serverWornReady\.value\s*=\s*true/, 'adopt 要立起 serverWornReady —— 否则空数组仍然被当成"没数据"')
})

test('④ 三道失败路径都要把标志降回 false（回落父组件那份，面板不能变白）', () => {
  const i = SRC.indexOf('async function refresh(')
  assert.ok(i > 0, '找不到 refresh()')
  const body = SRC.slice(i, SRC.indexOf('\n// ──', i) > i ? SRC.indexOf('\n// ──', i) : i + 1500)

  // 没拿到角色 id / 服务端说未解锁 / 请求抛错 —— 三条都该降回 false
  const resets = (body.match(/serverWornReady\.value\s*=\s*false/g) || []).length
  assert.ok(resets >= 3, `refresh() 的三条失败路径都要降回 false，实际只有 ${resets} 处`)
  assert.equal(
    /serverWornReady\.value\s*=\s*true/.test(body), false,
    'refresh() 自己不该立标志（那是 adopt 的职责）—— 立在这里会把"没答复"也当成"答复了"',
  )
})

test('⑤ 回归锚点：批量那两个按钮的禁用态要跟着**服务端真值**走', () => {
  // 「全部摘下」靠 wornList.length 决定禁用与文案 ⇒ wornList 对了它就对了。
  // 这条只是把接线钉住：万一以后有人把按钮改成直接读 props/其它来源，这里会红。
  const row = SRC.slice(SRC.indexOf('<div class="toy-batch-row">'), SRC.indexOf('</div>', SRC.indexOf('<div class="toy-batch-row">')))
  assert.match(row, /wornList\.length/, '「全部摘下」的文案/禁用要指回 wornList')
  assert.match(row, /batchEquipCount/, '「全部戴上」的文案/禁用要指回 batchEquipCount')
})

test('⑥ 批量必须显式传 toyKeys（否则"全部"的定义两边不一致）', () => {
  // 2026-10-04 实测：面板渲染的是服务端 `catalog`（11 件），而批量端点不传 toyKeys 时
  // 按 `availablePayload` 推导（只有 5 件基础玩具）—— 按钮写「全部戴上（11 件）」、实际只戴 5 件。
  // 修法是让**用户眼前那份清单**决定"全部"是哪些，所以 runBatch 必须带 toyKeys。
  const i = SRC.indexOf('async function runBatch(')
  assert.ok(i > 0, '找不到 runBatch()')
  const body = SRC.slice(i, SRC.indexOf('\n}', i) + 2)
  assert.match(body, /api\.batchToys\(\s*id\s*,\s*\{\s*action\s*,\s*toyKeys\s*:\s*keys\s*\}/,
    'runBatch 必须把解析出来的 keys 一起发给 batchToys')
  assert.match(SRC, /function batchTargets\(action\)/, '要有把"全部"翻成 key 清单的 batchTargets()')
  // 目标清单的来源必须与**渲染**同源：装看 toyList（背包格子渲染的就是它）、摘看 wornList
  const t = SRC.slice(SRC.indexOf('function batchTargets('))
  const tb = t.slice(0, t.indexOf('\n}') + 2)
  assert.match(tb, /action === 'remove' \? \(wornList\.value/, '「摘下」的目标要用 wornList（与渲染同源）')
  assert.match(tb, /\(toyList\.value \|\| \[\]\)/, '「戴上」的目标要用 toyList（与背包格子同源）')
})

test('⑦ 批量成功后必须 emit 回执，好让父组件刷新**角标**', () => {
  // 2026-10-04 用户反馈：「清空是清空了，但是右下角的红色数字角标还是继续在」。
  // 角标读的是**父组件自己的** wornToys（ChatView `v-if="wornToys.length > 0"`）；
  // 批量是面板直接 POST ⇒ 父组件毫不知情 ⇒ 面板清空了、角标还挂旧数字。
  // 单件那三条 emit 没这问题，正因为它们本来就经过父组件 ⇒ 批量也必须补一条回执。
  const i = SRC.indexOf('async function runBatch(')
  const body = SRC.slice(i, SRC.indexOf('\n}', i) + 2)
  assert.match(body, /emit\('toy-batch-done'/, 'runBatch 成功后要 emit toy-batch-done')
  assert.match(SRC, /defineEmits\(\[[^\]]*'toy-batch-done'/, 'toy-batch-done 要声明在 defineEmits 里')
})

test('⑧ 两个父组件都要接 toy-batch-done（私聊 + 群聊）', () => {
  const CHAT = fs.readFileSync(path.join(HERE, '..', 'src', 'views', 'ChatView.vue'), 'utf8')
  const GROUP = fs.readFileSync(path.join(HERE, '..', 'src', 'views', 'GroupChatView.vue'), 'utf8')
  for (const [name, src, handler, fetcher] of [
    ['ChatView', CHAT, 'onToyBatchDone', 'loadToys'],
    ['GroupChatView', GROUP, 'onGroupToyBatchDone', 'loadGroupToys'],
  ]) {
    assert.match(src, new RegExp(`@toy-batch-done="${handler}"`), `${name} 模板要接 @toy-batch-done`)
    const i = src.indexOf(`function ${handler}`)
    assert.ok(i > 0, `${name} 要有 ${handler}()`)
    const body = src.slice(i, src.indexOf('\n}', i) + 2)
    assert.match(body, new RegExp(fetcher), `${handler} 要去调 ${fetcher}() 重取父组件那份（角标的数据源）`)
  }
})
