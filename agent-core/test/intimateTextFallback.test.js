/**
 * 亲密看板 · 正文兜底记账单测（task-26）
 *
 * 用户报的缺口：看板只吃"生图 prompt 的英文 tag 串" ——
 *   · 私聊：chat.js 只在 `tags.prompt` 存在时记账 ⇒ 纯文字轮次整段不进看板
 *   · 群聊：只收集 `[说话人]: {画面描述}` 的**发图行** ⇒ 群里只打字不发图，看板一笔都没有
 *
 * 修法（口径 A）：没有可归类生图 prompt 的轮次，用项目现成的二值判定
 * `containsExplicitAdultContent`（它自带中文词表）扫**正文**，命中就记一笔 `unspecified`（"未归类"）。
 * 零 LLM、零新增词表、不猜具体行为；幂等锚点仍是 raw_messages.id，与撤回/回滚同口径。
 *
 * 本文件覆盖：私聊实时 / 群聊实时（含"已归类就不叠未归类"）/ 两条回填线 / 幂等 / 权限与总开关 /
 * 词表标签可直接展示 / 源码级挂点断言（防止被改回"只看 prompt"）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate text fallback fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { upsertBodyProfile, listIntimateLogs, ACT_DEFINITIONS } = await import('../src/services/intimateService.js');
const {
  recordUnspecifiedFromText, recordUnspecifiedFromRawId, ACT_UNSPECIFIED,
} = await import('../src/services/intimateAutoRecord.js');
const { groupConvId, recordGroupIntimateFromText } = await import('../src/services/groupChatEngine.js');
const { startBackfill, resetBackfill } = await import('../src/services/intimateBackfill.js');

config.dbPath = ':memory:';
after(() => closeDb());

/** 正文命中判定所依赖的中文词（与 imagePromptKnowledgePolicy.EXPLICIT_ADULT_PATTERN 同源） */
const EXPLICIT_TEXT = '她忍不住叫了出来，高潮来得又急又猛。';
/** 普通正文：一个成人词都不含 → 不应产生任何流水 */
const PLAIN_TEXT = '今天天气不错，我们去河边走走吧。';
/** 与既有单测同一口径的可归类生图 prompt（vaginal） */
const PROMPT = '1girl, solo, sex from behind, cum';

let seq = 0;

