/**
 * 反重复 / 反钻牛角尖检测器单测（专题·车轱辘话与钻牛角尖 · 阶段一）
 *
 * 验收口径（专题 §六）：
 *   3 轮高重叠 → strong；2 轮轻微 → mild；无重叠 → null；催眠轮 → null。
 * 额外钉住：话题词排除程序时间/日程词、查库助手与活跃窗口同口径（id > sinceRawId + 催眠遗忘窗口）。
 *
 * 全部样本是合成文本，不依赖真实库、不联网（DB 用 :memory:）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`antiRepetition fixture forbids network: ${url}`); };

const {
  REPETITION_HIGH_OVERLAP,
  detectRepetition,
  detectTopicLock,
  buildAntiRepetitionInjection,
  buildAntiRepetitionBlock,
  buildTopicProgressBlock,
  buildRecentSelfOutputNote,
  shouldInjectRecentSelfOutputNote,
  formatAntiRepetitionLog,
  bigramOverlapRate,
  bigramsOf,
  consecutiveOverlaps,
  extractTopicKeywords,
  isEmotionExtremeHeld,
  isCurrentEmotionExtreme,
  cleanTurnText,
  cleanTurnTextFlat,
  fetchRecentAssistantTurns,
  fetchRecentEmotionSnapshots,
  TIME_SCHEDULE_WORDS,
} = await import('../src/services/antiRepetition.js');

// ── 合成样本工具 ──

/** 同一段话术的多轮变体：bigram 几乎全共享（真机里的「车轱辘话」形状） */
const REPEAT_BASES = {
  a: '我真的很担心你呢这件事让我一直放不下心里总觉得不安',
  b: '我也说不清楚为什么会这样就是觉得心里堵得慌难受',
  c: '你别太勉强自己了我会一直在你旁边陪着你的放心',
};
const repeatTurn = (base, marker) => `${REPEAT_BASES[base]}${marker}`;

/** 话题完全不同（连 bigram 都不共享）的轮次 */
function shiftTurn(base, marker) {
  const pools = {
    a: '今天去菜市场买了两斤排骨顺便修好了漏水的水龙头',
    b: '楼下新开的咖啡店味道不错店员还送了我一块芝士蛋糕',
    c: '刚把阳台的花搬到阳光下顺便把冬天的厚被子收进柜子',
  };
  return `${pools[base]}${marker}`;
}

/** 情绪快照：VAD 时间升序 */
const emotion = (valence, arousal) => ({ valence, arousal });

// ── 1. 车轱辘话两档 + 不注入 ──

test('3 轮高重叠 → strong，块里点名话题词', () => {
  const turns = [repeatTurn('a', '一'), repeatTurn('a', '二'), repeatTurn('a', '三')];
  const result = detectRepetition(turns);
  assert.equal(result.mode, 'strong', '最近 3 轮都在同一话题上应判强档');
  assert.ok(result.maxOverlap >= REPETITION_HIGH_OVERLAP, `maxOverlap=${result.maxOverlap} 应 ≥ ${REPETITION_HIGH_OVERLAP}`);
  assert.ok(result.topicKeywords.length > 0, '强档应能点出话题词');

  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  assert.equal(injection.mode, 'strong');
  assert.ok(injection.block?.includes('<anti_repetition mode="strong">'), '应产出强档块');
  assert.ok(injection.block.includes(result.topicKeywords[0]), '强档块必须点名话题词');
  assert.ok(injection.block.includes('不要再提'), '强档块必须给出禁止再谈的约束');
  assert.equal(injection.topicProgressBlock, null, '情绪未到极值时不该注入 <topic_progress>');
});

test('2 轮高重叠 → mild（温和档，不点名话题）', () => {
  const turns = [repeatTurn('a', '一'), repeatTurn('a', '二')];
  const result = detectRepetition(turns);
  assert.equal(result.mode, 'mild', '只有两轮时最高只能到温和档');
  assert.ok(result.maxOverlap >= REPETITION_HIGH_OVERLAP);

  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  assert.ok(injection.block.startsWith('<anti_repetition mode="mild">'), '温和档块格式');
  assert.ok(injection.block.includes('别把刚说过的话再讲一遍'));
  assert.equal(injection.topicKeywords.length, 0, '温和档不点名话题词（无法确定单一话题）');
});

