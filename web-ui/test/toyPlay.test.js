/**
 * 玩具玩法扩充 · 前端（2026-10-02 task-2，用户原话「玩具玩法有点太少了」）
 *
 * 这一份钉三件事：
 *   ① `toyLogic.js` 的镜像与展示辅助（**纯函数**：实时档位 / 模式 / 剩余 / 组合 / 她自己的判定文案）；
 *   ② 追加的 5 个 API：路径与 body **行为级**验证（换掉 fetch 看实参），并顺带确认旧的三个没被动过；
 *   ③ 面板真的长出了这些控件（多件装卸 / 模式 / 曲线开关 / 实时状态 / 她自己），且**没有裸控件**。
 *
 * 血泪教训①：源码扫描型断言先**剥注释**再断言（本仓已踩三次）；
 * 血泪教训②：逻辑走纯函数、只钉行为，不去 mount 重组件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate, compileScript } from '@vue/compiler-sfc'

import {
  TOYS, TOY_KEYS, ALL_TOYS, ALL_TOY_KEYS, EXTRA_TOYS, getToy, listAllToys, maxIntensityOf, hasIntensity,
  clampIntensity, intensityLabel, VIBRATION_MODES, INTENSITY_CURVES,
  modeLabelOf, curveLabelOf, durationText, liveIntensityOf, remainingText, wornStatusText,
  comboSummaryText, selfPlayText,
} from '../src/components/toyLogic.js'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 剥掉注释（HTML / 块 / 行）——源码扫描必须先做这一步 */
const strip = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const panelRaw = read('../src/components/ToyPanel.vue')
const panel = parseSfc(panelRaw).descriptor
const pTpl = panel.template.content
const pScript = panel.scriptSetup.content
const pStyle = panel.styles.map(s => s.content).join('\n')

// ── ① 镜像与展示辅助 ─────────────────────────────────────────────────────────

test('① 镜像加厚：11 件；首批 5 件的旧契约不动；每件都有部位/上限/效果语义', () => {
  assert.deepEqual(TOY_KEYS, ['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp', 'collar'], 'TOYS/TOY_KEYS 是首批 5 件（旧契约）')
  assert.equal(ALL_TOY_KEYS.length, 11)
  assert.equal(listAllToys().length, 11)
  assert.equal(Object.keys(EXTRA_TOYS).length, 6)
  for (const key of ALL_TOY_KEYS) {
    const toy = getToy(key)
    assert.ok(toy, key + ' 要能查到')
    for (const field of ['label', 'part', 'effect']) {
      assert.ok(toy[field] && String(toy[field]).length > 0, key + ' 缺 ' + field)
    }
    assert.equal(typeof toy.maxIntensity, 'number')
  }
  // 旧行为：项圈无强度档 / 越界夹取 / 不认识的玩具不炸
  assert.equal(hasIntensity('collar'), false)
  assert.equal(clampIntensity('collar', 3), 0)
  assert.equal(clampIntensity('clit_sucker', 99), 5, '新玩具也要能被夹到上限')
  assert.equal(clampIntensity('chain_clamp', 9), 2)
  assert.equal(maxIntensityOf('nope'), 0)
  assert.equal(getToy('nope'), null)
  assert.equal(intensityLabel('clit_sucker', 3), '3/5')
})

test('① 模式 / 曲线选项与后端同枚举（面板直接拿来渲染）', () => {
  assert.deepEqual(VIBRATION_MODES.map(m => m.value), ['steady', 'pulse', 'wave', 'random'])
  assert.deepEqual(INTENSITY_CURVES.map(c => c.value), ['ramp_up', 'ramp_down', 'wave', 'surge'])
  for (const m of VIBRATION_MODES) assert.ok(m.label && m.desc, m.value + ' 要有中文名与说明（分段控件的 title）')
  for (const c of INTENSITY_CURVES) assert.ok(c.label && c.desc, c.value + ' 要有中文名与说明')
  assert.equal(modeLabelOf('pulse'), '脉冲')
  assert.equal(modeLabelOf('nope'), '持续', '不认识的模式回落持续（不炸）')
})

