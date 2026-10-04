/**
 * SLG 动作系统 · 服务层单测（阶段一 L1 矩阵）
 *
 * 覆盖专题 §六 L1 要求的五组：**门控矩阵 / 腻烦叠加与衰减 / 偏好修正 / JSON 解析容错 / 配额耗尽回落**，
 * 外加动作清单契约、注入块与即时反应 prompt 的构造、以及「服务层不许越界」的源码级断言。
 *
 * 本模块**零依赖**（不 import 任何其它模块、不碰 DB），所以这个文件不需要建表、不需要假 LLM、
 * 不需要 globalThis.fetch 兜底——纯函数 + 可注入时钟，假时间就能把 30 分钟衰减测完。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  TOUCH_ACTIONS, TOUCH_ACTION_KEYS, TOUCH_ACTION_MAP, TOUCH_LEVELS, TOUCH_LEVEL_LABELS,
  TOUCH_MODES, TOUCH_GATE_CODES, TOUCH_REQUEST_CODES, DEFAULT_TOUCH_THRESHOLDS, normalizeTouchMode,
  ANNOYANCE, ANNOYANCE_TIERS, ANNOYANCE_TIER_TEXT, INSTANT_QUOTA_NOTICE,
  MAX_TOUCH_BLOCK_CHARS, MAX_REACTION_CHARS, TOUCH_EVENT_TTL_MS, touchEventCutoff, isTouchEventFresh,
  TOUCH_IMAGE_MODES, TOUCH_IMAGE_MODE_LABELS, DEFAULT_TOUCH_IMAGE_MODE, SMART_IMAGE_CHANCE, TOUCH_IMAGE_HINTS,
  normalizeTouchImageMode, shouldGenerateTouchImage, buildTouchImagePrompt,
  getTouchAction, listTouchActions, normalizeTouchRequest, getTouchGate,
  clampAnnoyance, likeGainScale, decayAnnoyance, annoyanceTier, nextAnnoyance, likeRatioText,
  resolveTouchMode, describeAction, describeActionForTarget,
  buildConversationReactionPrompt,
  buildTouchActionBlock, buildReactionPrompt, parseReactionOutput, extractReactionText,
} = await import('../src/services/touchActionService.js');

const MINUTE = 60 * 1000;
const lv1 = TOUCH_ACTIONS.filter(a => a.level === 1).map(a => a.key);
const lv2 = TOUCH_ACTIONS.filter(a => a.level === 2).map(a => a.key);
const lv3 = TOUCH_ACTIONS.filter(a => a.level === 3).map(a => a.key);
const withIntimate = { intimateAuthorized: true };

// ── A. 动作清单契约（专题 §1.1 冻结清单） ────────────────────────────────────

test('A. 清单：Lv1 6 个 / Lv2 5 个 / Lv3 7 个，key 唯一且字段齐全', () => {
  // 2026-10-02：加击打类 3 条（spank_butt / spank_thigh 记 Lv3，slap_face_light 记 Lv4）
  // ⇒ 25 → 28、Lv3 5 → 7。用户原话：「动作系统没有拍屁股这类打的交互」。
  assert.equal(TOUCH_ACTIONS.length, 28, '16 老动作 + §10.2 的 9 条 Lv4 + 击打类 3 条');
  assert.deepEqual([lv1.length, lv2.length, lv3.length], [6, 5, 7]);
  assert.equal(new Set(TOUCH_ACTION_KEYS).size, TOUCH_ACTION_KEYS.length, 'key 必须唯一');
  for (const action of TOUCH_ACTIONS) {
    assert.match(action.key, /^[a-z][a-z0-9_]*$/, 'key 口径：snake_case：' + action.key);
    assert.ok(action.label && action.label.length <= 6, action.key + ' 需要中文 label');
    assert.ok(action.promptDesc && action.promptDesc.length >= 6, action.key + ' 需要 promptDesc');
    assert.ok([1, 2, 3, 4].includes(action.level), action.key + ' 的 level 必须在 1~4（§十 新增 Lv4 私密）');
    for (const key of ['valence', 'arousal', 'dominance']) {
      const value = action.emotionDelta[key];
      assert.ok(Number.isFinite(value) && value >= -1 && value <= 1, action.key + '.' + key + ' 必须在 -1~1');
    }
    // 看板映射：只有 Lv3/Lv4 才可能记账（Lv1/Lv2 恒 null）；具体键由下面的映射表测试钉住
    if (action.level < 3) {
      assert.equal(action.intimateActKey, null, action.key + ' 只有 Lv3/Lv4 才可能记账');
    }
  }
  assert.deepEqual(TOUCH_LEVELS, { DAILY: 1, INTIMATE: 2, SENSITIVE: 3, EXPLICIT: 4 }, '§10.1：新增 Lv4 私密');
  assert.equal(TOUCH_LEVEL_LABELS[3], 'Lv3 敏感');
});

test('A. 清单：捏脸/挠痒 + 击打类 3 条是重动作（睡眠交互）；索引与 key 表一致', () => {
  // 击打类天生是重动作：睡着时挨一巴掌本来就会醒（`wakes: true` 与挠痒/捏脸同档）。
  assert.deepEqual(TOUCH_ACTIONS.filter(a => a.wakes).map(a => a.key).sort(),
    ['pinch_cheek', 'slap_face_light', 'spank_butt', 'spank_thigh', 'tickle']);
  for (const key of TOUCH_ACTION_KEYS) assert.equal(TOUCH_ACTION_MAP[key].key, key);
  assert.equal(Object.keys(TOUCH_ACTION_MAP).length, TOUCH_ACTION_KEYS.length);
});

test('A. listTouchActions 按等级截断；getTouchAction 对脏 key 返回 null 而不是抛', () => {
  assert.deepEqual(listTouchActions({ maxLevel: 1 }).map(a => a.level), [1, 1, 1, 1, 1, 1]);
  assert.equal(listTouchActions({ maxLevel: 2 }).length, 11);
  assert.equal(listTouchActions().length, 28, '默认要带 Lv4（§10.1 的"动态遍历自动覆盖"）+ 击打类 3 条');
  assert.equal(listTouchActions({ maxLevel: 3 }).length, 18, 'Lv3 截断仍可用（老 16 条 + 击打类 Lv3×2）');
  assert.equal(listTouchActions({ maxLevel: 0 }).length, 6, '越界向下夹到 Lv1');
  assert.equal(listTouchActions({ maxLevel: 99 }).length, 28, '越界向上夹到 Lv4');
  assert.equal(getTouchAction('pat_head').label, '摸头');
  for (const bad of ['', null, undefined, 'nope', 'PAT_HEAD', 'pat head', 0, {}]) {
    assert.equal(getTouchAction(bad), null, '脏 key 应返回 null：' + JSON.stringify(bad));
  }
});

test('A. 动作描述：玩家视角原样，对她说话时转成第二人称（16 个动作全覆盖）', () => {
  assert.equal(describeAction('pat_head'), '你伸手轻轻摸了摸她的头');
  assert.equal(describeAction('nope'), '');
  for (const key of TOUCH_ACTION_KEYS) {
    const line = describeActionForTarget(key, { userName: 'Tester' });
    assert.ok(line.length > 0, key + ' 转视角后不能为空');
    assert.ok(!line.includes('她'), key + ' 转视角后不该再出现"她"：' + line);
    assert.ok(!line.startsWith('你'), key + ' 转视角后不该以"你"开头：' + line);
    assert.ok(line.startsWith('Tester'), key + ' 应该由玩家名开头：' + line);
  }
  assert.equal(describeActionForTarget('pat_head'), '他伸手轻轻摸了摸你的头', '没给名字时用"他"');
  assert.equal(describeActionForTarget('nope'), '');
});

// ── B. 参数校验 ────────────────────────────────────────────────────────────

test('B. normalizeTouchRequest：私聊/群聊的形状与三类非法输入', () => {
  const ok = normalizeTouchRequest({ actionKey: 'pat_head', characterId: '7' });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'ok');
  assert.equal(ok.characterId, 7);
  assert.equal(ok.scene, 'chat');
  assert.equal(ok.groupId, 0);
  assert.equal(ok.mode, TOUCH_MODES.AUTO);
  assert.equal(ok.action.key, 'pat_head');

  const group = normalizeTouchRequest({ actionKey: 'hug', characterId: 3, groupId: '9', scene: 'group' });
  assert.equal(group.ok, true);
  assert.equal(group.scene, 'group');
  assert.equal(group.groupId, 9);

  assert.equal(normalizeTouchRequest({ actionKey: 'nope', characterId: 3 }).code, 'invalid_action');
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: 0 }).code, 'invalid_character');
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: 'abc' }).code, 'invalid_character');
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: -2 }).code, 'invalid_character');
  assert.equal(normalizeTouchRequest({ actionKey: 'hug', characterId: 3, scene: 'group' }).code, 'invalid_scene');
  assert.equal(normalizeTouchRequest({ actionKey: 'hug', characterId: 3, scene: 'group', groupId: 0 }).code, 'invalid_scene');

  // 取整口径与既有 toId 一致（'1.5' -> 1）；非法 mode / scene 一律回落
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: '1.5' }).characterId, 1);
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: 5, mode: 'weird' }).mode, TOUCH_MODES.AUTO);
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: 5, scene: 'weird' }).scene, 'chat');
  const bad = normalizeTouchRequest({ actionKey: 'nope', characterId: 5 });
  assert.equal(bad.action, null);
  assert.equal(bad.characterId, 0);
  for (const code of TOUCH_REQUEST_CODES) assert.ok(typeof code === 'string');
});


// ── C. 门控矩阵（专题 §1.3） ────────────────────────────────────────────────

test('C. Lv1 无门控：好感 0 / 睡眠中 / 群聊 / 未授权 都放行', () => {
  for (const key of lv1) {
    for (const extra of [{}, { affinity: 0 }, { sleeping: true }, { scene: 'group' }, { intimateAuthorized: false }]) {
      const gate = getTouchGate({ actionKey: key, ...extra });
      assert.equal(gate.allowed, true, key + ' 必须随时可点：' + JSON.stringify(extra));
      assert.equal(gate.code, 'ok');
      assert.equal(gate.message, '', '放行时不该带拒绝文案');
    }
  }
  assert.equal(getTouchGate({ actionKey: 'pat_head' }).level, 1);
});

test('C. Lv2：好感 < 40 拦（有趣文案）、≥ 40 放行、0 好感但有誓约放行、睡着也能做', () => {
  const low = getTouchGate({ actionKey: 'kiss_cheek', affinity: 39 });
  assert.equal(low.allowed, false);
  assert.equal(low.code, 'affinity_low');
  assert.equal(low.reason, 'affinity_low_lv2');
  assert.match(low.message, /还不太习惯/, '拒绝必须是人话，不是机械报错');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 40 }).code, 'ok');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 0, isOath: true }).code, 'ok');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 39, sleeping: true }).code, 'affinity_low', '睡着不改变好感门槛');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 80, sleeping: true }).code, 'ok', 'Lv2 在睡着的她身上可以做');
});

test('C. Lv3：好感 60 与亲密授权**两条都要**，缺哪条报哪条', () => {
  const lowAffinity = getTouchGate({ actionKey: 'touch_breast', affinity: 59, ...withIntimate });
  assert.equal(lowAffinity.code, 'affinity_low');
  assert.equal(lowAffinity.reason, 'affinity_low_lv3');
  assert.match(lowAffinity.message, /按住你的手/);

  const notAuthorized = getTouchGate({ actionKey: 'touch_breast', affinity: 80 });
  assert.equal(notAuthorized.code, 'intimate_not_authorized');
  assert.match(notAuthorized.message, /授权/);

  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 60, ...withIntimate }).code, 'ok');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 0, isOath: true, ...withIntimate }).code, 'ok', '誓约可顶掉好感门槛');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 0, isOath: true }).code, 'intimate_not_authorized', '誓约顶不掉授权');
});

test('C. Lv3 + 睡着 → 拦截（催眠中才豁免）；群聊 Lv3 默认拦截，显式开才放行', () => {
  const asleep = getTouchGate({ actionKey: 'touch_butt', affinity: 90, sleeping: true, ...withIntimate });
  assert.equal(asleep.code, 'sleeping_blocked');
  assert.match(asleep.message, /睡得很沉/);

  const inGroup = getTouchGate({ actionKey: 'touch_butt', affinity: 90, scene: 'group', ...withIntimate });
  assert.equal(inGroup.code, 'group_adult_blocked');
  assert.match(inGroup.message, /这么多人/);
  assert.equal(getTouchGate({ actionKey: 'touch_butt', affinity: 90, scene: 'group', allowGroupAdult: true, ...withIntimate }).code, 'ok');
  // Lv2 在群聊里不在隐私拦截范围（专题只收窄 Lv3）
  assert.equal(getTouchGate({ actionKey: 'hug', affinity: 90, scene: 'group' }).code, 'ok');
});

test('C. 催眠中无条件放行（豁免门控）：任意档 × 任意状态，且优先于睡眠拦截', () => {
  const worst = [
    { affinity: 0, sleeping: true, scene: 'group', intimateAuthorized: false },
    { affinity: 0, sleeping: false, scene: 'group', intimateAuthorized: false },
    { affinity: 0, sleeping: true, scene: 'chat', intimateAuthorized: false },
  ];
  for (const key of [...lv2, ...lv3]) {
    for (const extra of worst) {
      const gate = getTouchGate({ actionKey: key, hypnotized: true, ...extra });
      assert.equal(gate.allowed, true, key + ' 催眠中必须放行：' + JSON.stringify(extra));
      assert.equal(gate.exempt, 'hypnosis');
    }
  }
  assert.equal(getTouchGate({ actionKey: 'touch_thigh', affinity: 0, sleeping: true, hypnotized: true }).code, 'ok');
});

test('C. 睡眠中的重动作打 wakesSleeping 标记（调用方据此挂 temporaryWake）', () => {
  assert.equal(getTouchGate({ actionKey: 'tickle', sleeping: true }).wakesSleeping, true);
  assert.equal(getTouchGate({ actionKey: 'pinch_cheek', sleeping: true }).wakesSleeping, true);
  assert.equal(getTouchGate({ actionKey: 'pat_head', sleeping: true }).wakesSleeping, false);
  assert.equal(getTouchGate({ actionKey: 'tickle', sleeping: false }).wakesSleeping, false);
  assert.equal(getTouchGate({ actionKey: 'tickle', sleeping: true, hypnotized: true }).wakesSleeping, true);
});

test('C. 未知动作 / 自定义阈值 / 机器码白名单', () => {
  const unknown = getTouchGate({ actionKey: 'nope', affinity: 100, ...withIntimate });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.code, 'unknown_action');
  assert.equal(unknown.level, null);
  assert.equal(unknown.action, null);
  assert.equal(unknown.message, '没有这个动作。');

  const custom = getTouchGate({ actionKey: 'kiss_cheek', affinity: 10, thresholds: { lv2Affinity: 10 } });
  assert.equal(custom.code, 'ok');
  assert.equal(custom.thresholds.lv2Affinity, 10);
  assert.equal(custom.thresholds.lv3Affinity, DEFAULT_TOUCH_THRESHOLDS.lv3Affinity, '没传的阈值回落默认');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 39, thresholds: { lv2Affinity: 39 } }).code, 'ok');

  for (const gate of [unknown, custom, getTouchGate({ actionKey: 'touch_breast', affinity: 0 }), getTouchGate({ actionKey: 'pat_head' })]) {
    assert.ok(TOUCH_GATE_CODES.includes(gate.code), '未知机器码：' + gate.code);
  }
});

// ── D. 腻烦度与偏好修正（专题 §2.3） ────────────────────────────────────────

test('D. 衰减：每 30 分钟 -10，不足一周期不减，永不跌破 0', () => {
  assert.equal(decayAnnoyance(100, 0), 100);
  assert.equal(decayAnnoyance(100, 29 * MINUTE), 100);
  assert.equal(decayAnnoyance(100, 30 * MINUTE), 90);
  assert.equal(decayAnnoyance(100, 65 * MINUTE), 80);
  assert.equal(decayAnnoyance(100, 10 * 60 * MINUTE), 0, '地板是 0');
  assert.equal(decayAnnoyance(10, 30 * MINUTE), 0);
  assert.equal(decayAnnoyance(10, 90 * MINUTE), 0);
  assert.equal(decayAnnoyance(-5, 0), 0, '负数先夹到 0');
  assert.equal(decayAnnoyance('x', 30 * MINUTE), 0);
  assert.equal(clampAnnoyance(150), 100);
  assert.equal(clampAnnoyance(-1), 0);
});

test('D. 偏好修正：liked 涨得慢、讨厌的涨得快，越界夹在 [0.5, 2]', () => {
  assert.equal(likeGainScale(1), 1);
  assert.equal(likeGainScale(2), 0.5);
  assert.equal(likeGainScale(0.5), 2);
  assert.equal(likeGainScale(5), 0.5, '上限 2 倍减速');
  assert.equal(likeGainScale(0.1), 2, '上限 2 倍加速');
  assert.equal(likeGainScale('x'), 1);
  assert.ok(likeGainScale(1.3) > 0.7 && likeGainScale(1.3) < 0.8);
  assert.equal(likeRatioText(1.3).includes('受用'), true);
  assert.equal(likeRatioText(0.5).includes('并不喜欢'), true);
  assert.equal(likeRatioText(1).includes('谈不上偏好'), true);
});

test('D. 连点曲线：10 分钟内每次 +20 × 偏好倍率，第 3~5 次明显（fine → warm → refusing）', () => {
  let state = { annoyance: 0, lastAt: null };
  const curve = [];
  for (let i = 0; i < 5; i++) {
    const step = nextAnnoyance({ current: state.annoyance, lastAt: state.lastAt, now: 1000 + i * 1000, likeRatio: 1 });
    state = { annoyance: step.annoyance, lastAt: 1000 + i * 1000 };
    curve.push([step.annoyance, step.tier, step.repeated, step.gain]);
  }
  assert.deepEqual(curve.map(row => row[0]), [0, 20, 40, 60, 80], '第一次不叠加（没有"上一次"），之后每次 +20');
  assert.deepEqual(curve.map(row => row[1]), ['fine', 'fine', 'fine', 'warm', 'warm']);
  assert.equal(curve[0][2], false);
  assert.equal(curve[1][2], true);
  assert.equal(curve[4][0], 80);
  // 第 6 次 → 100 = refusing（专题"第 4~5 次明显"）
  const sixth = nextAnnoyance({ current: 80, lastAt: 5000, now: 6000, likeRatio: 1 });
  assert.equal(sixth.annoyance, 100);
  assert.equal(sixth.tier, ANNOYANCE_TIERS.REFUSING);
});

test('D. 窗口外不叠加（只吃衰减）；喜欢摸头的涨得慢；没有 lastAt 不加成', () => {
  const outside = nextAnnoyance({ current: 60, lastAt: 0, now: 20 * MINUTE, likeRatio: 1 });
  assert.equal(outside.repeated, false);
  assert.equal(outside.gain, 0);
  assert.equal(outside.annoyance, 60, '20 分钟不足一个衰减周期，原样');

  const boundary = nextAnnoyance({ current: 60, lastAt: 0, now: ANNOYANCE.REPEAT_WINDOW_MS, likeRatio: 1 });
  assert.equal(boundary.repeated, true, '正好 10 分钟算连点');
  assert.equal(boundary.gain, 20);

  const liked = nextAnnoyance({ current: 0, lastAt: 0, now: 1000, likeRatio: 1.3 });
  assert.ok(liked.gain > 15 && liked.gain < 16, '喜欢被摸头 → 增速 < 16（专题：偏好角色 ×0.5 量级）');
  const disliked = nextAnnoyance({ current: 0, lastAt: 0, now: 1000, likeRatio: 0.5 });
  assert.equal(disliked.gain, 40, '讨厌挠痒 → 增速 2 倍');

  const firstTime = nextAnnoyance({ current: 30, now: 1000 });
  assert.equal(firstTime.gain, 0);
  assert.equal(firstTime.repeated, false);
  assert.equal(firstTime.annoyance, 30);
  assert.equal(firstTime.elapsedMs, null);
  assert.equal(nextAnnoyance({ current: 95, lastAt: 0, now: 1000 }).annoyance, 100, '夹在 100');
});

test('D. 档位阈值：>50 变冷、>80 拒绝；档位文案齐全', () => {
  assert.equal(annoyanceTier(0), ANNOYANCE_TIERS.FINE);
  assert.equal(annoyanceTier(50), ANNOYANCE_TIERS.FINE, '正好 50 还不算烦');
  assert.equal(annoyanceTier(51), ANNOYANCE_TIERS.WARM);
  assert.equal(annoyanceTier(80), ANNOYANCE_TIERS.WARM);
  assert.equal(annoyanceTier(81), ANNOYANCE_TIERS.REFUSING);
  assert.equal(annoyanceTier(999), ANNOYANCE_TIERS.REFUSING);
  assert.ok(ANNOYANCE_TIER_TEXT.warm.includes('不耐烦'));
  assert.ok(ANNOYANCE_TIER_TEXT.refusing.includes('躲开'));
  assert.equal(ANNOYANCE.REPEAT_GAIN >= 15 && ANNOYANCE.REPEAT_GAIN <= 25, true, '专题给的 15~25 区间');
});

// ── E. 即时反应 / 隐式注入 的模式回落（专题 §2.1） ──────────────────────────

test('E. resolveTouchMode：auto 跟开关、显式 instant 遇额度也用隐式、显式隐式不消耗', () => {
  assert.deepEqual(resolveTouchMode({}), { mode: 'instant', fallback: false, notice: null, reason: 'instant' });
  assert.equal(resolveTouchMode({ instantEnabled: false }).mode, 'implicit');
  assert.equal(resolveTouchMode({ instantEnabled: false }).reason, 'instant_disabled');
  assert.equal(resolveTouchMode({ mode: 'implicit', instantEnabled: true }).mode, 'implicit');
  assert.equal(resolveTouchMode({ mode: 'implicit', instantEnabled: true, quotaExhausted: true }).mode, 'implicit');
  assert.equal(resolveTouchMode({ mode: 'implicit' }).fallback, false);

  const exhausted = resolveTouchMode({ mode: 'instant', quotaExhausted: true });
  assert.equal(exhausted.mode, 'implicit');
  assert.equal(exhausted.fallback, true);
  assert.equal(exhausted.notice, INSTANT_QUOTA_NOTICE);
  assert.equal(exhausted.reason, 'quota_exhausted');
  assert.match(INSTANT_QUOTA_NOTICE, /下次发言时出现/);

  const autoExhausted = resolveTouchMode({ instantEnabled: true, quotaExhausted: true });
  assert.equal(autoExhausted.mode, 'implicit');
  assert.equal(autoExhausted.fallback, true);
  assert.equal(resolveTouchMode({ mode: 'weird' }).mode, 'instant', '非法 mode 回落 auto');
  assert.equal(resolveTouchMode({ mode: TOUCH_MODES.INSTANT }).mode, 'instant');

  // 规范化辅助（服务层对外也用同一个口径，别在路由里手写一遍）
  assert.equal(normalizeTouchMode('instant'), 'instant');
  assert.equal(normalizeTouchMode('implicit'), 'implicit');
  assert.equal(normalizeTouchMode('auto'), 'auto');
  for (const bad of ['', null, undefined, 'weird', 'INSTANT', 0, {}]) assert.equal(normalizeTouchMode(bad), 'auto');
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: 5, mode: 'instant' }).mode, 'instant');
  assert.equal(normalizeTouchRequest({ actionKey: 'pat_head', characterId: 5, mode: 'implicit' }).mode, 'implicit');
});


// ── F. 注入块构造（隐式注入 / 即时反应两种口径） ─────────────────────────────

test('F. buildTouchActionBlock：包标签、含动作与耐受、未知 key 返回空串', () => {
  const block = buildTouchActionBlock({ actionKey: 'pat_head', userName: 'Tester' });
  assert.ok(block.startsWith('<touch_action>\n'));
  assert.ok(block.endsWith('</touch_action>'));
  assert.ok(block.includes('Tester 对你做了「摸头」'));
  assert.ok(block.includes('Tester伸手轻轻摸了摸你的头'), '必须转成第二人称');
  assert.ok(block.includes('【你的耐受】还乐意'));
  assert.ok(block.includes('【你的偏好】'));
  assert.ok(block.includes('写进你这一轮的回复里'), '隐式模式：让她这一轮演出');
  assert.ok(block.includes('不要报幕'));
  assert.ok(block.length <= MAX_TOUCH_BLOCK_CHARS);
  assert.equal(buildTouchActionBlock({ actionKey: 'nope' }), '');
  assert.equal(buildTouchActionBlock({}), '');
  assert.ok(buildTouchActionBlock({ actionKey: 'hug' }).includes('他 对你做了「抱抱」'), '默认玩家名"他"');
});

test('F. buildTouchActionBlock：instant 模式要求"别再演一遍"，耐受/偏好按档位走', () => {
  const instant = buildTouchActionBlock({ actionKey: 'hug', userName: 'Tester', mode: 'instant' });
  assert.ok(instant.includes('已经单独发过了'));
  assert.ok(!instant.includes('写进你这一轮的回复里'));
  assert.ok(buildTouchActionBlock({ actionKey: 'cuddle', annoyance: 60 }).includes('有点不耐烦'));
  assert.ok(buildTouchActionBlock({ actionKey: 'cuddle', annoyance: 90 }).includes('已经很烦了'));
  assert.ok(buildTouchActionBlock({ actionKey: 'cuddle', likeRatio: 1.3 }).includes('很受用'));
  assert.ok(buildTouchActionBlock({ actionKey: 'cuddle', likeRatio: 0.5 }).includes('并不喜欢'));
});

test('F. buildTouchActionBlock：催眠中走"无条件顺从"且不写耐受；睡着标记"被弄醒"；催眠块追加在末尾', () => {
  const hypno = buildTouchActionBlock({ actionKey: 'touch_breast', userName: 'Tester', hypnotized: true, annoyance: 100, likeRatio: 0.5, sleeping: true });
  assert.ok(hypno.includes('无条件顺从'));
  assert.ok(!hypno.includes('【你的耐受】'), '完全控制下不写耐受/腻烦');
  assert.ok(!hypno.includes('【你的偏好】'));
  assert.ok(!hypno.includes('弄醒了'), '催眠状态优先，不再写"被弄醒"');

  const asleep = buildTouchActionBlock({ actionKey: 'tickle', sleeping: true });
  assert.ok(asleep.includes('弄醒了'));
  assert.ok(asleep.includes('【你的耐受】'));

  const withHypnoBlock = buildTouchActionBlock({ actionKey: 'pat_head', hypnosisBlock: '<hypnosis_state>\n身体受控\n</hypnosis_state>' });
  assert.ok(withHypnoBlock.includes('</touch_action>\n\n<hypnosis_state>'), '调用方给的催眠块必须在我们的块之后');
  assert.ok(withHypnoBlock.endsWith('</hypnosis_state>'));
});

// ── G. 「即时反应」prompt 构造（AGENTS.md：JSON 必须给全示例） ────────────────

test('G. buildReactionPrompt：system/user 两条消息，JSON 示例与字段约束齐全', () => {
  const prompt = buildReactionPrompt({
    actionKey: 'pat_head', persona: '你是纳西妲，说话轻柔', characterName: '纳西妲', userName: 'Tester',
    emotionText: '心情很好、略微兴奋', likeRatio: 1.3, annoyance: 60,
    recentLines: ['Tester：在干什么', '纳西妲：翻甜点图鉴呢'],
  });
  assert.equal(prompt.label, '触摸即时反应');
  assert.equal(prompt.messages.length, 2);
  assert.equal(prompt.messages[0].role, 'system');
  assert.equal(prompt.messages[1].role, 'user');
  assert.equal(prompt.messages[0].content, prompt.system);
  assert.equal(prompt.messages[1].content, prompt.user);

  assert.ok(prompt.system.includes('你是纳西妲，说话轻柔'));
  assert.ok(prompt.system.includes('心情很好、略微兴奋'));
  assert.ok(prompt.system.includes('很受用'));
  assert.ok(prompt.system.includes('有点不耐烦了'));
  assert.ok(prompt.system.includes('只输出 JSON'));

  // JSON 示例四字段 + 每条约束（AGENTS.md「LLM 输出」节）
  for (const field of ['reaction_text', 'emotion_delta', 'facial_expression', 'annoyed']) {
    assert.ok(prompt.system.includes('"' + field + '"'), 'JSON 示例缺字段：' + field);
    assert.ok(prompt.system.includes('`' + field + '`'), '缺字段约束说明：' + field);
  }
  assert.ok(prompt.system.includes('"valence": 0.08'));
  assert.ok(prompt.system.includes('"害羞"'));

  assert.ok(prompt.user.includes('Tester 做了「摸头」'));
  assert.ok(prompt.user.includes('Tester伸手轻轻摸了摸你的头'));
  assert.ok(prompt.user.includes('Tester：在干什么'));
  assert.ok(prompt.user.includes('【场景】私聊'));
});

test('G. buildReactionPrompt：睡着 / 群聊围观 / 催眠 / 无人格 / 最近对话截断 / 未知动作', () => {
  const asleep = buildReactionPrompt({ actionKey: 'pinch_cheek', sleeping: true });
  assert.ok(asleep.system.includes('被这一下弄醒'));
  assert.ok(asleep.system.includes('未提供人格资料'), '没给 persona 要有显式占位');

  const group = buildReactionPrompt({ actionKey: 'hug', scene: 'group', groupPeek: true });
  assert.ok(group.system.includes('其他人看得到'));
  assert.ok(group.user.includes('【场景】群聊（其他人看得到）'));

  const noPeek = buildReactionPrompt({ actionKey: 'hug', scene: 'group' });
  assert.ok(!noPeek.system.includes('其他人看得到'));
  assert.ok(noPeek.user.includes('【场景】群聊'));

  const hypno = buildReactionPrompt({ actionKey: 'touch_breast', hypnosisBlock: '<hypnosis_state>完全控制</hypnosis_state>' });
  assert.ok(hypno.system.includes('<hypnosis_state>完全控制</hypnosis_state>'));

  const many = buildReactionPrompt({ actionKey: 'hug', recentLines: ['a', 'b', 'c', 'd', 'e', ''] });
  assert.equal((many.user.match(/^- /gm) || []).length, 4, '最多带 4 行最近对话');
  assert.ok(!many.user.includes('- a\n'), '截断保留最近 4 行');
  assert.ok(many.user.includes('- e'));

  const none = buildReactionPrompt({ actionKey: 'hug', recentLines: 'not-an-array' });
  assert.ok(none.user.includes('【最近两轮对话】（无）'));

  const bad = buildReactionPrompt({ actionKey: 'nope' });
  assert.deepEqual(bad, { system: '', user: '', messages: [], label: '触摸即时反应' });
});

// ── H. JSON 解析容错（专题 §2.1 / 验收 L1） ────────────────────────────────

test('H. parseReactionOutput：纯 JSON / 代码块包裹 / 前后夹话都能解析', () => {
  const plain = '{"reaction_text":"她缩了缩脖子。","emotion_delta":{"valence":0.08,"arousal":0.1,"dominance":-0.05},"facial_expression":"害羞","annoyed":true}';
  const fenced = '```json\n' + plain + '\n```';
  const chatty = '好的，这是她的反应：\n' + fenced + '\n希望符合要求！';
  for (const raw of [plain, fenced, chatty]) {
    const parsed = parseReactionOutput(raw);
    assert.equal(parsed.ok, true, '解析失败：' + raw.slice(0, 20));
    assert.equal(parsed.reactionText, '她缩了缩脖子。');
    assert.deepEqual(parsed.emotionDelta, { valence: 0.08, arousal: 0.1, dominance: -0.05 });
    assert.equal(parsed.facialExpression, '害羞');
    assert.equal(parsed.annoyed, true);
    assert.equal(parsed.error, '');
  }
});

test('H. parseReactionOutput：坏 JSON / 缺正文一律 ok:false（不写脏数据）', () => {
  for (const raw of ['', null, undefined, '不是 JSON', '{坏}', '{"reaction_text":""}', '{}', '[1,2,3]', '{"reaction_text":123}']) {
    const parsed = parseReactionOutput(raw);
    assert.equal(parsed.ok, false, '必须判失败：' + JSON.stringify(raw));
    assert.equal(parsed.reactionText, '');
    assert.equal(parsed.emotionDelta, null);
    assert.equal(parsed.annoyed, false);
    assert.ok(parsed.error.length > 0);
  }
  assert.equal(parseReactionOutput('不是 JSON').error, 'output is not valid JSON');
  assert.equal(parseReactionOutput('{}').error, 'missing reaction_text');
  assert.equal(extractReactionText('{"reaction_text":"她愣了一下。"}'), '她愣了一下。');
  assert.equal(extractReactionText('坏输出'), '');
});

test('H. parseReactionOutput：越界夹取 / 别名 / 缺 emotion_delta / 超长截断 / annoyed 只认 true', () => {
  const clamped = parseReactionOutput('{"reaction_text":"嗯。","emotion_delta":{"valence":9,"arousal":-9,"dominance":"x"},"facial_expression":"慌乱","annoyed":"yes"}');
  assert.deepEqual(clamped.emotionDelta, { valence: 1, arousal: -1, dominance: 0 });
  assert.equal(clamped.facialExpression, '慌乱');
  assert.equal(clamped.annoyed, false, '只认真正的 true');

  const noDelta = parseReactionOutput('{"reactionText":"略。","facialExpression":"无奈"}');
  assert.equal(noDelta.ok, true);
  assert.equal(noDelta.emotionDelta, null, '没给情绪增量就不给（调用方据此跳过 evolveEmotion）');
  assert.equal(noDelta.facialExpression, '无奈');

  const long = parseReactionOutput(JSON.stringify({ reaction_text: 'x'.repeat(500) }));
  assert.equal(long.reactionText.length, MAX_REACTION_CHARS);
  assert.equal(parseReactionOutput('   {"reaction_text":"  有空格的  "}   ').reactionText, '有空格的');
});

// ── I. 服务层契约（越界防线） ──────────────────────────────────────────────

test('I. 源码级：服务层零依赖、不碰 DB/routes/config，Lv3 看板映射留白', () => {
  const source = fs.readFileSync(new URL('../src/services/touchActionService.js', import.meta.url), 'utf8');
  assert.equal((source.match(/^import /gm) || []).length, 0, '服务层必须零 import（判定值由调用方传入）');
  assert.ok(!/require\(/.test(source), '不许用 require');
  assert.ok(!/from '`|from "`/.test(source), '不该有任何 from 子句');
  assert.ok(!/web-ui/.test(source), '服务层不该提到前端');
  assert.ok(!/antiRepetition/.test(source), '服务层不该出现 B1 写手的模块');
  // 允许注释里点名既有模块（那是接线说明），但**不许有任何 from/require 子句**把它拉进来
  assert.ok(!/(?:from|require\s*\()\s*['"][^'"]*(?:chat\.js|config\.js|db\/|emotionEngine|scheduleManager|intimateService|antiRepetition)/.test(source),
    '不该从别人占用的模块 import');
  // 2026-09-30 task-16：用户放权后 Lead 裁决"复用冻结管线、不新增 act_key" ⇒ 原"一律 null"的断言
  // 改为**钉住最终映射表**（它是防漂移的锚，不是"不许填"的守门）：Lv1/Lv2 一律 null，
  // Lv3 手部抚摸统一 hand（不借 breast=乳交 / thigh=素股 / anal=后庭 这些"另一种行为"的键），
  // 耳后吹气留 null（白名单无吹气/耳部语义，宁可不记也不硬凑）。
  assert.deepEqual(
    TOUCH_ACTIONS.filter(a => a.intimateActKey !== null).map(a => a.key + '=' + a.intimateActKey).sort(),
    [
      'finger_insert=hand', 'inner_thigh=hand', 'slap_face_light=hand', 'spank_butt=hand',
      'spank_thigh=hand', 'stroke_waist=hand', 'suck_nipple=oral',
      'touch_breast=hand', 'touch_butt=hand', 'touch_clit=hand', 'touch_nipple=hand',
      'touch_pussy=hand', 'touch_thigh=hand',
    ],
    '映射表（含 §十 Lv4 与击打类）：手部抚摸统一 hand、吮吸乳头 oral；排序后比对，顺序无关'
  );
  assert.deepEqual(
    TOUCH_ACTIONS.filter(a => a.level === 3 && a.intimateActKey === null).map(a => a.key),
    ['whisper_ear'],
    '给 Lv3 补映射前先确认白名单里真有语义对应的键；没有就继续留 null'
  );
  assert.ok(!/intimateActKey: '(?!hand'|oral')/.test(source), '只允许 hand（手部抚摸）与 oral（吮吸乳头）；借部位键会让看板数字说谎');
});

// ── J. 群聊成员限定行 + 事件新鲜度窗口（task-17 · 阶段二）────────────────────

test('J. scopeLine：群聊成员限定行插在块内第一行；不传时与改动前逐字节一致', () => {
  const scope = '【本节只对「甲」生效：以下所有"你"一律指甲，其它成员不受影响、也不知情】';
  const plain = buildTouchActionBlock({ actionKey: 'pat_head', userName: '阿远' });
  const scoped = buildTouchActionBlock({ actionKey: 'pat_head', userName: '阿远', scopeLine: scope });

  const plainLines = plain.split('\n');
  const scopedLines = scoped.split('\n');
  assert.equal(plainLines[0], '<touch_action>');
  assert.equal(scopedLines[0], '<touch_action>');
  assert.equal(scopedLines[1], scope, '限定行必须在开标签之后、正文之前');
  assert.deepEqual(scopedLines.slice(2), plainLines.slice(1), '除了多一行限定行，正文逐行一致');
  assert.ok(scoped.length <= MAX_TOUCH_BLOCK_CHARS);

  // 空串 / 空白 / undefined 都等于"没有限定行"（私聊口径）
  assert.equal(buildTouchActionBlock({ actionKey: 'pat_head', scopeLine: '' }), buildTouchActionBlock({ actionKey: 'pat_head' }));
  assert.equal(buildTouchActionBlock({ actionKey: 'pat_head', scopeLine: '   ' }), buildTouchActionBlock({ actionKey: 'pat_head' }));
  // 未知动作仍然零注入（有 scopeLine 也一样）
  assert.equal(buildTouchActionBlock({ actionKey: 'nope', scopeLine: scope }), '');
});

test('K. 出图档位：三态归一（默认 smart）+ 判定矩阵（含总开关）', () => {
  assert.equal(DEFAULT_TOUCH_IMAGE_MODE, 'smart', '用户裁决：默认智能');
  assert.deepEqual(TOUCH_IMAGE_MODE_LABELS, { always: '总是', smart: '智能', never: '从不' });
  assert.deepEqual(TOUCH_IMAGE_MODES, { ALWAYS: 'always', SMART: 'smart', NEVER: 'never' });

  // 归一：三态原样通过，脏值一律回落 smart
  for (const mode of ['always', 'smart', 'never']) assert.equal(normalizeTouchImageMode(mode), mode);
  for (const bad of [undefined, null, '', 'ALWAYS', 'sometimes', false, 0, {}, []]) {
    assert.equal(normalizeTouchImageMode(bad), 'smart', '非法值必须回落 smart: ' + JSON.stringify(bad));
  }

  const never = () => { throw new Error('从不档不该掷点'); };
  assert.equal(shouldGenerateTouchImage({ mode: 'never', level: 3, random: never }), false);
  assert.equal(shouldGenerateTouchImage({ mode: 'always', level: 1, random: never }), true, '总是档连 Lv1 都出图');

  // 智能档：Lv1 永不出图（概率表里没有 1），Lv2/Lv3 按概率
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 1, random: () => 0 }), false);
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0 }), true, '掷 0 必中');
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => SMART_IMAGE_CHANCE[2] }), false, '边界：等于概率值不算中');
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 2, random: () => 0.999 }), false);
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 3, random: () => 0 }), true);
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 3, random: () => SMART_IMAGE_CHANCE[3] }), false);
  assert.ok(SMART_IMAGE_CHANCE[3] > SMART_IMAGE_CHANCE[2], 'Lv3 比 Lv2 更容易出图');

  // 既有出图总开关关着 → 任何档位都不出
  assert.equal(shouldGenerateTouchImage({ mode: 'always', level: 3, enabled: false, random: never }), false);
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 3, enabled: false, random: () => 0 }), false);
});

test('K. 出图 prompt：画面提示覆盖全 16 动作 + 情绪/场景/外观拼接', () => {
  const actionKeys = TOUCH_ACTIONS.map(a => a.key).sort();
  assert.deepEqual(Object.keys(TOUCH_IMAGE_HINTS).sort(), actionKeys, '画面提示必须覆盖全集（防漏 / 防多）');
  for (const key of actionKeys) {
    assert.ok(TOUCH_IMAGE_HINTS[key].length > 5, '画面提示不能是空串: ' + key);
  }

  const prompt = buildTouchImagePrompt({
    actionKey: 'pat_head',
    appearance: '## 你的外观\n银色长发，蓝色眼睛',
    reactionText: '她缩了缩脖子。',
    annoyance: 0,
    scene: 'chat',
  });
  assert.ok(prompt.startsWith(TOUCH_IMAGE_HINTS.pat_head), '第一句是动作画面提示');
  assert.ok(prompt.includes('blushing'), '腻烦 fine 档 → 害羞画面情绪');
  assert.ok(prompt.includes('intimate private moment'), '私聊场景');
  assert.ok(prompt.includes('她缩了缩脖子。'), '反应原文带上（最多 60 字）');
  assert.ok(prompt.includes('银色长发'), '外观块由调用方传入');

  const groupPrompt = buildTouchImagePrompt({ actionKey: 'hug', scene: 'group' });
  assert.ok(groupPrompt.includes('faintly visible in the background'), '群聊场景与私聊区分');
  const annoyed = buildTouchImagePrompt({ actionKey: 'hug', annoyance: 100 });
  assert.ok(annoyed.includes('push his hand away'), '腻烦 refusing 档（>80）→ 拒绝画面情绪');
  assert.ok(annoyed.includes('intimate private moment'), '没传 scene 默认私聊场景');

  assert.equal(buildTouchImagePrompt({ actionKey: 'nope' }), '', '未知动作不拼 prompt');
  assert.equal(buildTouchImagePrompt({}), '');
  const long = buildTouchImagePrompt({ actionKey: 'hug', reactionText: 'x'.repeat(200) });
  assert.ok(!long.includes('x'.repeat(61)), '反应原文最多 60 字');
});

test('J. touchEventCutoff / isTouchEventFresh：30 分钟窗口，SQLite 无时区 UTC 串口径', () => {
  assert.equal(TOUCH_EVENT_TTL_MS, 30 * 60 * 1000);

  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(touchEventCutoff(now), '2026-09-30 11:30:00', '必须是 SQLite 无时区 UTC 串（可直接与 created_at 字符串比较）');
  assert.equal(touchEventCutoff(now, 5 * 60 * 1000), '2026-09-30 11:55:00', '窗口可覆盖');
  assert.equal(touchEventCutoff(now, 0), '2026-09-30 11:30:00', '非法窗口回落默认值');
  assert.equal(touchEventCutoff(now, -1), '2026-09-30 11:30:00');

  // 内存侧判定（群聊直接用它兜底；取不到时间 = 不新鲜）
  assert.equal(isTouchEventFresh('2026-09-30 11:45:00', now), true);
  assert.equal(isTouchEventFresh('2026-09-30T11:45:00Z', now), true, '带时区的 ISO 也认');
  assert.equal(isTouchEventFresh('2026-09-30 11:29:59', now), false, '刚好超窗口 → 不新鲜');
  assert.equal(isTouchEventFresh('2026-09-30 11:30:00', now), true, '边界取等号（与 SQL 的 >= 一致）');
  assert.equal(isTouchEventFresh('', now), false);
  assert.equal(isTouchEventFresh(null, now), false);
  assert.equal(isTouchEventFresh('not-a-date', now), false);
  assert.equal(isTouchEventFresh('2026-09-30 12:30:00', now), true, '未来时间（时钟漂移）不判过期');
});

// ── L. 对话式反应 prompt（task-30 反应喂料扩容）────────────────

test('L. buildConversationReactionPrompt：四块新喂料 + 8 条窗口 + 对话式口径 + 完整 JSON 示例', () => {
  const prompt = buildConversationReactionPrompt({
    actionKey: 'pat_head',
    persona: '她是安静的图书管理员',
    characterName: '阿黎',
    userName: '阿远',
    emotionText: '心情：平静',
    annoyance: 20,
    likeRatio: 1.2,
    // 零填充，避免 'MSG-1' 命中 'MSG-10' 这类子串误判
    recentLines: Array.from({ length: 10 }, (_, i) => 'MSG-' + String(i + 1).padStart(2, '0')),
    scene: 'chat',
    affinityBlock: '好感度 62/100（亲近）',
    scheduleBlock: '她正在【事务所】整理书架',
    intimateBlock: '【亲密档案】你们有过拥抱',
    hypnosisBlock: 'HYPNOSIS-BLOCK',
    recentSameAction: { minutesAgo: 1, count: 3 },
  });
  assert.equal(prompt.messages.length, 2);
  assert.ok(prompt.system.includes('图书管理员'), '人格仍在');
  // ① 四块新喂料都进了 system
  for (const marker of ['好感度 62/100', '事务所', '亲密档案', 'HYPNOSIS-BLOCK']) {
    assert.ok(prompt.system.includes(marker), '缺喂料: ' + marker);
  }
  // ② 窗口 = 最近 8 条（10 条里丢掉最早 2 条）
  assert.ok(prompt.user.includes('MSG-03'), '第 3 条应在窗口内');
  assert.ok(!prompt.user.includes('MSG-01') && !prompt.user.includes('MSG-02'), '更早的两条必须被裁掉');
  assert.equal(prompt.meta.rounds, 8);
  assert.deepEqual(prompt.meta.blocks, ['affinity', 'schedule', 'intimate', 'hypnosis']);
  // ③ 对话式口径：长度放开 + 允许接话/抛话 + 防连摸重复
  assert.ok(prompt.system.includes('1~4 句'), '长度放开到 1~4 句');
  assert.ok(prompt.system.includes('抛'), '允许结尾抛一句话引对话');
  assert.ok(prompt.system.includes('刚刚才'), '同一动作刚发生过 → 这一下回短一点');
  assert.ok(prompt.system.includes('顺着'), '允许顺着当前话题接话');
  // ④ JSON 示例按 AGENTS.md 给全（四个字段 + 只输出 JSON）
  for (const field of ['"reaction_text"', '"emotion_delta"', '"facial_expression"', '"annoyed"']) {
    assert.ok(prompt.system.includes(field), 'JSON 示例缺字段: ' + field);
  }
  assert.ok(prompt.system.includes('不要输出任何解释'), '必须要求只输出 JSON');
  assert.ok(prompt.system.includes('reaction_text'), '字段约束要写清楚');
});

test('L. buildConversationReactionPrompt：没有喂料块时不硬塞（blocks 空）+ 场景差异 + 未知动作零输出', () => {
  const bare = buildConversationReactionPrompt({ actionKey: 'hug', scene: 'group', groupPeek: true });
  assert.deepEqual(bare.meta.blocks, []);
  assert.equal(bare.meta.rounds, 0);
  assert.ok(!bare.system.includes('好感度'), '没给就不许出现');
  assert.ok(!bare.system.includes('【她此刻正在做的事】'));
  assert.ok(bare.user.includes('群聊'), '场景要写清');
  assert.ok(/被看见|别人看得到/.test(bare.system), '群聊要有被看见的顾虑');
  assert.ok(bare.user.includes('（无）') || bare.user.includes('最近'), '没有对话时给占位而不是空段');
  assert.equal(buildConversationReactionPrompt({ actionKey: 'nope' }).user, '', '未知动作零输出');
  assert.deepEqual(buildConversationReactionPrompt({ actionKey: 'nope' }).messages, []);
});

test('L. 快速版 buildReactionPrompt 保持原口径（不喂新块 / 窗口仍 4 条上限 / 仍是 1~2 句）', () => {
  const quick = buildReactionPrompt({ actionKey: 'hug', recentLines: Array.from({ length: 8 }, (_, i) => 'Q' + i) });
  assert.ok(!quick.system.includes('好感度'), '快速版不喂关系块');
  assert.ok(!quick.system.includes('1~4 句'), '快速版仍是 1~2 句');
  assert.ok(quick.user.includes('最近两轮对话'));
  assert.ok(!quick.user.includes('- Q0') && !quick.user.includes('- Q1') && !quick.user.includes('- Q2') && !quick.user.includes('- Q3'), '窗口仍是 4 条');
  assert.ok(quick.user.includes('- Q7'), '保留的是最近的');
});

// ── §十：深入触碰扩展（Lv4 私密 + 9 个动作）──────────────────────────────

test('§10.2 Lv4 十条动作：key / label / level / wakes / intimateActKey 全按表', () => {
  const EXPECTED = [
    ['touch_pussy', '摸私处', 'hand'],
    ['touch_clit', '摸阴蒂', 'hand'],
    ['finger_insert', '手指进入', 'hand'],
    ['touch_neck', '抚摸脖颈', null],      // §10.2：吻颈不落任何性行为白名单 ⇒ 最终值 null
    ['lick_neck', '舔颈', null],
    ['suck_nipple', '吮吸乳头', 'oral'],
    ['touch_nipple', '捏乳头', 'hand'],
    ['ear_nibble', '咬耳朵', null],
    ['inner_thigh', '抚摸大腿内侧', 'hand'],
    // 2026-10-02 击打类：**唯一一条 wakes 的 Lv4** —— §10.3 "Lv4 不唤醒"是给"私密抚摸"定的口径，
    // 而轻拍脸颊是击打类，物理上必然把她惊醒（与 Lv1 的捏脸/挠痒同档）。
    ['slap_face_light', '轻拍脸颊', 'hand', true],
  ];
  for (const [key, label, actKey, wakesOverride] of EXPECTED) {
    const action = getTouchAction(key);
    assert.ok(action, key + ' 必须存在');
    assert.equal(action.level, TOUCH_LEVELS.EXPLICIT, key + ' 必须是 Lv4');
    assert.equal(action.label, label, key + ' 的 label');
    assert.equal(action.intimateActKey, actKey, key + ' 的 intimateActKey');
    assert.equal(action.wakes, wakesOverride === true, key + ' 的 wakes（击打类要唤醒）');
    assert.ok(action.promptDesc && action.promptDesc.length >= 8, key + ' 要有玩家视角 promptDesc');
    assert.ok(action.emotionDelta.arousal >= 0.25 && action.emotionDelta.arousal <= 0.40, key + ' 的 arousal 应比 Lv3 更高一档');
    assert.ok(action.emotionDelta.dominance <= -0.10, key + ' 的 dominance 应更低（她更被动）');
  }
  assert.deepEqual(EXPECTED.map(([k]) => k).every(k => TOUCH_ACTION_KEYS.includes(k)), true);
  assert.equal(Object.keys(TOUCH_ACTION_MAP).length, 28, 'key 唯一、索引齐全');
});

test('§10.1 常量：Lv4 标签 / 门槛（2026-10-04 起 Lv4=0）/ 智能出图概率 / 拒绝文案', () => {
  assert.equal(TOUCH_LEVEL_LABELS[4], 'Lv4 私密');
  // 2026-10-04 用户裁决「Lv4 私密整档直接开放」⇒ 门槛 80 → 0。
  // ⚠️ 这条不是"放宽了测试"：后面 ⑨ 段专门钉住 **Lv2/Lv3 的门槛一个字都不许变**，
  //    放开 Lv4 的代价是被 Lv2/Lv3 的回归守卫换来的。
  assert.equal(DEFAULT_TOUCH_THRESHOLDS.lv4Affinity, 0, 'Lv4 私密整档直接开放（用户 2026-10-04 裁决）');
  assert.equal(DEFAULT_TOUCH_THRESHOLDS.lv3Affinity, 60, 'Lv3 门槛不许动');
  assert.equal(DEFAULT_TOUCH_THRESHOLDS.lv2Affinity, 40, 'Lv2 门槛不许动');
  // 2026-10-01：概率整表调高（0.25/0.5/0.6 → 0.5/0.75/0.9）——
  // 用户报「其他地方好像还是有限制」，点四下才出一张图观感就是被限。
  // 这里钉的是**新口径 + 单调性 + 边界语义**，不是历史数值。
  assert.equal(SMART_IMAGE_CHANCE[4], 0.9);
  assert.ok(SMART_IMAGE_CHANCE[4] > SMART_IMAGE_CHANCE[3], 'Lv4 出图概率比 Lv3 高一档');
  assert.ok(SMART_IMAGE_CHANCE[3] > SMART_IMAGE_CHANCE[2], 'Lv3 比 Lv2 高一档');
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 4, random: () => 0.89 }), true);
  assert.equal(shouldGenerateTouchImage({ mode: 'smart', level: 4, random: () => 0.9 }), false);
});

test('§10.1+§一③ Lv4 门控矩阵：2026-10-04 起「整档直接开放」，但睡着/群聊两道闸门仍在', () => {
  const base = { actionKey: 'touch_pussy', scene: 'chat', hypnotized: false, sleeping: false, intimateAuthorized: true };

  // ① **新口径**：零好感、未誓约、未授权 —— 一律放行（原先是 affinity_low_lv4 + 拒绝文案）
  let g = getTouchGate({ ...base, affinity: 0 });
  assert.equal(g.allowed, true, 'Lv4 不再吃好感门槛（用户：私密整档直接开放）');
  assert.equal(g.code, 'ok');
  assert.equal(getTouchGate({ ...base, affinity: 0, isOath: false }).allowed, true, '誓约不再是必要条件');
  // ② 未授权也放行：授权只对 Lv3 还生效（见 ⑨）
  g = getTouchGate({ ...base, affinity: 90, intimateAuthorized: false });
  assert.equal(g.allowed, true, 'Lv4 不再要求「亲密」授权');
  assert.equal(g.code, 'ok');
  // ③ 任意好感都放行（含边界 0 / 极大）
  for (const aff of [0, 1, 79, 80, 100]) {
    assert.equal(getTouchGate({ ...base, affinity: aff }).allowed, true, `affinity=${aff} 应放行`);
  }
  // ④ 睡着**仍然拦**（这条不在用户放开范围内）
  g = getTouchGate({ ...base, affinity: 90, sleeping: true });
  assert.equal(g.code, 'sleeping_blocked', '睡着仍拦 Lv4');
  // ⑤ 群聊：仍吃 `touchGroupAdult` 开关 —— 但该开关 **2026-10-04 起默认开**
  g = getTouchGate({ ...base, affinity: 90, scene: 'group', allowGroupAdult: false });
  assert.equal(g.code, 'group_adult_blocked', '开关**显式关掉**时照样拦（开关本身没被废掉）');
  g = getTouchGate({ ...base, affinity: 90, scene: 'group', allowGroupAdult: true });
  assert.equal(g.allowed, true, '开关打开后 Lv4 在群聊里放行');
  // ⑥ 催眠豁免：睡着 + 群聊 + 未授权 + 零好感，一律放行（用户：催眠的权限是最高的）
  g = getTouchGate({ actionKey: 'touch_pussy', affinity: 0, hypnotized: true, sleeping: true, scene: 'group', allowGroupAdult: false, intimateAuthorized: false });
  assert.equal(g.allowed, true);
  assert.equal(g.exempt, 'hypnosis');
  // ⑦ 阈值仍可被调用方覆盖（把 lv4Affinity 调回 50 时，50 才刚好过）
  assert.equal(getTouchGate({ ...base, affinity: 50, thresholds: { lv4Affinity: 50 } }).allowed, true);
  assert.equal(getTouchGate({ ...base, affinity: 49, thresholds: { lv4Affinity: 50 } }).allowed, false, '覆盖生效后低于阈值仍拦');

  // ⑧ **回归守卫（本次最重要的断言）**：Lv2 / Lv3 的门槛一个字都没被动
  assert.equal(getTouchGate({ actionKey: 'pat_head', affinity: 0 }).allowed, true, 'Lv1 无门槛');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 39 }).reason, 'affinity_low_lv2', 'Lv2 仍要 40');
  assert.equal(getTouchGate({ actionKey: 'kiss_cheek', affinity: 40 }).allowed, true, 'Lv2 到 40 放行');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 59, intimateAuthorized: true }).reason, 'affinity_low_lv3', 'Lv3 仍要 60');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 60, intimateAuthorized: true }).allowed, true, 'Lv3 门槛仍 60');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 90, intimateAuthorized: false }).reason, 'intimate_not_authorized', 'Lv3 仍要「亲密」授权');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 90, sleeping: true, intimateAuthorized: true }).code, 'sleeping_blocked', 'Lv3 睡着仍拦');
  assert.equal(getTouchGate({ actionKey: 'touch_breast', affinity: 90, scene: 'group', allowGroupAdult: true, intimateAuthorized: true }).allowed, true, '群聊 Lv3 仍受开关控制');
});

// ── 三期 §一① / §4.1：出图直白（image_prompt）+ 催眠耐受降级 ──────────────

test('§一① parseReactionOutput：提取 LLM 现写的 image_prompt（缺失 = 空串，走兜底）', () => {
  const out = parseReactionOutput(JSON.stringify({
    reaction_text: '她仰起头喘了口气。',
    image_prompt: 'she is lying back on the desk, skirt hiked up, his fingers between her thighs, flushed and gasping',
    emotion_delta: { valence: 0.1, arousal: 0.3, dominance: -0.1 },
    facial_expression: '羞耻',
    annoyed: false,
  }));
  assert.equal(out.ok, true);
  assert.match(out.imagePrompt, /lying back on the desk/, '要原样带出画面的英文描述');
  assert.equal(parseReactionOutput(JSON.stringify({ reaction_text: '只是文字' })).imagePrompt, '', '没给就是空串');
  assert.equal(parseReactionOutput(JSON.stringify({ reaction_text: 'x', image_prompt: 42 })).imagePrompt, '', '非字符串不认');
});

test('§一① buildTouchImagePrompt：优先用 image_prompt（图文同源），缺失才回落 TOUCH_IMAGE_HINTS', () => {
  const written = buildTouchImagePrompt({
    actionKey: 'touch_clit',
    imagePrompt: 'she is bent over the mirror stand, clothes pulled aside, trembling',
    appearance: 'silver long hair, white blouse',
  });
  assert.ok(written.startsWith('she is bent over the mirror stand'), '第一句必须是 LLM 现写的画面：' + written.slice(0, 60));
  assert.ok(!written.includes(TOUCH_IMAGE_HINTS.touch_clit), '写了就不再拼兜底模板');
  assert.ok(written.includes('silver long hair'), '外观块照旧拼在后面');
  const fallback = buildTouchImagePrompt({ actionKey: 'touch_clit' });
  assert.ok(fallback.startsWith(TOUCH_IMAGE_HINTS.touch_clit), '没写才回落模板');
  assert.equal(buildTouchImagePrompt({ actionKey: 'nope' }), '', '未知动作仍返回空串');
});

test('§一① 两个 builder 的 JSON 示例都带 image_prompt，并要求「直接描述正在发生什么」', () => {
  const prompts = [
    buildConversationReactionPrompt({ actionKey: 'touch_clit' }),
    buildReactionPrompt({ actionKey: 'touch_clit' }),
  ];
  for (const prompt of prompts) {
    assert.ok(prompt.system.includes('"image_prompt"'), 'JSON 示例必须有 image_prompt');
    assert.ok(/直接描述/.test(prompt.system), '要写明直接描述正在发生什么（不回避、不暗示性遮掩）');
    assert.ok(/英文/.test(prompt.system), '画面描述要用英文（生图模型吃英文）');
  }
});

test('§4.1② 催眠时耐受行降级：refusing 的「必须拍开手」被短路（两个 builder 一致）', () => {
  const dg = '（催眠中：耐受无效，身体无条件接受，情绪反应只走内心与台词）';
  for (const build of [buildConversationReactionPrompt, buildReactionPrompt]) {
    const hypno = build({ actionKey: 'touch_pussy', annoyance: 85, hypnotized: true });
    assert.ok(hypno.system.includes(dg), '催眠轮必须换成降级文案');
    assert.ok(!hypno.system.includes('这一下必须躲开或拍掉'), '降级后不许再出现「必须躲开或拍掉」');
    const normal = build({ actionKey: 'touch_pussy', annoyance: 85, hypnotized: false });
    assert.ok(!normal.system.includes('催眠中：耐受无效'), '非催眠轮不受影响');
  }
});
