/**
 * B1 wiring 级回归：**检测器输入在真实存储里到底存不存在**（2026-09-30，task-23 / P0-1）
 *
 * 缺陷：`emotion_snapshots` 表是「**每个会话只保留最新一条**」——
 *   · `db/index.js:154` `conversation_id TEXT NOT NULL UNIQUE`
 *   · `db/index.js:893` 迁移 `migrateEmotionSnapshotsUnique`（删历史 + 重建带 UNIQUE）
 *   · `emotionEngine.saveEmotionSnapshot` 用 `INSERT OR REPLACE` 写入
 * 于是 `fetchRecentEmotionSnapshots(..., { limit: 8 })` **永远只回 1 行**，
 * 而旧 `detectTopicLock` 要求「连续 ≥ `TOPIC_LOCK_MIN_EXTREME_TURNS`(4) 条快照都是极值」⇒
 * `rows.length < 4` 恒真 ⇒ `<topic_progress>` **从未注入过、也不可能注入**。
 *
 * 纯函数单测（antiRepetition.test.js 直接喂合成数组）测不到这种**存储层**假设错误 ——
 * 这正是本文件的价值：**先建真表、只写一行、走同一条查库路径**。
 *
 * 本文件同时是"红→绿"证据：修复前的断言是 `topicProgressBlock === null`（红），
 * 修复后改为断言 `!== null` 并保留"表里确实只有一行"的前提校验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`antiRepetition wiring fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb } = await import('../src/db/index.js');
const {
  fetchRecentEmotionSnapshots,
  fetchRecentAssistantTurns,
  buildAntiRepetitionInjection,
  TOPIC_LOCK_MIN_EXTREME_TURNS,
  TOPIC_LOCK_MIN_TOPIC_TURNS,
  isEmotionExtremeHeld,
  detectTopicLock,
} = await import('../src/services/antiRepetition.js');

/** 同一句话术的多轮变体：bigram 几乎全共享（车轱辘话的真实形状） */
const BASE = '我真的很担心你呢这件事让我一直放不下心里总觉得不安';
const repeat = marker => BASE + marker;

function seedRawMessages(db, conversationId, contents) {
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, \'assistant\', ?)');
  for (const content of contents) insert.run(conversationId, content);
}

/** 写一行情绪快照（真实表结构：每会话 UNIQUE，走 INSERT OR REPLACE 与线上一致） */
function seedEmotionSnapshot(db, conversationId, { valence, arousal, moodValence, moodArousal }) {
  db.prepare(`INSERT OR REPLACE INTO emotion_snapshots
    (conversation_id, after_msg_id, valence, arousal, dominance, mood_valence, mood_arousal, mood_dominance, dominant_emotion, affinity)
    VALUES (?, NULL, ?, ?, 0.5, ?, ?, 0.5, 'sadness', 50)`)
    .run(conversationId, valence, arousal, moodValence ?? valence, moodArousal ?? arousal);
}

// ── 前提：存储层确实只留一行（缺陷的根因，必须先证实再修） ──

test('前提：emotion_snapshots 每会话 UNIQUE → fetchRecentEmotionSnapshots 只可能回 1 行', () => {
  const db = getDb();
  const conversationId = 'char_antirep_wiring_single_row';
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);

  // 连续写 4 次（模拟 4 轮各自保存快照）：真实表上只会留下最后一行
  for (let i = 0; i < 4; i++) {
    seedEmotionSnapshot(db, conversationId, { valence: 0.7, arousal: 0.9 });
  }
  const rows = fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 });
  assert.equal(rows.length, 1, 'UNIQUE + INSERT OR REPLACE ⇒ 每会话只剩最新一行（这就是缺陷根因）');
  assert.ok(isEmotionExtremeHeld(rows), '单行本身确实在极值区间（A=0.9）');

  const rawCount = db.prepare('SELECT COUNT(*) FROM emotion_snapshots WHERE conversation_id = ?').pluck().get(conversationId);
  assert.equal(rawCount, 1, '库里也只剩一行，不是读侧过滤掉的');
});

// ── 前提（源码级）：全仓没有"给 group_ 会话写情绪快照"的调用点（P1 / task-27） ──
//
// 上一条是**夹具级**前提（某个 group_ 夹具 0 行）；这条是**源码级**：直接扫全仓
// `saveEmotionSnapshot(` 的调用点，解析第一个实参变量在**同文件内**的赋值，断言它不含 `group_`。
// 这样日后有人新增一个往 group_ 会话写快照的调用点时，测试会红。

const SRC_ROOT = new URL('../src/', import.meta.url);
const SNAPSHOT_WRITER = 'saveEmotionSnapshot(';

function listSourceFiles(dirUrl) {
  const out = [];
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
    if (entry.isDirectory()) out.push(...listSourceFiles(child));
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(child);
  }
  return out;
}