test('3 轮两次换话题 → null（不注入，零 token）', () => {
  const turns = [shiftTurn('a', '一'), shiftTurn('b', '二'), shiftTurn('c', '三')];
  const result = detectRepetition(turns);
  assert.equal(result.mode, 'none');
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  assert.equal(injection.block, null, '无重叠必须不产生任何注入');
  assert.equal(injection.topicProgressBlock, null);
});

test('只有 1 轮 / 空输入 → none（首轮注入会无意义地花 token）', () => {
  assert.equal(detectRepetition([repeatTurn('a', '一')]).mode, 'none');
  assert.equal(detectRepetition([]).mode, 'none');
  assert.equal(detectRepetition(undefined).mode, 'none');
  const injection = buildAntiRepetitionInjection({});
  assert.equal(injection.block, null);
  assert.equal(injection.reason, 'not_enough_turns');
});

test('大段完全不同的长文本不会因「都用汉字」被误判', () => {
  const a = '医院走廊的灯白得刺眼我坐在长椅上等叫号手心全是汗';
  const b = '上周公司团建去爬山我第一个登顶还在山顶拍了很多照片';
  assert.ok(bigramOverlapRate(a, b) < REPETITION_HIGH_OVERLAP, '不同话题的重叠率必须低于阈值');
});

// ── 2. 催眠轮跳过 ──

test('催眠「完全控制」轮 → 跳过注入（mode 保留、block 为 null、skipped=hypnosis）', () => {
  const turns = [repeatTurn('a', '一'), repeatTurn('a', '二'), repeatTurn('a', '三')];
  const injection = buildAntiRepetitionInjection({
    recentAssistantTurns: turns,
    emotionSnapshots: [emotion(0.9, 0.9), emotion(0.9, 0.9), emotion(0.9, 0.9), emotion(0.9, 0.9)],
    hypnosisActive: true,
  });
  assert.equal(injection.skipped, 'hypnosis');
  assert.equal(injection.block, null, '完全控制态下不允许注入反重复块（她要照指令重复执行）');
  assert.equal(injection.topicProgressBlock, null, '也不允许注入反钻牛角尖块');
  assert.equal(injection.reason, 'hypnosis_full_control');
});

// ── 3. 钻牛角尖 ──

test('日志契约：reason 里的话题锁标签只能出现一次（独立验证者报的拼接瑕疵）', () => {
  const BASE = '我真的很担心你呢这件事让我一直放不下心里总觉得不安';
  const turns = [BASE + '一', BASE + '二', BASE + '三', BASE + '四'];
  const single = [{ valence: 0.7, arousal: 0.9 }];

  // 【红】修复前这里得到 'consecutive_high=3 + current_extreme current_extreme(duration_turns=4/need=4)'
  // —— tag 与"自带前缀的 lock.reason"直接相接。判定与注入块逐字节未变，只脏了日志可读性；
  // 旧断言只做 includes 所以漏掉了，改成精确断言。
  const injection = buildAntiRepetitionInjection({
    recentAssistantTurns: turns,
    emotionSnapshots: single,
    escalationEnabled: false,
  });
  assert.equal(
    injection.reason,
    'consecutive_high=3 + current_extreme(duration_turns=4/need=4)',
    'reason 必须是「车轱辘话理由 + 话题锁理由」各一份，标签不得重复',
  );
  const occurrences = (injection.reason.match(/current_extreme/g) || []).length;
  assert.equal(occurrences, 1, `current_extreme 标签只能出现一次，实际=${injection.reason}`);

  // 纯话题锁（没有车轱辘话理由）时保持 lock.reason 原样，不加 tag
  const lock = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: single });
  assert.equal(lock.reason, 'current_extreme(duration_turns=4/need=4)');
});

