/**
 * 催眠手机 · 发情模式的纯逻辑单测（2026-10-02）
 *
 * 用户原话：「然后再在催眠手机里加一个选项 叫发情模式 角色的敏感度就会直接拉满」。
 *
 * 本文件只测不依赖 Vue 的纯函数与请求形状：
 *   1. 状态归一化（`tier` 的两种口径 —— 服务层给对象、路由给字符串键）——**这一条是本文件存在的理由**：
 *      只认一种口径时另一条链路会渲染成 "undefined"，是"假绿"高发区；
 *   2. 视图文案（数值 / 档位 / 到点倒计时 / 开关状态字）；
 *   3. 两个接口的 URL 与 body 形状；
 *   4. 发情模式**不混进**催眠指令集合，也不吃催眠门控（与 ACTION_DEFS / GROUP_BATCH_ACTIONS 分离）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ACTION_DEFS,
  GROUP_BATCH_ACTIONS,
  SENSITIVITY_TIER_LABELS,
  clampSensitivityValue,
  heatViewModel,
  normalizeHeat,
} from '../src/components/hypnosisLogic.js'

// ── 1. 归一化 ──

test('normalizeHeat：tier 给字符串键（路由口径）与给对象（服务层口径）都必须读出档位名', () => {
  const byKey = normalizeHeat({ heat: true, value: 100, tier: 'extreme', tierLabel: '极度敏感' })
  assert.deepEqual(byKey, {
    heat: true, value: 100, tierKey: 'extreme', tierLabel: '极度敏感', until: null,
  })

  const byObject = normalizeHeat({ heat: true, value: 100, tier: { key: 'extreme', label: '极度敏感', multiplier: 1.35 } })
  assert.equal(byObject.tierKey, 'extreme')
  assert.equal(byObject.tierLabel, '极度敏感', 'tier 是对象时也要读出 label（否则面板显示 undefined）')

  // 只给了键、没给任何 label → 用前端兜底表，不许显示成英文键或 undefined
  const keyOnly = normalizeHeat({ tier: 'high', value: 66 })
  assert.equal(keyOnly.tierLabel, '很敏感')
  assert.equal(SENSITIVITY_TIER_LABELS.high, '很敏感')
})

test('normalizeHeat：heat 的布尔 / 0-1 / 字符串三种写法都认，缺字段不炸', () => {
  assert.equal(normalizeHeat({ heat: true }).heat, true)
  assert.equal(normalizeHeat({ heat: 1 }).heat, true)
  assert.equal(normalizeHeat({ heat: '1' }).heat, true)
  assert.equal(normalizeHeat({ heat: 0 }).heat, false)
  assert.equal(normalizeHeat({ heat: false }).heat, false)
  assert.equal(normalizeHeat(null).heat, false, 'null 不许抛')
  assert.equal(normalizeHeat(undefined).value, 0)
  assert.equal(normalizeHeat({}).tierKey, 'cold', '啥都没有时按冷淡档，不显示 undefined')
})

test('clampSensitivityValue：夹到 0~100，且**保留一位小数**（数值系统要看得出在动）', () => {
  // 2026-10-03：从"取整"改成"一位小数"。一次性爱推进只涨 0.5，取整之后面板上的数**永远不动**
  //（用户真机反馈「性爱并没有增加敏感度」就有这一半原因）⇒ 显示必须留一位小数。
  assert.equal(clampSensitivityValue(59.6), 59.6)
  assert.equal(clampSensitivityValue(59.64), 59.6)
  assert.equal(clampSensitivityValue(-3), 0)
  assert.equal(clampSensitivityValue(140), 100)
  assert.equal(clampSensitivityValue('77'), 77)
  assert.equal(clampSensitivityValue(55), 55, '整数不许显示成 55.0（Number 天然不带小数位）')
  assert.equal(clampSensitivityValue('abc'), 0)
  assert.equal(clampSensitivityValue(null), 0)
})

// ── 2. 视图 ──

test('heatViewModel：数值 + 档位 + 到点倒计时 + 开关状态字', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const until = new Date(now + 90 * 60000).toISOString()   // 1 小时 30 分后回落
  const on = heatViewModel({ heat: true, value: 100, tier: 'extreme', tierLabel: '极度敏感', until }, now)

  assert.equal(on.heat, true)
  assert.equal(on.valueText, '100/100 · 极度敏感')
  assert.equal(on.switchText, '发情中')
  assert.match(on.untilText, /^90 分后自然回落$/, '倒计时要走 parseBackendTime（带 Z 的 ISO 也不能算错）')
  assert.match(on.note, /最敏感|拉满/)
})

test('heatViewModel：关掉时不显示倒计时，且说明文案换成"打开后会怎样"', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const off = heatViewModel({ heat: false, value: 42, tier: 'warm', tierLabel: '敏感', until: null }, now)
  assert.equal(off.heat, false)
  assert.equal(off.valueText, '42/100 · 敏感')
  assert.equal(off.switchText, '已关闭')
  assert.equal(off.untilText, '', '关着的时候不该出现倒计时')
  assert.match(off.note, /打开后/)
})

test('heatViewModel：开着但后端没给 until（或已过期）→ 不显示倒计时，也不显示 NaN', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const noUntil = heatViewModel({ heat: true, value: 100, tier: 'extreme', tierLabel: '极度敏感' }, now)
  assert.equal(noUntil.untilText, '')

  const expired = heatViewModel({
    heat: true, value: 100, tier: 'extreme', tierLabel: '极度敏感',
    until: new Date(now - 60000).toISOString(),
  }, now)
  assert.equal(expired.untilText, '', '已过点就不该再报剩余时间')
  assert.ok(!/NaN|undefined/.test(JSON.stringify(expired)), '视图里不许漏出 NaN / undefined')
})

// ── 3. 接口形状（fetch 打桩，不联网） ──

test('发情模式接口：GET/POST /api/characters/:id/heat，POST 只带 { on }（不带 minutes 时）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body })
    return {
      ok: true,
      json: async () => ({ characterId: 7, heat: true, value: 100, tier: 'extreme', tierLabel: '极度敏感', until: '2026-10-02T14:00:00.000Z' }),
    }
  }
  try {
    const api = await import('../src/api/hypnosis.js')
    const read = await api.getHeatMode(7)
    const on = await api.setHeatMode(7, true)
    const off = await api.setHeatMode(7, false)
    const timed = await api.setHeatMode(7, true, 30)

    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
      'GET /api/characters/7/heat',
      'POST /api/characters/7/heat',
      'POST /api/characters/7/heat',
      'POST /api/characters/7/heat',
    ])
    assert.deepEqual(JSON.parse(calls[1].body), { on: true })
    assert.deepEqual(JSON.parse(calls[2].body), { on: false })
    assert.deepEqual(JSON.parse(calls[3].body), { on: true, minutes: 30 }, '给了时长才带 minutes')
    // 返回形状直接可喂给归一化
    assert.equal(normalizeHeat(read).heat, true)
    assert.equal(normalizeHeat(on).heat, true)
    assert.equal(heatViewModel(off, Date.now()).heat, true, '打桩返回什么就显示什么（服务端说了算）')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── 4. 与催眠指令的分界 ──

test('发情模式不混进催眠指令集合：ACTION_DEFS / GROUP_BATCH_ACTIONS 保持原样', () => {
  const hypnoKeys = ACTION_DEFS.map(a => a.key)
  assert.deepEqual(hypnoKeys, ['hypnotize', 'wake', 'wakeMind', 'forcedClimax', 'forget'], '发情模式不该出现在催眠按钮里')
  assert.deepEqual(GROUP_BATCH_ACTIONS.map(a => a.key), ['hypnotize', 'wake', 'wakeMind', 'forcedClimax'])
})

// ── 5. 面板源码守卫（真机点不动的那类 bug 只有扫源码才拦得住） ──
//
// 教训：睡前面板曾经"测试全绿但真机点不动"，因为守卫钉的是实现写法、不是行为。
// 这里只钉三件事：**入口在**、**控件是统一的**、**不吃催眠门控**。

const panelSrc = readFileSync(new URL('../src/components/HypnosisPhonePanel.vue', import.meta.url), 'utf8')
const apiSrc = readFileSync(new URL('../src/api/hypnosis.js', import.meta.url), 'utf8')
const panelTpl = panelSrc.slice(panelSrc.indexOf('<template>'), panelSrc.indexOf('</template>'))
const panelScript = panelSrc.slice(panelSrc.indexOf('<script setup>'), panelSrc.indexOf('</script>'))
// 扫源码前先剥注释：本仓库两次被自己的注释绊倒（`matrix.body_control`、`new Date()`）
const tplCode = panelTpl.replace(/<!--[\s\S]*?-->/g, '')
const scriptCode = panelScript.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('入口：催眠手机里有「发情模式」，且用 LinsheSwitch（不许裸 checkbox）', () => {
  assert.match(panelTpl, /发情模式/, '要有这一节')
  assert.match(panelTpl, /<linshe-switch[\s\S]{0,400}@change="onToggleHeat"/, '开关要绑 onToggleHeat')
  assert.match(panelTpl, /v-model="heatOn"/, '开关要绑 heatOn')
  assert.match(panelTpl, /heatView\.valueText/, '要把她的敏感度数值显示出来')
  assert.equal(/<input[\s>]/.test(tplCode), false, 'AGENTS.md：不许裸 <input>（统一走 Linshe 组件）')
})

test('★ 发情模式不吃催眠门控（与催眠无关：手机没催眠也要能拨）', () => {
  const section = tplCode.slice(tplCode.indexOf('hp-sec-heat'))
  const disabled = section.match(/:disabled="([^"]*)"/)
  assert.ok(disabled, '开关要有 :disabled')
  assert.equal(/matrix\./.test(disabled[1]), false, '不许挂 actionMatrix 门控（它不是催眠指令）')
  assert.match(disabled[1], /heatBusy/, '只随"正在请求中"置灰')
})

test('请求：面板走 api 层的 getHeatMode / setHeatMode，不在组件里手写 fetch', () => {
  assert.match(panelScript, /getHeatMode/, '要 import getHeatMode')
  assert.match(panelScript, /setHeatMode/, '要 import setHeatMode')
  assert.equal(/fetch\(/.test(scriptCode), false, '组件里不许直接 fetch（口径在 api 层）')
  assert.match(apiSrc, /export function getHeatMode/, 'api 层要有读接口')
  assert.match(apiSrc, /export function setHeatMode/, 'api 层要有写接口')
  assert.match(apiSrc, /\/characters\/\$\{encodeURIComponent\(characterId\)\}\/heat/, '路径要是 /characters/:id/heat')
})

test('★ 开关状态服务端说了算：失败时把开关拨回去（不许乐观更新后和真相反着来）', () => {
  const handler = scriptCode.slice(scriptCode.indexOf('async function onToggleHeat'))
  const body = handler.slice(0, handler.indexOf('\nonMounted'))
  assert.match(body, /normalizeHeat\(payload\)\.heat/, '成功后用返回值覆盖本地开关')
  assert.match(body, /catch[\s\S]*normalizeHeat\(heatRaw\.value\)\.heat/, '失败/被拒时按上一次的真实状态回滚')
})