function seedCharacter() {
  const db = getDb();
  seq += 1;
  db.prepare('INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, ?, ?)')
    .run(`textfb_${seq}`, `角色${seq}`, '测试用成年角色', '测试');
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** 私聊 raw：conversation_id = char_<characterId> */
function addPrivateRaw(characterId, { content = '', prompt = null, role = 'assistant' } = {}) {
  const db = getDb();
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, ?, ?, ?)')
    .run(`char_${characterId}`, role, content, prompt);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** 群聊 raw：conversation_id = group_<groupId>，content 是 `[显示名]: …` 多行剧本 */
function addGroupRaw(groupId, content) {
  const db = getDb();
  db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`)
    .run(groupConvId(groupId), content);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function seedGroup(characterIds) {
  const db = getDb();
  db.prepare(`INSERT INTO group_chats (name) VALUES ('正文兜底测试群')`).run();
  const groupId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const insert = db.prepare('INSERT OR IGNORE INTO group_members (group_id, character_id) VALUES (?, ?)');
  for (const characterId of characterIds) insert.run(groupId, characterId);
  return groupId;
}

const displayName = characterId => getDb().prepare('SELECT display_name FROM characters WHERE id = ?').get(characterId).display_name;
/** 群聊与私聊的口径不同：群聊那笔 partnerKind='character'，默认口径读不到，要显式放开 */
const allLogs = characterId => listIntimateLogs(characterId, { limit: 200, partnerKinds: ['user', 'character'] });
const withIntimateFeatureOff = fn => {
  const previous = config.features.intimate;
  config.features.intimate = false;
  try { return fn(); } finally { config.features.intimate = previous; }
};

test('recordUnspecifiedFromRawId：纯文字正文命中成人内容 → 记一笔「未归类」，锚点与口径正确', () => {
  const id = seedCharacter();
  const rawId = addPrivateRaw(id, { content: EXPLICIT_TEXT });

  const res = recordUnspecifiedFromRawId({ characterId: id, rawId, scene: 'chat', partnerKind: 'user' });
  assert.equal(res.inserted, 1, `应记一笔，实际 ${JSON.stringify(res)}`);
  assert.equal(res.blocked, false);

  const rows = listIntimateLogs(id, { limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actKey, ACT_UNSPECIFIED);
  assert.equal(rows[0].actKey, 'unspecified');
  assert.equal(rows[0].positionKey, '', '未归类不携带体位（不猜）');
  assert.equal(rows[0].scene, 'chat');
  assert.equal(rows[0].partnerKind, 'user');
  assert.equal(rows[0].partnerId, 0);
  assert.equal(rows[0].rawId, rawId, '幂等锚点必须是本轮 raw_id（撤回时才能跟着回落）');
  assert.equal(rows[0].source, 'auto');
});

test('recordUnspecifiedFromRawId：普通正文 / raw 不存在 / 非法入参一律零写入，重复调用幂等', () => {
  const id = seedCharacter();
  const plainRawId = addPrivateRaw(id, { content: PLAIN_TEXT });
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: plainRawId }).inserted, 0, '不含成人词的正文不能记');

  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: 999999 }).inserted, 0, 'raw 不存在 → 零写入');
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: 0 }).inserted, 0);
  assert.equal(recordUnspecifiedFromRawId({ characterId: 0, rawId: plainRawId }).inserted, 0);

  const rawId = addPrivateRaw(id, { content: EXPLICIT_TEXT });
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId }).inserted, 1);
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId }).inserted, 0, '同一 raw 重复记账必须幂等（重生成/断线重试）');
  assert.equal(listIntimateLogs(id, { limit: 10 }).length, 1);
});

test('recordUnspecifiedFromText：显式传入正文、空文本与无成人词文本不记', () => {
  const id = seedCharacter();
  const rawId = addPrivateRaw(id, { content: '占位' });

  assert.equal(recordUnspecifiedFromText({ characterId: id, rawId, text: '' }).inserted, 0);
  assert.equal(recordUnspecifiedFromText({ characterId: id, rawId, text: PLAIN_TEXT }).inserted, 0);
  assert.equal(recordUnspecifiedFromText({ characterId: id, rawId: null, text: EXPLICIT_TEXT }).inserted, 0);
  assert.equal(recordUnspecifiedFromText({ characterId: id, rawId, text: EXPLICIT_TEXT }).inserted, 1);
});

test('总开关关闭 / AI 未授权 stats：正文兜底零写入，未授权时返回 blocked', () => {
  const id = seedCharacter();
  const rawId = addPrivateRaw(id, { content: EXPLICIT_TEXT });

  const off = withIntimateFeatureOff(() => recordUnspecifiedFromRawId({ characterId: id, rawId }));
  assert.equal(off.inserted, 0, 'features.intimate=false 时一个字都不写');
  assert.equal(listIntimateLogs(id, { limit: 10 }).length, 0);

  upsertBodyProfile(id, { aiEditFields: ['body'] }); // 关掉 stats 授权
  const blocked = recordUnspecifiedFromRawId({ characterId: id, rawId });
  assert.equal(blocked.blocked, true, '未授权要如实返回 blocked，供调用方/回填停线');
  assert.equal(listIntimateLogs(id, { limit: 10 }).length, 0);

  upsertBodyProfile(id, { aiEditFields: ['stats'] }); // 重新授权后照常
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId }).inserted, 1);
});

test('recordGroupIntimateFromText：按发言角色各记一笔（群聊口径 character/0），多句与重复都不翻倍', () => {
  const [jia, yi] = [seedCharacter(), seedCharacter()];
  const groupId = seedGroup([jia, yi]);
  const rawId = addGroupRaw(groupId, `[${displayName(jia)}]: ${EXPLICIT_TEXT}\n[${displayName(yi)}]: ${PLAIN_TEXT}`);

  const res = recordGroupIntimateFromText(rawId, [
    { characterId: jia, text: EXPLICIT_TEXT },
    { characterId: yi, text: PLAIN_TEXT },
  ]);
  assert.equal(res.inserted, 1, `只有命中正文的那个角色记账，实际 ${JSON.stringify(res)}`);

  const jiaRows = allLogs(jia);
  assert.equal(jiaRows.length, 1);
  assert.equal(jiaRows[0].actKey, ACT_UNSPECIFIED);
  assert.equal(jiaRows[0].scene, 'group', '群聊口径：scene=group');
  assert.equal(jiaRows[0].partnerKind, 'character');
  assert.equal(jiaRows[0].partnerId, 0);
  assert.equal(jiaRows[0].rawId, rawId);
  assert.equal(allLogs(yi).length, 0);

  // 同一角色在同一轮里说再多句命中，也只算一笔（source_uid 与 raw_id 绑定）
  const again = recordGroupIntimateFromText(rawId, [
    { characterId: jia, text: `${EXPLICIT_TEXT} 又一次。` },
    { characterId: jia, text: '继续高潮。' },
  ]);
  assert.equal(again.inserted, 0, '同一 raw 重复/多句必须幂等');
  assert.equal(allLogs(jia).length, 1);
});

test('recordGroupIntimateFromText：本轮已归类（有发图行）的角色必须被排除，避免双重计数', () => {
  const [jia, yi] = [seedCharacter(), seedCharacter()];
  const groupId = seedGroup([jia, yi]);
  const rawId = addGroupRaw(groupId, `[${displayName(jia)}]: {${PROMPT}}\n[${displayName(yi)}]: ${EXPLICIT_TEXT}`);

  const res = recordGroupIntimateFromText(
    rawId,
    [{ characterId: jia, text: EXPLICIT_TEXT }, { characterId: yi, text: EXPLICIT_TEXT }],
    { excludeCharacterIds: [jia] }
  );
  assert.equal(res.inserted, 1);
  assert.equal(allLogs(jia).length, 0, '已归类的角色不能再叠一笔「未归类」');
  assert.equal(allLogs(yi).length, 1);
});

test('recordGroupIntimateFromText：raw 已删 / 空数组 / 总开关关闭 → 零写入', () => {
  const [jia] = [seedCharacter()];
  const groupId = seedGroup([jia]);
  const rawId = addGroupRaw(groupId, `[${displayName(jia)}]: ${EXPLICIT_TEXT}`);

  assert.equal(recordGroupIntimateFromText(rawId, []).inserted, 0);
  assert.equal(recordGroupIntimateFromText(rawId, null).inserted, 0);
  assert.equal(recordGroupIntimateFromText(0, [{ characterId: jia, text: EXPLICIT_TEXT }]).inserted, 0);

  assert.equal(withIntimateFeatureOff(
    () => recordGroupIntimateFromText(rawId, [{ characterId: jia, text: EXPLICIT_TEXT }])
  ).inserted, 0);

  // raw 被删（撤回/截断）后记账只会留下回滚不掉的脏计数 → 必须先查存在性
  getDb().prepare('DELETE FROM raw_messages WHERE id = ?').run(rawId);
  assert.equal(recordGroupIntimateFromText(rawId, [{ characterId: jia, text: EXPLICIT_TEXT }]).inserted, 0);
});

test('回填 · 私聊线：只能靠正文识别的老回合补进流水，重复回填与 reset 重扫都不翻倍', () => {
  const id = seedCharacter();
  const explicitRaw = addPrivateRaw(id, { content: EXPLICIT_TEXT });
  addPrivateRaw(id, { content: PLAIN_TEXT });
  addPrivateRaw(id, { content: '拍好了', prompt: PROMPT });

  const run1 = startBackfill(id, { schedule: fn => fn() });
  assert.equal(run1.status, 'done');
  const rows = listIntimateLogs(id, { limit: 50 });
  assert.equal(rows.length, 2, `一条「未归类」+ 一条归类，实际 ${rows.length}`);
  const unspecified = rows.find(row => row.actKey === ACT_UNSPECIFIED);
  assert.ok(unspecified, '正文命中的老回合必须被补进流水');
  assert.equal(unspecified.rawId, explicitRaw, '回填也要用 raw_id 做锚点');
  assert.ok(rows.some(row => row.actKey === 'vaginal'), '有 prompt 的回合仍走原来的归类口径');

  const run2 = startBackfill(id, { schedule: fn => fn() });
  assert.equal(run2.inserted, run1.inserted, 'inserted 是累计值：重复启动不该翻倍');
  assert.equal(run2.scanned, run1.scanned, '没有新消息就不该再扫');
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 2);

  resetBackfill(id);
  startBackfill(id, { schedule: fn => fn() });
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 2, '重置重扫也不翻倍（去重靠 source_uid）');
});

test('回填 · 群聊线：没发图行的成员补「未归类」，有发图行的成员走归类且不叠未归类', () => {
  const [jia, yi] = [seedCharacter(), seedCharacter()];
  const groupId = seedGroup([jia, yi]);
  addGroupRaw(groupId, `[${displayName(jia)}]: ${EXPLICIT_TEXT}\n[${displayName(yi)}]: {${PROMPT}}`);

  const run = startBackfill(jia, { schedule: fn => fn() });
  assert.equal(run.status, 'done');
  const jiaRows = allLogs(jia);
  assert.equal(jiaRows.length, 1, `甲只有正文命中，应只有「未归类」一笔，实际 ${JSON.stringify(jiaRows.map(r => r.actKey))}`);
  assert.equal(jiaRows[0].actKey, ACT_UNSPECIFIED);
  assert.equal(jiaRows[0].scene, 'group');

  const yiRows = allLogs(yi);
  assert.equal(yiRows.length, 1, '乙有发图行 → 只记归类那一笔，不再叠「未归类」');
  assert.equal(yiRows[0].actKey, 'vaginal');
  assert.notEqual(yiRows[0].actKey, ACT_UNSPECIFIED);

  startBackfill(jia, { schedule: fn => fn() });
  assert.equal(allLogs(jia).length, 1, '重复回填不翻倍');
});

test('词表：unspecified 带中文标签「未归类」，前端可直接展示（不会裸出英文 key）', () => {
  const entry = ACT_DEFINITIONS.find(item => item.key === ACT_UNSPECIFIED);
  assert.ok(entry, 'ACT_DEFINITIONS 必须收录 unspecified（面板标签靠它下发）');
  assert.equal(entry.label, '未归类');
  assert.deepEqual(entry.tags, [], '不做 tag 自动归类（只有正文兜底与人工才会产生它）');
});

test('源码级：三条实时挂点 + 两条回填线都接上了正文兜底（防止被改回"只看 prompt"）', () => {
  const chatSource = fs.readFileSync(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.match(chatSource, /recordUnspecifiedFromRawId/, 'chat.js 必须用正文兜底');
  assert.match(chatSource, /else recordIntimateTextFallback\(characterId, Number\(rawMsgId\)\)/, '主流式落库的 else 分支');
  assert.match(chatSource, /else if \(character && assistantRawId\) recordIntimateTextFallback\(/, 'needImage 的 else 分支');

  const engineSource = fs.readFileSync(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  assert.match(engineSource, /intimateTextLines\.push\(\{\s*characterId:\s*parsed\.speaker\.id,\s*text:\s*parsed\.text\s*\}\)/);
  assert.match(engineSource, /recordGroupIntimateFromText\(rawId,\s*intimateTextLines,\s*\{/);
  assert.match(engineSource, /excludeCharacterIds:\s*intimatePrompts\.map\(item\s*=>\s*item\.characterId\)/);

  const backfillSource = fs.readFileSync(new URL('../src/services/intimateBackfill.js', import.meta.url), 'utf8');
  assert.match(backfillSource, /function parseGroupTextLines\(content\)/, '群聊线要能解析出"没有发图 prompt 的正文行"');
  assert.ok((backfillSource.match(/recordUnspecifiedFromText\(/g) || []).length >= 2, '私聊线与群聊线都要接正文兜底');
});
