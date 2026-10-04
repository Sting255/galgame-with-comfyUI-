/**
 * 亲密看板 × 聊天 / 奇遇链路集成回归
 *
 * 覆盖两件事：
 *   A. 行为链路：会话尾部自动记账（幂等）、撤回联动、清空联动、注入联动、权限闸门、
 *      奇遇场景记账（显式 sourceUid 幂等、raw_id 保持 0、总开关关闭零写入）。
 *   B. 挂点契约：读 chat.js / eventGenerator.js 源码断言挂点还在。
 *      为什么要源码断言：这些挂点处在 2000+ 行的聊天主链路上，极易在后续重构里被顺手删掉，
 *      而"删掉"不会让任何功能测试变红——只有源码断言能兜住这类静默回归。
 *      （口径与 test/intimateApi.test.js 的"读 app.js 源码断言挂载"一致。）
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import（config 在 import 期读环境变量）；
 * globalThis.fetch 直接抛错挡网络——本文件不应产生任何真实外部请求。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate chat integration fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  clearIntimateData,
  getBodyProfile,
  getIntimateStats,
  listFirsts,
  listIntimateLogs,
  listIntimateVocabulary,
  recordIntimateActs,
  resolvePositionKey,
  rollbackIntimateByRawId,
  upsertBodyProfile,
} = await import('../src/services/intimateService.js');
const { buildIntimateProfileBlock } = await import('../src/services/intimatePrompt.js');
const { recordFromConversationTail } = await import('../src/services/intimateAutoRecord.js');
const { recordIntimateForEvent } = await import('../src/services/eventGenerator.js');

/** 每个用例独立一份 :memory: 库：closeDb() 后 getDb() 会重建并重跑迁移与知识库种子 */
function seedCharacter(t, name = 'lin') {
  const db = getDb();
  t.after(() => closeDb());
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
  ).run(name, name);
  const characterId = Number(lastInsertRowid);
  return { db, characterId, conversationId: `char_${characterId}` };
}

