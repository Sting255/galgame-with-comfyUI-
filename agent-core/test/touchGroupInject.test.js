/**
 * 群聊动作注入（task-17 · 阶段二 · 后端）
 *
 * 覆盖 `groupChatEngine.collectTouchActionBlocks()`：本群待消费的触摸事件 → 带**成员限定行**的
 * `<touch_action>` 块 + `<touch_bystander>` 围观规则（用户裁决：单轮只 1 人插话）。
 *
 * task-22 起围观概率化（默认 30%）：本文件凡是要断言围观**文案**的地方，都显式传
 * `bystanderChance: null`（关闭概率模型 → 与 task-17 逐字节一致），概率模型本身见
 * `test/touchBystanderChance.test.js`。
 *
 * 四条核心口径：
 *   1. 消费语义与私聊一致：读一条 → 注入 → 立刻置 `injected`（**一次动作只注入一次**）；
 *   2. **单轮最多消费 1 条事件**（LIMIT 1），其余留到下一轮；
 *   3. **过期作废**：`created_at < touchEventCutoff()`（默认 30 分钟）→ 标 `'expired'` 且不注入；
 *   4. 事件指向的成员已不在群里 → 标 `'dropped'`（否则一条坏行会把 LIMIT 1 后面的正常事件堵死）。
 *
 * 纯服务层 + :memory: 库；不联网（globalThis.fetch 禁网）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`touch group fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { collectTouchActionBlocks } = await import('../src/services/groupChatEngine.js');
const { TOUCH_EVENT_TTL_MS } = await import('../src/services/touchActionService.js');
const hypnosis = await import('../src/services/hypnosisService.js');

after(() => closeDb());

let seq = 0;
function seedCharacter(displayName) {
  const db = getDb();
  seq += 1;
  const info = db.prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')"
  ).run(`tg_${seq}`, displayName);
  return Number(info.lastInsertRowid);
}

function seedGroup(memberIds) {
  const db = getDb();
  seq += 1;
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run(`群${seq}`, '测试').lastInsertRowid);
  for (const id of memberIds) db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id);
  return gid;
}

/** 造一条群聊触摸事件；ageMinutes > 0 = 造一条"已经放了很久"的（过期用例） */
function seedTouchEvent({ groupId, characterId, actionKey = 'pat_head', status = 'pending', mode = 'implicit', ageMinutes = 0, annoyance = 0, likeRatio = 1 }) {
  const db = getDb();
  const createdAt = ageMinutes > 0
    ? `datetime('now', '-${Math.round(ageMinutes)} minutes')`
    : "datetime('now')";
  const info = db.prepare(
    `INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${createdAt}, datetime('now'))`
  ).run(characterId, groupId, actionKey, mode, annoyance, likeRatio, status);
  return Number(info.lastInsertRowid);
}

const statusOf = eventId => getDb().prepare('SELECT status FROM touch_events WHERE id = ?').pluck().get(eventId);
const groupOf = (id, members) => ({ id, members });

// ──────────────── 注入与消费 ────────────────

test('群聊注入：带成员限定行 + 围观规则；事件置 injected（一次动作只注入一次）', () => {
  const a = seedCharacter('甲');
  const b = seedCharacter('乙');
  const gid = seedGroup([a, b]);
  const members = [{ id: a, display_name: '甲' }, { id: b, display_name: '乙' }];
  const eventId = seedTouchEvent({ groupId: gid, characterId: a });

  // task-22 起围观是**真概率**（默认 30%）：本用例只关心动作块与成员限定行，
  // 围观文案交给 bystanderChance: null（关闭概率模型 → 逐字节等于 task-17 版本）来固定。
  // 概率模型本身的三态由 test/touchBystanderChance.test.js 覆盖。
  const first = collectTouchActionBlocks(groupOf(gid, members), { bystanderChance: null });
  assert.equal(first.blocks.length, 2, '动作块 + 围观规则');
  assert.ok(first.blocks[0].startsWith('<touch_action>'), first.blocks[0].slice(0, 40));
  assert.ok(first.blocks[0].includes('【本节只对「甲」生效'), '必须带成员限定行（口径同群聊催眠块）');
  assert.ok(!first.blocks[0].includes('「乙」'), '不能把乙也算进去');
  assert.ok(first.blocks[0].includes('摸头'), '要点出是哪个动作');
  assert.ok(first.blocks[0].includes('把这一下的即时反应写进你这一轮的回复里'), 'implicit 口径');
  assert.ok(first.blocks[0].includes('这是真实发生过的肢体接触'));
  assert.ok(first.blocks[1].includes('<touch_bystander>'), '必须有围观规则块');
  assert.ok(first.blocks[1].includes('最多 1 个人') && first.blocks[1].includes('甲'), '点名让她演、其他人最多 1 人插话（关闭概率模型时的 task-17 口径）');
  assert.deepEqual(first.consumed, { id: eventId, characterId: a, actionKey: 'pat_head', name: '甲', mode: 'implicit' });
  assert.equal(statusOf(eventId), 'injected', '消费即完成');

  const second = collectTouchActionBlocks(groupOf(gid, members), { bystanderChance: null });
  assert.deepEqual(second.blocks, [], '一次动作只注入一次');
  assert.equal(second.consumed, null);
});

