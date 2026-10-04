/**
 * 群聊反重复（P2-3 / task-26）
 *
 * 用户主诉「说着说着就车轱辘话」**没有限定私聊**，而群聊是「一次调用演所有人」的放大器。
 * 本轮把**同一套** `antiRepetition.js` 纯函数接到群聊轮上：
 *   · 输入＝**整群最近若干轮剧本**（群聊一轮一条 assistant raw，里面已经是所有人的发言）
 *     ⇒ 天然得到**一个面向全群的合并块**，而不是按成员各成一块；
 *   · 复用 `features.antiRepetition`（总开关）与 `features.antiRepetitionEscalation`（升级）两个键，
 *     **不新增设置键**；总开关关闭 ⇒ 零块、零查询，与加功能前逐字节一致；
 *   · 块序：紧跟 `<round_message_limit>`/发图规则之后、`<member_private_memory>` 与
 *     `<touch_action>` 之前，催眠块仍最后（理由见 docs/anti-repetition.md 与源码注释）。
 *
 * 纯函数 + :memory: 库；不联网。检测逻辑一行都不复制——全部来自 antiRepetition.js。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`group anti-rep fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  buildGroupAntiRepetitionBlock,
  collectGroupAntiRepetitionBlock,
  GROUP_ANTI_REPETITION_TURNS,
} = await import('../src/services/groupChatEngine.js');

after(() => closeDb());

const REPEATED = '别担心，我一直都在这里陪着你，不会走开的。';
const OTHER_A = '今天的风很凉，我把窗子关上了。';
const OTHER_B = '你上次说的那本书我读完了，很喜欢结尾。';
const OTHER_C = '晚饭想吃点什么？我可以顺路带回来。';

test('① 群聊剧本连续重复 → 注入**一个**合并块（不是按成员各成一块）', () => {
  const result = buildGroupAntiRepetitionBlock({ turns: [REPEATED, REPEATED, REPEATED] });
  assert.ok(result.block, '重复时必须给块');
  assert.equal(result.enabled, true);
  assert.match(result.block, /^<(anti_repetition|topic_progress)/);
  // 合并口径：整块里只允许出现一个反重复 / 话题推进标签
  const tags = result.block.match(/<(anti_repetition|topic_progress)/g) || [];
  assert.equal(tags.length, 1, '只能是一块（面向全群），不能拼成多块');
  assert.ok(['strong', 'mild', 'escalated'].includes(result.result.mode), result.result.mode);
});

test('② 群聊剧本不重复 → 零注入（零 token）', () => {
  const result = buildGroupAntiRepetitionBlock({ turns: [OTHER_A, OTHER_B, OTHER_C] });
  assert.equal(result.block, null);
  assert.equal(result.result.mode, 'none');
});

test('③ 总开关关闭 → 零块（与加功能前逐字节一致）', () => {
  const off = buildGroupAntiRepetitionBlock({ turns: [REPEATED, REPEATED, REPEATED], enabled: false });
  assert.equal(off.block, null);
  assert.equal(off.result, null);
  assert.equal(off.enabled, false);
});

test('④ 升级开关关闭 → 不出现 escalated 档（复用既有 antiRepetitionEscalation 键口径）', () => {
  const turns = [REPEATED, REPEATED, REPEATED, REPEATED];
  const on = buildGroupAntiRepetitionBlock({ turns, escalationEnabled: true });
  const off = buildGroupAntiRepetitionBlock({ turns, escalationEnabled: false });
  assert.ok(off.block, '关掉升级也仍要有基础档');
  assert.doesNotMatch(off.block, /mode="escalated"/, '关掉升级后不得出现 escalated');
  assert.equal(off.result.escalate, false);
  // 开关打开时这一档是允许出现的（不强求，接口以 antiRepetition.js 为准）
  assert.ok(on.result.escalate === true || on.result.mode === 'strong' || on.result.mode === 'mild');
});

test('⑤ 与催眠不打架：全群完全控制 → 跳过（skipped=hypnosis），块为 null', () => {
  const result = buildGroupAntiRepetitionBlock({ turns: [REPEATED, REPEATED, REPEATED], hypnosisActive: true });
  assert.equal(result.block, null);
  assert.equal(result.result.skipped, 'hypnosis');
});

// ── 集成：真实取数的接线（:memory: 库） ──
let seq = 0;
function seedGroupWithScripts(scriptContents) {
  const db = getDb();
  seq += 1;
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run(`反重复群${seq}`, '测试').lastInsertRowid);
  const conversationId = `group_${gid}`;
  for (const content of scriptContents) {
    db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(conversationId, content);
  }
  return { gid, conversationId };
}

test('⑥ 集成：从群会话取最近剧本 → 重复时注入；总开关关 → 零注入', () => {
  const { gid } = seedGroupWithScripts([REPEATED, REPEATED, REPEATED]);
  const group = { id: gid, members: [] };
  const hit = collectGroupAntiRepetitionBlock(group);
  assert.ok(hit.block, '库里连着三轮重复 → 必须注入');
  assert.ok(hit.turns.length >= GROUP_ANTI_REPETITION_TURNS - 3, 'turns 应是该群最近的 assistant 剧本');

  const before = config.features.antiRepetition;
  config.features.antiRepetition = false;
  const off = collectGroupAntiRepetitionBlock(group);
  assert.equal(off.block, null);
  assert.deepEqual(off.turns, []);
  config.features.antiRepetition = before;
});

test('⑦ 源码级块序：反重复在 round_message_limit 之后、privateMem / touch 之前、催眠之前', () => {
  const src = readFileSync(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  const at = label => {
    const index = src.indexOf(label);
    assert.ok(index > 0, `源码里找不到 ${label}`);
    return index;
  };
  const limit = at('<round_message_limit>本轮消息上限');
  const antiRep = at('collectGroupAntiRepetitionBlock(group)');
  const privateMem = at('collectMemberPrivateMemoryBlocks(group.members)');
  const touch = at('collectTouchActionBlocks(group)');
  const hypno = at('collectHypnosisDirectiveBlocks(group.members)');
  assert.ok(limit < antiRep, '反重复必须排在 round_message_limit 之后（与私聊「紧跟长度条之后」一致）');
  assert.ok(antiRep < privateMem, '反重复在成员私聊记忆之前');
  assert.ok(antiRep < touch, '反重复在群聊动作块之前');
  assert.ok(antiRep < hypno, '反重复在催眠块之前（催眠块保持最后）');
  assert.ok(touch < hypno, '动作块仍在催眠之前（task-17 口径不变）');
});
// ── 前置：群聊侧"钻牛角尖"的输入在真实存储里不存在（P1，task-27）──
//
// 群聊反重复原先给 detectTopicLock 喂的是 group_<gid> 会话的情绪快照，
// 但全仓**没有任何代码**给 group_ 会话写快照（saveEmotionSnapshot 的每个调用点 conversationId 都是 char_<id>）
// ⇒ 群聊的 <topic_progress> 永不触发。这是三天内第三次同款「检测器输入在真实存储里不存在」。
// 修法（方案 B）：群聊侧**不做情绪判定**，topic_progress 改成纯文本「话题锁 ≥6 轮」。
test('⑧ P1 前置：group_ 会话永远没有情绪快照行（所以群聊不能做情绪判定）', () => {
  const db = getDb();
  const { gid, conversationId } = seedGroupWithScripts([REPEATED, REPEATED, REPEATED, REPEATED, REPEATED, REPEATED]);
  assert.match(conversationId, /^group_/);
  const rows = db.prepare('SELECT COUNT(*) FROM emotion_snapshots WHERE conversation_id = ?').pluck().get(conversationId);
  assert.equal(rows, 0, '群会话没有任何快照写入点 ⇒ 行数恒为 0');

  // 对照：私聊会话（char_<id>）才是唯一会被写快照的形态（同一张表、同一套写入路径）
  const charConv = `char_p1_probe_${gid}`;
  db.prepare(`INSERT OR REPLACE INTO emotion_snapshots
    (conversation_id, after_msg_id, valence, arousal, dominance, mood_valence, mood_arousal, mood_dominance, dominant_emotion, affinity)
    VALUES (?, NULL, 0.1, 0.9, 0.5, 0.1, 0.9, 0.5, 'sadness', 50)`).run(charConv);
  assert.equal(db.prepare('SELECT COUNT(*) FROM emotion_snapshots WHERE conversation_id = ?').pluck().get(charConv), 1, '私聊形态能写进去（证明不是表坏了，是没人写 group_）');

  const { emotionSnapshots } = collectGroupAntiRepetitionBlock({ id: gid, members: [] });
  assert.equal(emotionSnapshots.length, 0, '群聊取数必然拿到 0 条快照 —— 任何"靠快照判定"的群聊条件都是死条件');
});

// 6 轮"同一件事、每轮换一个词"的剧本：相邻重叠率都落在 [0.6, 0.75)，
// 既不会触发阶段二升级档（那会顶掉 topic_progress），又满足纯文本话题锁。
const SAME_TOPIC_6 = [
  '今天下雨了我们还是别出门了',
  '今天下雨了咱们还是别出去了',
  '今天下雨咱们还是别乱跑了',
  '今天下雨了咱们还是别出门了',
  '今天雨挺大咱们还是别出门了',
  '今天下雨咱们还是别出门了吧',
];
/** 最近 5 轮（相邻重叠仍在 [0.6,0.75)，专供"不足 6 轮"边界用例） */
const SAME_TOPIC_5 = SAME_TOPIC_6.slice(0, 5);

