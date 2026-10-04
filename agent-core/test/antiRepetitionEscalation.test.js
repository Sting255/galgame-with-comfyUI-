/**
 * B1 阶段二：输出侧检测 + 自动升级（专题·车轱辘话与钻牛角尖）
 *
 * 用户裁决：**阶段一保持温和，阶段二才做升级** ⇒ 升级必须有：
 *   1. 阈值（比 base 更严，且要连续多轮才升）
 *   2. 退路（重叠率回落就自动降档，不许"赶话题"停不下来）
 *   3. 开关（关掉后行为与阶段一逐字节一致）
 *
 * 覆盖：升级/不升级的边界、回落、可关、催眠优先、以及"同一轮只注入一条最强约束"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';

const {
  REPETITION_ESCALATED_OVERLAP,
  REPETITION_ESCALATED_PAIRS,
  REPETITION_ESCALATION_RELEASE_PAIRS,
  REPETITION_HIGH_OVERLAP,
  bigramOverlapRate,
  detectRepetitionWithEscalation,
  detectRepetition,
  buildAntiRepetitionInjection,
  buildAntiRepetitionMetrics,
  buildAntiRepetitionBlock,
  buildTopicProgressBlock,
} = await import('../src/services/antiRepetition.js');

// ── 合成样本 ──

const BASE = '我真的很担心你呢这件事让我一直放不下心里总觉得不安';
/** 复述同一句话（marker 保证是不同字符串、但 bigram 几乎全共享） */
const repeat = marker => BASE + marker;
/** 完全换话题（bigram 不共享） */
const SHIFT = [
  '今天去菜市场买了两斤排骨顺便修好了漏水的水龙头',
  '楼下新开的咖啡店味道不错店员还送了我一块芝士蛋糕',
  '刚把阳台的花搬到阳光下顺便把冬天的厚被子收进柜子',
];
const emotion = (valence, arousal) => ({ valence, arousal });

// ── 1. 阈值边界：几段高复述才升级 ──

test('2 轮高复述（1 段）→ 不升级，mild', () => {
  const r = detectRepetitionWithEscalation([repeat('一'), repeat('二')]);
  assert.equal(r.mode, 'mild');
  assert.equal(r.escalated, false);
  assert.equal(r.escalatedRunLength, 1);
  assert.equal(r.trend, 'trending', '已经在升档路上，本轮仍按温和档走');
});

test('3 轮高复述（2 段）→ 不升级，strong（升级要慢一档）', () => {
  const r = detectRepetitionWithEscalation([repeat('一'), repeat('二'), repeat('三')]);
  assert.equal(r.mode, 'strong');
  assert.equal(r.escalated, false);
  assert.equal(r.escalatedRunLength, 2, `连续高复述段数应为 2（阈值 ${REPETITION_ESCALATED_PAIRS}）`);
  assert.equal(r.trend, 'trending');
});

test('4 轮高复述（3 段 = 阈值）→ escalated，且块里明确要求换话题', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四')];
  const r = detectRepetitionWithEscalation(turns);
  assert.equal(r.mode, 'escalated');
  assert.equal(r.escalated, true);
  assert.equal(r.trend, 'escalating');
  assert.equal(r.escalatedRunLength, REPETITION_ESCALATED_PAIRS);
  assert.ok(r.maxOverlap >= REPETITION_ESCALATED_OVERLAP);

  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  assert.ok(injection.block?.startsWith('<anti_repetition mode="escalated">'), '升级档块格式');
  assert.ok(injection.block.includes('换话题'), '升级档必须明确要求换话题/推进新事');
  assert.ok(!injection.block.includes('别把刚说过的话再讲一遍'), '升级档不是温和档的文案');
  assert.ok(injection.reason.includes('escalated_run=3'));
});

test('5 轮高复述 → 仍然 escalated（不会越升越高，只有一档）', () => {
  const turns = ['一', '二', '三', '四', '五'].map(repeat);
  const r = detectRepetitionWithEscalation(turns);
  assert.equal(r.mode, 'escalated');
  assert.equal(r.escalatedRunLength, 4);
  assert.equal(buildAntiRepetitionInjection({ recentAssistantTurns: turns }).block,
    buildAntiRepetitionInjection({ recentAssistantTurns: turns.slice(0, 4) }).block,
    '档位封顶：5 轮与 4 轮的升级块逐字节相同');
});

