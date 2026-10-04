/**
 * 「广播了但没人收」这一类死链路的守卫（2026-10-03 复查补上的**方向缺口**）
 *
 * 背景：`web-ui/test/timeControlSseWhitelist.test.js` 只查了两个方向 ——
 *   · 订阅 ⊆ 白名单；白名单 ⊆ 订阅 ∪ 广播。
 * 于是"**后端广播了、白名单没有、前端也没订阅**"的事件永远是绿的，而功能是死的。
 * 真事：`intimate_stimulus`（亲密刺激下游：累积/心情/敏感度）后端一直在发，
 * 白名单里从来没有它 ⇒ 推进面板那句"进度条实时更新"从来没生效 ——
 * 用户看到的正是"自动插入开着，数字一动不动"，还被当成"敏感度没涨"。
 *
 * 本文件补齐第三个方向：**后端广播的每一个事件名，前端都必须有归宿**
 * （白名单里放行 + 至少一个订阅方；或者显式写进"有意不订阅"的清单并说明理由）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORE = path.join(ROOT, 'agent-core', 'src')
const WEB = path.join(ROOT, 'web-ui', 'src')

/**
 * 有意**不**在前端订阅的广播（每一条都要写清理由；空着也要写"没有"）。
 * 加进来之前先问：用户看得见它吗？看不见才允许放这里。
 */
const INTENTIONALLY_UNSUBSCRIBED = new Map([
  // 货架换货进度：前端没有消费者（货架 UI 不做进度条，换完直接读新货）。
  // 留在白名单里是为了以后要接进度时不用再改两处；真接了订阅就从这里删掉。
  ['town_npc_stock_progress', '货架换货进度目前不做进度 UI（无订阅方）'],
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(js|vue)$/.test(name)) out.push(full)
  }
  return out
}

/** 后端广播的事件名：broadcast('x', …) / broadcast(NAME, …)（常量单独解析） */
function backendEvents() {
  const names = new Set()
  const consts = new Map()
  for (const file of walk(CORE)) {
    const src = readFileSync(file, 'utf8')
    // 常量：const XXX_EVENT = 'xxx' / = "xxx"
    for (const m of src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*['"]([a-z0-9_]+)['"]/g)) consts.set(m[1], m[2])
    for (const m of src.matchAll(/broadcast\(\s*'([a-z0-9_]+)'/g)) names.add(m[1])
    for (const m of src.matchAll(/broadcast\(\s*([A-Z0-9_]+)/g)) {
      if (consts.has(m[1])) names.add(consts.get(m[1]))
    }
  }
  return names
}

/** 前端白名单里放行的事件名（unifiedStream.js 的 _connect 映射表） */
function whitelist() {
  const src = readFileSync(path.join(WEB, 'stores', 'unifiedStream.js'), 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/^\s*([a-z0-9_]+):\s*d\s*=>/gm)) out.add(m[1])
  return out
}

/**
 * 前端有人订阅的事件名。
 * ⚠️ 订阅有两种写法：组件里的 `onEvent('x', …)`（unifiedStream 的公开 API）与
 * `App.vue` 里的 `onStreamEvent('x', …)`（同一件事的另一个入口）——
 * **两种都要认**，否则会把"其实有订阅"的当成死链路（第一版就误报了 3 条）。
 */
function subscriptions() {
  const out = new Map()
  for (const file of walk(WEB)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/on(?:Stream)?Event\(\s*'([a-z0-9_]+)'/g)) {
      if (!out.has(m[1])) out.set(m[1], path.relative(ROOT, file).replace(/\\/g, '/'))
    }
  }
  return out
}

test('★ 后端广播的每个事件，前端都必须有归宿（白名单 + 订阅），否则就是死链路', () => {
  const events = backendEvents()
  const allow = whitelist()
  const subs = subscriptions()
  assert.ok(events.size > 10, `应当扫到不少广播事件，实际 ${events.size}`)

  const dead = []
  const noSub = []
  for (const name of events) {
    if (INTENTIONALLY_UNSUBSCRIBED.has(name)) continue
    if (!allow.has(name)) { dead.push(name); continue }
    if (!subs.has(name)) noSub.push(name)
  }
  assert.deepEqual(dead, [],
    '这些事件后端在广播、但 unifiedStream 白名单里没有 ⇒ 前端永远收不到（死广播）：' + dead.join(', '))
  // 白名单放行了但没人订阅：不一定是 bug（有的 store 走别的入口），列出来提醒
  assert.deepEqual(noSub, [],
    '这些事件放行了却没有任何 onEvent 订阅方（要么补订阅、要么写进 INTENTIONALLY_UNSUBSCRIBED 并说明理由）：' + noSub.join(', '))
})

test('★ 回归：intimate_stimulus 必须被放行 + 被推进面板订阅（"面板实时更新"那条链路）', () => {
  const allow = whitelist()
  const subs = subscriptions()
  assert.ok(allow.has('intimate_stimulus'), 'intimate_stimulus 必须进白名单（后端一直在广播）')
  assert.equal(subs.get('intimate_stimulus'), 'web-ui/src/components/IntimateActionPanel.vue',
    '推进面板要订阅它刷新 HUD')
  const panel = readFileSync(path.join(WEB, 'components', 'IntimateActionPanel.vue'), 'utf8')
  assert.match(panel, /onEvent\('intimate_stimulus'/, '面板要注册订阅')
  assert.match(panel, /offEvent\('intimate_stimulus'/, '卸载时要退订（别泄漏 handler）')
  assert.match(panel, /character_id/, '要按 character_id 过滤（别的角色的事件不许刷本面板）')
})

test('守卫自身：白名单解析得到的东西是真事件名（防止正则失效后变成永远绿）', () => {
  const allow = whitelist()
  for (const must of ['proactive_message_update', 'group_message_update', 'group_message', 'standing_display_state']) {
    assert.ok(allow.has(must), `白名单解析应当包含 ${must}（不含说明正则失效了，这条守卫会假绿）`)
  }
  const subs = subscriptions()
  assert.ok(subs.size >= 5, `前端订阅方应当不止几个，实际 ${subs.size}`)
})