test('① 实时状态：以服务端字段为准（前端不重算曲线）', () => {
  // 服务端给 liveIntensity / mode / remainingSec，前端只做展示
  const worn = {
    toyKey: 'vibe_egg', intensity: 2, liveIntensity: 4, maxIntensity: 5,
    mode: 'pulse', modeLabel: '脉冲', modePhaseText: '正被这一波顶着',
    curve: { type: 'ramp_up', from: 2, to: 5, durationSec: 300 }, remainingSec: 185, curveFinished: false,
  }
  assert.equal(liveIntensityOf(worn), 4, '有 liveIntensity 就用它（不是基准档 2）')
  assert.ok(wornStatusText(worn).includes('4/5'))
  assert.ok(wornStatusText(worn).includes('脉冲'))
  assert.ok(wornStatusText(worn).includes('还剩 3 分 5 秒'), wornStatusText(worn))
  // 旧响应没有 liveIntensity → 退回基准档（渲染不炸）
  assert.equal(liveIntensityOf({ toyKey: 'vibe_egg', intensity: 3, maxIntensity: 5 }), 3)
  assert.equal(wornStatusText({ toyKey: 'vibe_egg', intensity: 3, maxIntensity: 5, mode: 'steady' }), '强度 3/5')
  // 曲线走完 / 没曲线
  assert.equal(remainingText({ curve: { type: 'ramp_up' }, curveFinished: true }), '曲线已走完')
  assert.equal(remainingText({ curve: null }), '')
  assert.equal(remainingText({ curve: { type: 'ramp_up' }, remainingSec: 45 }), '还剩 45 秒')
})

test('① 文案辅助：曲线 / 时长 / 组合 / 她自己的判定都说人话', () => {
  assert.equal(curveLabelOf({ type: 'ramp_up', from: 1, to: 5, durationSec: 300 }), '渐强 1→5档/5 分钟')
  assert.equal(curveLabelOf({ type: 'wave', from: 1, to: 4, durationSec: 600, loop: true }), '起伏 1→4档/10 分钟（循环）')
  assert.equal(curveLabelOf(null), '')
  assert.equal(durationText(45), '45 秒')
  assert.equal(durationText(185), '3 分 5 秒')
  assert.equal(durationText(300), '5 分钟')
  assert.equal(comboSummaryText({ labels: [], count: 0 }), '')
  assert.ok(comboSummaryText({ labels: ['前后夹击'], count: 2 }).includes('前后夹击'))
  assert.ok(comboSummaryText({ labels: ['双穴同时'], count: 4, overload: true }).includes('过载'))
  assert.ok(comboSummaryText({ labels: ['上下两点'], count: 3, heavy: true }).includes('叠加明显'))
  assert.ok(selfPlayText({ play: false, code: 'cooldown' }).includes('缓过来'))
  assert.ok(selfPlayText({ play: false, code: 'held_back' }).includes('忍住'))
  assert.ok(selfPlayText({ play: false, code: 'not_yet' }).length > 4)
  assert.ok(selfPlayText({ play: true, secret: true }).includes('偷偷'))
  assert.equal(selfPlayText(null), '')
})

// ── ② 追加的 API（行为级）────────────────────────────────────────────────────

