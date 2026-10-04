/**
 * 玩具独立入口 + 独立面板（用户明确要求：「玩具也没单独弄个按钮模块」）
 *
 * · 入口：聊天页输入区 ✋ 旁边一颗独立玩具按钮，**未解锁（服务端 unlocked !== true）就不渲染**
 * · 面板：独立 ToyPanel（LinsheModal），装 / 调强度 / 摘，**门控全走服务端**
 * · 去重：动作面板里原来那段玩具区**移除**（不留死代码）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

const TOY = new URL('../src/components/ToyPanel.vue', import.meta.url)
const chat = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor
const chatTpl = chat.template.content
const chatScript = chat.scriptSetup.content
const actRaw = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const act = parseSfc(actRaw).descriptor
const actTpl = act.template.content
const actScript = act.scriptSetup.content

test('ToyPanel 组件存在，用 LinsheModal（不引入新视觉）', () => {
  assert.ok(existsSync(TOY), 'components/ToyPanel.vue 应存在')
  const raw = readFileSync(TOY, 'utf8')
  const d = parseSfc(raw).descriptor
  const compiled = compileTemplate({ source: d.template.content, filename: 'ToyPanel.vue', id: 'tp' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(d.template.content.includes('linshe-modal'), '用 LinsheModal')
  assert.ok(/linshe-button/.test(d.template.content), '按钮用 Linshe')
  assert.ok(d.template.content.includes('title='), '要有标题')
  // ⚠️ 真机事故教训：新增 ref/computed/watch 用法必须先 import
  const need = ['ref', 'computed', 'watch', 'nextTick', 'inject'].filter(k => new RegExp('\\b' + k + '\\s*\\(').test(d.scriptSetup.content))
  for (const k of need) {
    assert.ok(new RegExp('\\b' + k + '\\b').test(d.scriptSetup.content.split('</script>')[0].slice(0, d.scriptSetup.content.indexOf('const props')) ||
      d.scriptSetup.content.slice(0, d.scriptSetup.content.indexOf('const props'))), 'import 行里要有 ' + k)
  }
})

test('玩具面板：5 种可装清单 + 部位/强度上限 + 已戴列表 + 强度 ± + 摘下', () => {
  const d = parseSfc(readFileSync(TOY, 'utf8')).descriptor
  const tpl = d.template.content
  const script = d.scriptSetup.content
  assert.ok(/TOYS|toyOptions|toyList/.test(tpl + script), '可装清单来自镜像/服务端')
  assert.ok(/part/.test(tpl), '显示部位')
  // 2026-10-02：强度上限文案改走 `intensityCapText()`（项圈没有强度档 ⇒ 不能再直写"最多 0 档"）
  assert.ok(/intensityCapText|maxIntensity|max-intensity/.test(tpl + script), '显示强度上限')
  assert.ok(/worn/i.test(tpl), '已戴列表')
  assert.ok(script.includes('bumpIntensity') || tpl.includes('bumpIntensity'), '强度 ± 入口')
  assert.ok(script.includes('unequip') || tpl.includes('unequip'), '摘下入口')
  assert.ok(/toy-worn-empty|还没给她戴上/.test(tpl), '未戴时空态')
})

test('玩具面板：门控只渲染服务端结论，前端零推断', () => {
  const d = parseSfc(readFileSync(TOY, 'utf8')).descriptor
  const tpl = d.template.content
  const script = d.scriptSetup.content
  assert.ok(/gate/.test(tpl), '门控照服务端 gate 渲染')
  assert.ok(/toast/.test(script) || /emit\('reject'/.test(script), '被拒 toast 服务端那句')
  assert.equal(/affinity\s*[><]=?\s*\d/.test(script), false, '前端不许自己算门槛')
  assert.equal(/mindAwake|annoyance\s*[><]/.test(script), false, '不许本地推断状态')
})

test('聊天页：独立玩具入口，未解锁不渲染', () => {
  const compiled = compileTemplate({ source: chatTpl, filename: 'ChatView.vue', id: 'c' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(chatTpl.includes('toy-icon-btn'), '要有独立玩具按钮')
  assert.ok(/v-if="toysEnabled"[\s\S]{0,200}toy-icon-btn|toy-icon-btn[\s\S]{0,200}v-if="toysEnabled"/.test(chatTpl),
    '未解锁就不渲染（不是灰按钮）')
  assert.ok(chatScript.includes('showToyPanel'), '有自己的显隐状态')
  assert.ok(chatTpl.includes(':open="showToyPanel"'), '挂独立的 ToyPanel')
  assert.ok(/aria-label="玩具"/.test(chatTpl), '无障碍标签')
  assert.ok(/role="button"/.test(chatTpl), '照样例用 role=button')
  // 入口必须在 ✋ 旁边（同一输入行）
  const iToy = chatTpl.indexOf('toy-icon-btn')
  const iHand = chatTpl.indexOf('touch-icon-btn')
  assert.ok(iHand > 0 && Math.abs(iToy - iHand) < 2500, '两个入口要在同一输入区、位置相邻')
})

test('聊天页：装/调/摘真的调那三个 API', () => {
  for (const fn of ['equipToy', 'setToyIntensity', 'removeToy']) {
    assert.ok(chatScript.includes(fn), '要调 ' + fn)
  }
  assert.ok(chatScript.includes('loadToys'), '操作后要刷新')
})

test('去重：动作面板里不再有玩具区（props / emits / 模板 / 引用一并清掉）', () => {
  assert.equal(/toy-control/.test(actTpl), false, '动作面板里不该再有玩具控制区')
  assert.equal(/toysEnabled|wornToys|toyOptions|hypnosisBadgeOf/.test(actScript.replace(/hypnosisBadge/g, '')), false,
    '玩具相关 props 要清掉')
  assert.equal(/toy-equip|toy-intensity|toy-remove/.test(actScript), false, '玩具事件要清掉')
  assert.equal(/ToyPanel|toyLogic/.test(actScript), false, '不该再引玩具逻辑')
  // 动作面板的 import 里也要干净
  assert.equal(/toyLogic/.test(actRaw), false, '组件文件里不该残留 toyLogic 引用')
})