test('单轮最多消费 1 条事件（用户裁决「单轮只 1 人插话」），其余留到下一轮', () => {
  const a = seedCharacter('甲');
  const b = seedCharacter('乙');
  const gid = seedGroup([a, b]);
  const members = [{ id: a, display_name: '甲' }, { id: b, display_name: '乙' }];
  const firstEvent = seedTouchEvent({ groupId: gid, characterId: a, actionKey: 'hug' });
  const secondEvent = seedTouchEvent({ groupId: gid, characterId: b, actionKey: 'stroke_hair' });

  const round1 = collectTouchActionBlocks(groupOf(gid, members));
  assert.equal(round1.blocks.length, 2, '本轮只出 1 个动作块 + 1 条围观规则（不是 2 个动作）');
  assert.equal(round1.consumed.characterId, a, '先来先服务');
  assert.equal(statusOf(firstEvent), 'injected');
  assert.equal(statusOf(secondEvent), 'pending', '第二条留到下一轮');

  const round2 = collectTouchActionBlocks(groupOf(gid, members));
  assert.equal(round2.consumed.characterId, b);
  assert.ok(round2.blocks[0].includes('【本节只对「乙」生效'));
  assert.equal(statusOf(secondEvent), 'injected');
});

test('instant 口径：反应已单独发过（status=done + mode=instant）→ 块里写"别再演一遍"', () => {
  const a = seedCharacter('甲');
  const gid = seedGroup([a]);
  const members = [{ id: a, display_name: '甲' }];
  seedTouchEvent({ groupId: gid, characterId: a, status: 'done', mode: 'instant' });

  const result = collectTouchActionBlocks(groupOf(gid, members));
  assert.equal(result.consumed.mode, 'instant');
  assert.ok(result.blocks[0].includes('已经单独发过了'), '必须明确"别再重演"（专题 §七 抢戏风险）');
  assert.ok(!result.blocks[0].includes('把这一下的即时反应写进你这一轮的回复里'), 'instant 不该再要求她演一遍');
});

test('催眠中的成员：块里换成"无条件顺从"（门控豁免同口径）', () => {
  const a = seedCharacter('甲');
  const gid = seedGroup([a]);
  hypnosis.grantHypnosisPhone();
  hypnosis.hypnotize(a, { minutes: 30 });
  seedTouchEvent({ groupId: gid, characterId: a, actionKey: 'touch_breast' });

  const result = collectTouchActionBlocks(groupOf(gid, [{ id: a, display_name: '甲' }]));
  assert.ok(result.blocks[0].includes('无条件顺从'), '催眠态下不做抗拒/腻烦反应');
  assert.ok(result.blocks[0].includes('【本节只对「甲」生效'));
});

// ──────────────── 过期 / 作废 ────────────────

test('过期事件（默认 30 分钟）：标 expired、不注入，且不堵住后面的新鲜事件', () => {
  const a = seedCharacter('甲');
  const b = seedCharacter('乙');
  const gid = seedGroup([a, b]);
  const members = [{ id: a, display_name: '甲' }, { id: b, display_name: '乙' }];

  const stale = seedTouchEvent({ groupId: gid, characterId: a, ageMinutes: (TOUCH_EVENT_TTL_MS / 60000) + 5 });
  const fresh = seedTouchEvent({ groupId: gid, characterId: b });

  const result = collectTouchActionBlocks(groupOf(gid, members));
  assert.equal(result.expired, 1, '过期的那条要被扫掉');
  assert.equal(statusOf(stale), 'expired');
  assert.equal(result.consumed.characterId, b, '过期的先扫掉，不挡住新鲜事件');
  assert.equal(statusOf(fresh), 'injected');
});

test('事件指向的成员已不在群里 → 标 dropped，不堵住后面的正常事件', () => {
  const a = seedCharacter('甲');
  const outsider = seedCharacter('丙');
  const gid = seedGroup([a]);
  const orphan = seedTouchEvent({ groupId: gid, characterId: outsider });
  const fresh = seedTouchEvent({ groupId: gid, characterId: a, actionKey: 'hold_hand' });

  const result = collectTouchActionBlocks(groupOf(gid, [{ id: a, display_name: '甲' }]));
  assert.equal(result.dropped, 1);
  assert.equal(statusOf(orphan), 'dropped');
  assert.equal(result.consumed.characterId, a, '坏行不得把 LIMIT 1 后面的正常事件堵死');
  assert.equal(statusOf(fresh), 'injected');
});

// ──────────────── 开关与非法入参 ────────────────

test('总开关关闭 / 非法 group 参数 → 零注入、不消费', () => {
  const a = seedCharacter('甲');
  const gid = seedGroup([a]);
  const eventId = seedTouchEvent({ groupId: gid, characterId: a });
  const g = groupOf(gid, [{ id: a, display_name: '甲' }]);

  config.features.touch = false;
  try {
    assert.deepEqual(collectTouchActionBlocks(g).blocks, []);
    assert.equal(statusOf(eventId), 'pending', '开关关闭时一个事件都不该被消费掉');
  } finally {
    config.features.touch = true;
  }

  assert.deepEqual(collectTouchActionBlocks(null).blocks, []);
  assert.deepEqual(collectTouchActionBlocks({ id: 0 }).blocks, []);
  assert.deepEqual(collectTouchActionBlocks({ id: 'x' }).blocks, []);
  assert.deepEqual(collectTouchActionBlocks({ id: gid, members: [] }).blocks, [], '没有成员可注入（事件会被标 dropped）');
});
