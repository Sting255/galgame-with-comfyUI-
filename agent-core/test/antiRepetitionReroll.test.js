/**
 * D2 · 反重复「重写兜底」(reroll) 的判定层（2026-09-30）
 *
 * 用户裁决：默认**关**；打开后，一轮生成结束若检测到「仍在复读」且达到既有升级/强档阈值，
 * **重写一次**（多一次真实 LLM 调用）。
 *
 * 本文件覆盖**判定层**（纯函数 + 源码接线守卫）：
 *   · 关 = 零变化（不触发、不追加指令、不发事件）
 *   · 开 + 达到阈值 = 触发一次
 *   · 已经重写过 = 不再触发（不连环，防打爆额度）
 *   · 催眠「完全控制」轮 / 检测器没给结论 / 客户端已断开 = 不触发
 * 调用点行为（替换事件形状、失败保留原文）在 chat.js 里，由源码级守卫钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error('reroll fixture forbids network: ' + url); };

const {
  shouldReroll, buildRerollInstruction, buildReplaceLastAssistantEvent,
  REPETITION_REROLL_MAX_ATTEMPTS,
} = await import('../src/services/antiRepetition.js');

const strongResult = { mode: 'strong', escalate: false, topicKeywords: ['担心'], block: '<x/>' };
const escalatedResult = { mode: 'escalated', escalate: true, topicKeywords: ['担心'], block: '<x/>' };
const mildResult = { mode: 'mild', escalate: false, topicKeywords: [], block: '<x/>' };
const noneResult = { mode: 'none', escalate: false, topicKeywords: [], block: null };

// ── 1. 开关：关 = 零变化 ──

test('默认关：任何档位都不触发（逐字节零变化）', () => {
  for (const result of [strongResult, escalatedResult, mildResult, noneResult]) {
    const decision = shouldReroll({ enabled: false, result });
    assert.equal(decision.fire, false, '关着时连 strong/escalated 也不许触发');
    assert.equal(decision.reason, 'disabled');
    assert.equal(decision.instruction, null, '不触发就不产生指令块');
  }
});

test('开关缺省（undefined）按关处理', () => {
  assert.equal(shouldReroll({ result: strongResult }).fire, false);
  assert.equal(shouldReroll({ result: strongResult }).reason, 'disabled');
});

// ── 2. 触发条件：开 + 达到既有阈值 ──

test('开 + strong ⇒ 触发一次（复用既有档位，不新造检测器）', () => {
  const decision = shouldReroll({ enabled: true, result: strongResult });
  assert.equal(decision.fire, true);
  assert.equal(decision.reason, 'repetition_strong');
  assert.ok(decision.instruction.includes('<anti_repetition_rewrite>'), '要带重写指令块');
  assert.ok(decision.instruction.includes('担心'), '指令里点名她刚复述的话题，便于真正换方向');
  assert.equal(decision.maxAttempts, REPETITION_REROLL_MAX_ATTEMPTS);
});

test('开 + escalated ⇒ 同样触发（升级档也算仍在复读）', () => {
  const decision = shouldReroll({ enabled: true, result: escalatedResult });
  assert.equal(decision.fire, true);
  assert.equal(decision.reason, 'repetition_escalated');
});

test('开 + mild ⇒ 不触发（阶段一保持温和，用户裁决）', () => {
  const decision = shouldReroll({ enabled: true, result: mildResult });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'below_threshold');
  assert.equal(decision.instruction, null);
});

test('开 + none（本轮没复读）⇒ 不触发', () => {
  const decision = shouldReroll({ enabled: true, result: noneResult });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'below_threshold');
});

test('开但没有检测结果（检测失败/关闭）⇒ 不触发', () => {
  const decision = shouldReroll({ enabled: true, result: null });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'no_result');
});

// ── 3. 不连环：一轮只重写一次 ──

test('已经重写过一次 ⇒ 绝不再触发（防连环重试打爆额度）', () => {
  const first = shouldReroll({ enabled: true, result: strongResult, firedCount: 0 });
  assert.equal(first.fire, true, '第一次允许');
  const second = shouldReroll({ enabled: true, result: strongResult, firedCount: 1 });
  assert.equal(second.fire, false, '同一轮第二次必须拒绝');
  assert.equal(second.reason, 'already_rerolled');
  assert.equal(second.instruction, null);
  assert.equal(shouldReroll({ enabled: true, result: escalatedResult, firedCount: 5 }).fire, false);
});

test('maxAttempts 常量 = 1（口径写死在常量里，改它就等于改口径）', () => {
  assert.equal(REPETITION_REROLL_MAX_ATTEMPTS, 1);
});

// ── 4. 与催眠 / 客户端断开的优先关系 ──

test('开 + strong，但本轮是催眠完全控制轮 ⇒ 不触发', () => {
  const decision = shouldReroll({ enabled: true, result: strongResult, hypnosisActive: true });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'hypnosis');
});

test('开 + strong，但客户端已断开 ⇒ 不触发（不再花一次调用）', () => {
  const decision = shouldReroll({ enabled: true, result: strongResult, clientGone: true });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'client_gone');
});

// ── 5. 指令块与替换事件形状 ──

test('重写指令块：明确要求从头换一种说法，并禁止衔接旧输出', () => {
  const block = buildRerollInstruction(['担心', '不安']);
  assert.ok(block.startsWith('<anti_repetition_rewrite>'), '块标签固定，便于 grep');
  assert.ok(block.endsWith('</anti_repetition_rewrite>'));
  assert.ok(block.includes('担心') && block.includes('不安'), '点出复述过的词');
  assert.ok(/重新|换一种/.test(block), '要说清这是重写');
  assert.ok(!block.includes('undefined'));
  const fallback = buildRerollInstruction([]);
  assert.ok(fallback.includes('刚才'), '没有话题词时用兜底措辞');
});

test('替换事件形状固定：replace_last_assistant + content/segments/reason/turn', () => {
  const parsed = [
    { content: '第一句', emojiKeys: [], stickerUrls: [], images: [] },
    // 表情段：key 只做诊断，stickerUrls 才是前端渲染用的 url（与前端 sticker_images 里的 url 同源）
    { content: '', emojiKeys: ['sticker_1'], stickerUrls: ['/stickers/1.png'], images: ['/stickers/1.png'] },
    { content: '', emojiKeys: [], stickerUrls: [], images: ['/img/a.png'] },
  ];
  const payload = buildReplaceLastAssistantEvent({ parsedSegments: parsed, reason: 'reroll' });
  assert.equal(payload.event, 'replace_last_assistant');
  assert.equal(payload.data.content, '第一句', 'content 是所有文本段拼起来（前端简单路径）');
  assert.deepEqual(payload.data.segments, [
    { content: '第一句', emojiKeys: [], stickerUrls: [], images: [] },
    { content: '', emojiKeys: ['sticker_1'], stickerUrls: ['/stickers/1.png'], images: ['/stickers/1.png'] },
    { content: '', emojiKeys: [], stickerUrls: [], images: ['/img/a.png'] },
  ], 'segments 保留逐气泡的文本/表情/图片（含 stickerUrls 渲染 url），替换后不丢表情包与图片');
  // 调用点没显式给 stickerUrls 时，回落到 images（parseEmojiText 的 images 就是命中表情的 url）
  const legacy = buildReplaceLastAssistantEvent({ parsedSegments: [{ content: '', emojiKeys: ['k'], images: ['/stickers/legacy.png'] }] });
  assert.deepEqual(legacy.data.segments[0].stickerUrls, ['/stickers/legacy.png'], '缺 stickerUrls 时回落 images');
  const none = buildReplaceLastAssistantEvent({ parsedSegments: [{ content: 'x', emojiKeys: [] }] });
  assert.deepEqual(none.data.segments[0].stickerUrls, [], '完全没给 = 空数组 = 这轮没换表情（前端保持原样）');
  assert.equal(payload.data.reason, 'reroll');
  assert.equal(typeof payload.data.turn, 'number', 'turn 供前端校验替换的是本轮');
  assert.ok(payload.data.turn > 0);
});

test('替换事件：空输入也安全（不抛错、segments 为空数组）', () => {
  const payload = buildReplaceLastAssistantEvent({ parsedSegments: [], reason: 'reroll' });
  assert.equal(payload.data.content, '');
  assert.deepEqual(payload.data.segments, []);
});

// ── 7. 设置开关的落库往返（用户点名"开关放到设置里"） ──

test('设置键 feature_antiRepetitionReroll 往返：写 true/false 都能装回 config.features', async () => {
  const { setSetting, loadSystemSettings } = await import('../src/db/settings.js');
  const { getDb } = await import('../src/db/index.js');
  const { config } = await import('../src/config.js');
  const db = getDb();

  setSetting('feature_antiRepetitionReroll', 'true');
  loadSystemSettings(db);
  assert.equal(config.features.antiRepetitionReroll, true, '打开后必须落到 config.features（后端才看得到）');

  setSetting('feature_antiRepetitionReroll', 'false');
  loadSystemSettings(db);
  assert.equal(config.features.antiRepetitionReroll, false, '关掉后同样要落回 false');

  // 收尾：别把这个开关留在内存里影响别的用例
  config.features.antiRepetitionReroll = false;
});
// ── 6. 源码级接线守卫（真跑 chat 管线成本过高） ──

test('源码级：chat.js 的 reroll 接线（开关/只重写一次/事件名/日志）', async () => {
  const src = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes('antiRepetitionReroll === true'), '开关要从 config.features.antiRepetitionReroll 读（默认关）');
  assert.ok(src.includes('shouldReroll({'), '必须走判定函数，不在调用点自己写条件');
  assert.ok(src.includes('buildRerollInstruction('), '重写时要追加指令块');
  assert.ok(src.includes('buildReplaceLastAssistantEvent(') && src.includes('send(replacement.event, replacement.data)'),
    '必须向后端→前端发替换事件（走 buildReplaceLastAssistantEvent + send(event, data)）');
  assert.ok(src.includes('[anti-repetition] reroll fired'), '日志要能看出真的重写过');
  assert.ok(src.includes('[anti-repetition] reroll failed'), '失败只 warn，可 grep');
  assert.ok(src.includes('antiRepRerollFired += 1'), '必须记录已重写（保证一轮只重写一次）');
  assert.ok(src.includes('antiRepRerollFired: 0') === false && /let antiRepRerollFired = 0/.test(src), '计数器要初始化在调用点作用域内');
});

test('源码级：替换事件只在重写成功后发（失败保留原文）', async () => {
  const src = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  const idx = src.indexOf('send(replacement.event, replacement.data)');
  assert.ok(idx > 0, '找不到替换事件');
  const region = src.slice(Math.max(0, idx - 800), idx + 200);
  assert.ok(/rerollSucceeded|rerollOk|rerolledContent/.test(region),
    '替换事件必须在重写成功的分支里发（失败时不能替换，否则用户看到空）');
});