test('当前情绪极值 + 话题锁死 4 轮 → <topic_progress>（阶段一档位：关掉升级）', () => {
  const turns = [repeatTurn('b', '一'), repeatTurn('b', '二'), repeatTurn('b', '三'), repeatTurn('b', '四')];
  // ⚠️ task-23（P0-1）：真实存储里 emotion_snapshots 每会话只有**一行**，
  // 所以现在只看"当前这一行是否极值"，持续性由文本侧（上面 4 轮）证明。
  const snapshots = [emotion(-0.2, 0.9)];
  assert.equal(isEmotionExtremeHeld(snapshots), true, 'A=0.9 即便只有一行也算贴着极值');
  assert.equal(isCurrentEmotionExtreme(snapshots[0]), true);

  // 阶段二默认会把"连续 4 轮高复述"升档成 escalated；这条测试要验的是**阶段一的** <topic_progress>
  // 口径，因此显式关掉升级（等价于阶段一行为）。
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots, escalationEnabled: false });
  assert.equal(injection.escalate, false);
  assert.equal(injection.topicLock, true);
  assert.equal(injection.topicProgressBlock, buildTopicProgressBlock());
  assert.ok(injection.topicProgressBlock.includes('<topic_progress>'));
  assert.ok(injection.topicProgressBlock.includes('往前'));
  assert.equal(injection.block, null, 'topic_progress 命中时不再叠加 <anti_repetition>');
});

test('情绪极值但话题换了 → 不判钻牛角尖', () => {
  const turns = [shiftTurn('a', '一'), shiftTurn('b', '二'), shiftTurn('c', '三'), shiftTurn('a', '四')];
  const snapshots = [emotion(0.9, 0.5), emotion(0.9, 0.5), emotion(0.9, 0.5), emotion(0.9, 0.5)];
  const lock = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: snapshots });
  assert.equal(lock.locked, false);
  assert.equal(lock.reason, 'current_extreme(topic_changed=1/need=4)');
  assert.equal(lock.mode, 'private');
});

test('强档遇到「只复述日程」的话题词 → 退回不点名的兜底措辞', () => {
  const turns = [
    '已经这么晚了，明天早上还要早起，早点睡吧',
    '已经这么晚了，明天早上还要早起，早点睡吧呢',
    '已经这么晚了，明天早上还要早起，早点睡吧啊',
  ];
  // 阶段一档位（3 轮 = 2 段高复述 → strong）；这里验的是"无论哪一档都不点日程词"
  const result = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  assert.equal(result.mode, 'strong');
  assert.deepEqual(result.topicKeywords, [], '时间/日程词不当话题词点名');
  assert.ok(result.block.includes('刚才那个话题'), '没有可用话题词时用兜底措辞');
  assert.ok(result.reason.includes('keywords_time_schedule_only'));

  // 关掉升级 → 回到阶段一的 strong 档，同样不点日程词
  const base = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [], escalationEnabled: false });
  assert.equal(base.mode, 'strong');
  assert.deepEqual(base.topicKeywords, []);
  assert.ok(base.block.includes('刚才那个话题'), '强档同样用兜底措辞');
});

test('情绪快照比轮次多时按「最新对齐」截断（两张表行数不保证相等）', () => {
  const turns = [repeatTurn('b', '一'), repeatTurn('b', '二'), repeatTurn('b', '三'), repeatTurn('b', '四')];
  // 6 条快照，最后 1 条是极值；旧口径会去对齐"最近 4 条"，新口径只看**当前（最新）一行**
  const snapshots = [emotion(0.5, 0.5), emotion(0.5, 0.5), emotion(0.1, 0.9), emotion(0.1, 0.9), emotion(0.1, 0.9), emotion(0.5, 0.4)];
  const lock = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: snapshots });
  assert.equal(lock.locked, false, '最新一行已回到中间区间 ⇒ 不算"当前处于极值"');
  assert.equal(lock.reason, 'current_emotion_not_extreme');

  // 历史再多也不能替代"当前"：最后一行是极值才判
  const snapshots2 = [...snapshots.slice(0, 5), emotion(0.1, 0.9)];
  const lock2 = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: snapshots2 });
  assert.equal(lock2.locked, true, '当前（最新）一行极值 + 4 轮同话题 ⇒ 锁死');
});

test('当前情绪不极端 → 不判钻牛角尖（哪怕文本连着 4 轮在复述）', () => {
  const turns = [repeatTurn('b', '一'), repeatTurn('b', '二'), repeatTurn('b', '三'), repeatTurn('b', '四')];
  const middle = [emotion(0.5, 0.5)];   // V/A 都在中间区间
  assert.equal(isCurrentEmotionExtreme(middle[0]), false);
  const lock = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: middle });
  assert.equal(lock.locked, false);
  assert.equal(lock.reason, 'current_emotion_not_extreme');
});

