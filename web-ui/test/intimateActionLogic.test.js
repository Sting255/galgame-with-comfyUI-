/**
 * 性爱交互「可点击推进」· 前端纯逻辑回归（task-1）
 *
 * 覆盖 `web-ui/src/components/intimateActionLogic.js`：
 *   · 档位 / 阈值口径（节奏 1~4、累积 60 边缘 / 85 绷不住）；
 *   · normalizeIntimateState 的默认值与脏数据夹取；
 *   · 镜像门控（未插入时「继续抽插」不可用、档位上下限、边缘门槛、非插入体位不能「进入她」）；
 *   · 服务端 actions / positionOptions 优先，端点不可用才回落镜像；
 *   · **镜像与服务层的契约**：动作清单、体位清单、档位表逐项比对
 *     `agent-core/src/services/intimateActionService.js`（改了一边没改另一边直接红）。
 *
 * 注意：源码扫描一律**先剥注释再断言**（本仓已踩过三次"自己的注释把测试绊倒"）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  EDGE_THRESHOLD,
  FALLBACK_POSITIONS,
  INTIMATE_ACTIONS,
  INTIMATE_REJECT_CODES,
  MAX_ACCUMULATION,
  OVERLOAD_THRESHOLD,
  PACE_LEVELS,
  PACE_MAX,
  PACE_MIN,
  accumulationHint,
  accumulationTierOf,
  actionButtonsOf,
  actionFeedbackText,
  localAvailability,
  normalizeIntimateState,
  paceLabelOf,
  paceOptions,
  parseActionResponse,
  positionOptionsOf,
  positionTitle,
  progressPercent,
  statusChipText,
  summaryText,
} from '../src/components/intimateActionLogic.js'

// ── 1. 档位与阈值 ──

test('节奏档：1 缓 / 2 正常 / 3 快 / 4 冲刺，越界夹取', () => {
  assert.deepEqual(PACE_LEVELS.map(p => p.label), ['缓', '正常', '快', '冲刺'])
  assert.equal(paceLabelOf(1), '缓')
  assert.equal(paceLabelOf(2), '正常')
  assert.equal(paceLabelOf(3), '快')
  assert.equal(paceLabelOf(4), '冲刺')
  assert.equal(paceLabelOf(0), '缓', '越界夹到下限')
  assert.equal(paceLabelOf(99), '冲刺', '越界夹到上限')
  assert.equal(paceLabelOf(undefined), '正常', '缺失回落默认档')
  assert.deepEqual(paceOptions().map(o => o.value), [1, 2, 3, 4])
})

test('累积档位：30 渐入 / 60 高潮边缘 / 85 绷不住（与服务层同阈值）', () => {
  assert.equal(accumulationTierOf(0).key, 'calm')
  assert.equal(accumulationTierOf(29).key, 'calm')
  assert.equal(accumulationTierOf(30).key, 'rising')
  assert.equal(accumulationTierOf(EDGE_THRESHOLD).key, 'edge')
  assert.equal(accumulationTierOf(EDGE_THRESHOLD).label, '高潮边缘')
  assert.equal(accumulationTierOf(84).key, 'edge')
  assert.equal(accumulationTierOf(OVERLOAD_THRESHOLD).key, 'overload')
  assert.equal(accumulationTierOf(999).value, MAX_ACCUMULATION, '越界夹取');
  assert.match(accumulationHint({ accumulation: 90 }), /绷不住/)
  assert.match(accumulationHint({ accumulation: 70 }), /失控/)
  assert.match(accumulationHint({ accumulation: 0 }), /稳得住/)
})

// ── 2. 状态归一 ──

test('normalizeIntimateState：缺字段给安全默认，脏数据不炸', () => {
  const empty = normalizeIntimateState(null)
  assert.equal(empty.active, false)
  assert.equal(empty.penetrating, false)
  assert.equal(empty.pace, 2)
  assert.equal(empty.accumulation, 0)
  assert.equal(empty.positionKey, 'missionary')
  assert.equal(empty.positionLabel, 'missionary', '没给中文名时回落 key，而不是空白')
  assert.equal(empty.paceLabel, '正常')
  assert.equal(empty.edge, false)

  const dirty = normalizeIntimateState({ active: true, penetrating: true, pace: 99, accumulation: -5, climaxCount: 'x' })
  assert.equal(dirty.pace, PACE_MAX)
  assert.equal(dirty.accumulation, 0)
  assert.equal(dirty.climaxCount, 0)
  assert.equal(dirty.active, true)
  assert.equal(dirty.penetrating, true)

  // 没 active 就不算插入中（脏回执不能凭空显示"插入中"）
  assert.equal(normalizeIntimateState({ active: false, penetrating: true }).penetrating, false)
})

test('进度条与摘要：百分比 0~100，摘要含体位 / 状态 / 节奏 / 累积', () => {
  assert.equal(progressPercent({ accumulation: 0 }), 0)
  assert.equal(progressPercent({ accumulation: 62 }), 62)
  assert.equal(progressPercent({ accumulation: 200 }), 100, '越界夹到 100%')
  const text = summaryText({ active: true, penetrating: true, positionKey: 'doggystyle', positionLabel: '狗爬式', pace: 3, accumulation: 62 })
  assert.match(text, /狗爬式/)
  assert.match(text, /插入中/)
  assert.match(text, /快/)
  assert.match(text, /62%/)
  assert.equal(statusChipText({ active: true, penetrating: false }), '停在外面')
  assert.equal(statusChipText({ active: false }), '还没开始')
  assert.equal(statusChipText({ active: true, penetrating: true }), '插入中')
})

// ── 3. 镜像门控（端点不可用时的兜底） ──

test('镜像门控：没插进去时「继续抽插 / 加速 / 慢下来 / 一起到」全部不可用', () => {
  const state = { active: true, penetrating: false, positionKey: 'missionary', positionLabel: '传教士体位' }
  for (const key of ['thrust', 'faster', 'slower', 'climax']) {
    const gate = localAvailability(key, state)
    assert.equal(gate.allowed, false, key + ' 不该可用')
    assert.equal(gate.code, 'not_penetrating')
    assert.ok(gate.message.length > 0, key + ' 必须给人话理由')
  }
  assert.equal(localAvailability('enter', state).allowed, true)
  assert.equal(localAvailability('position', state).allowed, true)
  assert.equal(localAvailability('stop', state).allowed, true)
})

test('镜像门控：档位上下限 / 边缘门槛 / 已在里面 / 非插入体位 / 没开始', () => {
  const inside = { active: true, penetrating: true, pace: 2, accumulation: 10 }
  assert.equal(localAvailability('faster', { ...inside, pace: PACE_MAX }).code, 'pace_max')
  assert.equal(localAvailability('slower', { ...inside, pace: PACE_MIN }).code, 'pace_min')
  assert.equal(localAvailability('climax', inside).code, 'not_edge')
  assert.equal(localAvailability('climax', { ...inside, accumulation: 70 }).allowed, true)
  assert.equal(localAvailability('enter', inside).code, 'already_penetrating')
  assert.equal(localAvailability('enter', { active: true, positionKey: 'handjob' }).code, 'position_not_penetrative')
  assert.equal(localAvailability('stop', { active: false }).code, 'not_active')
  assert.equal(localAvailability('nope', inside).code, 'unknown_action')
  assert.ok(INTIMATE_REJECT_CODES.includes('she_refuses'), '服务端可能返回的码前端要认识')
})

test('actionButtonsOf：服务端 actions 优先（原样吃 available / reason），没有才回落镜像', () => {
  const server = actionButtonsOf({
    actions: [
      { key: 'enter', label: '进入她', hint: 'h', tone: '', available: false, reason: '服务端说不', code: 'not_penetrating' },
      { key: 'thrust', label: '继续抽插', hint: 'h2', available: true, reason: '', code: 'ok' },
    ],
  })
  assert.equal(server.length, 2)
  assert.equal(server[0].available, false)
  assert.equal(server[0].reason, '服务端说不')
  assert.equal(server[1].available, true)

  const mirrored = actionButtonsOf({ active: true, penetrating: true, pace: 2, accumulation: 0 })
  assert.equal(mirrored.length, INTIMATE_ACTIONS.length)
  const byKey = Object.fromEntries(mirrored.map(a => [a.key, a]))
  assert.equal(byKey.thrust.available, true)
  assert.equal(byKey.climax.available, false, '累积 0 到不了')
  assert.equal(byKey.faster.available, true)
})

test('positionOptionsOf：服务端清单优先；没有才回落镜像，镜像每条都有 key + 中文 label', () => {
  const server = positionOptionsOf({ positionOptions: [{ key: 'x', label: 'X 体位' }] })
  assert.deepEqual(server, [{ key: 'x', label: 'X 体位' }])
  const mirror = positionOptionsOf({})
  assert.ok(mirror.length >= 10)
  for (const item of mirror) {
    assert.ok(item.key && item.label, '镜像体位必须有 key 与中文名')
    assert.ok(item.label !== item.key, '中文名不能等于英文 key')
  }
  assert.equal(positionTitle(mirror[0], { positionKey: mirror[0].key, active: true }), positionTitle(mirror[0], { positionKey: mirror[0].key, active: true }))
  assert.match(positionTitle(mirror[0], {}), /（/)
})

// ── 4. 回执解析 ──

test('parseActionResponse / actionFeedbackText：被拒给人话，成功给推进反馈', () => {
  const rejected = parseActionResponse({ allowed: false, code: 'not_penetrating', message: '还没插进去：先点「进入她」。' })
  assert.equal(rejected.allowed, false)
  assert.equal(rejected.code, 'not_penetrating')
  assert.equal(actionFeedbackText({ allowed: false, code: 'not_penetrating', message: '还没插进去：先点「进入她」。' }), '还没插进去：先点「进入她」。')

  const ok = parseActionResponse({ allowed: true, code: 'ok', state: { penetrating: true }, reaction: { text: '……' } })
  assert.equal(ok.allowed, true)
  assert.equal(ok.state.penetrating, true)
  assert.match(actionFeedbackText({ allowed: true, code: 'ok', reaction: { text: '……' } }), /已推进/)

  const failed = parseActionResponse({ allowed: true, code: 'ok', fallback: true, reaction: null })
  assert.equal(failed.fallback, true)
  assert.equal(failed.reaction, null)
  assert.match(actionFeedbackText({ allowed: true, code: 'ok', fallback: true, reaction: null }), /补演/)

  const climax = parseActionResponse({ allowed: true, code: 'ok', climaxed: true })
  assert.equal(climax.climaxed, true)
  assert.match(actionFeedbackText({ allowed: true, code: 'ok', climaxed: true }), /她到了/)

  assert.equal(parseActionResponse(null).allowed, false, '空回执按失败处理，不假装成功')
})

test('reaction:null 的成功必须有「已推进」反馈行（不能让用户以为点坏了）', () => {
  // 省额度模式：服务端给 notice，原样用
  const implicit = { allowed: true, code: 'ok', mode: 'implicit', reaction: null, notice: '「省额度模式」已开启：这一下的反应会留到她下一轮聊天里演出来。' }
  assert.match(actionFeedbackText(implicit), /省额度模式/)
  // 没有 notice 也没有反应正文：也要有一句「已推进」
  const silent = actionFeedbackText({ allowed: true, code: 'ok', mode: 'implicit', reaction: null })
  assert.match(silent, /已推进/)
  assert.match(silent, /下一轮/)
  const noReaction = actionFeedbackText({ allowed: true, code: 'ok', reaction: null })
  assert.match(noReaction, /已推进/)
  assert.ok(noReaction.length > 0)
  // 有反应正文时也是「已推进」，而不是空白
  assert.match(actionFeedbackText({ allowed: true, code: 'ok', reaction: { text: '嗯……' } }), /已推进/)
})

// ── 5. 与服务层的契约（镜像不能漂） ──

/** 剥掉 JS 注释（源码扫描型断言必须先剥注释：本仓踩过三次） */
function stripJsComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const serviceSource = stripJsComments(
  readFileSync(new URL('../../agent-core/src/services/intimateActionService.js', import.meta.url), 'utf8'),
)

