/**
 * 面板上的「自动速度」独立旋钮（2026-10-03 用户原话：「自动的速度新增一个单独的」）
 *
 * 口径（服务端口径见 `agent-core/test/autoPace.test.js`）：
 *   · 手动节奏档（`pace`）：他顶得多快、手点一下涨多少 —— 上面那一排「节奏」只作状态显示；
 *   · **自动速度（`autoPace`）**：她自己动的频率与每下涨多少 —— 面板上**单独一排页签**，点一下直接落库；
 *   · 没开「自动继续抽插」时那一排置灰并说明原因；改速度**不触发**一轮反应（不白烧模型调用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  AUTO_PACE_INTERVALS_FALLBACK,
  autoPaceTitle,
  clampPaceForUi,
  normalizeIntimateState,
  paceOptions,
} from '../src/components/intimateActionLogic.js'

const panel = readFileSync(new URL('../src/components/IntimateActionPanel.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
const tpl = panel.slice(panel.indexOf('<template>'), panel.indexOf('</template>'))
const tplCode = tpl.replace(/<!--[\s\S]*?-->/g, '')
const script = panel.slice(panel.indexOf('<script setup>'), panel.indexOf('</script>'))
const scriptCode = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('① 归一化：autoPace / 间隔 / 每下增益都要有安全默认（后端没给也不能白屏）', () => {
  const full = normalizeIntimateState({ accumulation: 10, autoThrust: true, autoPace: 4, autoPaceLabel: '冲刺', autoIntervalMs: 1500, autoTickGain: 5 })
  assert.equal(full.autoThrust, true)
  assert.equal(full.autoPace, 4)
  assert.equal(full.autoPaceLabel, '冲刺')
  assert.equal(full.autoIntervalMs, 1500)
  assert.equal(full.autoTickGain, 5)

  // 后端只给 autoPace（老版本没投影 label/ms）⇒ 前端自己按表兜底，别写死 3000
  const partial = normalizeIntimateState({ autoPace: 3 })
  assert.equal(partial.autoPace, 3)
  assert.equal(partial.autoPaceLabel, '快')
  assert.equal(partial.autoIntervalMs, AUTO_PACE_INTERVALS_FALLBACK[3])
  // 脏值 / 缺字段
  assert.equal(normalizeIntimateState({ autoPace: 99 }).autoPace, 4)
  assert.equal(normalizeIntimateState({ autoPace: 'x' }).autoPace, 2, '缺省 = 正常')
  assert.equal(normalizeIntimateState({}).autoThrust, false)
  assert.equal(normalizeIntimateState({ autoThrust: 1 }).autoThrust, true, '服务端布尔/数字两种都要认')
  assert.ok(!/undefined|NaN/.test(JSON.stringify(normalizeIntimateState({}))))
})

test('① 页签口径：自动速度与手动节奏档用**同一排档位定义**，但两个字段互不影响', () => {
  const opts = paceOptions()
  assert.deepEqual(opts.map(o => o.value), [1, 2, 3, 4])
  assert.deepEqual(opts.map(o => o.label), ['缓', '正常', '快', '冲刺'])
  assert.equal(clampPaceForUi(3), 3)
  assert.equal(clampPaceForUi(99), 4)
  assert.equal(clampPaceForUi('x'), 0, '脏值给 0（调用方据此不发请求）')
  const s = normalizeIntimateState({ pace: 1, autoPace: 4, autoThrust: true })
  assert.equal(s.pace, 1, '手动节奏档不受自动速度影响')
  assert.equal(s.autoPace, 4)
})

test('① 说明文案：没开自动时说清"先开自动"，开着时报出间隔与每下增益', () => {
  const off = autoPaceTitle({ autoThrust: false, autoPace: 2 })
  assert.match(off, /先点「自动插入」/)
  const on = autoPaceTitle({ autoThrust: true, autoPace: 3, autoIntervalMs: 2000, autoTickGain: 4 })
  assert.match(on, /快/)
  assert.match(on, /2\.0 秒一下/)
  assert.match(on, /\+4/)
  assert.match(on, /与上面的「节奏」无关/)
  // 用户 2026-10-03 澄清：「自动的意思是自动插入 不是自己动」——文案主语必须是"他"
  assert.match(on, /他自动插送/)
  assert.equal(/她自己动/.test(on + off), false, '不许再写成她自己动')
})

test('★ ② 面板源码守卫：有单独一排「自动速度」页签，且走 auto 动作带 pace', () => {
  assert.match(tpl, /自动速度/, '面板要有这一排')
  assert.match(tplCode, /:options="paces"/, '用同一排档位定义')
  assert.match(tplCode, /:model-value="view\.autoPace"/, '绑的是 autoPace（不是 pace）')
  assert.match(tplCode, /@update:model-value="setAutoPace"/, '点页签要落到 setAutoPace')
  assert.match(tplCode, /:disabled="!view\.autoThrust[^"]*"/, '没开自动时必须置灰')
  assert.match(tplCode, /autoIntervalMs/, '要显示"每 N 秒一下"')
  assert.match(scriptCode, /postIntimateAction\(id, 'auto', \{ pace: next/, '改速度发的是 auto 动作 + pace')
  assert.equal(/postIntimateAction\(id, 'autoPace'/.test(scriptCode), false, '别发明新动作名（服务端只认 auto）')
  assert.equal(/<input[\s>]/.test(tplCode), false, 'AGENTS.md：不许裸 <input>')
})

test('★ ② 改速度不触发反应：setAutoPace 不许调 run()/emit reaction', () => {
  const fn = scriptCode.slice(scriptCode.indexOf('async function setAutoPace'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.equal(/run\(/.test(body), false, '改速度走自己的请求，不套 run（run 会触发一轮模型调用）')
  assert.equal(/emit\('reaction'/.test(body), false, '不许发 reaction（那会让父组件当成一轮对话）')
  assert.match(body, /setFeedback/, '要给她一句回执')
})

test('② 面板自己的自动节拍也要标成"他自动插送的"（否则增益按手动档算）', () => {
  assert.match(scriptCode, /run\(\{ key: 'thrust' \}, \{ auto: true \}\)/, '面板 tick 必须带 auto:true')
})

test('③ 接口：auto 动作带 pace 时的 body 形状（scene 字段照旧透传）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body })
    return { ok: true, json: async () => ({ allowed: true, state: { autoPace: 3, autoThrust: true } }) }
  }
  try {
    const mod = await import('../src/api/index.js')
    await mod.postIntimateAction(9, 'auto', { pace: 3 })
    await mod.postIntimateAction(9, 'auto', { pace: 1, scene: 'group', groupId: 5 })
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
      'POST /api/intimate-actions/9/auto',
      'POST /api/intimate-actions/9/auto',
    ])
    assert.deepEqual(JSON.parse(calls[0].body), { pace: 3 })
    assert.deepEqual(JSON.parse(calls[1].body), { pace: 1, scene: 'group', groupId: 5 })
    assert.match(api, /export function postIntimateAction/, 'api 层函数还在（没另造一个）')
  } finally {
    globalThis.fetch = realFetch
  }
})