test('文本侧只有 3 轮（不足 4 轮）→ 不判钻牛角尖（持续时间由文本侧证明）', () => {
  const turns = [repeatTurn('b', '一'), repeatTurn('b', '二'), repeatTurn('b', '三')];
  const extreme = [emotion(-0.2, 0.9)];
  const lock = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: extreme });
  assert.equal(lock.locked, false, '时间没到"锁死"的程度');
  assert.equal(lock.reason, 'current_extreme(not_enough_turns=3/need=4)');
});

test('历史型辅助 isEmotionExtremeHeld：给几行看几行（不再要求"必须有 4 行"）', () => {
  // 这是缺陷的直接根因：旧实现 rows.length < 4 直接 false ⇒ 单行/少行在真实存储里永不成立。
  assert.equal(isEmotionExtremeHeld([emotion(0.1, 0.9)]), true, '单行极值也要成立');
  assert.equal(isEmotionExtremeHeld([emotion(0.1, 0.9), emotion(0.1, 0.9)]), true);
  assert.equal(isEmotionExtremeHeld([]), false, '没有快照 → 无法判定');
  assert.equal(isEmotionExtremeHeld([emotion(0.5, 0.5)]), false, '中间区间不算极值');
});

test('情绪在极值区间剧烈波动（1.0 ↔ 0.0）不算「一直贴着」', () => {
  const snapshots = [emotion(1, 0.5), emotion(0, 0.5), emotion(1, 0.5), emotion(0, 0.5)];
  assert.equal(isEmotionExtremeHeld(snapshots), false);
});

// ── 4. 话题指纹排除程序时间 / 日程词 ──

test('连续 4 轮只聊日程 + 情绪极值 → 不注入 <topic_progress>（防误判）', () => {
  const scheduleTurns = [
    '现在已经很晚了明天早上还要早起上班你还是早点睡觉吧',
    '现在已经很晚了明天早上还要早起上班你还是早点睡觉吧吗',
    '现在已经很晚了明天早上还要早起上班你还是早点睡觉吧呢',
    '现在已经很晚了明天早上还要早起上班你还是早点睡觉吧啊',
  ];
  const snapshots = [emotion(0.5, 0.9), emotion(0.5, 0.9), emotion(0.5, 0.9), emotion(0.5, 0.9)];
  assert.equal(isEmotionExtremeHeld(snapshots), true, '前提：情绪确实贴着极值');

  const lock = detectTopicLock({ recentAssistantTurns: scheduleTurns, emotionSnapshots: snapshots });
  assert.equal(lock.locked, false, '只剩时间/日程词的轮次不该被当成钻牛角尖话题');
  assert.equal(lock.reason, 'current_extreme(no_topic_keyword)');

  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: scheduleTurns, emotionSnapshots: snapshots });
  assert.equal(injection.topicProgressBlock, null);
  // 但车轱辘话（L2）仍然要提示：她确实在打转（4 轮 → 阶段二升到 escalated 档）
  assert.equal(injection.mode, 'escalated');
  assert.ok(injection.block?.includes('<anti_repetition mode="escalated">'));
  assert.ok(
    injection.topicKeywords.every(k => !/明天|早上|睡觉|现在/.test(k)),
    `点名的话题词不能是程序时间/日程词，实际=${JSON.stringify(injection.topicKeywords)}`,
  );
});

test('话题词提取会剔除停用词与时间/日程词', () => {
  const keywords = extractTopicKeywords(
    ['明天早上的安排我觉得还是推迟一下吧', '明天早上的安排我觉得还是推迟一下吧啊', '明天早上的安排我觉得还是推迟一下吧呢'],
    { excludeWords: TIME_SCHEDULE_WORDS },
  );
  assert.ok(!keywords.includes('明天'), '时间词必须被排除');
  assert.ok(!keywords.includes('早上'), '时段词必须被排除');
  assert.ok(!keywords.includes('安排'), '日程词必须被排除');
  assert.ok(keywords.every(k => !/明天|早上|安排/.test(k)), `不该出现时间/日程碎片，实际=${JSON.stringify(keywords)}`);
});

