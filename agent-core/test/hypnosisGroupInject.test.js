/**
 * 群聊里的催眠手机（task-31）
 *
 * 覆盖两块：
 *   A. **行为级**：`groupChatEngine.collectHypnosisDirectiveBlocks(members)`
 *      —— 只给"真正被催眠"的成员出块；块首必须带**成员限定行**（一轮群聊同时演多个角色，
 *      不加限定模型会把"你"算到所有人头上）；一次性指令消费即清空；总开关关闭零注入；
 *      非法成员安全跳过。
 *   B. **源码级**：`groupChatEngine.js` 里确实在 `buildGroupContext` **之前**调用它，
 *      且整段被 try/catch 兜住（群聊主流程不能被催眠拖垮）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络。
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`hypnosis group fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  grantHypnosisPhone, hypnotize, wake, issueCommand, getHypnosisState,
} = await import('../src/services/hypnosisService.js');
const { collectHypnosisDirectiveBlocks } = await import('../src/services/groupChatEngine.js');

/** 造一个角色（门控要 好感≥阈值 + 誓约 + 有手机，这里直接用 service 的口径） */
function seedCharacter(t, displayName) {
  const db = getDb();
  t.after(() => closeDb());
  const id = Number(db.prepare(
    'INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)'
  ).run(`group_${displayName}`, displayName, `你是${displayName}，说话简短。`).lastInsertRowid);
  db.prepare('INSERT INTO user_relationships (character_id, relationship_text, affinity, is_oath) VALUES (?, ?, ?, 1)')
    .run(id, '恋人', 100);
  return { db, id, member: { id, display_name: displayName } };
}

const SCOPE = name => `【本节只对「${name}」生效`;

// ──────────────── A. 行为级 ────────────────

test('未被催眠的成员：零注入（不产生任何块）', async t => {
  const a = seedCharacter(t, '甲');
  const b = seedCharacter(t, '乙');
  grantHypnosisPhone();
  const { blocks, hypnotized } = collectHypnosisDirectiveBlocks([a.member, b.member]);
  assert.deepEqual(blocks, []);
  assert.deepEqual(hypnotized, []);
});

test('深度催眠的成员：出状态块 + 成员限定行（只对他生效）', async t => {
  const a = seedCharacter(t, '甲');
  const b = seedCharacter(t, '乙');
  grantHypnosisPhone();
  hypnotize(a.id, { minutes: 30 });

  const { blocks, hypnotized } = collectHypnosisDirectiveBlocks([a.member, b.member]);
  assert.equal(blocks.length, 1, `应只有甲的块：${blocks.length}`);
  assert.ok(blocks[0].includes(SCOPE('甲')), '必须带成员限定行');
  assert.ok(blocks[0].includes('完全控制'), '深度催眠＝完全控制口径');
  assert.ok(!blocks[0].includes(SCOPE('乙')), '不能把乙也算进去');
  assert.deepEqual(hypnotized, [{ id: a.id, name: '甲' }]);
});

test('只唤醒意志的成员：限定行 + 撕裂口径（与深度催眠区分）', async t => {
  const a = seedCharacter(t, '甲');
  grantHypnosisPhone();
  hypnotize(a.id, { minutes: 30 });
  wake(a.id, { mode: 'mind' });

  // task-42：「只唤醒意志」同样是一次真实的醒来 ⇒ 会多一块一次性的 <hypnosis_wake_reaction>。
  // 先把它取走（消费即清空），后面的断言仍然只看状态块的撕裂口径。
  const first = collectHypnosisDirectiveBlocks([a.member]);
  assert.equal(first.blocks.length, 2, `状态块 + 唤醒反应块：${first.blocks.length}`);
  assert.ok(first.blocks[1].includes('<hypnosis_wake_reaction>'), '只唤醒意志也要有"刚被唤醒"的反应');
  assert.ok(first.blocks[1].includes(SCOPE('甲')), '唤醒反应块同样要限定到本人');

  const { blocks } = collectHypnosisDirectiveBlocks([a.member]);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes(SCOPE('甲')));
  assert.ok(blocks[0].includes('意志已经完全清醒'), '只唤醒意志口径');
  assert.ok(!blocks[0].includes('完全控制'), '不该混进深度催眠口径');
});

test('多人各态：每人一块，互不串台', async t => {
  const a = seedCharacter(t, '甲');
  const b = seedCharacter(t, '乙');
  grantHypnosisPhone();
  hypnotize(a.id, { minutes: 30 });              // 甲：深度（完全控制）
  hypnotize(b.id, { minutes: 30 }); wake(b.id, { mode: 'mind' });  // 乙：只唤醒意志

  const { blocks, hypnotized } = collectHypnosisDirectiveBlocks([a.member, b.member]);
  // 甲：只有状态块；乙：状态块 + 一次性的唤醒反应块（task-42：「只唤醒意志」也算刚被唤醒）
  assert.equal(blocks.length, 3);
  assert.equal(blocks.filter(x => x.includes('<hypnosis_wake_reaction>')).length, 1, '唤醒反应块只属于乙');
  assert.ok(blocks[0].includes(SCOPE('甲')) && blocks[0].includes('完全控制'));
  assert.ok(blocks[1].includes(SCOPE('乙')) && blocks[1].includes('意志已经完全清醒'));
  assert.ok(blocks[2].includes(SCOPE('乙')) && blocks[2].includes('<hypnosis_wake_reaction>'));
  assert.deepEqual(hypnotized.map(h => h.name), ['甲', '乙']);
});

