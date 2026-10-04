/**
 * 角色形象面板的「立绘待同步」提示（2026-10-01）
 * 用户原话：「同步形象展示那边的立绘，需要根据现在的世界观去生成」
 *
 * 后端那侧的口径（签名/判定矩阵/两条写库路径）在
 * `agent-core/test/standingWorldSync.test.js`；本文件只钉前端展示层。
 *
 * 钉住什么：
 * 1. 按服务端下发的 `standing_stale` 显示提示（不自己算世界观哈希——那是服务端的事）。
 * 2. 文案要能指导动作（说清"不一致"+"怎么同步"），并区分"老图无法确认"与"世界观已改"。
 * 3. 沿用 0.3s 节奏与既有 token（AGENTS.md），不写裸 <button>。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../src/components/CharacterStandingPanel.vue', import.meta.url), 'utf8')
// ⚠️ 剥注释再扫：这轮已经两次被自己写在注释里的历史说明绊倒（`matrix.body_control` / `new Date()`）
const tplCode = raw.slice(raw.indexOf('<template>'), raw.indexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '')

test('① 按服务端下发的 standing_stale 显示提示', () => {
  assert.match(tplCode, /v-if="character\?\.standing_stale"/, '要按 standing_stale 显示')
  assert.match(tplCode, /standing_stale_reason/, '要区分原因（unknown / world_changed）')
  assert.equal(/crypto|sha1|currentWorldSignature/.test(tplCode), false, '前端不该自己算世界观签名')
})

test('② 文案能指导动作：说清不一致 + 怎么同步', () => {
  assert.match(tplCode, /立绘与当前世界观不一致/, '要说清是"与当前世界观不一致"')
  assert.match(tplCode, /重新生成立绘/, '要告诉用户按哪个入口同步')
  assert.match(tplCode, /世界观已更改/, 'world_changed 的悬停解释')
  assert.match(tplCode, /生成于「世界观记录」之前|无法确认/, 'unknown（老图）要有自己的解释')
})

test('③ 沿用 0.3s 节奏与既有 token，不写裸控件', () => {
  assert.match(raw, /\.standing-stale \{[\s\S]{0,300}transition: opacity 0\.3s/, '提示条要有 0.3s 过渡')
  assert.match(raw, /sp-fade-enter-active[\s\S]{0,120}0\.3s/, '进出场过渡 0.3s')
  assert.match(raw, /rgba\(var\(--accent-rgb\)/, '用既有 token，不硬编码色值')
  assert.equal(/<button[\s>]/.test(tplCode), false, 'AGENTS.md：不许裸 <button>')
  assert.equal(/style="[^"]*background:[^"]*#/.test(tplCode), false, '不许行内硬编码颜色')
})
