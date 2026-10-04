/**
 * 群聊围观插话的概率模型（task-22）
 *
 * 背景：task-17 的 `<touch_bystander>` 只是 prompt 约束（「其他成员最多 1 人可以插一句」），
 * 每轮都这么写 = 每轮都允许有人插话。task-22 把它做成**真概率**：
 *   · 默认 30%（`features.touchBystanderChance` 可配）；
 *   · 命中 → 允许围观并**点名一位**成员（仍然最多 1 人）；
 *   · 未命中 → 明确「其他成员这一轮都不要发言」；
 *   · **关闭**（null / false）→ 字符串与 task-17 版本**逐字节一致**（本文件第 1 条就是钉这个）。
 *
 * 纯函数 + :memory: 库；不联网。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`bystander fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  DEFAULT_TOUCH_BYSTANDER_CHANCE,
  buildTouchBystanderRule,
  collectTouchActionBlocks,
  planTouchBystander,
  resolveTouchBystanderChance,
} = await import('../src/services/groupChatEngine.js');

after(() => closeDb());

/** task-17 版本的块文案（关闭概率模型时必须逐字节等于这个） */
const LEGACY_RULE = '<touch_bystander>本轮是群聊：只让「纳西妲」演出这一下接触的反应；其他成员**最多 1 个人**可以插一句围观 / 起哄的话（其余人这一轮不要发言），不要整群跟着刷屏。</touch_bystander>';

test('① 关闭时与 task-17 逐字节一致', () => {
  assert.equal(buildTouchBystanderRule('纳西妲', { chance: null }), LEGACY_RULE);
  // 不传 otherName / allowed 也一样（关闭态不看点名）
  assert.equal(buildTouchBystanderRule('纳西妲', { chance: null, allowed: true, otherName: '琪亚娜' }), LEGACY_RULE);
  // 走配置：key 为 null 时 resolve 出 null，collect 也用旧文案
  const before = config.features.touchBystanderChance;
  config.features.touchBystanderChance = null;
  assert.equal(resolveTouchBystanderChance(), null);
  config.features.touchBystanderChance = before;
});

test('② 概率解析：默认 30%、可配、越界夹取、null/false 关闭', () => {
  assert.equal(DEFAULT_TOUCH_BYSTANDER_CHANCE, 0.3);
  const before = config.features.touchBystanderChance;
  config.features.touchBystanderChance = undefined;
  assert.equal(resolveTouchBystanderChance(), 0.3, '缺省即默认 30%');
  assert.equal(resolveTouchBystanderChance(0.7), 0.7);
  assert.equal(resolveTouchBystanderChance(0), 0);
  assert.equal(resolveTouchBystanderChance(1), 1);
  assert.equal(resolveTouchBystanderChance(3), 1, '越界夹到 1');
  assert.equal(resolveTouchBystanderChance(-2), 0, '越界夹到 0');
  assert.equal(resolveTouchBystanderChance('0.5'), 0.5, '字符串数字也认');
  assert.equal(resolveTouchBystanderChance(null), null);
  assert.equal(resolveTouchBystanderChance(false), null);
  assert.equal(resolveTouchBystanderChance('abc'), 0.3, '垃圾值回落默认');
  config.features.touchBystanderChance = before;
});

test('③ 决策：命中才点名，且点名的不是被摸的那位', () => {
  const members = [{ id: 1, display_name: '纳西妲' }, { id: 2, display_name: '琪亚娜' }, { id: 3, display_name: '三月七' }];
  // roll=0.1 < 0.3 → 允许；第二个随机值 0 → 取过滤后的第 0 位（id=2）
  const seq = [0.1, 0];
  let i = 0;
  const hit = planTouchBystander({ members, excludeId: 1, chance: 0.3, random: () => seq[i++] });
  assert.equal(hit.allowed, true);
  assert.equal(hit.member.id, 2);
  assert.notEqual(hit.member.id, 1);
  // roll=0.9 ≥ 0.3 → 拒绝，且不消耗第二次随机
  const miss = planTouchBystander({ members, excludeId: 1, chance: 0.3, random: () => 0.9 });
  assert.equal(miss.allowed, false);
  assert.equal(miss.member, null);
  // 群里只有她一个人 → 没有人可以围观
  const alone = planTouchBystander({ members: [{ id: 1, display_name: '纳西妲' }], excludeId: 1, chance: 1, random: () => 0 });
  assert.equal(alone.allowed, false);
  // 关闭态：概率 null 一律拒绝
  const off = planTouchBystander({ members, excludeId: 1, chance: null, random: () => 0 });
  assert.equal(off.allowed, false);
});

