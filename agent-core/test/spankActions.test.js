/**
 * 击打类动作（2026-10-02 用户：「动作系统没有拍屁股这类打的交互」）
 *
 * 这一份钉**玩法差异**，不是钉字段表（字段表由 `touchActionService.test.js` 的既有契约覆盖）：
 *   ① 「打」与「摸」的核心区别 = **连点会不会真恼** —— 同一个连点间隔，拍屁股涨的腻烦是抚摸类的 1.5 倍；
 *   ② 倍数写在动作定义里、由纯函数查表，未知 key / 没写倍数的动作一律 1.0（与加字段前逐字节一致）；
 *   ③ 击打类是重动作（睡着时挨一下会醒），且 wake 口径与既有"捏脸/挠痒"一致；
 *   ④ 画面提示与前端镜像都必须同步（少了就红 —— 上一轮"玩具英文 key"的同类事故）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-spank-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const {
  TOUCH_ACTIONS, TOUCH_ACTION_KEYS, TOUCH_ACTION_MAP, TOUCH_IMAGE_HINTS,
  getTouchAction, nextAnnoyance, annoyanceGainMultiplierOf, ANNOYANCE,
} = await import('../src/services/touchActionService.js')

const SPANK_KEYS = ['spank_butt', 'spank_thigh', 'slap_face_light']

test('① 三条击打类动作齐全，等级/映射/唤醒口径正确', () => {
  const expected = {
    spank_butt: { label: '拍屁股', level: 3 },
    spank_thigh: { label: '拍大腿', level: 3 },
    slap_face_light: { label: '轻拍脸颊', level: 4 },
  }
  for (const [key, want] of Object.entries(expected)) {
    const action = getTouchAction(key)
    assert.ok(action, `${key} 必须存在`)
    assert.equal(action.label, want.label)
    assert.equal(action.level, want.level)
    assert.equal(action.intimateActKey, 'hand', `${key} 记手部接触账`)
    assert.equal(action.wakes, true, `${key} 是重动作：睡着时挨一下会醒`)
    assert.ok(action.emotionDelta.arousal >= 0.15, `${key} 要有明显的 arousal`)
    assert.ok(action.emotionDelta.dominance <= -0.08, `${key} 上她更被动`)
  }
  // 加在数组末尾（数组顺序即同等级内的展示顺序，别插中间打乱既有面板）
  const tail = TOUCH_ACTION_KEYS.slice(-3)
  assert.deepEqual([...tail].sort(), [...SPANK_KEYS].sort(), '三条要加在数组末尾')
})

test('② 「打」比「摸」腻烦涨得快（连点会真恼）', () => {
  const now = 1_700_000_000_000
  const repeatAt = now - 60 * 1000   // 一分钟前刚点过 ⇒ 落在 REPEAT_WINDOW 内
  const base = nextAnnoyance({ current: 0, lastAt: null, now, actionKey: 'pat_head' })
  assert.equal(base.gain, 0, '第一次点没有增益')

  const caress = nextAnnoyance({ current: 10, lastAt: repeatAt, now, actionKey: 'pat_head' })
  const spank = nextAnnoyance({ current: 10, lastAt: repeatAt, now, actionKey: 'spank_butt' })
  const slap = nextAnnoyance({ current: 10, lastAt: repeatAt, now, actionKey: 'slap_face_light' })

  assert.ok(spank.gain > caress.gain, `拍屁股的增益要高于摸头：${spank.gain} vs ${caress.gain}`)
  assert.ok(Math.abs(spank.gain - caress.gain * 1.5) < 1e-6, '拍屁股 = 基础增益 ×1.5')
  assert.ok(Math.abs(slap.gain - caress.gain * 1.8) < 1e-6, '轻拍脸颊 = 基础增益 ×1.8')
  assert.ok(spank.annoyance > caress.annoyance, '累积值也要更高')
  // 三次连打就该明显烦了（摸头三下不会）
  let a = { annoyance: 0, lastAt: null }
  let c = { annoyance: 0, lastAt: null }
  for (let i = 0; i < 3; i++) {
    const at = now + i * 3000
    const r1 = nextAnnoyance({ current: a.annoyance, lastAt: a.lastAt, now: at, actionKey: 'spank_butt' })
    const r2 = nextAnnoyance({ current: c.annoyance, lastAt: c.lastAt, now: at, actionKey: 'pat_head' })
    a = { annoyance: r1.annoyance, lastAt: at }
    c = { annoyance: r2.annoyance, lastAt: at }
  }
  assert.ok(a.annoyance > c.annoyance * 1.3, `连点三下：打 ${a.annoyance} 应远高于摸 ${c.annoyance}`)
  assert.ok(a.annoyance >= ANNOYANCE.WARM_THRESHOLD, `连打三下应进入"变冷"档（≥${ANNOYANCE.WARM_THRESHOLD}），实际 ${a.annoyance}`)
})

test('③ 未知 key / 没写倍数的动作一律 1.0（与加字段前逐字节一致）', () => {
  assert.equal(annoyanceGainMultiplierOf('pat_head'), 1)
  assert.equal(annoyanceGainMultiplierOf('spank_butt'), 1.5)
  assert.equal(annoyanceGainMultiplierOf('slap_face_light'), 1.8)
  for (const bad of [null, undefined, '', 'nope', 0, {}, []]) {
    assert.equal(annoyanceGainMultiplierOf(bad), 1, `脏输入 ${JSON.stringify(bad)} 要回落 1.0`)
  }
  // 不传 actionKey 时与老口径完全一致
  const withKey = nextAnnoyance({ current: 10, lastAt: 1_700_000_000_000 - 1000, now: 1_700_000_000_000, likeRatio: 1 })
  const explicit = nextAnnoyance({ current: 10, lastAt: 1_700_000_000_000 - 1000, now: 1_700_000_000_000, likeRatio: 1, actionKey: 'pat_head' })
  assert.equal(withKey.gain, explicit.gain)
})

test('④ 画面提示与前端镜像都覆盖了这三条（少一个就红）', () => {
  for (const key of SPANK_KEYS) {
    assert.ok(TOUCH_IMAGE_HINTS[key], `${key} 缺英文画面提示（TOUCH_IMAGE_HINTS）`)
    assert.match(TOUCH_IMAGE_HINTS[key], /[a-z]{4,}/, `${key} 的提示要是有内容的英文画面句`)
  }
  const mirror = fs.readFileSync(new URL('../../web-ui/src/components/touchActionLogic.js', import.meta.url), 'utf8')
  for (const key of SPANK_KEYS) {
    assert.ok(mirror.includes(`key: '${key}'`), `前端镜像缺 ${key}（用户面板上就点不到）`)
  }
  const backend = fs.readFileSync(new URL('../src/services/touchActionService.js', import.meta.url), 'utf8')
  assert.match(backend, /annoyanceGainMultiplier: 1\.5/, '倍数要写在动作定义里（纯函数只查表）')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
