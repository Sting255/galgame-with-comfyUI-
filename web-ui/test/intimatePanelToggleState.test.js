/**
 * 推进面板：开关型动作的「状态回显」守卫（2026-10-02 用户反馈）
 *
 * 用户原话：「性爱面板的那块前端 在我点击捆绑之后 字不变 不知道是捆绑上了还是未捆绑 自动抽插也是这个问题 /
 *            禁止高潮的模式也是一样 点下去不知道是不是禁止 按钮一直是一样的」
 *
 * 根因（读代码确认）：服务端 `state` 里**一直就有** bondage / autoThrust / denial 三个字段
 * （agent-core/src/services/intimateActionService.js 的 buildPanelSnapshot），
 * 但前端只把 autoThrust 用于"自动抽插 tick 判定"，**从没显示给用户** ⇒ 点完按钮样式与文字都不变。
 *
 * 这条测试钉两件事：
 *   ① 前端三处回显都在（按钮 :active / 文案翻转 / HUD 胶囊）—— 少一处就红；
 *   ② **跨文件契约**：服务端快照确实提供这三个字段（字段名一旦改名，这里立刻红，
 *      而不是等到用户又发现"点了看不出来"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const PANEL = path.join(ROOT, 'web-ui', 'src', 'components', 'IntimateActionPanel.vue')
const SERVICE = path.join(ROOT, 'agent-core', 'src', 'services', 'intimateActionService.js')

const panel = fs.readFileSync(PANEL, 'utf8')
const service = fs.readFileSync(SERVICE, 'utf8')

test('① 按钮接上了状态：:active 绑定开关字段（不再是"点了看不出"）', () => {
  assert.match(panel, /:active="isToggleOn\(action\.key\)"/,
    '动作按钮必须有 :active="isToggleOn(action.key)" —— 否则点了捆绑/自动/禁止高潮看不出生效')
  assert.match(panel, /\{\{\s*labelFor\(action\)\s*\}\}/,
    '按钮文字必须走 labelFor(action)（生效时翻转成「解开捆绑 / 停止自动 / 允许她到」）')
  assert.match(panel, /:title="hintFor\(action\)"/,
    '按钮 title 必须走 hintFor(action)（生效时给出"再点一次解除"的说明）')
})

test('② HUD 必须把当前生效的开关明写出来（一枚胶囊）', () => {
  assert.match(panel, /v-if="toggleChips\.length"/, 'HUD 要有 toggleChips 胶囊')
  assert.match(panel, /toggleChips\.join\(' · '\)/, '胶囊内容来自 toggleChips')
  // 2026-10-02 分型捆绑：捆绑那一段改成"已捆 手腕+龟甲缚"这种逐项写法（不再是一句"已捆绑"）
  assert.match(panel, /out\.push\('已捆 ' \+ bondNames\.join\('\+'\)\)/, '胶囊要写清绑了哪几处')
  // 2026-10-03：文案随语义改了（用户：「自动的意思是自动插入 不是自己动」）⇒ 胶囊写「自动插入中」
  for (const text of ['禁止高潮中', '自动插入中']) {
    assert.ok(panel.includes(text), `胶囊文案缺少「${text}」`)
  }
  for (const key of ['bondage', 'bind_box', 'bind_legs', 'bind_body', 'bind_gag']) {
    assert.ok(panel.includes(key), `面板缺少分型捆绑的键：${key}`)
  }
})

test('③ 前端字段映射与服务端快照字段名一致（跨文件契约）', () => {
  // 前端读的字段名
  const front = { bondage: 'bondage', auto: 'autoThrust', denial: 'denial' }
  for (const [key, field] of Object.entries(front)) {
    assert.match(panel, new RegExp(`${key}:\\s*'${field}'`),
      `前端 TOGGLE_FIELD 应把动作 ${key} 映射到服务端字段 ${field}`)
  }
  // 服务端真写进了快照（buildPanelSnapshot 的 state 字段）
  for (const field of ['bondage', 'autoThrust', 'denial']) {
    assert.match(service, new RegExp(`${field}:\\s*clampInt\\(`),
      `服务端快照必须提供 state.${field}（前端靠它判"生效没有"）`)
  }
})

test('④ 开关判定只读服务端 state，不自己记账（刷新即同步）', () => {
  assert.match(panel, /snapshot\.value\?\.state\?\.\[field\]/,
    'isToggleOn 必须直接读 snapshot.state（服务端说了算），不许前端自建一份开关状态')
  assert.ok(!/toggleOn\s*=\s*ref\(/.test(panel),
    '不允许再出现一份前端自持的开关状态（会和后端漂移）')
})

test('④b 真实故障回归：开关态必须同时认**布尔**与**数字**（第一版只判 === 1 ⇒ 文字永不翻转）', () => {
  // 用户 2026-10-02 报「自动抽插点了不变成停止自动抽插 / 禁止高潮关不掉」。
  // 真相：服务端 buildPanelSnapshot 投影的是**布尔值**（autoThrust: current.autoThrust === 1），
  // 而面板第一版写的是 `snapshot.value?.state?.[field] === 1` ⇒ 对 true 永远不成立
  // ⇒ **行为其实是对的（日志里开关真的切换了），但按钮文字永不翻转**，用户以为停不下来。
  // 这条断言把两个形态都钉住：只认一种就会再犯。
  assert.match(panel, /value === true \|\| value === 1/,
    '布尔与数字两种形态都要认（服务端投影的是布尔）')
  assert.ok(!/state\?\.\[field\]\s*===\s*1(?!\s*\|\|)/.test(panel),
    '不许再出现「只判 === 1」的写法 —— 那正是这次的 bug')
  // 跨包契约：服务端那边确实投影成布尔（谁改了它，面板与这条断言都得跟着改）
  const svc = fs.readFileSync(
    path.join(ROOT, 'agent-core', 'src', 'services', 'intimateActionService.js'), 'utf8')
  for (const field of ['autoThrust', 'denial']) {
    assert.match(svc, new RegExp(`${field}: current\\.${field} === 1`),
      `快照里 ${field} 是布尔（\`=== 1\`）；若改成 0/1 形态，请同步面板与这条断言`)
  }
  // bondage 是**位掩码**（分型捆绑可叠加）⇒ 快照里判 > 0；面板读的是逐位的 bonds
  assert.match(svc, /bondage: current\.bondage > 0,/, 'bondage 快照判 > 0（位掩码，不是 0/1）')
  assert.match(svc, /bonds: Object\.fromEntries\(/, '分型捆绑要投影成 bonds 逐位布尔（面板靠它显示选中态）')
})

test('⑤ 群聊接线：面板带 scene/groupId，群聊视图真的传了（否则她的反应又跑回私聊）', () => {
  // 面板：props + 两处透传（GET 拼 query / POST 带 body），少一处就等于没接
  assert.match(panel, /scene: \{ type: String, default: 'chat' \}/, '面板要有 scene prop')
  assert.match(panel, /groupId: \{ type: \[Number, String\], default: null \}/, '面板要有 groupId prop')
  assert.match(panel, /fetchIntimateActionState\(id, \{ scene: props\.scene, groupId: props\.groupId \}\)/,
    'GET 状态要带上场景（否则群聊里读的是私聊的场景快照）')
  assert.match(panel, /props\.scene === 'group' && props\.groupId \? \{ scene: 'group', groupId: props\.groupId \}/,
    'POST 动作要带上场景（这一条就是"消息跑到私聊"的开关）')
  // 群聊视图：必须显式传 group
  const groupView = fs.readFileSync(path.join(ROOT, 'web-ui', 'src', 'views', 'GroupChatView.vue'), 'utf8')
  assert.match(groupView, /scene="group"/, 'GroupChatView 挂面板时要传 scene="group"')
  assert.match(groupView, /:group-id="store\.activeGroupId"/, 'GroupChatView 要传当前群 id')
  // api 层：query 真拼出来了（后端按它切会话）
  const api = fs.readFileSync(path.join(ROOT, 'web-ui', 'src', 'api', 'index.js'), 'utf8')
  assert.match(api, /\?scene=group&groupId=/, 'api 要把 ?scene=group&groupId= 拼进 URL')
  assert.match(api, /scene = 'chat', groupId = null, signal/, 'api 的默认值必须是私聊（老调用不变）')
})

