/**
 * 「自动插入」的两套节拍不许叠加（2026-10-03 代码复查的额度洞）
 *
 * 现象：面板开着时她每 ~10 秒就说一次话，每次都是一轮 LLM 调用。
 * 根因：**两条各走各的 20 秒节拍** ——
 *   · 面板这一拍：`IntimateActionPanel.vue` 的 `AUTO_TICK_MS`（走 HTTP 全链路，她会说话 + 配图）；
 *   · 服务端那一跳：`intimateAutoThrust.js` 的**反应跳**（`AUTO_REACTION_INTERVAL_MS`）。
 *
 * 修法是"共用一个闸门"：路由在完整反应真的出来之后调 `noteReaction()`（后端口径见
 * `agent-core/src/services/intimateAutoThrust.js` 与 `reactionDue()`），面板这一拍也会记账。
 * 于是面板的周期**必须严格短于**闸门 —— 每一拍都在闸门重开之前把它续上，
 * 服务端每一跳就都退化成状态跳（silent，不调模型），她说话的节拍只剩一条。
 *
 * 本文件钉前端这一半（后端那一半在 `agent-core/test/intimateAutoThrust.test.js` ⑤/⑥ 与
 * `agent-core/test/intimateActionHttp.test.js` 的闸门用例里）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panelSrc = readFileSync(new URL('../src/components/IntimateActionPanel.vue', import.meta.url), 'utf8')
const tickerSrc = readFileSync(new URL('../../agent-core/src/services/intimateAutoThrust.js', import.meta.url), 'utf8')

/** 读一个数字常量（允许 20_000 这种下划线写法） */
function numericConst(src, pattern, name) {
  const raw = pattern.exec(src)?.[1]
  assert.ok(raw != null, `找不到 ${name} 的定义`)
  const value = Number(String(raw).replace(/_/g, ''))
  assert.ok(Number.isFinite(value) && value > 0, `${name} 必须是正数（实际 ${raw}）`)
  return value
}

const panelTickMs = numericConst(panelSrc, /const AUTO_TICK_MS = ([\d_]+)/, 'AUTO_TICK_MS')
const reactionGateMs = numericConst(tickerSrc, /export const AUTO_REACTION_INTERVAL_MS = ([\d_]+)/, 'AUTO_REACTION_INTERVAL_MS')

test('① 面板这一拍必须**严格短于**服务端反应闸门（短于才能独占，不再两条节拍叠加）', () => {
  assert.ok(panelTickMs < reactionGateMs,
    `面板 AUTO_TICK_MS=${panelTickMs}ms 必须 < 服务端 AUTO_REACTION_INTERVAL_MS=${reactionGateMs}ms：`
    + '每一拍都在闸门重开之前续上，服务端那一跳才只能走 silent 状态跳；'
    + '设成更长（如 25~30 秒）没用 —— 闸门会在两拍之间重开，服务端照样补一跳（叠加只是变稀）')
})

test('② 节拍是"上一拍走完再排下一拍"的 setTimeout 链，不是 setInterval', () => {
  assert.equal(/setInterval\(/.test(panelSrc), false,
    '不许用 setInterval：模型慢的时候它会被 busy 跳过，两拍之间被拖过闸门 ⇒ 叠加又回来')
  assert.match(panelSrc, /autoTimer = setTimeout\(autoTickOnce, AUTO_TICK_MS\)/, '唯一的排期入口')
  assert.match(panelSrc,
    /async function autoTickOnce\(\)[\s\S]{0,400}?await run\(\{ key: 'thrust' \}, \{ auto: true \}\)[\s\S]{0,200}?finally[\s\S]{0,120}?scheduleAutoTick\(\)/,
    '跑完这一拍（成功 / 失败 / 被跳过都算）再排下一拍，间隔才会恒等于 AUTO_TICK_MS')
  assert.match(panelSrc, /clearTimeout\(autoTimer\)/, '关掉自动 / 卸载时要把这一拍清掉（不留定时器）')
})

test('③ 节拍只在「面板开着 + 自动插入开着」时跑（关掉面板就把节拍交回服务端 ticker）', () => {
  assert.match(panelSrc, /if \(autoOn\.value && props\.open\) scheduleAutoTick\(\)/, '开着的判定必须带上 props.open')
  assert.match(panelSrc, /if \(autoTimer \|\| !autoOn\.value \|\| !props\.open\) return/, '排期时再确认一次（幂等，不重复排）')
  assert.match(panelSrc, /watch\(\[\(\) => props\.open, autoOn\], syncAutoTick\)/, '开合面板 / 开关自动都要重新判定')
})