test('一次性指令（强制高潮）：只注入一轮，第二次调用即清空', async t => {
  const a = seedCharacter(t, '甲');
  grantHypnosisPhone();
  hypnotize(a.id, { minutes: 30 });
  issueCommand(a.id, 'forced_climax');

  const first = collectHypnosisDirectiveBlocks([a.member]);
  // task-1 起，强制高潮额外带一块「本轮必须发图行」的硬指令 ⇒ 状态块 + 指令块 + 发图硬指令
  assert.equal(first.blocks.length, 3, '状态块 + 指令块 + 强制发图硬指令');
  assert.ok(first.blocks[1].includes('<hypnosis_command kind="forced_climax">'));
  assert.ok(first.blocks[1].includes(SCOPE('甲')), '指令块也要限定到本人');
  assert.ok(first.blocks[2].includes('<forced_climax_image>'), '必须要求该角色本轮发出图行');
  assert.ok(first.blocks[2].includes('甲'), '发图硬指令要点名到本人');
  assert.deepEqual(first.forcedClimax, [{ id: a.id, name: '甲' }], '记录本轮强制高潮的成员供出图兜底');

  const second = collectHypnosisDirectiveBlocks([a.member]);
  assert.equal(second.blocks.length, 1, '第二次只剩状态块（指令已消费）');
  assert.ok(!second.blocks[0].includes('forced_climax'));
  assert.deepEqual(second.forcedClimax, [], '指令已消费 ⇒ 不再有强制高潮成员');
});

test('总开关关闭时零注入；非法成员 / 空入参安全', async t => {
  const a = seedCharacter(t, '甲');
  grantHypnosisPhone();
  hypnotize(a.id, { minutes: 30 });

  config.features = { ...config.features, hypnosis: false };
  try {
    assert.deepEqual(collectHypnosisDirectiveBlocks([a.member]), { blocks: [], hypnotized: [], forcedClimax: [] });
  } finally {
    config.features = { ...config.features, hypnosis: true };
  }

  assert.deepEqual(collectHypnosisDirectiveBlocks([]), { blocks: [], hypnotized: [], forcedClimax: [] });
  assert.deepEqual(collectHypnosisDirectiveBlocks(null), { blocks: [], hypnotized: [], forcedClimax: [] });
  assert.deepEqual(collectHypnosisDirectiveBlocks([{ id: 0 }, { id: 'x' }, null]), { blocks: [], hypnotized: [], forcedClimax: [] });
});

test('过期状态不再注入（惰性过期后 active=false）', async t => {
  const a = seedCharacter(t, '甲');
  grantHypnosisPhone();
  hypnotize(a.id, { minutes: 1 });
  // 直接把 active_until 改到过去，触发惰性过期
  a.db.prepare("UPDATE character_hypnosis SET active_until = datetime('now','-5 minutes') WHERE character_id = ?").run(a.id);
  const st = getHypnosisState(a.id);
  assert.equal(st.active, false, '应已过期');
  assert.deepEqual(collectHypnosisDirectiveBlocks([a.member]).blocks, []);
});

// ──────────────── B. 源码级 ────────────────

test('groupChatEngine 挂点：注入在 buildGroupContext 之前且被 try/catch 兜住', async () => {
  const source = await readFile(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  const callAt = source.indexOf('collectHypnosisDirectiveBlocks(group.members)');
  assert.ok(callAt > 0, 'runGroupRound 里没有调用 collectHypnosisDirectiveBlocks');
  const buildAt = source.indexOf('buildGroupContext(group, directiveBlocks', callAt);
  assert.ok(buildAt > callAt, '注入必须发生在 buildGroupContext 之前');
  // task-1 在注入与 buildGroupContext 之间插了遗忘窗口解析（resolveTranscriptExcludeRanges），
  // 距离比 task-31 时更长；这里仍卡住"同一段直落代码、没有别的分支夹进来"的量级。
  assert.ok(buildAt - callAt < 2000, `注入点应紧邻 buildGroupContext（差 ${buildAt - callAt} 字符）`);
  const guardAt = source.lastIndexOf('config.features.hypnosis === false', callAt);
  assert.ok(guardAt > 0, '总开关必须在 collect 内生效');
  // 守卫写在 collectHypnosisDirectiveBlocks 体内（函数定义在文件上部，调用点在 runGroupRound 里），
  // 所以这里断言"守卫确实落在该函数体内"，而不是去量它和调用点的距离。
  const defineAt = source.lastIndexOf('export function collectHypnosisDirectiveBlocks', guardAt);
  assert.ok(defineAt > 0 && guardAt - defineAt < 600, '总开关应写在 collectHypnosisDirectiveBlocks 函数体内');
  assert.match(source, /console\.warn\('\[hypnosis\] group collect failed:', err\.message\)/, '缺少群聊注入的失败兜底');
  assert.match(source, /console\.warn\(`\[hypnosis\] group inject failed for \$\{label\}:`, err\.message\)/, '缺少单成员失败兜底');
});