/** 造一条 assistant 原始消息（可选带生图 prompt），返回 raw_id */
function insertAssistantRaw(db, conversationId, prompt = null) {
  return Number(db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, 'assistant', ?, ?)`
  ).run(conversationId, prompt ? `(图片) {"prompt":"${prompt}"}` : '普通回复', prompt).lastInsertRowid);
}

/**
 * 取一个生图 prompt 里能精确命中的体位 tag。
 * 优先 69（词表里的单 token 打包 key，知识库种子稳定包含），取不到就退回任意单 token key。
 */
function pickExactPositionKey() {
  const keys = listIntimateVocabulary().positions.map(p => p.key);
  for (const candidate of ['69', ...keys.filter(k => !k.includes(','))]) {
    if (resolvePositionKey(candidate)) return candidate;
  }
  return '';
}

// ──────────────── A. 行为链路 ────────────────

test('recordFromConversationTail：尾部带生图 prompt 的 assistant 原始消息自动记账，重放幂等', async t => {
  const { db, characterId, conversationId } = seedCharacter(t);
  const rawId = insertAssistantRaw(db, conversationId, '1girl, bedroom, creampie, fellatio');

  const first = recordFromConversationTail({ characterId, conversationId, scene: 'chat', partnerKind: 'user' });
  assert.equal(first.rawId, rawId, '尾部锚点必须是刚落库的那条 raw');
  assert.equal(first.blocked, false);
  // creampie → vaginal、fellatio → oral，各一条
  assert.deepEqual(first.acts.map(a => a.actKey).sort(), ['oral', 'vaginal']);
  assert.equal(first.inserted, 2);

  // 同一轮重放（重连/重试/重复调用）：source_uid 含 raw_id，全部落 skipped，总数不翻倍
  const second = recordFromConversationTail({ characterId, conversationId, scene: 'chat', partnerKind: 'user' });
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);
  assert.equal(getIntimateStats(characterId).totalActs, 2);

  // 所有流水都锚在这条 raw 上：撤回一轮按 raw_id 删，才删得干净
  const rows = listIntimateLogs(characterId, { partnerKinds: 'all' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.rawId === rawId && r.scene === 'chat' && r.partnerKind === 'user'));
});

test('recordFromConversationTail：身体接触类 prompt 归到 position_key，无 prompt 的回合零写入', async t => {
  const { db, characterId, conversationId } = seedCharacter(t);
  const postureKey = pickExactPositionKey();
  assert.ok(postureKey, '词表应至少有一个可精确命中的体位 tag（知识库种子 222 条）');

  const rawId = insertAssistantRaw(db, conversationId, `creampie, ${postureKey}`);
  const res = recordFromConversationTail({ characterId, conversationId, scene: 'chat', partnerKind: 'user' });
  assert.equal(res.inserted, 1);
  const vaginal = listIntimateLogs(characterId, { partnerKinds: 'all' }).find(r => r.rawId === rawId && r.actKey === 'vaginal');
  assert.ok(vaginal, 'creampie 应归到 vaginal');
  assert.equal(vaginal.positionKey, postureKey);

  // 尾部换成不带 prompt 的回复：同会话再记账不会再新增（拿不到 prompt 就不猜）
  const before = getIntimateStats(characterId).totalActs;
  db.prepare(`UPDATE raw_messages SET prompt = NULL WHERE id = ?`).run(rawId);
  const again = recordFromConversationTail({ characterId, conversationId, scene: 'chat', partnerKind: 'user' });
  assert.equal(again.rawId, 0);
  assert.equal(again.inserted, 0);
  assert.equal(getIntimateStats(characterId).totalActs, before);
});

test('撤回一轮联动：rollbackIntimateByRawId 后统计回落、derived 里程碑被清空', async t => {
  const { characterId } = seedCharacter(t);
  recordIntimateActs(characterId, {
    scene: 'chat', partnerKind: 'user', rawId: 11,
    acts: [{ actKey: 'vaginal', positionKey: 'missionary', count: 3 }],
  });
  recordIntimateActs(characterId, {
    scene: 'chat', partnerKind: 'user', rawId: 12,
    acts: [{ actKey: 'oral', count: 1 }],
  });
  assert.equal(getIntimateStats(characterId, { partnerKinds: 'all' }).totalActs, 4);
  assert.ok(listFirsts(characterId).some(f => f.actKey === 'vaginal' && f.source === 'derived'));

  const rolled = rollbackIntimateByRawId(11);
  assert.equal(rolled.deleted, 1);
  assert.deepEqual(rolled.characters, [characterId]);

  const after = getIntimateStats(characterId, { partnerKinds: 'all' });
  assert.equal(after.totalActs, 1, 'raw_id=11 的行删掉后统计必须回落');
  assert.ok(!listFirsts(characterId).some(f => f.actKey === 'vaginal'), 'derived 里程碑要随流水一起消失');
  assert.ok(listFirsts(characterId).some(f => f.actKey === 'oral'), '别的 raw 的里程碑不受牵连');
  // 无锚点/非法锚点不误删
  assert.deepEqual(rollbackIntimateByRawId(0), { deleted: 0, characters: [] });
});

test('清空会话联动：clearIntimateData 清流水与里程碑，但保留身体档案', async t => {
  const { characterId } = seedCharacter(t);
  upsertBodyProfile(characterId, {
    height: '168', bust: '88', waist: '58', hip: '89', cup: 'D', note: '肩膀怕痒', injectEnabled: true,
  });
  recordIntimateActs(characterId, { scene: 'chat', partnerKind: 'user', rawId: 21, acts: [{ actKey: 'vaginal', count: 2 }] });
  assert.equal(getIntimateStats(characterId).totalActs, 2);
  assert.ok(listFirsts(characterId).length > 0);

  const cleared = clearIntimateData(characterId);
  assert.equal(cleared.logs, 1);
  assert.ok(cleared.firsts > 0);
  assert.equal(getIntimateStats(characterId).totalActs, 0);
  assert.deepEqual(listFirsts(characterId), []);
  assert.deepEqual(listIntimateLogs(characterId, { partnerKinds: 'all' }), []);

  // 身体档案是用户手工维护的设定，清会话不该连带清掉
  const profile = getBodyProfile(characterId);
  assert.equal(profile.height, '168');
  assert.equal(profile.cup, 'D');
  assert.equal(profile.note, '肩膀怕痒');
  assert.equal(profile.injectEnabled, true);
});

test('注入联动：开关关闭零注入；开启且有档案时给出 ≤600 字符的 <intimate_profile> 块', async t => {
  const { characterId } = seedCharacter(t);
  upsertBodyProfile(characterId, { height: '168', bust: '88', waist: '58', hip: '89', cup: 'D' });
  assert.equal(buildIntimateProfileBlock(characterId, { chatUserName: '你' }), '', 'injectEnabled 默认关闭 → 零注入');

  upsertBodyProfile(characterId, {
    injectEnabled: true,
    note: '肩膀怕痒',
    sensitiveZones: [{ key: 'neck', label: '脖颈', level: 4 }, { key: 'ear', label: '耳后', level: 2 }],
  });
  const block = buildIntimateProfileBlock(characterId, { chatUserName: '你' });
  assert.ok(block.startsWith('<intimate_profile>\n'), '首行必须是开标签');
  assert.ok(block.endsWith('\n</intimate_profile>'), '末行必须是闭标签');
  assert.ok(block.length <= 600, `默认预算 600 字符，实际 ${block.length}`);
  assert.match(block, /身高 168/);
  assert.match(block, /脖颈\(很强\)/);
  assert.match(block, /禁止复述具体数字/);

  // 档案清空但开关还开着：仍然零注入（不能注入空壳）
  const blankId = seedCharacter(t, 'empty').characterId;
  upsertBodyProfile(blankId, { injectEnabled: true });
  assert.equal(buildIntimateProfileBlock(blankId), '');
});

test('权限闸门：aiEditFields 不含 stats 时自动记账被阻断，人工补录仍可写', async t => {
  const { characterId } = seedCharacter(t);
  upsertBodyProfile(characterId, { aiEditFields: ['body'] });

  const blocked = recordIntimateActs(characterId, {
    scene: 'chat', partnerKind: 'user', rawId: 31, acts: [{ actKey: 'vaginal' }],
  });
  assert.deepEqual(blocked, { inserted: 0, skipped: 0, blocked: true });
  assert.equal(getIntimateStats(characterId).totalActs, 0);

  // 奇遇链路同样过闸门（内部走 recordIntimateActs）
  const eventBlocked = recordIntimateForEvent({ characterId, eventId: 5, prompt: 'creampie' });
  assert.equal(eventBlocked.blocked, true);
  assert.equal(eventBlocked.inserted, 0);

  // 人工补录是用户自己点的，一律放行
  const manual = recordIntimateActs(characterId, {
    scene: 'manual', partnerKind: 'user', source: 'manual',
    acts: [{ actKey: 'vaginal', customLabel: '用户补录' }],
  });
  assert.equal(manual.blocked, false);
  assert.equal(manual.inserted, 1);
  assert.equal(getIntimateStats(characterId).totalActs, 1);

  // 重新授权 stats 后自动记账恢复
  upsertBodyProfile(characterId, { aiEditFields: ['stats'] });
  const allowed = recordIntimateActs(characterId, {
    scene: 'chat', partnerKind: 'user', rawId: 32, acts: [{ actKey: 'oral' }],
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.inserted, 1);
});

test('奇遇场景记账：显式 sourceUid 幂等、raw_id 保持 0、无 tag 与总开关关闭都不写库', async t => {
  const { characterId } = seedCharacter(t);
  const prompt = 'creampie, fellatio, bedroom'; // vaginal + oral

  const first = recordIntimateForEvent({ characterId, eventId: 77, prompt });
  assert.equal(first.blocked, false);
  assert.equal(first.inserted, 2);

  // 同一事件重放（重复结算/重试）：只落一次
  const second = recordIntimateForEvent({ characterId, eventId: 77, prompt });
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);

  const rows = listIntimateLogs(characterId, { partnerKinds: 'all' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.scene === 'event' && r.rawId === 0), '事件流水不占用 raw_id，撤回聊天不会误删它');
  assert.equal(getIntimateStats(characterId).totalActs, 2, '默认口径（用户↔角色 + 角色↔角色）应能看到事件行');

  // 另一个事件 id → 另一套 sourceUid，互不覆盖
  assert.equal(recordIntimateForEvent({ characterId, eventId: 78, prompt }).inserted, 2);
  assert.equal(getIntimateStats(characterId).totalActs, 4);

  // 拿不到 prompt / 没有成人 tag / 非法事件 id → 什么都不记，不猜测
  assert.equal(recordIntimateForEvent({ characterId, eventId: 79, prompt: '1girl, classroom, sunlight' }).inserted, 0);
  assert.equal(recordIntimateForEvent({ characterId, eventId: 80, prompt: '' }).inserted, 0);
  assert.equal(recordIntimateForEvent({ characterId, eventId: 0, prompt }).inserted, 0);
  assert.equal(getIntimateStats(characterId).totalActs, 4);

  // 总开关关闭：奇遇链路零写入
  const prev = config.features.intimate;
  config.features.intimate = false;
  try {
    assert.deepEqual(recordIntimateForEvent({ characterId, eventId: 81, prompt }), { inserted: 0, skipped: 0, blocked: false });
    assert.equal(getIntimateStats(characterId).totalActs, 4);
  } finally {
    config.features.intimate = prev;
  }
});

// ──────────────── B. 挂点契约（源码级） ────────────────

test('chat.js 挂点契约：撤回×2、清空×1、注入×1、尾部记账定义 + ≥2 调用', async () => {
  const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  const at = (needle, label = needle) => {
    const i = source.indexOf(needle);
    assert.ok(i >= 0, `chat.js 缺少挂点：${label}`);
    return i;
  };

  // 依赖导入（只锁"符号 + 来源模块"，不锁同一 import 语句里的其余符号与格式）
  assert.match(source, /^import \{[^}]*\bclearIntimateData\b[^}]*\} from '\.\.\/services\/intimateService\.js';$/m, '未 import clearIntimateData');
  assert.match(source, /^import \{[^}]*\brollbackIntimateByRawId\b[^}]*\} from '\.\.\/services\/intimateService\.js';$/m, '未 import rollbackIntimateByRawId');
  assert.match(source, /^import \{ buildIntimateProfileBlock \} from '\.\.\/services\/intimatePrompt\.js';$/m, '未 import buildIntimateProfileBlock');
  assert.match(source, /^import \{[^}]*\brecordFromConversationTail\b[^}]*\} from '\.\.\/services\/intimateAutoRecord\.js';$/m, '未 import recordFromConversationTail');
  assert.match(source, /^import \{[^}]*\brecordUnspecifiedFromRawId\b[^}]*\} from '\.\.\/services\/intimateAutoRecord\.js';$/m, '未 import recordUnspecifiedFromRawId（正文兜底）');

  // ① 撤回：两条路径都必须与记忆同步回滚，但**锚点语义不同**，必须分开锁：
  //    · 仅 agent 消息分支：撤回的就是最后一条 assistant raw，记账锚点与之一致 → 等值回滚
  //    · 有 user 消息分支：删除按 id >= lastUserRawId 整段删，而自动记账锚在**本轮 assistant raw**
  //      （recordIntimateFromTail 取会话尾部带 prompt 的 assistant raw）→ 等值回滚会命中 0 行、
  //      raw 却照删，流水变孤儿且 totalActs 不回落（task-6 用真实 HTTP 复现过：user raw=55 / assistant raw=56）。
  //      所以这里必须按**区间**回滚并带 conversationId 收敛。
  assert.match(source, /^import \{[^}]*\brollbackIntimateByRawIdRange\b[^}]*\} from '\.\.\/services\/intimateService\.js';$/m,
    '未 import rollbackIntimateByRawIdRange');

  const proactiveMem = at('rollbackMemoriesFromRawId(conversationId, lastRawId);', '仅 agent 消息分支的记忆回滚');
  const proactiveIntimate = at('rollbackIntimateByRawId(lastRawId);', '仅 agent 消息分支的看板回滚');
  assert.ok(proactiveIntimate > proactiveMem && proactiveIntimate - proactiveMem < 400, '看板回滚必须紧跟同一 raw_id 的记忆回滚');

  const roundMem = at('rollbackMemoriesFromRawId(conversationId, lastUserRawId);', '撤回一轮分支的记忆回滚');
  const roundRangeCall = at('rollbackIntimateByRawIdRange(lastUserRawId, maxRawId, { conversationId });', '撤回一轮分支的区间回滚');
  assert.ok(roundRangeCall > roundMem && roundRangeCall - roundMem < 1200, '看板区间回滚必须紧跟同一处的记忆回滚');
  const maxRawIdLookup = at('SELECT MAX(id) AS id FROM raw_messages WHERE conversation_id = ?', '撤回区间上界的会话内查询');
  assert.ok(maxRawIdLookup < roundRangeCall, '必须先查会话内 MAX(id)、再按区间回滚（顺序反了会漏删本轮助手 raw）');
  const equalityCalls = source.match(/^\s*rollbackIntimateByRawId\(/gm) || [];
  assert.equal(equalityCalls.length, 1, '等值回滚只允许出现在"仅 agent 消息"分支；有 user 消息的分支必须用区间回滚');

  // ② 清空会话：必须在 DELETE /characters/:id/messages 分支内，且早于 last-round 路由定义
  const clearRoute = at("router.delete('/characters/:id/messages',", '清空会话路由');
  const lastRoundRoute = at("router.delete('/characters/:id/messages/last-round'", '撤回一轮路由');
  const clearCall = at('clearIntimateData(charId);', '清空会话的看板清理');
  assert.ok(clearCall > clearRoute && clearCall < lastRoundRoute, 'clearIntimateData 必须在清空会话分支内调用');

  // ③ 注入：buildIntimateProfileBlock 必须落在 features.intimate 守卫内，且空串不 push（零注入）
  const injectGuard = at('if (config.features.intimate !== false) {', '注入总开关守卫');
  const injectCall = at('buildIntimateProfileBlock(characterId, { chatUserName })', '档案注入调用');
  assert.ok(injectCall > injectGuard && injectCall - injectGuard < 300, '注入调用必须在 features.intimate 守卫内');
  assert.match(source.slice(injectCall, injectCall + 240), /if \(intimateBlock\) dynamicBlocks\.push\(intimateBlock\);/,
    '空串不能 push（否则会注入空块）');

  // ④ 尾部记账：唯一一份定义（自身带 features.intimate 守卫）+ 至少两处调用，调用处必须判本轮有生图 prompt
  const tailLines = source.split('\n').filter(line => /recordIntimateFromTail\(/.test(line));
  const definitionLines = tailLines.filter(line => /^\s*function recordIntimateFromTail\(/.test(line));
  const callLines = tailLines.filter(line => !/^\s*function recordIntimateFromTail\(/.test(line));
  assert.equal(definitionLines.length, 1, 'recordIntimateFromTail 应只有一处定义');
  assert.ok(callLines.length >= 2, `recordIntimateFromTail 至少两处调用（主流式 + needImage），实际 ${callLines.length}`);
  assert.ok(callLines.every(line => /tags\.prompt/.test(line)), '每处调用都要先判本轮确实有生图 prompt');

  const defAt = at('function recordIntimateFromTail(characterId, conversationId) {', '尾部记账定义');
  assert.match(source.slice(defAt, defAt + 320), /if \(config\.features\.intimate === false\) return;/, '定义内必须有总开关守卫');

  // ④b 正文兜底（没有生图 prompt 的纯文字轮次）：定义唯一 + 恰好两处调用，且必须落在 ④ 的 else 分支上。
  //    互斥是关键：有 prompt 走 tag 归类、没 prompt 才走兜底，两处都记账会把同一轮算两次。
  const fallbackLines = source.split('\n').filter(line => /recordIntimateTextFallback\(/.test(line));
  const fallbackDefs = fallbackLines.filter(line => /^\s*function recordIntimateTextFallback\(/.test(line));
  const fallbackCalls = fallbackLines.filter(line => !/^\s*function recordIntimateTextFallback\(/.test(line));
  assert.equal(fallbackDefs.length, 1, 'recordIntimateTextFallback 应只有一处定义');
  assert.equal(fallbackCalls.length, 2, `正文兜底应恰好两处调用（主流式 + needImage），实际 ${fallbackCalls.length}`);
  assert.ok(fallbackCalls.every(line => /^\s*else\b/.test(line)), '正文兜底只能出现在 if (tags.prompt) 的 else 分支（与归类记账互斥）');
  const fallbackDefAt = at('function recordIntimateTextFallback(characterId, rawId) {', '正文兜底定义');
  assert.match(source.slice(fallbackDefAt, fallbackDefAt + 360), /if \(config\.features\.intimate === false\) return;/, '正文兜底定义内必须有总开关守卫');
});

test('eventGenerator.js 挂点契约：concludeEvent 调用奇遇记账，幂等锚点是显式 sourceUid', async () => {
  const source = await readFile(new URL('../src/services/eventGenerator.js', import.meta.url), 'utf8');

  const fnAt = source.indexOf('export function recordIntimateForEvent(');
  assert.ok(fnAt >= 0, 'eventGenerator.js 必须导出 recordIntimateForEvent');
  const fnBody = source.slice(fnAt, fnAt + 1600);
  assert.match(fnBody, /if \(config\.features\.intimate === false\) return empty;/, '总开关关闭要直接返回');
  assert.ok(fnBody.includes('sourceUid: `event:${evId}:${act.actKey}:${act.positionKey}`'),
    '幂等锚点必须是 event:<eventId>:<actKey>:<positionKey> 的显式 sourceUid');
  assert.match(fnBody, /scene: 'event'/);

  // 必须在 concludeEvent 收尾链路里被调用，且用事件自身的 prompt（零额外 LLM）
  const concludeAt = source.indexOf('export async function concludeEvent(');
  assert.ok(concludeAt >= 0, 'eventGenerator.js 缺少 concludeEvent');
  const callAt = source.indexOf('recordIntimateForEvent({', concludeAt);
  assert.ok(callAt > concludeAt, 'concludeEvent 内必须调用 recordIntimateForEvent');
  const callSnippet = source.slice(callAt, callAt + 400);
  assert.match(callSnippet, /prompt: event\.prompt/, '记账必须用事件自身的生图 prompt');
  assert.match(callSnippet, /eventId: event\.id/);
});
