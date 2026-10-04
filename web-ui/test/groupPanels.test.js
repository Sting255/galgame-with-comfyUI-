/**
 * 群聊里的「🧸 玩具 / ❤ 推进」入口（2026-10-02 用户：「群聊里也没有动作系统和玩具 性爱系统的按钮」）
 *
 * 这里钉的是**行为**，不是"源码里有某一行"：
 *   ① 纯函数 resolveGroupPanelTarget 的三种情况 —— 没选目标 / 选的人不在群里 / 选好了；
 *   ② 群聊视图真的挂了这两个入口（同款 class、同款 aria-label、role=button 可键盘触发）；
 *   ③ 群聊视图真的把选中的成员 id 喂给了两个面板的 :character-id；
 *   ④ 面板是自包含的 ⇒ 群聊**不该**替它取 worn-toys / toy-options（否则又变成"两处各取一份"）。
 *
 * 为什么逻辑要抽成纯函数：SFC 里的内联判断测不到，只能退化成"断言源码里有某行" ——
 * 那种测试改个写法就失效，钉不住"绝不默认拿第一个群成员"这条真正重要的口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScript, parse } from '@vue/compiler-sfc'

import { resolveGroupPanelTarget, GROUP_PANEL_HINTS, GROUP_PANEL_META } from '../src/components/groupPanelLogic.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const VIEW = path.join(here, '..', 'src', 'views', 'GroupChatView.vue')
const CHAT = path.join(here, '..', 'src', 'views', 'ChatView.vue')
const view = fs.readFileSync(VIEW, 'utf8')
const chat = fs.readFileSync(CHAT, 'utf8')
/** 剥注释：说明文字里会提到旧的写法/反面例子，不剥会自己把自己判红 */
const stripped = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')

const MEMBERS = [
  { id: 1, display_name: '刻晴' },
  { id: 2, display_name: '纳西妲' },
]

test('① 没选目标 ⇒ 不打开、给一句人话，且**绝不默认第一个群成员**', () => {
  for (const targetId of [null, undefined, '']) {
    const r = resolveGroupPanelTarget({ targetId, members: MEMBERS })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_target')
    assert.equal(r.message, GROUP_PANEL_HINTS.noTarget)
    assert.match(r.message, /选一个人/, '提示要告诉用户怎么做（本仓规矩：门控拒绝必须是人话）')
    assert.equal(r.characterId, undefined, '没选目标时不能偷偷给出 id（那就是"默认第一个成员"）')
  }
})