// ── 5. 工具函数口径 ──

test('bigram 重叠率是 Dice 系数：完全相同 = 1，无交集 = 0', () => {
  const a = '我真的很担心你这件事情';
  assert.equal(bigramOverlapRate(a, a), 1);
  assert.equal(bigramOverlapRate(a, 'abcdefg'), 0);
  assert.equal(bigramOverlapRate('', a), 0);
  assert.equal(bigramOverlapRate(null, null), 0);
});

test('清洗会剥掉生图 prompt JSON 与标点空白', () => {
  const raw = '你今天还好吗？{"prompt":"1girl, smile, warm light"}';
  const cleaned = cleanTurnTextFlat(raw);
  assert.ok(!cleaned.includes('prompt'), '生图 JSON 不是她说的话，必须剥离');
  assert.ok(!cleaned.includes('girl'));
  assert.equal(cleaned, '你今天还好吗');
  assert.ok(!bigramsOf(raw).has('pr'), '剥离后不会残留 prompt 的 bigram');
  assert.ok(cleanTurnText(raw).includes('\u0001'), '句界用分隔符标记，公共子串不会跨句粘连');
});

test('相邻轮重叠率数组长度 = 轮数 - 1', () => {
  const rates = consecutiveOverlaps(['abc', 'abcd', 'xyz']);
  assert.equal(rates.length, 2);
  assert.ok(rates[0] > rates[1], '同话术对 > 换话题对');
});

test('L1-1 近端标注：有她说过的话才注入', () => {
  assert.equal(shouldInjectRecentSelfOutputNote([]), false);
  assert.equal(shouldInjectRecentSelfOutputNote(['   ', '{"prompt":"x"}']), false, '只有生图 JSON 不算说过话');
  assert.equal(shouldInjectRecentSelfOutputNote(['你好呀']), true);
  const note = buildRecentSelfOutputNote();
  assert.ok(note.startsWith('<recent_self_output_note>'));
  assert.ok(note.includes('不要重复'));
  assert.ok(note.endsWith('</recent_self_output_note>'));
});

test('日志行格式可搜 [anti-repetition] 且带档位/重叠率', () => {
  const turns = [repeatTurn('a', '一'), repeatTurn('a', '二'), repeatTurn('a', '三')];
  const result = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  const line = formatAntiRepetitionLog({ result, turns, emotionSnapshots: [] });
  assert.ok(line.startsWith('[anti-repetition] '));
  assert.ok(line.includes('mode=strong'));
  assert.ok(line.includes('overlap=0.9') || /overlap=0\.\d+/.test(line));
  assert.ok(line.includes('turns=3'));
});

test('无重叠的日志也带 mode=none（便于量化复读率）', () => {
  const turns = [shiftTurn('a', '一'), shiftTurn('b', '二')];
  const result = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: [] });
  const line = formatAntiRepetitionLog({ result, turns, emotionSnapshots: [] });
  assert.ok(line.includes('mode=none'));
});

test('buildAntiRepetitionBlock 非法档位返回 null（调用点不会拼错块）', () => {
  assert.equal(buildAntiRepetitionBlock('none'), null);
  assert.equal(buildAntiRepetitionBlock(undefined), null);
  assert.ok(buildAntiRepetitionBlock('strong', []).includes('刚才那个话题'), '没有话题词时用兜底措辞');
});

// ── 6. 查库助手：与活跃窗口同口径 ──

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb } = await import('../src/db/index.js');