test('⑨ P1 红→绿：群聊 6 轮同话题 + 无快照 → 必须注入 <topic_progress>（纯文本判定）', () => {
  const { gid } = seedGroupWithScripts(SAME_TOPIC_6);
  const hit = collectGroupAntiRepetitionBlock({ id: gid, members: [] });
  assert.equal(hit.emotionSnapshots.length, 0, '前提：群聊没有快照可用');
  assert.equal(hit.result.escalate, false, '前提：这组样本不会触发升级档（否则 topic_progress 会被它顶掉）');
  // 【红→绿证据】修复前这里是 assert.equal(hit.result?.topicProgressBlock, null) —— 它通过、而且**永远**通过。
  assert.notEqual(hit.result?.topicProgressBlock, null,
    '纯文本 ≥6 轮 ⇒ 群聊必须能注入 <topic_progress>（修复前恒为 null）');
  assert.ok(hit.result.topicProgressBlock.includes('<topic_progress>'));
  assert.equal(hit.result.topicLock, true);
  assert.ok(hit.result.reason.includes('text_only'), `reason 要能区分群聊纯文本触发，实际=${hit.result.reason}`);
});

test('⑨b 群聊 5 轮同话题（不足 6）→ 不注入 <topic_progress>（比私聊 4 轮保守）', () => {
  const { gid } = seedGroupWithScripts(SAME_TOPIC_5);
  const hit = collectGroupAntiRepetitionBlock({ id: gid, members: [] });
  assert.equal(hit.result.escalate, false, '前提：这组样本不升级');
  assert.equal(hit.result?.topicProgressBlock, null, '纯文本门槛是 6 轮，5 轮不够');
  assert.notEqual(hit.result?.topicLock, true);
  assert.ok(hit.result.reason.includes('text_only'), `reason 要能看出是群聊纯文本路径，实际=${hit.result.reason}`);
  assert.ok(hit.result.reason.includes('need=6'), `reason 应写明 need=6，实际=${hit.result.reason}`);
  assert.ok(hit.block, '不足 6 轮也仍有车轱辘话提醒（strong/mild），只是不给 topic_progress');
});