test('② 群里没有成员 ⇒ 明确提示，而不是静默', () => {
  const r = resolveGroupPanelTarget({ targetId: 1, members: [] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no_members')
  assert.equal(r.message, GROUP_PANEL_HINTS.noMembers)
})

test('③ 选好的人不在当前群里（换群/退群）⇒ 拒绝并让人重选', () => {
  const r = resolveGroupPanelTarget({ targetId: 99, members: MEMBERS })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'target_gone')
  assert.match(r.message, /重新选/)
})

test('④ 选好了 ⇒ 返回那个人的 id（数字与字符串两种写法都要认）', () => {
  const a = resolveGroupPanelTarget({ targetId: 2, members: MEMBERS })
  assert.deepEqual(a, { ok: true, characterId: 2, name: '纳西妲' })
  const b = resolveGroupPanelTarget({ targetId: '2', members: MEMBERS })
  assert.equal(b.ok, true)
  assert.equal(String(b.characterId), '2', '群成员 id 从 store 来可能是字符串，不能因此判成"人不见了"')
  // 参数全缺省也不能炸（视图初始化那一拍就会调到）
  assert.equal(resolveGroupPanelTarget().ok, false)
  assert.equal(resolveGroupPanelTarget({}).ok, false)
})

test('⑤ 群聊视图挂了两个入口：与私聊同款 class、同款 aria-label、role=button 可键盘触发', () => {
  const labels = [...stripped.matchAll(/aria-label="(玩具|推进)"/g)].map((m) => m[1])
  // ⚠️ 别用 Array.sort 比中文（按码位排，"推进"会排在"玩具"前面）—— 用集合口径，意图也更清楚
  assert.equal(new Set(labels).size, 2, '两个入口都要在（缺一个用户就会说"还是没有按钮"）')
  assert.ok(labels.includes('玩具') && labels.includes('推进'), `实际只有：${labels.join('/')}`)
  assert.match(stripped, /class="touch-icon-btn toy-icon-btn"/, '玩具入口要用与私聊同一个图标钮皮肤')
  assert.match(stripped, /class="touch-icon-btn intimate-icon-btn"/, '推进入口同上')
  // 键盘可达（本仓对"图标钮"的要求：div + role=button + tabindex + aria-label）
  for (const key of ['玩具', '推进']) {
    const block = stripped.slice(Math.max(0, stripped.indexOf(`aria-label="${key}"`) - 420), stripped.indexOf(`aria-label="${key}"`) + 60)
    assert.match(block, /role="button"/, `${key} 入口要 role=button`)
    assert.match(block, /tabindex="0"/, `${key} 入口要 tabindex=0`)
    assert.match(block, /@keydown\.enter/, `${key} 入口要能键盘触发`)
  }
  // 与私聊同样的 class 名（不新造视觉体系）
  assert.match(chat, /class="touch-icon-btn toy-icon-btn"/, '私聊也应当是同一套 class（两处对齐的锚点）')
  assert.match(chat, /class="touch-icon-btn intimate-icon-btn"/, '同上')
})

test('⑥ 选中后把成员 id 喂进两个面板，并补上 ToyPanel 需要父组件做的那一半', () => {
  assert.match(stripped, /<ToyPanel[\s\S]{0,600}?:character-id="panelCharacterId"/, 'ToyPanel 要拿到选中成员的 id')
  assert.match(stripped, /<IntimateActionPanel[\s\S]{0,400}?:character-id="panelCharacterId"/, 'IntimateActionPanel 同上')

  // ⚠️ 实测结论（别被"两个面板都自包含"误导）：IntimateActionPanel 确实自己 GET + 自己 POST；
  //    但 ToyPanel 只有一半自包含 —— 「戴上 / 调强度 / 摘下」是 emit 给父组件做的。
  //    群聊必须像私聊那样接住这三个事件，否则那三个按钮在群里点了没反应（= 用户抱怨的"按钮点不出来"）。
  for (const ev of ['@toy-equip="onGroupToyEquip"', '@toy-intensity="onGroupToyIntensity"', '@toy-remove="onGroupToyRemove"']) {
    assert.ok(stripped.includes(ev), `ToyPanel 的 ${ev} 必须接住（否则"戴上/调强度/摘下"在群里没反应）`)
  }
  for (const fn of ['async function onGroupToyEquip', 'async function onGroupToyIntensity', 'async function onGroupToyRemove']) {
    assert.ok(stripped.includes(fn), `要有 ${fn}（与 ChatView 的 onToyXxx 同口径）`)
  }
  // props 也要喂（私聊就是这么喂的）：戴上之后角标与列表才会立刻更新
  assert.match(stripped, /:worn-toys="groupWornToys"/, 'worn-toys 要传群聊自己取的那份')
  assert.match(stripped, /:toy-options="groupToyOptions"/, 'toy-options 同上')

  // 取状态必须用**选中的那个人**，不能在群聊里回落到私聊角色（那会作用错人）
  const load = stripped.match(/async function loadGroupToys[\s\S]{0,1400}?\n\}/)
  assert.ok(load, '要有一处 loadGroupToys')
  assert.match(load[0], /panelCharacterId\.value/, 'loadGroupToys 要用 panelCharacterId')
  assert.doesNotMatch(load[0], /chat\.activeCharId/, '别在群聊里用私聊的 activeCharId')

  // 两个面板都要能被关掉（面板里的 × / Esc）
  assert.match(stripped, /@close="showToyPanel = false"/)
  assert.match(stripped, /@close="showIntimatePanel = false"/)
})