function seedRawMessages(db, conversationId, rows) {
  const insert = db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)`);
  const ids = [];
  for (const row of rows) ids.push(insert.run(conversationId, row.role, row.content).lastInsertRowid);
  return ids;
}

test('fetchRecentAssistantTurns：只取 assistant、按 id 升序、遵守 sinceRawId 与催眠遗忘窗口', () => {
  const db = getDb();
  const conversationId = 'char_antirep_db_fixture';
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
  const ids = seedRawMessages(db, conversationId, [
    { role: 'assistant', content: '第一轮回复' },
    { role: 'user', content: '用户插话' },
    { role: 'assistant', content: '第二轮回复' },
    { role: 'assistant', content: '第三轮回复（被遗忘窗口屏蔽）' },
    { role: 'user', content: '用户又说话' },
    { role: 'assistant', content: '第四轮回复' },
  ]);

  const all = fetchRecentAssistantTurns(db, conversationId, { limit: 6 });
  assert.deepEqual(all, ['第一轮回复', '第二轮回复', '第三轮回复（被遗忘窗口屏蔽）', '第四轮回复'], '默认全取且按时间升序');

  const sinceSecond = fetchRecentAssistantTurns(db, conversationId, { limit: 6, sinceRawId: ids[1] });
  assert.deepEqual(sinceSecond, ['第二轮回复', '第三轮回复（被遗忘窗口屏蔽）', '第四轮回复'], '已摘要（id ≤ 边界）的消息不进比较');

  const withoutForgotten = fetchRecentAssistantTurns(db, conversationId, {
    limit: 6,
    excludeWindows: [{ fromRawId: ids[3], toRawId: ids[3] }],
  });
  assert.deepEqual(withoutForgotten, ['第一轮回复', '第二轮回复', '第四轮回复'], '催眠遗忘窗口里的回复不算「她说过的话」');

  const limited = fetchRecentAssistantTurns(db, conversationId, { limit: 1 });
  assert.deepEqual(limited, ['第四轮回复'], 'limit 取最近 N 轮，最新在末尾');

  assert.deepEqual(fetchRecentAssistantTurns(db, conversationId, { limit: 6, sinceRawId: ids[5] + 1000 }), [], '边界之后没有消息时返回空数组');
});

test('fetchRecentAssistantTurns：查库失败返回空数组（不许影响聊天主流程）', () => {
  const broken = { prepare() { throw new Error('boom'); } };
  const out = fetchRecentAssistantTurns(broken, 'char_x', { limit: 3 });
  assert.deepEqual(out, []);
});

test('fetchRecentEmotionSnapshots：按 id 升序返回合成后的 V/A（mood×0.4 + instant×0.6）', () => {
  const db = getDb();
  const base = 'char_antirep_emotion_fixture_';
  // emotion_snapshots 以 conversation_id 为主键（每轮 UPSERT），这里造两条不同的会话行
  const insert = db.prepare(`INSERT OR REPLACE INTO emotion_snapshots
    (conversation_id, after_msg_id, valence, arousal, dominance, mood_valence, mood_arousal, mood_dominance, dominant_emotion, affinity)
    VALUES (?, NULL, ?, ?, 0.5, ?, ?, 0.5, 'sadness', 50)`);
  insert.run(base + 'a', 0.2, 0.4, 0.2, 0.4);
  insert.run(base + 'b', -0.2, 0.9, -0.2, 0.9);

  const rows = fetchRecentEmotionSnapshots(db, base + 'b', { limit: 6 });
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].arousal - (0.9 * 0.4 + 0.9 * 0.6)) < 1e-9, 'arousal 按 mood×0.4+instant×0.6 合成');
  assert.ok(Math.abs(rows[0].valence - (-0.2 * 0.4 + -0.2 * 0.6)) < 1e-9, 'valence 同样是合成值');
  assert.equal(isEmotionExtremeHeld([...rows, ...rows, ...rows, ...rows]), true, '同一条极值快照连续 4 轮 → 判贴极值');
  assert.equal(isCurrentEmotionExtreme(rows[rows.length - 1]), true, '这才是检测真正在用的判定（当前一行）');

  // 缺失 mood 列（老库行）时退回 instant 值
  db.prepare('UPDATE emotion_snapshots SET mood_valence = NULL, mood_arousal = NULL WHERE conversation_id = ?').run(base + 'b');
  const legacy = fetchRecentEmotionSnapshots(db, base + 'b', { limit: 6 });
  assert.equal(legacy[0].valence, -0.2, '缺 mood 时退回 instant');
});

test('fetchRecentEmotionSnapshots：查库失败返回空数组', () => {
  const broken = { prepare() { throw new Error('boom'); } };
  assert.deepEqual(fetchRecentEmotionSnapshots(broken, 'char_x'), []);
});
