/**
 * §4.2 面板浮窗化：可拖动 + 去遮罩 + 去自动收起 + busyActions Set（不同动作并发）+ 位置持久化
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

const panelFile = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const d = parseSfc(panelFile).descriptor
const tpl = d.template.content
const script = d.scriptSetup.content
const style = panelFile.slice(panelFile.indexOf('<style'))
const chat = readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
const group = readFileSync(new URL('../src/views/GroupChatView.vue', import.meta.url), 'utf8')

test('无遮罩：点外面不关闭、只有 ✕ 关', () => {
  const compiled = compileTemplate({ source: tpl, filename: 'TouchActionPanel.vue', id: 'p' })
  assert.deepEqual(compiled.errors, [])
  assert.equal(/@click\.self/.test(tpl), false, '遮罩点击关闭要删掉')
  // 只看 .touch-overlay 那一段 —— 第一版用全局匹配，被 .touch-card.is-busy 的 pointer-events:none 蒙混过去了（假绿）
  const overlayBlock = style.slice(style.indexOf('.touch-overlay {'), style.indexOf('.touch-panel {'))
  assert.ok(/pointer-events:\s*none/.test(overlayBlock), '定位层不吃指针事件（等于没有遮罩）')
  assert.ok(/pointer-events:\s*auto/.test(style.slice(style.indexOf('.touch-panel {'))), '面板本体仍可交互')
  assert.ok(tpl.includes('关闭动作面板'), '✕ 还在')
})

test('浮窗尺寸 ~340px + 拖动手柄与状态类', () => {
  assert.ok(/width:\s*min\(340px/.test(style), '宽度收窄到 ~340px')
  assert.equal(/width:\s*520px/.test(style), false, '旧的 520 全宽要没了')
  assert.ok(tpl.includes('@pointerdown="onDragStart"'), '标题栏是拖动把手')
  assert.ok(tpl.includes('is-dragging'), '拖动中有状态类')
  assert.ok(style.includes('cursor: grab'), '有「可拖」暗示')
  assert.ok(script.includes('clampOffset'), '要做视口边界 clamp')
})

test('位置持久化：localStorage key = touch-panel-pos；关掉再开回默认位置', () => {
  assert.ok(script.includes("'touch-panel-pos'"), 'key 要一致')
  assert.ok(script.includes('localStorage.getItem'), '要读')
  assert.ok(script.includes('localStorage.setItem'), '要有写入实现')
  // 必须**在拖动结束时**真的调用 savePos —— 第一版只断言 localStorage.setItem 存在，
  // 变异把 onDragEnd 里的调用删掉后仍然绿（假绿），所以这里钉住调用点。
  // 2026-10-01：原来是 `slice(indexOf(...), +400)` 的**固定 400 字窗口**，把 onDragEnd 写长一点
  // （加了 rAF 合并与注释）就会把 `savePos(` 挤出窗口、误报成"没存位置"。
  // 改成**取完整函数体**：到下一个顶层 `function ` 为止。
  const endAt = script.indexOf('function onDragEnd')
  const nextFn = script.indexOf('\nfunction ', endAt + 1)
  const dragEnd = script.slice(endAt, nextFn === -1 ? undefined : nextFn)
  assert.ok(dragEnd.includes('savePos('), '拖动结束要真的把位置存下来')
  assert.ok(/dragOffset\.value = null/.test(script), '打开时要能回默认位置')
  assert.ok(script.includes('restoredOnce'), '「刷新恢复 / 关掉再开回默认」两者要区分')
})

test('busyActions：Set 化、每卡独立 loading、旧单值仍有兜底', () => {
  assert.ok(script.includes('busyActions'), '要有 Set prop')
  assert.ok(script.includes('function isBusy'), '卡片按 key 判断')
  assert.equal(/busyAction === action\.key/.test(tpl), false, '模板不再用单值判断')
  assert.ok(tpl.includes('isBusy(action.key)'), '模板走 isBusy')
  assert.ok(/typeof set\.has === 'function'/.test(script), 'Set / 数组都吃')
})

test('两个视图：Set 化 + 传 busy-actions + 不同动作可并发 + 不再自动收起', () => {
  for (const [name, src] of [['ChatView', chat], ['GroupChatView', group]]) {
    assert.ok(src.includes('touchBusyActions'), name + ' 要用 Set')
    assert.equal(src.includes('touchBusyAction ='), false, name + ' 不该残留单值 ref')
    assert.ok(src.includes(':busy-actions="touchBusyActions"'), name + ' 要传下去')
    assert.ok(src.includes('touchBusyActions.value.has(actionId)'), name + ' 同动作才忽略')
    assert.equal(/showTouchPanel\.value = false/.test(src.slice(src.indexOf('async function onTouchAction'))), false,
      name + '：§4.2 起不再自动收起')
  }
})
