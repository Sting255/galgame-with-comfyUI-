/**
 * 专题 §十（2026-09-30）：Lv4 私密档的前端镜像与分级元信息
 * （面板实际以服务端 gate/清单为准，镜像是离线兜底与契约一致性锚点）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { TOUCH_ACTIONS, TOUCH_LEVELS, DEFAULT_GATE_THRESHOLDS } from '../src/components/touchActionLogic.js'

test('§十：镜像共 28 条动作，Lv4 私密 10 条 key/label/level 齐全', () => {
  assert.equal(TOUCH_ACTIONS.length, 28, '16 老动作 + §10.2 的 Lv4 + 2026-10-02 击打类 3 条')
  const lv4 = TOUCH_ACTIONS.filter(a => a.level === 4)
  assert.equal(lv4.length, 10)
  assert.deepEqual(lv4.map(a => a.key), [
    'touch_pussy', 'touch_clit', 'finger_insert', 'touch_neck', 'lick_neck',
    'suck_nipple', 'touch_nipple', 'ear_nibble', 'inner_thigh',
    'slap_face_light',
  ])
  for (const a of lv4) assert.ok(a.label && a.label.length >= 2, a.key + ' 要有 label')
})

test('§十：分级元信息含第四段「私密」，顺序 Lv1~Lv4', () => {
  assert.deepEqual(TOUCH_LEVELS.map(l => l.level), [1, 2, 3, 4])
  assert.equal(TOUCH_LEVELS[3].label, '私密')
})

test('§十：门控阈值镜像与服务层一致（2026-10-04 起 lv4Affinity=0，Lv2/Lv3 不许动）', () => {
  // 2026-10-04 用户裁决「Lv4 私密整档直接开放」⇒ 服务层 80 → 0，镜像必须跟着改。
  // ⚠️ 这不是放宽容度：Lv3/Lv2 的断言原样保留（下面两行），另加了"Lv4 确实恒过"的行为验证。
  assert.equal(DEFAULT_GATE_THRESHOLDS.lv4Affinity, 0, 'Lv4 私密整档直接开放（用户 2026-10-04 裁决）')
  assert.equal(DEFAULT_GATE_THRESHOLDS.lv3Affinity, 60, 'Lv3 门槛不许被动过')
  assert.equal(DEFAULT_GATE_THRESHOLDS.lv2Affinity, 40, 'Lv2 门槛不许被动过')
})
