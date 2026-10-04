/**
 * 触摸动作浮窗的两条真机反馈（2026-10-01 用户实测）
 *
 * ## 现象
 * 1. 「滑动之后还得返回最顶部才能拖动」—— 面板本体是滚动容器（`overflow-y:auto`），
 *    而唯一的拖动把手 `.touch-header` 是它的**第一个子元素**：往下滑，把手就滚出视野，抓不到了。
 * 2. 「拖动框比较卡」—— 拖动时每一帧都往响应式 ref（`dragOffset`）里写位移，
 *    触发整块面板重渲染；面板又有圆角/阴影/半透明背景，真机上就是一顿一顿的。
 *
 * ## 修法（本文件钉住的就是这两条）
 * 1. 面板不再滚动：`display:flex; flex-direction:column; overflow:hidden`，
 *    滚动下沉到 `.touch-body`（`overflow-y:auto; min-height:0`）⇒ 头部常驻，任何滚动位置都能拖。
 * 2. 拖动不再碰响应式：`requestAnimationFrame` 合并高频 `pointermove`，
 *    直接写 `el.style.transform`；只在松手时把最终位移**提交**回 `dragOffset`。
 *
 * 这两条都是"改回去就复发"的类型（结构看着都挺合理），所以用源码级断言钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../../web-ui/src/components/TouchActionPanel.vue', import.meta.url)
const raw = readFileSync(SRC, 'utf8')

/** 去掉 CSS/JS 注释再断言：注释里会**描述**旧实现（比如"原来面板本体是滚动容器（overflow-y:auto）"），
 *  直接对原文做正则会把注释命中，冤枉了修好的代码 —— 第一版就栽在这上面。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const src = stripComments(raw)
/** 模板区（去注释后），用于「不许裸 button」这类只看标记的断言 */
const template = src.slice(src.indexOf('<template>'), src.indexOf('</template>'))

/** 取出某个选择器的样式块（从 `选择器 {` 到配对的 `}`） */
function styleBlock(selector) {
  const at = src.indexOf(`\n${selector} {`)
  assert.ok(at > 0, `找不到样式块 ${selector}`)
  const end = src.indexOf('\n}', at)
  assert.ok(end > at, `样式块 ${selector} 没闭合`)
  return src.slice(at, end)
}

test('① 面板本体不再滚动，滚动下沉到 .touch-body（否则滑下去就抓不到把手）', () => {
  const panel = styleBlock('.touch-panel')
  assert.match(panel, /display:\s*flex/, '面板要是 flex 列')
  assert.match(panel, /flex-direction:\s*column/, '面板要是 flex 列')
  assert.match(panel, /overflow:\s*hidden/, '面板本体必须不滚动（这是"把手会被滚走"的根因）')
  assert.equal(/overflow-y:\s*auto/.test(panel), false, '面板本体不能再是滚动容器')

  const body = styleBlock('.touch-body')
  assert.match(body, /overflow-y:\s*auto/, '内容区要自己滚')
  assert.match(body, /min-height:\s*0/, 'flex 子项要 min-height:0，否则内部滚不动')
  assert.match(body, /flex:\s*1 1 auto/, '内容区要吃掉剩余高度')

  const header = styleBlock('.touch-header')
  assert.match(header, /flex:\s*0 0 auto/, '头部常驻：不参与伸缩与滚动')
  assert.match(header, /touch-action:\s*none/, '把手仍要吃掉触摸滚动（否则手指一滑就变成滚内容）')
  assert.equal(/touch-action/.test(panel), false, '面板本体不能加 touch-action:none（那样触屏滚不动内容）')
})

test('② 拖动不再走响应式：rAF 合并 + 直接写 style.transform（否则每帧整块重渲染=卡）', () => {
  assert.match(src, /requestAnimationFrame\(applyDragFrame\)/, '高频 pointermove 要用 rAF 合并')
  assert.match(src, /function applyDragFrame\(\)/, '要有每帧应用函数')
  assert.match(src, /rafId = requestAnimationFrame/, '要记录在途帧，避免同帧排队多次')

  // onDragMove 里**不许**写 dragOffset（那是提交值，拖动中一写就整块重渲染）
  const moveAt = src.indexOf('function onDragMove(e) {')
  assert.ok(moveAt > 0)
  const moveBody = src.slice(moveAt, src.indexOf('function onDragEnd()', moveAt))
  assert.equal(/dragOffset\.value\s*=/.test(moveBody), false, '拖动过程中不许改 dragOffset（响应式）')
  assert.match(moveBody, /lastPointer\s*=/, '只记最近一次指针坐标')

  // 单一写入口：transform 只能由 applyTransform 写
  const writers = src.match(/style\.transform\s*=/g) || []
  assert.equal(writers.length, 1, `style.transform 只允许有一个写入点，实际 ${writers.length} 个`)
  assert.match(src, /function applyTransform\(offset\)/, '要有统一的 applyTransform')
  // 模板里不许再留一份 :style 绑定（会和直接写 DOM 互相覆盖）
  assert.equal(/:style="dragOffset/.test(src), false, '模板不该再用 :style 绑定位移（会和直接写 DOM 打架）')
  assert.match(src, /watch\(dragOffset/, 'dragOffset 变化时要同步一次 DOM（打开恢复位置 / 松手提交）')
})

test('③ 收尾与边界：松手补最后一帧、保存位置、释放合成层提示', () => {
  const endAt = src.indexOf('function onDragEnd() {')
  const endBody = src.slice(endAt, endAt + 1200)
  assert.match(endBody, /cancelAnimationFrame\(rafId\)/, '松手要取消在途帧')
  assert.match(endBody, /applyDragFrame\(\)/, '松手要把最后一帧补上（否则快速甩动会停在上帧）')
  assert.match(endBody, /savePos\(lastApplied\)/, '松手要把最终位置存起来')
  assert.match(endBody, /willChange = ''/, '松手要撤掉 will-change')
  assert.match(src, /addEventListener\('pointercancel'/, '要处理 pointercancel（否则手指被系统抢走时拖动态卡住）')
  // 拖动期间的合成层提示
  assert.match(src, /willChange = 'transform'/, '拖动期间提示合成层，减少真机重绘')
})

test('④ 仓库约定：不写裸 button（交互元件走 LinsheButton / role=button）', () => {
  assert.equal(/<button[\s>]/.test(template), false, 'AGENTS.md：模板里不许裸 <button>')
  assert.match(template, /linshe-button/, '要用 LinsheButton')
})
