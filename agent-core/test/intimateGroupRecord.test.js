/**
 * 亲密看板 · 群聊场景记账单测
 *
 * 覆盖「角色↔角色」口径的闭环缺口：群聊一轮只落一条 assistant raw（多角色多行剧本合并），
 * 生图 prompt 不在 raw_messages.prompt 里，而是以 `[说话人]: {prompt}` 的行留在 content 中。
 * 引擎在解析出图片行时按发言角色收集，raw 落库拿到 id 后调用 recordGroupIntimateFromRound 记账。
 *
 * 本文件不跑真实 LLM：直接驱动导出的记账出口 + 用真实 parseScriptLine 模拟"收集"这一步，
 * 并用源码级断言守住挂载点（防止将来被改回成不记账）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate group fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';

const { getDb, closeDb } = await import('../src/db/index.js');
const intimate = await import('../src/services/intimateService.js');
const {
  groupConvId,
  parseScriptLine,
  truncateRoundAfter,
  recordGroupIntimateFromRound,
} = await import('../src/services/groupChatEngine.js');

/** 真实可归类为 vaginal 的生图 prompt（与 intimateAutoRecord.test.js 同一口径） */
const PROMPT = '1girl, solo, sex from behind, arms grab, cum';
/** 无成人内容的普通画面描述：不应产生任何流水 */
const PLAIN_PROMPT = '1girl, solo, indoors, window light';

/**
 * 造一套群聊数据：两个角色 + 一个群 + 成员关系；返回真实列名的 schema 用法。
 * 每个用例结束后关闭连接 → 下一个用例 getDb() 会重新建一份干净的 :memory: 库。
 */