test('⑨c 群聊硬塞快照也不走情绪判定（4 轮 + 极值快照 → 不注入 topic_progress）', () => {
  const injected = buildGroupAntiRepetitionBlock({
    turns: [REPEATED, REPEATED, REPEATED, REPEATED],
    emotionSnapshots: [{ valence: 0.9, arousal: 0.9 }],
  });
  assert.equal(injected.result.topicProgressBlock, null, '4 轮 + 极值快照：群聊不认情绪，只认 6 轮文本');
  assert.ok(!injected.result.reason.includes('current_extreme'), `不得出现私聊口径文案，实际=${injected.result.reason}`);
});

test('⑨d 私聊口径逐字节不变：同样 4 轮文本 + 极值快照 → 私聊仍然按 need=4 触发', () => {
  // 4 轮中等重叠（不升级）——这样 topic_progress 才不会被 escalated 顶掉，能验到私聊判定本身
  const turns = SAME_TOPIC_6.slice(0, 4);
  const privateHit = buildGroupAntiRepetitionBlock({
    turns,
    emotionSnapshots: [{ valence: 0.9, arousal: 0.9 }],
    textOnly: false,   // 生产里私聊由 routes/chat.js 直接调 antiRepetition.js（同样是 textOnly 默认 false）
  });
  assert.ok(privateHit.result.topicProgressBlock, '私聊：当前极值 × 文本 ≥4 轮 ⇒ 注入');
  assert.ok(privateHit.result.reason.includes('current_extreme'));
  assert.ok(privateHit.result.reason.includes('need=4'));
  assert.equal(privateHit.result.topicLock, true);
});

test('⑨e 升级档顶掉 topic_progress 时仍有块可注入（群聊重复到升级档）', () => {
  const { gid } = seedGroupWithScripts([REPEATED, REPEATED, REPEATED, REPEATED, REPEATED, REPEATED]);
  const hit = collectGroupAntiRepetitionBlock({ id: gid, members: [] });
  assert.equal(hit.result.escalate, true, '6 轮几乎逐字重复 ⇒ 升级档');
  assert.equal(hit.result.topicProgressBlock, null, '升级档优先级更高（同一轮只给一条最强约束）');
  assert.ok(hit.block.includes('mode="escalated"'), '但必须仍然给块，不能什么都不注入');
});
