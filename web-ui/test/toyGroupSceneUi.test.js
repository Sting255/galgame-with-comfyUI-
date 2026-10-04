/**
 * 群聊玩具面板的「场景」守卫（2026-10-03；两位独立审查者各自复现的真机 bug）
 *
 * 用户原话：「在群聊里进行点玩具和插入动作 消息会去到私聊里 这是不应该的
 *            在哪里聊天就在哪里继续进行」
 *
 * 前端这一半的根因：群聊里的 🧸 玩具面板**从不告诉服务端"这是在群里点的"**
 * （`api.equipToy(charId, toyKey, {...})` 没有 scene/groupId）⇒ 后端按私聊口径把她的反应
 * 写进 `char_<id>` + 广播 `proactive_message`，而群聊页只认 `group_message` /
 * `group_message_update`（`stores/groups.js`）⇒ 群里什么都看不到，群聊成人闸门也形同虚设。
 *
 * 这份测试钉四件事：
 *   ① 行为级：带 `{ scene:'group', groupId }` 时**每个**玩具接口都把场景放进 URL / 请求体；
 *      不带时请求与改造前**逐字节一致**（老接线零影响 —— 私聊行为不许变）；
 *   ② 群聊视图：ToyPanel 收到 `scene="group"` + `:group-id`，四个调用点（装 / 调 / 摘 / 取状态）
 *      都带 `groupToyScene()`；
 *   ③ 面板：`scene` / `groupId` props + 一处 `sceneOpts`，**每一个**玩具请求都透传它
 *      （面板自己 POST 的那几件事 —— 模式 / 曲线 / tick / 她自己玩 —— 一条都不能漏）；
 *   ④ api 层：场景字段只有一个来源 `toySceneFields` / `toySceneQuery`，别在各函数里手抄。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 剥注释：说明文字里会提到旧写法/反面例子，不剥会自己把自己判红（照 groupPanels.test.js 的口径） */
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')

const apiSrc = read('../src/api/index.js')
const panelRaw = read('../src/components/ToyPanel.vue')
const groupRaw = read('../src/views/GroupChatView.vue')
const chatRaw = read('../src/views/ChatView.vue')
const panel = strip(panelRaw)
const group = strip(groupRaw)
const chat = strip(chatRaw)

/** 面板里所有玩具 api 调用（用于"一条都不能漏场景"的枚举断言） */
const PANEL_CALLS = [
  'api.fetchToys', 'api.tickToys', 'api.triggerSelfPlay', 'api.equipToy', 'api.setToyMode', 'api.setToyCurve',
]

// ──────────────── ① 行为级：场景参数真的进了请求 ────────────────

test('① 带 scene=group：每个玩具接口都把 scene + groupId 放进 URL / 请求体', async () => {
  const api = await import('../src/api/index.js')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body })
    return { ok: true, json: async () => ({ ok: true, unlocked: true, toy: { toyKey: 'vibe_egg' } }) }
  }
  const scene = { scene: 'group', groupId: 3 }
  try {
    await api.fetchToys(7, scene)
    await api.equipToy(7, 'vibe_egg', { intensity: 2 }, scene)
    await api.setToyIntensity(7, 'vibe_egg', 4, scene)
    await api.removeToy(7, 'vibe_egg', scene)
    await api.setToyMode(7, 'vibe_egg', 'pulse', scene)
    await api.setToyCurve(7, 'vibe_egg', null, scene)
    await api.tickToys(7, scene)
    await api.getSelfPlayState(7, scene)
    await api.triggerSelfPlay(7, { encourage: true }, scene)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls.map(c => c.url.split('?')[0]), [
    '/api/characters/7/toys',
    '/api/characters/7/toys/vibe_egg/equip',
    '/api/characters/7/toys/vibe_egg/set-intensity',
    '/api/characters/7/toys/vibe_egg/remove',
    '/api/characters/7/toys/vibe_egg/mode',
    '/api/characters/7/toys/vibe_egg/curve',
    '/api/characters/7/toys/tick',
    '/api/characters/7/toys/self-play',
    '/api/characters/7/toys/self-play',
  ], '路径不许变（只在 body/query 上加场景）')
  assert.equal(calls[0].url, '/api/characters/7/toys?scene=group&groupId=3', '两个 GET 走 query')
  assert.equal(calls[7].url, '/api/characters/7/toys/self-play?scene=group&groupId=3')
  for (const i of [1, 2, 3, 4, 5, 6, 8]) {
    const body = JSON.parse(calls[i].body)
    assert.equal(body.scene, 'group', calls[i].url + ' 的 body 必须带 scene')
    assert.equal(body.groupId, 3, calls[i].url + ' 的 body 必须带 groupId')
  }
  assert.equal(JSON.parse(calls[1].body).intensity, 2, '场景参数不许把原有字段挤掉')
  assert.equal(JSON.parse(calls[6].body).scene, 'group', 'tick 也要带（面板轮询走它）')
})