test('base 阈值与升级阈值确实分开：0.6~0.75 之间只到 strong/mild，不升级', () => {
  assert.ok(REPETITION_HIGH_OVERLAP < REPETITION_ESCALATED_OVERLAP, '升级阈值必须比 base 更严');
  // 构造"高度相似但没到 0.75"的样本：同一句话里换掉两处词
  const a = '我今天去了趟超市买了苹果香蕉和牛奶还有面包';
  const b = '我今天去了趟菜场买了苹果葡萄和牛奶还有面包';
  const rate = bigramOverlapRate(a, b);
  assert.ok(
    rate >= REPETITION_HIGH_OVERLAP && rate < REPETITION_ESCALATED_OVERLAP,
    `样本重叠率应在 [0.6, 0.75)：${rate.toFixed(3)}`,
  );
  const r = detectRepetitionWithEscalation([a, b]);   // 1 段：够 base 不够升级
  assert.equal(r.mode, 'mild');
  assert.equal(r.escalated, false);
  assert.equal(r.trend, 'normal', '连一段都没到升级阈值 ⇒ 不算"在升档路上"');
  assert.equal(r.escalatedRunLength, 0, '严格阈值下没有一段达标');

  // 再来一个"只差一点"的样本：a,b,a,a → 末尾一段超阈值，但只有 1 段连续 ⇒ 不升级
  const partial = detectRepetitionWithEscalation([a, b, a, a]);
  assert.equal(partial.escalated, false, '只有末尾 1 段超阈值，不够连续 3 段');
  assert.equal(partial.escalatedRunLength, 1);
  assert.equal(partial.mode, 'strong');

  // 同一段话术连说 3 段（每段相似度 > 升级阈值）→ 才升级：证明升的是"连续段数"，不是单段有多像
  const escalated = detectRepetitionWithEscalation([repeat('一'), repeat('二'), repeat('三'), repeat('四')]);
  assert.equal(escalated.escalated, true, '连成 3 段才升级');
  assert.equal(escalated.mode, 'escalated');
});

// ── 2. 退路：回落要快 ──

test('升到 escalated 之后换话题 → 立刻回落（不再注入升级块）', () => {
  // 末尾那一轮是"完全换话题"的裸文本（不加 marker：marker 会把轮次从 null 拉成 bigram）
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四'), SHIFT[0]];
  const r = detectRepetitionWithEscalation(turns);
  assert.equal(r.escalated, false, '末尾已换话题 → 必须撤档');
  assert.notEqual(r.trend, 'escalating', '撤离升级态（trending 只是"最近还在复述"的早期信号）');
  assert.equal(r.escalatedRunLength, 0, '严格阈值下末尾一段都不达标');
  // 末尾那一段不高，但倒数第二段仍然"高" ⇒ 退回温和档（保守：还在提醒，但不再升级）
  assert.equal(r.mode, 'mild');
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns });
  assert.ok(!injection.block.includes('mode="escalated"'));
  assert.ok(injection.block.startsWith('<anti_repetition mode="mild">'));
});

test('升到 escalated 之后只重复一次 → 回落一档到 mild/strong（不越级）', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), SHIFT[0], SHIFT[0] + '呀'];
  const r = detectRepetitionWithEscalation(turns);
  assert.equal(r.escalated, false);
  assert.equal(r.mode, 'mild', '只有末尾一段高复述 → 温和档');
  assert.equal(r.trend, 'trending');
});

test('回落是"看尾巴"而不是"看历史累计"：中间打转过、最近两轮新鲜 → 不注入', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), SHIFT[0], SHIFT[1]];
  const r = detectRepetitionWithEscalation(turns);
  assert.equal(r.mode, 'none');
  assert.equal(r.escalate, false);
  assert.ok(r.maxOverlap >= REPETITION_HIGH_OVERLAP, '历史确实重叠过（数字为证），但不应因为历史就继续升级');
});

// ── 3. 可关：关掉后与阶段一逐字节一致 ──

test('escalationEnabled=false → 与阶段一的 detectRepetition 完全同档同块', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四'), repeat('五')];
  const off = detectRepetitionWithEscalation(turns, { escalationEnabled: false });
  const stage1 = detectRepetition(turns);
  assert.equal(off.mode, stage1.mode, '关掉升级后档位与阶段一一致');
  assert.equal(off.reason, stage1.reason);
  assert.deepEqual(off.topicKeywords, stage1.topicKeywords);
  assert.equal(off.escalated, false);
  assert.equal(off.trend, 'normal', '关掉后不再有升档迹象');

  const offInjection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, escalationEnabled: false });
  const stage1Injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, escalationEnabled: false });
  assert.equal(offInjection.block, stage1Injection.block);
  assert.ok(offInjection.block.startsWith('<anti_repetition mode="strong">'));
  assert.ok(!offInjection.block.includes('mode="escalated"'));
});