test('⑦ 点击处理走纯函数：未选目标时不打开面板（而不是打开一个空面板）', () => {
  // openGroupPanel: 先校验 → 不通过就 toast 后 return（return 在赋值之前）
  const fn = stripped.match(/function openGroupPanel[\s\S]*?\n\}/)
  assert.ok(fn, '要有一处统一的 openGroupPanel（两个入口共用一个判定，别各写一份）')
  const body = fn[0]
  assert.match(body, /resolveGroupPanelTarget\(/, '判定要用纯函数（口径可测）')
  assert.match(body, /if \(!r\.ok\)[\s\S]{0,120}?return/, '不通过就返回，不能继续打开面板')
  assert.match(body, /toast\?\.\(r\.message/, '不通过要给一句人话（不默默无反应）')
  assert.ok(body.indexOf('if (!r.ok)') < body.indexOf('showToyPanel.value ='), '先判定再打开，顺序不能反')
  // 两个入口都真的调它
  assert.equal((stripped.match(/openGroupPanel\('toy'\)/g) || []).length, 3, '玩具入口的 click + 两个 keydown')
  assert.equal((stripped.match(/openGroupPanel\('intimate'\)/g) || []).length, 3, '推进入口的 click + 两个 keydown')
})

test('⑧ 换目标时把面板收起来（否则面板还在对上一个成员生效）', () => {
  assert.match(stripped, /watch\(touchTargetId,[\s\S]{0,200}?showToyPanel\.value = false[\s\S]{0,120}?showIntimatePanel\.value = false/,
    '换人后必须关掉两个面板：面板里的 id 是打开那刻锁定的')
})

test('⑨ 面板开着时入口高亮（0.3s 过渡，与设计系统同节奏）', () => {
  assert.match(stripped, /\.touch-icon-btn\.is-open\s*\{[\s\S]{0,300}?0\.3s/, '入口自己就是开关，要有 is-open 高亮 + 0.3s')
  assert.match(stripped, /'is-open': showToyPanel/, '玩具入口要绑 is-open')
  assert.match(stripped, /'is-open': showIntimatePanel/, '推进入口要绑 is-open')
})

test('⑩ 群聊视图仍然能编译（脚本 + 模板），且模板调用的处理函数都存在', () => {
  const { descriptor } = parse(view, { filename: 'GroupChatView.vue' })
  const out = compileScript(descriptor, { id: 'groupchatview' })
  assert.ok(out.content.length > 0, 'compileScript 要能过（脚本语法错误会当场抛）')
  const bindings = out.bindings || {}
  const handlers = [...descriptor.template.content.matchAll(/@[\w:.-]+="([^"]+)"/g)].map((m) => m[1])
  const called = new Set()
  for (const expr of handlers) for (const m of expr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1])
  // 模板里允许写内联语句（例如 `@click="if (x) y()"`）⇒ `if(` 会被上面那条正则当成"调用了 if"。
  // 关键字不是处理函数，跳过；其余每个真函数都必须在 <script setup> 里有绑定。
  const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'typeof',
    'catch', 'try', 'function', 'new', 'await', 'in', 'of', 'do', 'delete', 'void', 'throw'])
  for (const name of called) {
    if (KEYWORDS.has(name)) continue
    assert.ok(bindings[name], `模板调用了 ${name}()，但 <script setup> 里没有它（真机踩过：引用了不存在的键 ⇒ 永远置灰）`)
  }
  // 新增的入口引用的两个面板组件必须在 script 里 import 过
  assert.match(stripped, /import ToyPanel from '\.\.\/components\/ToyPanel\.vue'/, '要 import ToyPanel')
  assert.match(stripped, /import IntimateActionPanel from '\.\.\/components\/IntimateActionPanel\.vue'/, '要 import IntimateActionPanel')
})

test('⑪ 两个入口的文案与实际行为对得上（标题里要提醒"先选一个人"）', () => {
  assert.equal(GROUP_PANEL_META.toy.ariaLabel, '玩具')
  assert.equal(GROUP_PANEL_META.intimate.ariaLabel, '推进')
  assert.match(GROUP_PANEL_META.toy.titleClosed, /先选一个人/)
  assert.match(GROUP_PANEL_META.intimate.titleClosed, /先选一个人/)
  // 视图里的 title 也要带上"先选一个人"，并且**选中之后要显示对谁**（否则用户不知道这一下作用在谁身上）
  assert.match(stripped, /:title="showToyPanel \? '收起玩具面板' : \(touchTarget \? '玩具（对 ' \+ touchTarget\.display_name \+ '）' : '玩具（先选一个人）'\)"/,
    '玩具入口的 title：未选=提示先选，已选=显示对谁')
  assert.match(stripped, /:title="showIntimatePanel \? '收起推进面板' : \(touchTarget \? '推进（对 ' \+ touchTarget\.display_name \+ '）/,
    '推进入口的 title：同上')
})