function seedGroupScene(t, { names = ['小美', '阿离', '阿禾'] } = {}) {
  const db = getDb();
  t.after(() => closeDb());
  const characterIds = names.map((name, index) => {
    db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`)
      .run(`gc_${index}_${name}`, name);
    return db.prepare('SELECT max(id) AS id FROM characters').get().id;
  });
  const groupId = db.prepare(`INSERT INTO group_chats (name, topic) VALUES ('测试群', '')`).run().lastInsertRowid;
  for (const id of characterIds) {
    db.prepare(`INSERT INTO group_members (group_id, character_id) VALUES (?, ?)`).run(groupId, id);
  }
  return { db, characterIds, groupId, conversationId: groupConvId(groupId) };
}

/** 按群聊主流程的真实写法落一条 raw + 一个气泡（raw 不带 prompt，prompt 只在剧本行里） */
function insertGroupRound(db, conversationId, { speakerCharacterId, imagePrompt = '' } = {}) {
  const content = imagePrompt
    ? `[小美]: 拍好了\n[小美]: {${imagePrompt}}`
    : '[小美]: 今天天气不错';
  const rawId = db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`
  ).run(conversationId, content).lastInsertRowid;
  db.prepare(
    `INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id)
     VALUES (?, ?, 'assistant', ?, 0, ?)`
  ).run(conversationId, rawId, '拍好了', speakerCharacterId ?? null);
  return rawId;
}

const logRows = (db, characterId) => db.prepare(
  `SELECT * FROM character_intimate_log WHERE character_id = ? ORDER BY id ASC`
).all(characterId);

/**
 * 同一条 raw 下写多个气泡（模拟一轮剧本被分句上屏），返回 msg id 列表。
 * 用于真实驱动 truncateRoundAfter：靠 afterMsgId 决定"整条剧本被删"还是"只剩已上屏分句被重建"。
 */
function insertGroupRoundBubbles(db, conversationId, { speakerCharacterId, imagePrompt = '' } = {}) {
  const content = imagePrompt
    ? `[小美]: 拍好了\n[小美]: {${imagePrompt}}`
    : '[小美]: 今天天气不错';
  const rawId = db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`
  ).run(conversationId, content).lastInsertRowid;
  const msgIds = ['第一句', '第二句'].map((text, seq) => db.prepare(
    `INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id)
     VALUES (?, ?, 'assistant', ?, ?, ?)`
  ).run(conversationId, rawId, text, seq, speakerCharacterId ?? null).lastInsertRowid);
  return { rawId, msgIds };
}

test('群聊一轮：按发言角色记账，scene=group / partnerKind=character / partnerId=0 / raw_id 一致', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker, other] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });

  const result = recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]);
  assert.ok(result.inserted > 0, `应记账成功，实际 ${JSON.stringify(result)}`);
  assert.equal(result.blocked, false);

  const rows = logRows(db, speaker);
  assert.equal(rows.length, result.inserted);
  for (const row of rows) {
    assert.equal(row.scene, 'group');
    assert.equal(row.partner_kind, 'character');
    assert.equal(row.partner_id, 0, '具体对象未知，partnerId 必须固定 0');
    assert.equal(row.raw_id, rawId, '幂等锚点必须是刚落库的 raw id');
    assert.equal(row.source, 'auto');
  }

  // 不替"群里的其他角色"各记一笔：未发言成员零流水
  assert.equal(logRows(db, other).length, 0);
});

test('群聊一轮内多位角色发图：各自记各自那笔，不按群人数放大', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [a, b, idle] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: a, imagePrompt: PROMPT });

  const result = recordGroupIntimateFromRound(rawId, [
    { characterId: a, prompt: PROMPT },
    { characterId: b, prompt: PROMPT },
  ]);

  assert.ok(result.inserted > 0);
  const aRows = logRows(db, a);
  const bRows = logRows(db, b);
  assert.ok(aRows.length > 0 && bRows.length > 0);
  // 两人各自一笔：总数 = 两人之和，而不是 ×3（群成员数）
  assert.equal(aRows.length + bRows.length, result.inserted);
  assert.equal(logRows(db, idle).length, 0);
  // 同一轮里两个角色可以用同一条 raw_id（唯一约束是 (character_id, source_uid)）
  assert.ok(aRows.every(r => r.raw_id === rawId));
  assert.ok(bRows.every(r => r.raw_id === rawId));
});

test('同一 rawId 重复记账幂等：第二次全部 skipped，总数不翻倍', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });

  const first = recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]);
  assert.ok(first.inserted > 0);
  const countAfterFirst = logRows(db, speaker).length;

  const second = recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]);
  assert.equal(second.inserted, 0);
  assert.ok(second.skipped > 0);
  assert.equal(logRows(db, speaker).length, countAfterFirst);
  assert.equal(intimate.getIntimateStats(speaker, { partnerKinds: 'all' }).totalActs, countAfterFirst);
});

test('不带可归类 prompt / 非法入参：零写入', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker });

  // 纯文本群聊回复：没有图片行 → 调用方传空数组
  assert.deepEqual(recordGroupIntimateFromRound(rawId, []), { inserted: 0, skipped: 0, blocked: false });
  assert.deepEqual(recordGroupIntimateFromRound(rawId, null), { inserted: 0, skipped: 0, blocked: false });
  // 有画面描述但无成人 tag：不猜测
  assert.equal(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PLAIN_PROMPT }]).inserted, 0);
  // 缺角色 / 缺 prompt
  assert.equal(recordGroupIntimateFromRound(rawId, [{ characterId: 0, prompt: PROMPT }]).inserted, 0);
  assert.equal(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: '  ' }]).inserted, 0);
  // 无效锚点（raw 已被删的空剧本轮）
  assert.equal(recordGroupIntimateFromRound(0, [{ characterId: speaker, prompt: PROMPT }]).inserted, 0);
  assert.equal(recordGroupIntimateFromRound(null, [{ characterId: speaker, prompt: PROMPT }]).inserted, 0);

  assert.equal(logRows(db, speaker).length, 0);
});

test('锚点 raw 已被删除（撤回/截断）：不记账，避免留下回滚不掉的脏计数', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });
  // 模拟撤回一轮 / 截断把 raw 删掉后再调用（正常流程不会发生，属于防御）
  // 注意顺序：messages.raw_id 有外键，真实撤回路径也是先删气泡再删 raw
  db.prepare('DELETE FROM messages WHERE raw_id = ?').run(rawId);
  db.prepare('DELETE FROM raw_messages WHERE id = ?').run(rawId);

  assert.deepEqual(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]),
    { inserted: 0, skipped: 0, blocked: false });
  assert.equal(logRows(db, speaker).length, 0);
});

test('截断联动：整条剧本未上屏、raw 被删除 → 该笔流水消失且统计回落', t => {
  const { db, characterIds, groupId, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const { rawId } = insertGroupRoundBubbles(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });
  assert.ok(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]).inserted > 0);
  assert.equal(intimate.getIntimateStats(speaker, { partnerKinds: 'all' }).totalActs, 1);

  // 真实截断路径（routes/groups.js 打断播放时调用）：afterMsgId=0 → 本轮气泡全部未上屏 → raw 被删除
  truncateRoundAfter(groupId, 0);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM raw_messages WHERE id = ?').get(rawId).c, 0);
  assert.equal(logRows(db, speaker).length, 0, '被撤回回合的看板流水必须一起消失');
  assert.equal(intimate.getIntimateStats(speaker, { partnerKinds: 'all' }).totalActs, 0);
  assert.equal(intimate.getIntimateStats(speaker, { partnerKinds: 'character' }).totalActs, 0);
});

test('截断联动：raw 被重建（仍有分句上屏）时同样回滚该笔流水', t => {
  const { db, characterIds, groupId, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const { rawId, msgIds } = insertGroupRoundBubbles(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });
  assert.ok(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]).inserted > 0);

  // 保留第一个气泡，只截断第二个 → raw 存在但内容被重建（发图行已被丢弃）
  truncateRoundAfter(groupId, msgIds[0]);

  const raw = db.prepare('SELECT content FROM raw_messages WHERE id = ?').get(rawId);
  assert.ok(raw, 'raw 应被重建而不是删除');
  assert.ok(!raw.content.includes(PROMPT), '重建后的 raw 不再保留生图 prompt 行');
  assert.equal(logRows(db, speaker).length, 0, '重建同样使该笔流水失去锚点依据，必须一起回滚');
  assert.equal(intimate.getIntimateStats(speaker, { partnerKinds: 'all' }).totalActs, 0);
});

test('收尾清理对称回滚：源码级断言删/重建 raw 的路径都调了看板回滚', () => {
  const source = fs.readFileSync(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  // rollbackIntimateQuietly 的定义（内部调用 intimateService.rollbackIntimateByRawId）
  assert.match(source, /function rollbackIntimateQuietly\(rawId\)/);
  assert.match(source, /rollbackIntimateByRawId\(id\)/);
  // 三处 raw 删除/重建路径：截断循环、流中断丢弃、空剧本清理
  assert.ok((source.match(/rollbackIntimateQuietly\(rawId\)/g) || []).length >= 3,
    '每处删/重建 raw 的路径都必须回滚看板流水');
  // 截断路径里看板回滚与记忆回滚同处（rollbackMemoriesFromRawId 在同一函数体内）
  assert.match(source, /rollbackMemoriesFromRawId\(conversationId, rollbackRawId\)/);
});

test('aiEditFields 不含 stats：群聊自动记账被 blocked 且不落库，人工补录不受限', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });

  intimate.upsertBodyProfile(speaker, { aiEditFields: ['body'] });
  const blocked = recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.inserted, 0);
  assert.equal(logRows(db, speaker).length, 0);

  // 人工补录（面板上用户自己点的）不受权限闸门限制
  const manual = intimate.recordIntimateActs(speaker, {
    source: 'manual', scene: 'manual', acts: [{ actKey: 'vaginal' }],
  });
  assert.equal(manual.inserted, 1);
});

test('口径联动：viewScope=[character] 统计到群聊这笔，viewScope=[user] 时为 0', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });
  const recorded = recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]);
  assert.ok(recorded.inserted > 0);

  // 看"角色↔角色"：群聊这笔在口径内
  intimate.upsertBodyProfile(speaker, { viewScope: ['character'] });
  const asCharacter = intimate.getIntimateStats(speaker);
  assert.deepEqual(asCharacter.partnerKinds, ['character']);
  assert.equal(asCharacter.totalActs, recorded.inserted);
  assert.ok(asCharacter.byScene.some(s => s.scene === 'group' && s.count === recorded.inserted));

  // 看"用户↔角色"：同一笔不在口径内 → 0（但流水本身没被删）
  intimate.upsertBodyProfile(speaker, { viewScope: ['user'] });
  assert.equal(intimate.getIntimateStats(speaker).totalActs, 0);
  assert.equal(intimate.getIntimateStats(speaker, { partnerKinds: 'character' }).totalActs, recorded.inserted);
  assert.equal(logRows(db, speaker).length, recorded.inserted);
  assert.equal(intimate.listIntimateLogs(speaker, { partnerKinds: 'all' }).length, recorded.inserted);

  // 面板同样跟随口径
  assert.equal(intimate.getIntimatePanel(speaker).stats.totalActs, 0);
});

test('features.intimate=false：群聊记账直接不写库（总开关口径与 chat.js 一致）', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });

  const previous = config.features.intimate;
  config.features.intimate = false;
  t.after(() => { config.features.intimate = previous; });

  assert.deepEqual(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]),
    { inserted: 0, skipped: 0, blocked: false });
  assert.equal(logRows(db, speaker).length, 0);

  // 重新打开后同一 raw 仍能正常记账
  config.features.intimate = previous;
  assert.ok(recordGroupIntimateFromRound(rawId, [{ characterId: speaker, prompt: PROMPT }]).inserted > 0);
});

test('挂载链路口径：真实 parseScriptLine 解析出的发言角色 + 画面描述 -> 记账', t => {
  const { db, characterIds, conversationId } = seedGroupScene(t);
  const [speaker] = characterIds;
  const rawId = insertGroupRound(db, conversationId, { speakerCharacterId: speaker, imagePrompt: PROMPT });

  // 模拟引擎解析：行协议「角色名: {"prompt":"english scene"}」
  const membersByName = new Map([['小美', { id: speaker, display_name: '小美' }]]);
  const parsed = parseScriptLine(`[小美]: {"prompt":"${PROMPT}"}`, membersByName);
  assert.ok(parsed?.imagePrompt, '图片行应能解析出画面描述');
  assert.equal(parsed.speaker.id, speaker, '发言人必须是该角色 id');

  const result = recordGroupIntimateFromRound(rawId, [{ characterId: parsed.speaker.id, prompt: parsed.imagePrompt }]);
  assert.ok(result.inserted > 0);
  const rows = logRows(db, speaker);
  assert.equal(rows[0].scene, 'group');
  assert.equal(rows[0].partner_kind, 'character');
});

test('源码级断言：群聊一轮的记账挂载点存在（防止被改回成不记账）', () => {
  const source = fs.readFileSync(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');

  // ① 图片行解析处收集"发言角色 + 画面描述"
  assert.match(source, /intimatePrompts\.push\(\{\s*characterId:\s*speaker\.id,\s*prompt:\s*parsed\.imagePrompt\s*\}\)/);
  // ② raw 回填之后调用记账出口，且带上刚落库的 rawId
  assert.match(source, /recordGroupIntimateFromRound\(rawId,\s*intimatePrompts\)/);
  // ③ 固定口径：scene=group / partnerKind=character / partnerId=0
  assert.match(source, /scene:\s*'group'/);
  assert.match(source, /partnerKind:\s*'character'/);
  assert.match(source, /partnerId:\s*0/);
  // ④ 总开关：features.intimate === false 直接返回
  assert.match(source, /config\.features\?\.intimate\s*===\s*false/);
  // ⑤ raw 已被删的空剧本轮不记账
  assert.match(source, /if\s*\(rawContent\s*&&\s*intimatePrompts\.length\s*>\s*0\)/);
  // ⑥ 锚点行存在性前置校验（否则撤回后残留脏计数）
  assert.match(source, /SELECT 1 FROM raw_messages WHERE id = \?/);
});