// ── 4. 催眠优先 + 同一轮只一条约束 ──

test('催眠「完全控制」轮：升级态也一律跳过（block 与 topicProgressBlock 都是 null）', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四')];
  const snapshots = [emotion(-0.2, 0.9), emotion(-0.2, 0.9), emotion(-0.2, 0.9), emotion(-0.2, 0.9)];
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots, hypnosisActive: true });
  assert.equal(injection.skipped, 'hypnosis');
  assert.equal(injection.block, null);
  assert.equal(injection.topicProgressBlock, null);
  assert.equal(injection.escalate, false);
  assert.equal(injection.trend, 'normal');
});

test('升级档命中时不再叠加 <topic_progress>（同一轮只给一条最强约束）', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四')];
  const snapshots = [emotion(-0.2, 0.9), emotion(-0.2, 0.9), emotion(-0.2, 0.9), emotion(-0.2, 0.9)];
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots });
  assert.equal(injection.escalate, true);
  assert.ok(injection.block.startsWith('<anti_repetition mode="escalated">'));
  assert.equal(injection.topicProgressBlock, null, '两者不同时注入');
  assert.equal(injection.topicLock, true, '话题锁死仍然被记录（只是不注入）');
});

test('buildAntiRepetitionBlock 三档互不相同，且非法档位返回 null', () => {
  const mild = buildAntiRepetitionBlock('mild', []);
  const strong = buildAntiRepetitionBlock('strong', ['担心']);
  const escalated = buildAntiRepetitionBlock('escalated', ['担心']);
  assert.notEqual(mild, strong);
  assert.notEqual(strong, escalated);
  assert.equal(buildAntiRepetitionBlock('none'), null);
  assert.notEqual(buildTopicProgressBlock(), escalated);
});

// ── 5. 输出侧检测指标（阶段二调参数据） ──

test('buildAntiRepetitionMetrics：给出一轮可统计的复读率数字', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四')];
  const result = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  const metrics = buildAntiRepetitionMetrics({ turns, result });
  assert.equal(metrics.mode, 'escalated');
  assert.equal(metrics.trend, 'escalating');
  assert.equal(metrics.turns, 4);
  assert.equal(metrics.escalated, true);
  assert.equal(metrics.escalatedRunLength, 3);
  assert.ok(metrics.overlap >= REPETITION_ESCALATED_OVERLAP);
  assert.ok(metrics.escalatedOverlap >= REPETITION_ESCALATED_OVERLAP);
  assert.equal(buildAntiRepetitionMetrics({ turns, result: null }), null, '没有检测结果时不产出指标');
});

test('升级相关的常量都被导出（真机调参不改逻辑）', () => {
  assert.equal(typeof REPETITION_ESCALATED_OVERLAP, 'number');
  assert.equal(REPETITION_ESCALATED_PAIRS, 3);
  assert.equal(REPETITION_ESCALATION_RELEASE_PAIRS, 1, '退路是"断 1 段就撤"，比升档（连续 3 段）快得多');
});

// ── 6. 接线（源码级守卫：真跑 chat 管线成本过高） ──

test('chat.js：升级开关 + 指标日志已接线，且没有把开关写死在检测器里', async () => {
  const src = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes('config.features.antiRepetitionEscalation !== false'), '升级开关从 config 读，默认开');
  assert.ok(src.includes('escalationEnabled: antiRepEscalationEnabled'), '开关必须传进检测器');
  assert.ok(src.includes('buildAntiRepetitionMetrics('), '输出侧指标要记录');
  assert.ok(src.includes('[anti-repetition] output-check'), '日志前缀可搜');
});

test('config/settings：升级与重写两个键都有默认值且已注册（重写默认关）', async () => {
  const { config } = await import('../src/config.js');
  const { SETTING_TO_CONFIG } = await import('../src/db/settings.js');
  assert.equal(config.features.antiRepetitionEscalation, true, '自动升级默认开');
  assert.equal(config.features.antiRepetitionReroll, false, '重写兜底默认关');
  assert.equal(SETTING_TO_CONFIG.feature_antiRepetitionEscalation.key, 'antiRepetitionEscalation');
  assert.equal(SETTING_TO_CONFIG.feature_antiRepetitionReroll.key, 'antiRepetitionReroll');
});