test('① 不带场景 = 私聊：请求与改造前**逐字节一致**（老接线零影响）', async () => {
  const api = await import('../src/api/index.js')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await api.fetchToys(7)
    await api.equipToy(7, 'vibe_egg')
    await api.setToyIntensity(7, 'nipple_clamp', 3)
    await api.removeToy(7, 'collar')
    await api.setToyMode(7, 'vibe_egg', 'pulse')
    await api.setToyCurve(7, 'vibe_egg', { type: 'wave', from: 1, to: 4, durationSec: 300 })
    await api.tickToys(7)
    await api.getSelfPlayState(7)
    await api.triggerSelfPlay(7)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls.map(c => c.url), [
    '/api/characters/7/toys',
    '/api/characters/7/toys/vibe_egg/equip',
    '/api/characters/7/toys/nipple_clamp/set-intensity',
    '/api/characters/7/toys/collar/remove',
    '/api/characters/7/toys/vibe_egg/mode',
    '/api/characters/7/toys/vibe_egg/curve',
    '/api/characters/7/toys/tick',
    '/api/characters/7/toys/self-play',
    '/api/characters/7/toys/self-play',
  ], '私聊的 URL 一个字符都不许变（尤其别给 GET 挂上空 query）')
  assert.deepEqual(calls.map(c => c.body), [
    undefined,
    JSON.stringify({ intensity: 1 }),
    JSON.stringify({ intensity: 3 }),
    JSON.stringify({}),
    JSON.stringify({ mode: 'pulse' }),
    JSON.stringify({ curve: { type: 'wave', from: 1, to: 4, durationSec: 300 } }),
    JSON.stringify({}),
    undefined,
    JSON.stringify({ encourage: false }),
  ], '私聊的请求体也要逐字节一致（老测试就是这么钉的）')
})

test('① 群 id 是 0 也要带上（合法 id 不能被假值判断吃掉）', async () => {
  const api = await import('../src/api/index.js')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await api.fetchToys(7, { scene: 'group', groupId: 0 })
    await api.removeToy(7, 'collar', { scene: 'group', groupId: 0 })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(calls[0].url, '/api/characters/7/toys?scene=group&groupId=0')
  assert.deepEqual(JSON.parse(calls[1].body), { scene: 'group', groupId: 0 })
})

test('① 群 id 万一缺失：也要声明 scene=group（让服务端 400 + 人话，绝不悄悄按私聊写）', async () => {
  const api = await import('../src/api/index.js')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await api.equipToy(7, 'collar', { intensity: 1 }, { scene: 'group' })
    await api.tickToys(7, { scene: 'group' })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(JSON.parse(calls[0].body), { intensity: 1, scene: 'group' },
    '缺 groupId 时也别退回私聊口径 —— 服务端会回 invalid_group 人话，比静默写错地方强')
  assert.deepEqual(JSON.parse(calls[1].body), { scene: 'group' })
})

// ──────────────── ② 群聊视图真的把场景传下去了 ────────────────

test('★ ② 群聊视图：ToyPanel 收到 scene/groupId，四个调用点都带 groupToyScene()', () => {
  const i = group.indexOf('<ToyPanel')
  assert.ok(i > 0, '群聊视图要挂 ToyPanel')
  const seg = group.slice(i, group.indexOf('/>', i) + 2)
  assert.match(seg, /scene="group"/, '群聊面板必须声明 scene="group"（照 IntimateActionPanel 的既有写法）')
  assert.match(seg, /:group-id="store\.activeGroupId"/, '还要把当前群 id 传下来（服务端据此校验与写 group_<gid>）')

  assert.equal((group.match(/groupToyScene\(\)/g) || []).length, 4,
    '装 / 调强度 / 摘下 + 取状态四个调用点都要带场景（漏一个 = 那条链的反应又跑到私聊）')
  assert.match(group, /function groupToyScene[\s\S]{0,260}?scene: 'group'[\s\S]{0,80}?groupId/,
    '场景参数只在一处拼（别再手抄一遍）')
  assert.match(group, /:\s*\{ scene: 'group' \}/, '群 id 缺失时也别退回私聊口径（服务端会给人话 400）')
  // 私聊那份接线不许被顺手改掉（不传 = 私聊，服务端逐字保持旧行为）
  assert.equal(/scene/.test(chat.slice(chat.indexOf('<ToyPanel'), chat.indexOf('/>', chat.indexOf('<ToyPanel')))), false,
    '私聊的 ToyPanel 不该出现 scene（默认 chat）')
  for (const fn of ['api.equipToy', 'api.setToyIntensity', 'api.removeToy', 'api.fetchToys']) {
    const at = chat.indexOf(fn)
    assert.ok(at > 0, '私聊仍要调 ' + fn)
    assert.equal(chat.slice(at, chat.indexOf('\n', at)).includes('scene'), false, fn + ' 在私聊里不许带 scene 参数')
  }
})