function callSites(source, needle) {
  const sites = [];
  let index = source.indexOf(needle);
  while (index >= 0) {
    const lineStart = source.lastIndexOf('\n', index) + 1;
    const line = source.slice(lineStart, source.indexOf('\n', index));
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
    const isDeclaration = /^(export\s+)?(async\s+)?function\s/.test(trimmed);
    if (!isComment && !isDeclaration) {
      const arg = source.slice(index + needle.length).match(/^\s*([A-Za-z_$][\w$]*)/);
      sites.push({ index, argName: arg ? arg[1] : null, line: trimmed.slice(0, 90) });
    }
    index = source.indexOf(needle, index + needle.length);
  }
  return sites;
}

/** 同文件内**最近一次在调用点之前**的赋值（文件里可能有多个同名变量，取最近的那个） */
function nearestDeclaration(source, name, beforeIndex) {
  if (!name) return null;
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*([^;\\n]+)', 'g');
  let match;
  let last = null;
  while ((match = re.exec(source)) !== null) {
    if (match.index >= beforeIndex) break;
    last = match[1].trim();
  }
  return last;
}

test('前提（源码级）：saveEmotionSnapshot 的调用点没有任何一个写 group_ 会话', () => {
  const files = listSourceFiles(SRC_ROOT);
  assert.ok(files.length > 50, '源码文件扫描应覆盖全仓，实际 ' + files.length + ' 个');

  const resolved = [];
  for (const fileUrl of files) {
    const source = readFileSync(fileUrl, 'utf8');
    if (!source.includes(SNAPSHOT_WRITER)) continue;
    for (const site of callSites(source, SNAPSHOT_WRITER)) {
      // 解析**调用点之前最近一次**的赋值（同文件可能有多个同名变量：如 touch.js 里既有 group_ 又有 char_）
      const decl = nearestDeclaration(source, site.argName, site.index);
      resolved.push({ file: fileUrl.pathname.split('/').slice(-2).join('/'), argName: site.argName, decl });
    }
  }

  assert.ok(resolved.length >= 5, '至少要扫到 5 个真实写入方，实际 ' + resolved.length + '：' + JSON.stringify(resolved));
  const unresolvable = resolved.filter(item => item.decl === null);
  assert.deepEqual(unresolvable, [], '有调用点的实参无法在同文件内解析（守卫会失效，请补解析）：' + JSON.stringify(unresolvable));

  // 1) 实参变量名不得是 group_ 形态
  for (const item of resolved) {
    assert.ok(!item.argName.includes('group'), item.file + ': 实参名像群会话（' + item.argName + '）——群聊不该写情绪快照');
  }
  // 2) 解析出的赋值不得指向 group_（含模板与字面量）
  for (const item of resolved) {
    assert.ok(!item.decl.includes('group_'), item.file + ': ' + item.argName + ' = ' + item.decl + ' ⇒ 往 group_ 会话写快照，群聊情绪判定会变成死条件');
  }
  // 3) 反向证据：私聊侧必须有 char_ 形态的写入方（否则扫描口径写错了也不会红）
  assert.ok(
    resolved.some(item => item.decl.includes('char_')),
    '必须至少有一个 char_ 形态的写入方（证明扫描口径正确）：' + JSON.stringify(resolved),
  );
});
// ── 红→绿：真实存储 + 真实查库路径下，「当前极值 × 话题锁死多轮」必须能注入 ──

test('真实存储路径：当前快照极值 + 文本侧话题锁 ≥4 轮 → 必须注入 <topic_progress>（修复前为红）', () => {
  const db = getDb();
  const conversationId = 'char_antirep_wiring_topic_lock';
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);

  // 她最近 4 轮都在复述同一件事（文本侧证据）
  seedRawMessages(db, conversationId, [repeat('一'), repeat('二'), repeat('三'), repeat('四')]);
  // 情绪：只可能有"当前值"一行 —— 必须靠这一行就够用
  seedEmotionSnapshot(db, conversationId, { valence: 0.7, arousal: 0.9 });

  const turns = fetchRecentAssistantTurns(db, conversationId, { limit: 8 });
  const snapshots = fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 });
  assert.equal(snapshots.length, 1, '前提：真实路径只会给出 1 行快照');
  assert.equal(turns.length, 4, '前提：文本侧拿到了 4 轮原文');
  assert.ok(turns.length >= TOPIC_LOCK_MIN_EXTREME_TURNS.turns || turns.length >= 4, '文本侧轮次足够');

  // 【红→绿证据】修复前这里的断言是 `assert.equal(injection.topicProgressBlock, null)`，而且它**通过**了
  // ——因为 `fetchRecentEmotionSnapshots` 只给 1 行、旧判据要 4 行快照。现在断言反过来：
  // 为什么显式关掉升级：这 4 轮重叠率 ~0.96，阶段二会优先走 `escalated` 块（升级档不叠加 topic_progress，
  // 见下方"互斥"用例）。要单独验"钻牛角尖这条路通不通"，就得把升级档关掉。
  const injection = buildAntiRepetitionInjection({
    recentAssistantTurns: turns,
    emotionSnapshots: snapshots,
    escalationEnabled: false,
  });
  assert.notEqual(injection.topicProgressBlock, null,
    '当前情绪处于极值 + 文本侧话题锁死 4 轮 ⇒ 必须注入 <topic_progress>（修复前恒为 null）');
  assert.ok(injection.topicProgressBlock.includes('<topic_progress>'));
  assert.equal(injection.topicLock, true);
  assert.ok(!injection.reason.includes('emotion_not_extreme'), '判定理由不得再是骗人的 emotion_not_extreme');
});