test('② 新增 5 个 API：路径 / body / key 闸门都对', async () => {
  const api = await import('../src/api/index.js')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    return { ok: true, json: async () => ({ ok: true, toy: { toyKey: 'vibe_egg' } }) }
  }
  try {
    await api.setToyMode(7, 'vibe_egg', 'pulse')
    await api.setToyCurve(7, 'vibe_egg', { type: 'wave', from: 1, to: 4, durationSec: 300 })
    await api.setToyCurve(7, 'vibe_egg', null)
    await api.tickToys(7)
    await api.getSelfPlayState(7)
    await api.triggerSelfPlay(7, { encourage: true })
    await api.triggerSelfPlay(7)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls.map(c => c.url), [
    '/api/characters/7/toys/vibe_egg/mode',
    '/api/characters/7/toys/vibe_egg/curve',
    '/api/characters/7/toys/vibe_egg/curve',
    '/api/characters/7/toys/tick',
    '/api/characters/7/toys/self-play',
    '/api/characters/7/toys/self-play',
    '/api/characters/7/toys/self-play',
  ])
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body, JSON.stringify({ mode: 'pulse' }))
  assert.equal(calls[1].body, JSON.stringify({ curve: { type: 'wave', from: 1, to: 4, durationSec: 300 } }))
  assert.equal(calls[2].body, JSON.stringify({ curve: null }), '关曲线要能传 null')
  assert.equal(calls[3].body, JSON.stringify({}), 'tick 的 body 是空对象（不是 undefined）')
  assert.equal(calls[4].method, 'GET', '判定预览是只读 GET')
  assert.equal(calls[5].body, JSON.stringify({ encourage: true }))
  assert.equal(calls[6].body, JSON.stringify({ encourage: false }), '默认不逗她（她自己的判断）')
  // key 闸门对新接口同样生效（真机踩过 /toys/undefined/...）
  for (const bad of [undefined, null, '', 'undefined']) {
    assert.throws(() => api.setToyMode(7, bad, 'pulse'), err => err.code === 'toy_key_missing')
    assert.throws(() => api.setToyCurve(7, bad, null), err => err.code === 'toy_key_missing')
  }
})

test('② 旧三个接口一字未改（兼容既有接线）', async () => {
  const api = await import('../src/api/index.js')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await api.fetchToys(7)
    await api.equipToy(7, 'vibe_egg')
    await api.setToyIntensity(7, 'nipple_clamp', 3)
    await api.removeToy(7, 'collar')
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls.map(c => c.url), [
    '/api/characters/7/toys',
    '/api/characters/7/toys/vibe_egg/equip',
    '/api/characters/7/toys/nipple_clamp/set-intensity',
    '/api/characters/7/toys/collar/remove',
  ])
  assert.equal(calls[1].body, JSON.stringify({ intensity: 1 }))
  assert.equal(calls[2].body, JSON.stringify({ intensity: 3 }))
  assert.equal(calls[3].body, JSON.stringify({}))
})

// ── ③ 面板控件 ───────────────────────────────────────────────────────────────

test('③ 面板：用了全套 Linshe 组件、模板能编译、没有裸控件（先剥注释再断言）', () => {
  const compiled = compileTemplate({ source: pTpl, filename: 'ToyPanel.vue', id: 'tp' })
  assert.deepEqual(compiled.errors, [])
  for (const tag of ['linshe-modal', 'linshe-button', 'linshe-tabs', 'linshe-switch', 'linshe-select']) {
    assert.ok(pTpl.includes(tag), '要用 ' + tag)
  }
  const bare = strip(pTpl)
  for (const bad of ['<button', '<input', '<select', '<textarea']) {
    assert.equal(bare.includes(bad), false, '不许出现裸控件 ' + bad)
  }
  assert.ok(pStyle.includes('0.3s'), '状态变化要有 0.3s 过渡（设计系统口径）')
})

test('③ 面板：<script setup> 能编译，且模板里调用的每个处理函数都真的存在', () => {
  // compileScript 会当场炸出脚本语法错误（模板编译过不代表脚本没问题）
  const out = compileScript(panel, { id: 'toypanel' })
  assert.ok(out.content.length > 0)
  const bindings = out.bindings || {}
  const handlerAttrs = [...pTpl.matchAll(/@[\w:.-]+="([^"]+)"/g)].map(m => m[1])
  const called = new Set()
  for (const expr of handlerAttrs) {
    for (const m of expr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1])
  }
  assert.ok(called.size > 0, '模板里应当有事件处理（不然这些控件是死的）')
  for (const name of called) {
    assert.ok(bindings[name], '模板调用 ' + name + '()，但 <script setup> 里没有它（真机踩过：引用了不存在的键 ⇒ 永远置灰）')
  }
})