function extractStringArray(name) {
  const match = new RegExp(name + '\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)').exec(serviceSource)
  assert.ok(match, '服务层必须还有 ' + name)
  return [...match[1].matchAll(/'([^']*)'/g)].map(m => m[1])
}

test('契约：动作清单与服务层逐项一致（key / label / hint / tone）', () => {
  const block = /export const INTIMATE_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(serviceSource)
  assert.ok(block, '服务层必须还有 INTIMATE_ACTIONS')
  const rows = [...block[1].matchAll(/\{([^}]*)\}/g)].map(m => m[1])
  const serverActions = rows.map(row => ({
    key: /key:\s*'([^']*)'/.exec(row)?.[1] || '',
    label: /label:\s*'([^']*)'/.exec(row)?.[1] || '',
    hint: /hint:\s*'([^']*)'/.exec(row)?.[1] || '',
    tone: /tone:\s*'([^']*)'/.exec(row)?.[1] || '',
  }))
  assert.deepEqual(
    INTIMATE_ACTIONS.map(a => [a.key, a.label, a.hint, a.tone || '']),
    serverActions.map(a => [a.key, a.label, a.hint, a.tone]),
    '前端动作镜像必须与服务层一致（改了服务层就要同步镜像）',
  )
})

test('契约：节奏档位表与服务层一致', () => {
  const block = /export const PACE_LEVELS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(serviceSource)
  assert.ok(block, '服务层必须还有 PACE_LEVELS')
  const rows = [...block[1].matchAll(/\{([^}]*)\}/g)].map(m => m[1])
  const serverPaces = rows.map(row => ({
    value: Number(/value:\s*(\d+)/.exec(row)?.[1] || 0),
    key: /key:\s*'([^']*)'/.exec(row)?.[1] || '',
    label: /label:\s*'([^']*)'/.exec(row)?.[1] || '',
  }))
  assert.deepEqual(PACE_LEVELS, serverPaces)
})

test('契约：镜像体位清单与后端精选清单对得上（且都被后端词表收着）', () => {
  const serverKeys = extractStringArray('PREFERRED_POSITION_KEYS')
  assert.ok(serverKeys.length >= 10, '后端精选体位至少 10 条')
  for (const item of FALLBACK_POSITIONS) {
    assert.ok(serverKeys.includes(item.key), '镜像体位必须也在后端精选清单里：' + item.key)
  }
  // 后端新增的体位前端可以没有（服务端给了就用服务端的），但镜像不许出现后端不认的 key
  assert.ok(serverKeys.includes('missionary'))
  assert.ok(serverKeys.includes('doggystyle'))
})
