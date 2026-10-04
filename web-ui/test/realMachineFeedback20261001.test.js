/**
 * 2026-10-01 真机反馈三条的回归守卫（都来自用户实机日志 / 口述）
 *
 *   ①「窗口确实可以浮动了，但是打开就关不了」
 *      —— 动作面板浮窗的 ✕ 点不动。真因：`.touch-header` 整块是拖动把手，
 *      `onDragStart` 里**无条件** `setPointerCapture` 到头部；指针被头部捕获后，
 *      pointerup 被重定向到头部，浏览器随后把 click 派发到「pointerdown 目标与 pointerup
 *      目标的最近公共祖先」＝头部，于是头部里的 ✕ /「对 XXX」永远收不到 click。
 *   ②「玩具也一点就报错」
 *      —— `POST /api/characters/:id/toys/:key/equip` 400
 *      `Unexpected token '"', ""{\"intensity\":1}"" is not valid JSON`。
 *      真因：api 层三个玩具函数自己 `JSON.stringify`，而 `request()` 基元**还会再 stringify 一次**。
 *   ③「手机端的群聊设置不能滚动；电脑的也是只有群成员那里能划」
 *      —— `.gc-drawer` 是 `overflow: hidden` 的定高 flex 列，唯一的滚动容器是 `.gc-member-edit`；
 *      内容一超视口，底部的「撤回上一轮 / 解散群聊 / 保存」就被裁到视口外点不到。
 *
 * 这一组断言的是**契约**（不许再退回旧写法），不是实现细节；真机点击由 e2e/run-e2e.mjs 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

const read = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8')

const apiSrc = read('api/index.js')
const actRaw = read('components/TouchActionPanel.vue')
const act = parseSfc(actRaw).descriptor

/**
 * 断言前先剥掉注释 —— 这一轮的修复注释里**逐字写了**旧写法（`setPointerCapture` / `overflow:hidden`），
 * 不剥的话「注释里提到旧写法」会被误判成「代码里还是旧写法」。
 */
const stripJsComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const stripCssComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 从 api/index.js 里截出某个具名导出函数的源码段（到下一个顶层 export 为止） */
function fnSource(src, name) {
  const start = src.indexOf(`export function ${name}(`)
  if (start < 0) return ''
  const rest = src.slice(start)
  const next = rest.indexOf('\nexport ', 1)
  return next > 0 ? rest.slice(0, next) : rest
}