test('③ 面板：多件装卸（一件一行，各自摘）+ 实时状态 + 模式选择 + 曲线开关', () => {
  // 多件：已戴列表按 toyKey 循环渲染，每行有自己的摘下入口
  assert.ok(/v-for="toy in wornList"/.test(pTpl), '已戴清单要逐件渲染（支持多件同时戴）')
  assert.ok(pScript.includes('unequipToy'), '每件都能单独摘下')
  assert.ok(pScript.includes('bumpIntensity'), '每件都能单独调档')
  // 实时状态：强度 / 模式 / 剩余都显示
  assert.ok(pTpl.includes('statusOf'), '要显示实时状态串')
  assert.ok(pScript.includes('wornStatusText') && pScript.includes('remainingText'), '状态串来自纯函数（可测）')
  // 模式：分段选择 + 直接写服务端
  assert.ok(pTpl.includes('modeOptions') && pTpl.includes('setMode'), '要能选振动模式')
  assert.ok(pScript.includes('api.setToyMode'), '模式直接写服务端')
  // 曲线：开关 + 类型 + 时长（开关打开就有默认曲线，关掉就清空）
  assert.ok(pTpl.includes('toggleCurve'), '要有强度曲线开关')
  assert.ok(pScript.includes('api.setToyCurve'), '曲线直接写服务端')
  assert.ok(/type: 'ramp_up'/.test(pScript) && pScript.includes('durationSec'), '打开开关要给一条默认曲线')
  assert.ok(pTpl.includes('curveOptions') && pTpl.includes('durationOptions'), '曲线类型/时长可选')
})

test('③ 面板：她自己那一栏（显示服务端判定 + 「逗她一下」），且不越过她的意愿', () => {
  assert.ok(pTpl.includes('逗她一下'), '要有入口')
  assert.ok(pTpl.includes('selfPlayLine'), '要显示她的判定')
  assert.ok(pScript.includes('api.triggerSelfPlay'), '走主动那个接口')
  assert.ok(pScript.includes('encourage: true'), '"逗她一下"用 encourage（只是加分）')
  assert.ok(pScript.includes('res.secret'), '偷偷玩时措辞不同（没让你发现）')
})

test('③ 面板自包含：拿角色 id 自己取数 + 轮询 tick（父组件不刷新也能看实时状态）', () => {
  assert.ok(pScript.includes('useChatStore'), '从聊天 store 取当前角色（不依赖父组件传）')
  assert.ok(/characterId: \{ type/.test(pScript), '也可以由外部传 characterId（契约）')
  assert.ok(pScript.includes('api.fetchToys'), '自己拉清单与佩戴状态')
  assert.ok(pScript.includes('api.tickToys'), '轮询 tick：曲线随时间推进能看见')
  assert.ok(/setInterval\(/.test(pScript) && /clearInterval\(/.test(pScript), '开面板才轮询、关了就停（不留定时器）')
  assert.ok(pScript.includes('onBeforeUnmount'), '卸载要清定时器')
  assert.ok(pScript.includes('catalog'), '背包清单用服务端 catalog（含第二批）')
})

test('③ 面板：门控仍旧只渲染服务端结论；旧的三条 emit 契约不变', () => {
  assert.ok(/gate/.test(pTpl), '门控照服务端 gate 渲染')
  assert.equal(/affinity\s*[><]=?\s*\d/.test(pScript), false, '前端不许自己算门槛')
  assert.ok(/emit\('toy-equip'/.test(pScript) && /emit\('toy-intensity'/.test(pScript) && /emit\('toy-remove'/.test(pScript),
    '装/调/摘仍走父组件（旧契约）')
  assert.ok(pScript.includes("emit('close')"), '关闭事件不变')
})