// ──────────────── ③ 面板：每个玩具请求都透传场景 ────────────────

test('★ ③ 面板：scene/groupId props + 一处 sceneOpts，且每个玩具请求都带上它', () => {
  assert.match(panel, /scene: \{ type: String, default: 'chat' \}/, 'scene prop 默认 chat（私聊零改动）')
  assert.match(panel, /groupId: \{ type: \[Number, String\], default: null \}/, 'groupId 数字/字符串两种都认')
  assert.match(panel, /const sceneOpts = computed\(\(\) => \{/, '场景参数只算一处（computed）')
  assert.match(panel, /if \(props\.scene !== 'group'\) return \{\}/, '私聊 ⇒ 空对象（请求逐字节不变）')
  assert.match(panel, /return \{ scene: 'group' \}/, '群 id 缺失时也要声明 scene（别悄悄按私聊写）')
  // 换群 / 换场景要重取：门控是按场景算的，拿着上一个群的结论会显示错
  assert.match(panel, /watch\(\[\(\) => props\.scene, \(\) => props\.groupId\], \(\) => \{ if \(props\.open\) refresh\(\) \}\)/,
    '换群（或场景变化）要重新取数')

  // 每个玩具 api 调用都必须看见 sceneOpts：两条直调（取数 / tick / 她自己玩）显式传，
  // 其余（装 / 调强度 / 模式 / 曲线）统一走 callPlay —— 它把场景作为第四个参数转发。
  assert.match(panel, /api\.fetchToys\(id, sceneOpts\.value\)/, '取清单要带场景（群聊口径的逐件门控靠它）')
  assert.match(panel, /api\.tickToys\(id, sceneOpts\.value\)/, '轮询 tick 也要带')
  assert.match(panel, /api\.triggerSelfPlay\(id, \{ encourage: true \}, sceneOpts\.value\)/, '她自己玩那句台词也是要发在群里的')
  assert.match(panel, /const res = await fn\(id, toyKey, payload, sceneOpts\.value\)/, 'callPlay 要把场景转发给所有玩具接口')
  for (const fn of PANEL_CALLS) {
    assert.ok(panel.includes(fn), '面板仍要走 ' + fn + '（别为了加场景另造接口）')
  }
  // 反向守卫：面板里**不许**再有"没带场景"的玩具调用（否则那条链又回私聊）
  const bare = panel.match(/api\.(fetchToys|tickToys|triggerSelfPlay|equipToy|setToyMode|setToyCurve|setToyIntensity|removeToy)\([^)]*\)/g) || []
  for (const call of bare) {
    const ok = /sceneOpts\.value/.test(call) || /callPlay\(api\./.test(call) || /fn\(id, toyKey, payload/.test(call)
    assert.ok(ok, '这条玩具调用看起来没带场景：' + call)
  }
})

// ──────────────── ④ api 层：场景字段只有一个来源 ────────────────

test('④ api 层：场景字段由 toySceneFields / toySceneQuery 统一生成，玩具接口一个不漏', () => {
  assert.match(apiSrc, /function toySceneFields\(\{ scene, groupId \} = \{\}\)/, 'body 用的场景字段生成器')
  assert.match(apiSrc, /function toySceneQuery\(\{ scene, groupId \} = \{\}\)/, 'GET 用的场景 query 生成器')
  assert.match(apiSrc, /if \(scene !== 'group'\) return \{\}/, '不传 / 非 group ⇒ 空对象（私聊请求逐字节不变）')
  for (const fn of ['fetchToys', 'equipToy', 'setToyIntensity', 'removeToy', 'setToyMode', 'setToyCurve', 'tickToys', 'getSelfPlayState', 'triggerSelfPlay']) {
    const at = apiSrc.indexOf('export function ' + fn + '(')
    assert.ok(at > 0, fn + ' 必须还在（旧契约）')
    const body = apiSrc.slice(at, apiSrc.indexOf('\n}', at))
    assert.match(body, /sceneOpts = \{\}/, fn + ' 要接场景参数（放最后一个，老调用点零改动）')
    assert.ok(/toySceneFields\(sceneOpts\)|toySceneQuery\(sceneOpts\)/.test(body),
      fn + ' 要把场景真的用上（只声明不传 = 后端还是按私聊写）')
  }
  // 场景说明里要写清"为什么"（下一个人别再把它删掉）
  assert.match(apiSrc, /在哪里聊天|私聊/, '场景参数旁边要有人话说明')
})