// ── ① 动作面板浮窗：✕ 必须点得到 ─────────────────────────────────────────────
test('动作面板：拖动把手不许从头部按钮上抢指针（✕ 关不掉的真因）', () => {
  const script = stripJsComments(act.scriptSetup.content)
  const iStart = script.indexOf('function onDragStart')
  const iEnd = script.indexOf('function onDragEnd')
  assert.ok(iStart > 0 && iEnd > iStart, '要能定位到 onDragStart / onDragEnd')
  const onDragStart = script.slice(iStart, iEnd)

  assert.ok(/closest\(/.test(onDragStart), 'onDragStart 必须先判断按下的是不是头部里的交互元件')
  assert.ok(/button/.test(onDragStart), '判定选择器必须能命中 LinsheButton 渲染出的 <button class="ls-btn">')

  const iGuard = onDragStart.indexOf('closest(')
  const iCapture = onDragStart.indexOf('setPointerCapture')
  assert.ok(iCapture > 0, '拖动仍要捕获指针（触摸拖出面板才跟手）')
  assert.ok(iGuard > 0 && iGuard < iCapture, '守卫必须在 setPointerCapture **之前** return，否则捕获照抢')

  // 那一下必须是真的 return，而不是记个变量
  const guardLine = onDragStart.slice(iGuard, onDragStart.indexOf('\n', iGuard))
  assert.ok(/return/.test(guardLine), '命中交互元件要直接 return（不启动拖动、不抢指针）')
})

test('动作面板：✕ 走 LinsheButton + emit close，父组件两个页面都接住', () => {
  const tpl = act.template.content
  assert.ok(/aria-label="关闭动作面板"/.test(tpl), '✕ 的无障碍标签保持')
  assert.ok(/@click="requestClose"/.test(tpl), '✕ 要接到 requestClose')
  assert.ok(/emit\('close'\)/.test(act.scriptSetup.content), 'requestClose 要 emit close')
  assert.ok(/linshe-button/.test(tpl), '按钮继续用 Linshe 组件')

  for (const file of ['views/ChatView.vue', 'views/GroupChatView.vue']) {
    const d = parseSfc(read(file)).descriptor
    const tpl2 = d.template.content
    const i = tpl2.indexOf('<TouchActionPanel')
    assert.ok(i > 0, file + ' 应挂载 TouchActionPanel')
    const seg = tpl2.slice(i, tpl2.indexOf('/>', i) + 2)
    assert.ok(/:open="showTouchPanel"/.test(seg), file + ' 要受控显隐')
    assert.ok(/@close="showTouchPanel = false"/.test(seg), file + ' 必须处理 close（否则 ✕ 还是关不掉）')
  }
})

// ── ② 玩具三接口：body 传对象，别再自己 stringify ────────────────────────────
test('玩具三接口：body 必须是对象字面量（request() 基元负责 stringify）', () => {
  // 反向守卫：基元必须仍然自己 stringify —— 否则下面那条就站不住了
  assert.ok(/body: body !== undefined \? JSON\.stringify\(body\) : undefined/.test(apiSrc),
    'request() 基元负责 stringify，调用方一律传对象')

  for (const fn of ['equipToy', 'setToyIntensity', 'removeToy']) {
    const seg = fnSource(apiSrc, fn)
    assert.ok(seg.length > 40, fn + ' 应存在')
    assert.equal(/JSON\.stringify/.test(seg), false, fn + ' 的 body 不许自己 JSON.stringify（会双重编码 ⇒ 400）')
    assert.ok(/body:\s*\{/.test(seg), fn + ' 的 body 应是对象字面量')
  }
  // equipToy 的强度仍要能传默认值 1
  assert.ok(/\{\s*intensity = 1\s*\}\s*=\s*\{\}/.test(fnSource(apiSrc, 'equipToy')),
    'equipToy 强度默认 1 的契约不变')
})

test('request() 基元：4xx 取人话 message 再回落机器码 error；5xx 只取 error（不泄内部信息）', () => {
  const prim = apiSrc.slice(apiSrc.indexOf('async function request('), apiSrc.indexOf('return result'))
  assert.ok(prim.length > 200, '要能定位到 request() 基元')
  assert.ok(/res\.status\s*<\s*500\s*\?\s*\(?\s*result\.message\s*\|\|\s*result\.error/.test(prim),
    '4xx 必须优先 result.message —— 否则玩具门控被拒时 toast 出来的是 toy_gate_blocked 这种机器码')
  assert.ok(/:\s*result\.error/.test(prim), '5xx 分支只取 error（errorHandler 的 5xx message 可能含 SQL/路径）')
  assert.equal(/throw new Error\(result\.error \|\| result\.message/.test(prim), false, '不许退回旧顺序')
})

// ── ②b 玩具入口与背包清单（真机反馈的同一批） ────────────────────────────────
test('聊天页：冷启动/换角色就拉玩具状态（否则 🧸 入口根本不渲染）', () => {
  const chat = parseSfc(read('views/ChatView.vue')).descriptor
  const script = chat.scriptSetup.content
  const i = script.indexOf("watch(() => chat.activeCharId")
  assert.ok(i > 0, '要能定位到 activeCharId 的 watcher')
  const seg = script.slice(i, script.indexOf('}, { immediate: true })', i) + 24)
  assert.ok(/loadToys\(\)/.test(seg),
    'loadToys() 必须挂在「进页面 / 换角色」这条 watcher 上（原来只在点开 ✋ 时才算，冷启动看不到 🧸）')
  assert.ok(/\{ immediate: true \}/.test(seg), '要 immediate，否则首屏永远不拉')
  // 面板仍要受服务端 unlocked 门控
  assert.ok(/v-if="toysEnabled"/.test(chat.template.content), '未解锁仍不渲染入口')
})

test('聊天页：把服务端玩具清单（含逐件 gate）传给面板，别让它回落前端镜像', () => {
  const chat = parseSfc(read('views/ChatView.vue')).descriptor
  const script = chat.scriptSetup.content
  const tpl = chat.template.content
  assert.ok(/:toy-options="toyOptions"/.test(tpl), 'ToyPanel 要收到 toyOptions')
  assert.ok(/toyOptions\.value\s*=\s*Array\.isArray\(res\?\.available\)/.test(script),
    'toyOptions 要来自 GET /toys 的 available[]（带服务端 gate）')
  for (const guard of [/if \(!charId\)/, /catch \{/]) {
    assert.ok(guard.test(script), '取不到时要清空，别留着上一个角色的清单')
  }
  const d = parseSfc(read('components/ToyPanel.vue')).descriptor
  assert.ok(/props\.toyOptions\s*&&\s*props\.toyOptions\.length/.test(d.scriptSetup.content),
    'ToyPanel 侧仍保持「服务端给了就用」的优先级')
})

// ── ③ 群设置抽屉：滚动容器 + 底部按钮常驻 ────────────────────────────────────
// 2026-10-04 合并上游 v3.6.3：抽屉被重构成 head / body / foot 三段，
// 「底部按钮点不到」这个真机 bug 换了实现 —— 外壳 overflow:hidden，**正文**滚，
// 底部操作区 flex-shrink:0 **常驻视口**（比旧版「整个抽屉当滚动容器」更强：按钮根本不滚走）。
// 断言随之升级：口径从「.gc-drawer 自己可滚」改为「body 滚 + foot 常驻」，覆盖面只增不减。
test('群设置抽屉：正文可滚 + 底部操作区常驻（手机端能滚 / 桌面端底部按钮点得到）', () => {
  const raw = read('views/GroupChatView.vue')
  const d = parseSfc(raw).descriptor
  const css = stripCssComments(d.styles.map(s => s.content).join('\n'))

  const iDrawer = css.indexOf('.gc-drawer {')
  const iDrawerEnd = css.indexOf('.gc-drawer-head {')
  assert.ok(iDrawer > 0 && iDrawerEnd > iDrawer, '要能定位到 .gc-drawer 规则（其后应紧跟 .gc-drawer-head）')
  const drawer = css.slice(iDrawer, iDrawerEnd)

  // 三段式结构 + 常驻（缺任何一段都会复现同款"底部按钮被裁到点不到"的真机 bug）
  for (const part of ['.gc-drawer-head {', '.gc-drawer-body {', '.gc-drawer-foot {']) {
    assert.ok(css.includes(part), `抽屉三段式结构缺 ${part}（上游 v3.6.3 起的不变量）`)
  }
  assert.ok(/\.gc-drawer-foot \{[^}]*flex-shrink:\s*0/.test(css), '底部操作区必须 flex-shrink:0，否则会被表项挤走')
  assert.ok(/\.gc-drawer-head \{[^}]*flex-shrink:\s*0/.test(css), '标题栏必须 flex-shrink:0，否则会跟着表项滚走')
  assert.ok(/\.gc-drawer-body \{[^}]*flex:\s*1/.test(css), '正文必须 flex:1 吃掉剩余高度，否则没有滚动区')
  assert.ok(/\.gc-drawer-body \{[^}]*min-height:\s*0/.test(css), '正文必须 min-height:0，否则 flex 子项撑高、永远不滚')

  // 外壳：只做布局，**自己不滚**（外壳再滚会和 body 嵌套打架）
  assert.ok(/overflow:\s*hidden/.test(drawer), '外壳必须 overflow:hidden（滚动由 .gc-drawer-body 承担）')
  assert.equal(/overflow-y:\s*auto/.test(drawer), false, '外壳不许自己当滚动容器（会和 body 的滚动嵌套打架）')

  // 真正的滚动容器是正文，且要有 iPad/手机上的惯性与边界行为
  const iBody = css.indexOf('.gc-drawer-body {')
  const iBodyEnd = css.indexOf('.gc-drawer-foot {')
  assert.ok(iBody > 0 && iBodyEnd > iBody, '要能定位到 .gc-drawer-body 规则')
  const body = css.slice(iBody, iBodyEnd)
  assert.ok(/overflow-y:\s*auto/.test(body), '.gc-drawer-body 必须 y 轴可滚')
  assert.ok(/overscroll-behavior:\s*contain/.test(body), '正文滚到底不要滚穿到页面')
  assert.ok(/-webkit-overflow-scrolling:\s*touch/.test(body), 'iOS 上要有惯性滚动')

  // 安全区：底部按钮不能被手势条压住
  assert.ok(/safe-area-inset-bottom/.test(css), '移动端底部要留安全区，否则「保存」被手势条压住')

  const iMember = css.indexOf('.gc-member-field {')
  const iCheck = css.indexOf('.gc-member-check {')
  assert.ok(iMember > 0 && iCheck > iMember, '要能定位到 .gc-member-field / .gc-member-edit 规则')
  const member = css.slice(iMember, iCheck)
  assert.equal(/flex:\s*1;/.test(member), false, '群成员区不许再「吃掉全部剩余高度」（那样抽屉永远没得滚）')
  assert.ok(/max-height/.test(member), '成员网格要有高度上限')
  assert.ok(/overflow-y:\s*auto/.test(member), '成员网格自己仍要能滚（它是选择器）')

  // 模板侧：三段式结构必须与 CSS 对得上（class 名写错就是"样式全丢"）
  const tpl = d.template.content
  assert.ok(/class="gc-drawer-overlay"[\s\S]{0,200}class="gc-drawer"/.test(tpl), '结构保持：overlay > drawer')
  for (const cls of ['gc-drawer-head', 'gc-drawer-body', 'gc-drawer-foot']) {
    assert.ok(tpl.includes(`class="${cls}"`), `模板缺 .${cls} 容器（CSS 有、模板没有 = 样式全丢）`)
  }
  const compiled = compileTemplate({ source: tpl, filename: 'GroupChatView.vue', id: 'gc' })
  assert.deepEqual(compiled.errors, [], '模板要能编译')
})
