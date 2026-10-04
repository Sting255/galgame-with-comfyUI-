/**
 * 聊天页两个浮窗入口必须是**开关**（2026-10-02 用户反馈）
 *
 * 用户原话：「点开性爱面板的时候 不能在点性爱的按钮关掉 只能点右上角的×」
 * ⇒ 入口图标自己就该是开关：开着时点一下收起、按钮高亮让人看出"面板是我开着的"。
 * 玩具面板（🧸）是同一类交互，一并做成开关，免得两个隔壁按钮行为不一致。
 *
 * 这份测试看的是**行为契约**（谁绑了什么、绑的是不是 toggle），不是排版细节：
 * 只钉"存在 `= !showXPanel` 的绑定"和"面板开着的类绑定"，不钉具体 CSS 值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const chatView = fs.readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
// 模板注释里会解释历史（含旧写法），所以断言前先剥注释 —— 本仓踩过四次的坑
const code = chatView.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('① ❤ 推进入口：点击/回车/空格都必须是开关（不能只开不关）', () => {
  for (const ev of ['@click', '@keydown.enter.prevent', '@keydown.space.prevent']) {
    assert.match(code, new RegExp(`${ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="showIntimatePanel = !showIntimatePanel"`),
      `${ev} 必须是 toggle（用户反馈：只能点右上角 × 才能关）`)
  }
  assert.doesNotMatch(code, /="showIntimatePanel = true"/, '不许残留"只开"的旧绑定')
})

test('② 🧸 玩具入口同样做成开关（与隔壁 ✋/❤ 行为一致）', () => {
  for (const ev of ['@click', '@keydown.enter.prevent', '@keydown.space.prevent']) {
    assert.match(code, new RegExp(`${ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="showToyPanel = !showToyPanel"`),
      `${ev} 必须是 toggle`)
  }
  assert.doesNotMatch(code, /="showToyPanel = true"/, '不许残留"只开"的旧绑定')
})

test('③ 面板开着时按钮要有状态类（不然用户不知道再点一下会收）', () => {
  assert.match(code, /class="touch-icon-btn intimate-icon-btn"\s*\n?\s*:class="\{ 'is-open': showIntimatePanel \}"/,
    '❤ 按钮要绑 is-open 状态类')
  assert.match(code, /class="touch-icon-btn toy-icon-btn"\s*\n?\s*:class="\{ 'is-open': showToyPanel \}"/,
    '🧸 按钮要绑 is-open 状态类')
  // 悬停提示也要跟着状态变（开着时提示"收起"）
  assert.match(code, /showIntimatePanel \? '收起推进面板'/, '开着时提示文案要说"收起"')
  assert.match(code, /showToyPanel \? '收起玩具面板'/, '开着时提示文案要说"收起"')
  // 样式侧：is-open 要有明显反馈 + 0.3s 过渡
  assert.match(code, /\.touch-icon-btn\.is-open\s*\{[\s\S]{0,400}?transition:[^;]*0\.3s/, 'is-open 要有 0.3s 过渡')
})

test('④ 面板仍是受控组件：显隐由父组件持有，面板侧只 emit close', () => {
  assert.match(code, /<IntimateActionPanel[\s\S]{0,220}?:open="showIntimatePanel"[\s\S]{0,120}?@close="showIntimatePanel = false"/,
    '面板显隐由父组件控制、面板 emit close')
  const panel = fs.readFileSync(new URL('../src/components/IntimateActionPanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /defineProps\(\{[\s\S]{0,200}?open:\s*\{/, '面板仍是 open 受控')
  assert.match(panel, /defineEmits\(\['close'/, '面板仍 emit close')
})
