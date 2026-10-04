/**
 * 复审遗留 2 · 面板上的「催眠状态」徽标
 *
 * 显示「完全控制」（身体顺从）/「意志清醒」（只唤醒意志：身体不能反抗但嘴上不甘）。
 * 硬口径：**状态一律服务端说了算** —— 读 GET /characters/:id/hypnosis 的 { active, mindAwake }，
 * 前端**不做任何本地推断**；取不到 / 形状不对 ⇒ **不渲染徽标**（绝不默认显示「完全控制」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

import { hypnosisBadgeOf, HYPNOSIS_BADGES } from '../src/components/touchActionLogic.js'

const panelRaw = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const pD = parseSfc(panelRaw).descriptor
const pTpl = pD.template.content
const pScript = pD.scriptSetup.content
const chat = parseSfc(readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')).descriptor
const group = parseSfc(readFileSync(new URL('../src/views/GroupChatView.vue', import.meta.url), 'utf8')).descriptor

test('两种模式的文案都对：完全控制 / 意志清醒', () => {
  assert.equal(HYPNOSIS_BADGES.full, '完全控制')
  assert.equal(HYPNOSIS_BADGES.awake, '意志清醒')
  const full = hypnosisBadgeOf({ active: true, mindAwake: false })
  assert.deepEqual(full, { key: 'full', label: '完全控制' }, '身体受控 + 意志沉睡 = 完全控制')
  const awake = hypnosisBadgeOf({ active: true, mindAwake: true })
  assert.deepEqual(awake, { key: 'awake', label: '意志清醒' }, '只唤醒意志 = 意志清醒（身体仍受控）')
})

test('取不到 / 形状不对 ⇒ 不渲染（**不许**默认「完全控制」）', () => {
  for (const bad of [null, undefined, {}, { active: false, mindAwake: true }, { active: false, mindAwake: false },
    { mindAwake: true }, { active: true }, { active: 'true', mindAwake: 0 }, { active: 1, mindAwake: 0 }]) {
    assert.equal(hypnosisBadgeOf(bad), null, JSON.stringify(bad) + ' 应不显示')
  }
  assert.equal(hypnosisBadgeOf({ active: true, mindAwake: 'yes' }), null, 'mindAwake 不是布尔 ⇒ 拿不准就不显示')
})

test('面板：有徽标才渲染，且文案来自纯函数（前端零推断）', () => {
  const compiled = compileTemplate({ source: pTpl, filename: 'TouchActionPanel.vue', id: 'p' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(pScript.includes('hypnosisBadge'), '要有 hypnosisBadge prop')
  assert.ok(pTpl.includes('hypnosis-badge'), '徽标有自己的类名')
  assert.ok(/v-if="hypnosisBadge"/.test(pTpl), '取不到就不渲染')
  assert.ok(pTpl.includes('hypnosisBadge.label'), '文案来自服务端状态算出的 label')
  // 前端不许出现任何催眠推断
  assert.equal(/mindAwake|bodyControlled/.test(pScript), false, '组件里不许读原始字段做推断')
  assert.equal(/active\s*&&|=== true/.test(pScript.replace(/hypnosisBadge[^\n]*/g, '')), false, '组件里不许自己判 active')
})

test('视图：从催眠状态接口取，取不到就传 null（不推断、不默认）', () => {
  for (const [name, d] of [['ChatView', chat], ['GroupChatView', group]]) {
    const s = d.scriptSetup.content
    const tpl = d.template.content
    assert.ok(s.includes('getHypnosisState'), name + ' 要走既有催眠状态接口')
    assert.ok(s.includes('hypnosisBadgeOf'), name + ' 用纯函数算徽标')
    // prop 在**模板**里（第一版我在 script 里找它，永远找不到 —— 测试写错了）
    assert.ok(tpl.includes(':hypnosis-badge='), name + ' 要传给面板')
    assert.ok(s.includes('catch'), name + ' 取失败要容忍（不能炸面板）')
    assert.equal(/hypnosisBadge\s*=\s*\{\s*key:\s*'full'/.test(s), false, name + ' 不许在视图里硬编码「完全控制」')
  }
})
