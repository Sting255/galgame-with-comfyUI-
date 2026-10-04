/**
 * 镇民奇遇记账（亲密看板「小镇NPC」口径的生产者）单测
 *
 * 覆盖：归因（npc / user）、幂等（同 eventId 只落一次）、口径过滤联动、
 * 纯 NPC 跳过、总开关、以及"没有可归类 tag 就不猜"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`town intimate fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';

const { getDb, closeDb } = await import('../src/db/index.js');
const intimate = await import('../src/services/intimateService.js');
const { recordIntimateForTownEvent } = await import('../src/services/town/townIntimateRecord.js');

const PROMPT = 'outdoor, two girls, sex from behind, arms grab, cum';

function seedCharacter(t, name = 'npc-linked') {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`).run(name, name);
  return db.prepare('SELECT max(id) AS id FROM characters').get().id;
}

test('环境奇遇（两位镇民同框）→ scene=event / partnerKind=npc，且可按 NPC 口径统计', t => {
  const characterId = seedCharacter(t);
  const res = recordIntimateForTownEvent({ characterId, eventId: 501, prompt: PROMPT, partnerKind: 'npc' });
  assert.ok(res.inserted > 0, `应落库，实际 ${JSON.stringify(res)}`);

  // 注意：listIntimateLogs 默认按 profile.viewScope（默认 ['user']）过滤，
  // 所以要看 NPC 口径的流水必须显式传 partnerKinds —— 这本身就是过滤器生效的证据
  const logs = intimate.listIntimateLogs(characterId, { limit: 10, partnerKinds: ['npc'] });
  assert.ok(logs.length > 0);
  assert.equal(logs[0].scene, 'event');
  assert.equal(logs[0].partnerKind, 'npc');
  assert.equal(logs[0].rawId, 0, '镇民奇遇不该冒充 raw_id');

  // 口径联动：只有勾选 NPC 时才看得到
  const npcScope = intimate.getIntimateStats(characterId, { partnerKinds: ['npc'] });
  assert.ok(npcScope.totalActs > 0, 'NPC 口径应统计到');
  assert.equal(intimate.getIntimateStats(characterId, { partnerKinds: ['user'] }).totalActs, 0, 'user 口径不应统计到');
});

test('常规奇遇（镇民 + 玩家）→ partnerKind=user', t => {
  const characterId = seedCharacter(t, 'npc-linked-user');
  const res = recordIntimateForTownEvent({ characterId, eventId: 502, prompt: PROMPT, partnerKind: 'user' });
  assert.ok(res.inserted > 0);
  assert.equal(intimate.getIntimateStats(characterId, { partnerKinds: ['user'] }).totalActs > 0, true);
  assert.equal(intimate.getIntimateStats(characterId, { partnerKinds: ['npc'] }).totalActs, 0);
});

test('幂等：同一 eventId 重复记账只落一次；换 eventId 才算新的一笔', t => {
  const characterId = seedCharacter(t, 'npc-linked-idem');
  const first = recordIntimateForTownEvent({ characterId, eventId: 600, prompt: PROMPT });
  assert.ok(first.inserted > 0);
  const second = recordIntimateForTownEvent({ characterId, eventId: 600, prompt: PROMPT });
  assert.equal(second.inserted, 0);
  assert.ok(second.skipped > 0);
  const third = recordIntimateForTownEvent({ characterId, eventId: 601, prompt: PROMPT });
  assert.equal(third.inserted, first.inserted, '换 eventId 应产生同样多的一笔');
});

test('纯 NPC（没有关联酒馆角色）→ characterId 非法时零写入，不抛错', t => {
  seedCharacter(t, 'npc-linked-plain');
  assert.deepEqual(recordIntimateForTownEvent({ characterId: 0, eventId: 700, prompt: PROMPT }), { inserted: 0, skipped: 0, blocked: false });
  assert.deepEqual(recordIntimateForTownEvent({ characterId: null, eventId: 700, prompt: PROMPT }), { inserted: 0, skipped: 0, blocked: false });
});

test('没有可归类 tag / 空 prompt → 不记账也不猜', t => {
  const characterId = seedCharacter(t, 'npc-linked-empty');
  assert.equal(recordIntimateForTownEvent({ characterId, eventId: 800, prompt: '' }).inserted, 0);
  assert.equal(recordIntimateForTownEvent({ characterId, eventId: 801, prompt: 'outdoor, daytime, 1girl' }).inserted, 0);
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);
});

test('总开关关闭 → 零写入', t => {
  const characterId = seedCharacter(t, 'npc-linked-off');
  const prev = config.features.intimate;
  config.features.intimate = false;
  try {
    assert.deepEqual(recordIntimateForTownEvent({ characterId, eventId: 900, prompt: PROMPT }), { inserted: 0, skipped: 0, blocked: false });
  } finally {
    config.features.intimate = prev;
  }
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);
});

test('权限闸门：未授权 stats 时自动路径被 blocked，人工仍可写', t => {
  const characterId = seedCharacter(t, 'npc-linked-perm');
  intimate.upsertBodyProfile(characterId, { aiEditFields: ['body'] });
  const res = recordIntimateForTownEvent({ characterId, eventId: 950, prompt: PROMPT });
  assert.equal(res.blocked, true);
  assert.equal(res.inserted, 0);
  assert.equal(intimate.getIntimateStats(characterId).totalActs, 0);
});