test('真实存储路径：升级档命中时 topic_progress 让位（互斥，不是"两条一起注"）', () => {
  const db = getDb();
  const conversationId = 'char_antirep_wiring_exclusive';
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);

  seedRawMessages(db, conversationId, [repeat('一'), repeat('二'), repeat('三'), repeat('四')]);
  seedEmotionSnapshot(db, conversationId, { valence: 0.7, arousal: 0.9 });

  const turns = fetchRecentAssistantTurns(db, conversationId, { limit: 8 });
  const snapshots = fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 });
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots });

  assert.equal(injection.escalated, true, '4 轮 ~0.96 重叠 ⇒ 阶段二升级档');
  assert.ok(injection.block.includes('mode="escalated"'));
  assert.equal(injection.topicProgressBlock, null, '同一轮只给一条最强约束');
  assert.equal(injection.topicLock, true, '话题锁死仍被记录（只是不注入）');
});

test('真实存储路径：当前情绪不极端 → 不注入（不能因为文本重复就误判钻牛角尖）', () => {
  const db = getDb();
  const conversationId = 'char_antirep_wiring_not_extreme';
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);

  seedRawMessages(db, conversationId, [repeat('一'), repeat('二'), repeat('三'), repeat('四')]);
  seedEmotionSnapshot(db, conversationId, { valence: 0.55, arousal: 0.5, moodValence: 0.55, moodArousal: 0.5 });

  const turns = fetchRecentAssistantTurns(db, conversationId, { limit: 8 });
  const snapshots = fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 });
  assert.equal(isEmotionExtremeHeld(snapshots), false, 'V/A 都在中间区间');

  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots });
  assert.equal(injection.topicProgressBlock, null);
  assert.equal(injection.topicLock, false);
});

test('真实存储路径：情绪极端但话题换了 → 不注入（文本侧至少要 TOPIC_LOCK_MIN_TOPIC_TURNS 轮同话题）', () => {
  const db = getDb();
  const conversationId = 'char_antirep_wiring_topic_changed';
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);

  seedRawMessages(db, conversationId, [
    '今天去菜市场买了两斤排骨顺便修好了漏水的水龙头',
    '楼下新开的咖啡店味道不错店员还送了我一块芝士蛋糕',
    '刚把阳台的花搬到阳光下顺便把冬天的厚被子收进柜子',
    '明天想去把那本没看完的书读完顺便去趟图书馆',
  ]);
  seedEmotionSnapshot(db, conversationId, { valence: 0.9, arousal: 0.9 });

  const turns = fetchRecentAssistantTurns(db, conversationId, { limit: 8 });
  const snapshots = fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 });
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots });
  assert.equal(injection.topicProgressBlock, null, '话题换了就不算钻牛角尖');
  assert.equal(injection.topicLock, false);
});

test('真实存储路径：文本侧只有 2 轮重复（不足 TOPIC_LOCK_MIN_TOPIC_TURNS）→ 不注入', () => {
  const db = getDb();
  const conversationId = 'char_antirep_wiring_too_few_turns';
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);

  seedRawMessages(db, conversationId, [repeat('一'), repeat('二')]);
  seedEmotionSnapshot(db, conversationId, { valence: 0.9, arousal: 0.9 });

  const turns = fetchRecentAssistantTurns(db, conversationId, { limit: 8 });
  const snapshots = fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 });
  const injection = buildAntiRepetitionInjection({ recentAssistantTurns: turns, emotionSnapshots: snapshots });
  assert.equal(injection.topicProgressBlock, null, '只有 2 轮重复，还不到"锁死"的程度');
});

test('纯函数层：单行极值 + 4 轮同话题 → detectTopicLock 必须 locked（同一修复的另一半）', () => {
  const turns = [repeat('一'), repeat('二'), repeat('三'), repeat('四')];
  const single = [{ valence: 0.7, arousal: 0.9 }];
  const lock = detectTopicLock({ recentAssistantTurns: turns, emotionSnapshots: single });
  assert.equal(lock.locked, true, `话题轮数阈值=${TOPIC_LOCK_MIN_TOPIC_TURNS}`);
  assert.ok(lock.topicKeywords.length > 0, '话题词仍要能点出来');
  assert.equal(lock.durationTurns, 4, '持续时间由文本侧轮数给出');
  assert.ok(lock.reason.includes('duration_turns=4'), `reason 必须能自证持续时间，实际=${lock.reason}`);
  assert.ok(!lock.reason.includes('emotion_not_extreme'), '旧口径的理由文案已废弃');

  const few = detectTopicLock({ recentAssistantTurns: [repeat('一'), repeat('二')], emotionSnapshots: single });
  assert.equal(few.locked, false, '轮次不足时不锁');
});