test('④ 命中点名一位、未命中明确全员闭嘴（都仍然「最多 1 人」）', () => {
  const yes = buildTouchBystanderRule('纳西妲', { chance: 0.3, allowed: true, otherName: '琪亚娜' });
  assert.match(yes, /只让「琪亚娜」/);
  assert.match(yes, /不要整群跟着刷屏/);
  const no = buildTouchBystanderRule('纳西妲', { chance: 0.3, allowed: false });
  assert.match(no, /其他成员这一轮都不要发言/);
  assert.doesNotMatch(no, /最多 1 个人/);
  assert.match(no, /只让「纳西妲」/);
  // 允许但拿不到具体名字 → 退化成"都别说话"，不能出现无限定的"可以插一句"
  const noName = buildTouchBystanderRule('纳西妲', { chance: 0.3, allowed: true, otherName: '' });
  assert.match(noName, /其他成员这一轮都不要发言/);
});

// ── 集成：真实库路径里 collectTouchActionBlocks 的 bystander 结果 ──
let seq = 0;
function seedCharacter(displayName) {
  const db = getDb();
  seq += 1;
  const info = db.prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')"
  ).run(`tb_${seq}`, displayName);
  return Number(info.lastInsertRowid);
}

function seedGroup(memberIds) {
  const db = getDb();
  seq += 1;
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run(`围观群${seq}`, '测试').lastInsertRowid);
  for (const id of memberIds) db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id);
  return gid;
}

function seedEvent(groupId, characterId) {
  const db = getDb();
  db.prepare(
    "INSERT INTO touch_events (group_id, character_id, action_key, mode, status, created_at) VALUES (?, ?, 'pat_head', 'implicit', 'pending', datetime('now'))"
  ).run(groupId, characterId);
}

function membersOf(gid) {
  return getDb().prepare(
    'SELECT c.id, c.display_name FROM group_members gm JOIN characters c ON c.id = gm.character_id WHERE gm.group_id = ?'
  ).all(gid);
}

test('⑤ 集成：概率 1 + 随机 0 → 块里点名另一位成员（最多 1 人）', () => {
  const touched = seedCharacter('纳西妲');
  const other = seedCharacter('琪亚娜');
  const gid = seedGroup([touched, other]);
  seedEvent(gid, touched);
  const result = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: 1, bystanderRandom: () => 0 });
  assert.equal(result.blocks.length, 2, '动作块 + 围观块');
  assert.match(result.blocks[1], /^<touch_bystander>/);
  assert.match(result.blocks[1], /只让「琪亚娜」/);
  assert.equal(result.bystander.allowed, true);
  assert.equal(result.bystander.memberId, other);
});

test('⑥ 集成：概率 0 → 其他成员本轮都别说话；概率 null → 与 task-17 逐字节一致', () => {
  const touched = seedCharacter('纳西妲');
  const other = seedCharacter('三月七');
  const gid = seedGroup([touched, other]);
  seedEvent(gid, touched);
  const denied = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: 0, bystanderRandom: () => 0 });
  assert.match(denied.blocks[1], /其他成员这一轮都不要发言/);
  assert.equal(denied.bystander.allowed, false);

  seedEvent(gid, touched);
  const off = collectTouchActionBlocks({ id: gid, members: membersOf(gid) }, { bystanderChance: null, bystanderRandom: () => 0 });
  assert.equal(off.blocks[1], LEGACY_RULE.replace('纳西妲', '纳西妲'), '关闭态必须逐字节等于旧文案');
  assert.equal(off.bystander.chance, null);
});
