/**
 * 敏感度在面板上的可见性（2026-10-02）
 *
 * 用户原话：「新增一个数值 叫敏感度 所有和性爱相关的内容 都会和这个挂钩 数值高了低了会有不一样的表现」。
 * 数值系统做进后端是一半，**面板上看不见**就没人知道"为什么这次这么快"——本文件钉另一半：
 *   · 推进面板 HUD 显示「敏感度 68/100 · 很敏感」（发情模式直接写"发情中"）；
 *   · 累积度那一行显示**她自己的**「一起到」门槛（随敏感度浮动 45~60，不许写死 60）；
 *   · 私密时刻（自慰）的接口形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { normalizeIntimateState, sensitivityView } from '../src/components/intimateActionLogic.js'

const panel = readFileSync(new URL('../src/components/IntimateActionPanel.vue', import.meta.url), 'utf8')
const logic = readFileSync(new URL('../src/components/intimateActionLogic.js', import.meta.url), 'utf8')
const apiSrc = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')

const tpl = panel.slice(panel.indexOf('<template>'), panel.indexOf('</template>'))
const tplCode = tpl.replace(/<!--[\s\S]*?-->/g, '')

// ── 1. sensitivityView ──

test('sensitivityView：数值 + 档位 + 发情模式文案；缺字段不炸', () => {
  const warm = sensitivityView({ sensitivity: { value: 68, tier: 'high', tierLabel: '很敏感', multiplier: 1.15, heat: false, climaxStrength: 4 } })
  assert.equal(warm.available, true)
  assert.equal(warm.text, '敏感度 68/100 · 很敏感')
  assert.equal(warm.climaxStrength, 4)

  const heat = sensitivityView({ sensitivity: { value: 100, tier: 'extreme', tierLabel: '极度敏感', heat: true } })
  assert.equal(heat.text, '敏感度 100/100 · 发情中', '发情模式要直接写出来（这是用户拨的开关）')
  assert.match(heat.title, /拉满/)

  // 后端没给这个字段（老数据 / 关掉玩法）⇒ 不显示，不显示成 undefined
  const none = sensitivityView({})
  assert.equal(none.available, false)
  assert.equal(none.text, '')
  assert.equal(sensitivityView(null).available, false)
  // 脏值夹住（保留一位小数：一次推进 +0.5，取整就看不出在动）
  const dirty = sensitivityView({ sensitivity: { value: 999, tierLabel: '很敏感', climaxStrength: 9 } })
  assert.equal(dirty.value, 100)
  assert.equal(dirty.climaxStrength, 5)
  assert.ok(!/undefined|NaN/.test(JSON.stringify(dirty)))
  // 小数必须原样透出（前端那个通用 clamp 走 parseInt，会把 12.4 截成 12 —— 敏感度不能走它）
  const decimal = sensitivityView({ sensitivity: { value: 12.4, tier: 'cold', tierLabel: '冷淡' } })
  assert.equal(decimal.value, 12.4)
  assert.equal(decimal.text, '敏感度 12.4/100 · 冷淡')
})

// ── 2. 门槛 ──

test('normalizeIntimateState：门槛跟着服务端走，缺字段回落 60', () => {
  assert.equal(normalizeIntimateState({ accumulation: 50, climaxThreshold: 45 }).climaxThreshold, 45)
  assert.equal(normalizeIntimateState({ accumulation: 50 }).climaxThreshold, 60, '老端点没这个字段 ⇒ 老的 60')
  assert.equal(normalizeIntimateState({ climaxThreshold: 'x' }).climaxThreshold, 60)
  assert.equal(normalizeIntimateState({ climaxThreshold: 999 }).climaxThreshold, 100, '越界夹住')
})

// ── 3. 面板源码守卫 ──

test('★ 面板要显示敏感度与她自己门槛（数值系统必须可见）', () => {
  assert.match(panel, /sensitivityView\(/, '面板要用 sensitivityView 归一化（箭头在 script setup 里）')
  assert.match(tplCode, /sensitivity\.text/, 'HUD 上要显示敏感度文案')
  assert.match(tplCode, /view\.climaxThreshold/, '"一起到"的门槛要显示出来（不许写死 60）')
  assert.match(logic, /export function sensitivityView/, '归一化口径在逻辑层（可单测）')
  assert.equal(/<input[\s>]/.test(tplCode), false, 'AGENTS.md：不许裸 <input>')
})

// ── 4. 私密时刻接口 ──

test('私密时刻接口：GET /api/schedule/:id/private-moment，返回可直接渲染的形状', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' })
    return {
      ok: true,
      json: async () => ({ characterId: 7, has: true, active: true, caught: false, label: '自慰', line: '21:00~21:30 一个人在屋里', startTime: '21:00', endTime: '21:30', minutesLeft: 12 }),
    }
  }
  try {
    const api = await import('../src/api/index.js')
    const data = await api.getPrivateMoment(7)
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['GET /api/schedule/7/private-moment'])
    assert.equal(data.active, true)
    assert.equal(data.label, '自慰')
    assert.match(data.line, /一个人在屋里/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('私密时刻接口：文档化的字段名与日程页一致（别在页面里自己拼）', () => {
  assert.match(apiSrc, /export function getPrivateMoment/, 'api 层要有这个函数')
  assert.match(apiSrc, /\/schedule\/\$\{characterId\}\/private-moment/, '路径要对')
})
