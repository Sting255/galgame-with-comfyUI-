/**
 * 群聊 ⇄ 私聊 记忆互通（H1/H2/H3）
 *
 * 覆盖用户裁决的三块：
 *   H1 私聊侧的检索范围纳入「她所在的群」（不复制数据），群来源条目标出出处、
 *      最多 PRIVATE_GROUP_MEMORY_MAX_ITEMS 条；
 *   H2 群聊一轮结束后把「她这一轮在群里经历的事」写进她自己的私聊长期记忆（异步、有界、去重）；
 *   H3 群聊轮里给每个成员注入一节「只有她自己知道」的私聊记忆。
 *
 * 另外锁两条真机修正：
 *   · 群聊轮的 RAG 范围**只含本群会话**（成员私聊记忆只走 H3 的本人小节，不得进共享群 prompt）；
 *   · 带 `群聊` tag 的 H2 记忆（落在 `char_<id>` 里）在私聊召回时也标群出处。
 *
 * 第二目标是防上下文爆炸，所以**上限常量**与「多人 / 长历史下不膨胀」在这里直接断言。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络
 *（hybridSearch 会尝试系统内置嵌入/重排，本文件要证明整条链路都没有真联网）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
let networkAttempts = 0;
globalThis.fetch = async url => {
  networkAttempts += 1;
  throw new Error(`groupMemoryLink fixture forbids network: ${url}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER,
  GROUP_PRIVATE_MEMORY_MEMBER_CHARS,
  GROUP_PRIVATE_MEMORY_TOTAL_CHARS,
  GROUP_PRIVATE_MEMORY_SCAN_LIMIT,
  GROUP_PRIVATE_MEMORY_SCAN_OVERFETCH,
  GROUP_LINK_SUMMARY_MAX_CHARS,
  PRIVATE_GROUP_MEMORY_MAX_ITEMS,
  GROUP_LINK_TAG,
  isGroupMemoryLinkEnabled,
  listCharacterGroupConversationIds,
  isGroupConversationId,
  isGroupSourcedMemory,
  loadGroupNameMap,
  groupMemoryTag,
  selectPrivateChatMemories,
  formatPrivateChatMemoryLines,
  buildGroupLinkSummary,
  linkGroupRoundToPrivateMemories,
  resolveMemberMemoryBudget,
  isMemberPrivateOnlyMemory,
  rankPrivateMemories,
  readMemberPrivateMemories,
  buildMemberPrivateMemoryBlock,
  collectMemberPrivateMemoryBlocks,
} = await import('../src/services/groupMemoryLink.js');
const { hybridSearch, QUERY_TOKEN_LIMIT_DEFAULT } = await import('../src/services/memorySearch.js');
const { formatMemoryRecallBlock } = await import('../src/services/memory/activeSearch.js');
const {
  buildGroupRoundMemoryScope,
  buildGroupRoundMemoryBlock,
  GROUP_ROUND_QUERY_TOKEN_LIMIT,
} = await import('../src/services/groupChatEngine.js');

// ──────────────── 夹具 ────────────────

function useMemDb(t) {
  const db = getDb();
  t.after(() => closeDb());
  return db;
}

let memorySeq = 0;
/** 直接造记忆行：需要精确控制 importance / updated_at，走仓储 API 反而不好断言排序 */
function seedMemory(db, { conversationId, judgment, importance = 3, tags = ['测试'], updatedAt = '2026-08-01 10:00:00' }) {
  memorySeq += 1;
  const memoryId = `mem_fixture_${memorySeq}`;
  db.prepare(`
    INSERT INTO memory_fragments
      (conversation_id, fragment_type, content, memory_id, memory_type, subject, judgment, tags, status,
       importance, updated_at, created_at, valid_from, keywords, perspectives, semantic_note, episodic_note)
    VALUES (?, 'fact', ?, ?, 'knowledge', 'user', ?, ?, 'active', ?, ?, ?, ?, '[]', '[]', '', '')
  `).run(
    conversationId, judgment, memoryId, judgment, JSON.stringify(tags),
    importance, updatedAt, updatedAt, updatedAt,
  );
  return memoryId;
}

function seedCharacter(db, displayName) {
  return Number(db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`link_${displayName}`, displayName, `你是${displayName}，说话简短。`).lastInsertRowid);
}

function seedGroup(db, { name, memberIds }) {
  const groupId = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)')
    .run(name, '测试话题').lastInsertRowid);
  for (const id of memberIds) {
    db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(groupId, id);
  }
  return groupId;
}

function seedRaw(db, conversationId, content, role = 'assistant') {
  return Number(db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(conversationId, role, content).lastInsertRowid);
}

/** 同步执行并收集 console.log 文案（断言"打一条 log 而不是报错"） */
function captureLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), logs };
  } finally {
    console.log = original;
  }
}

/** 同上，给 async 路径用 */
async function captureLogsAsync(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = original;
  }
}

function activeMemories(db, conversationId) {
  return db.prepare(`SELECT * FROM memory_fragments WHERE conversation_id = ? AND status = 'active'`).all(conversationId);
}

const CHAT_USER = config.user?.nickname || '用户';

// ──────────────── 上限常量 ────────────────

test('硬上限常量：合计上限已降级为"硬顶"，每轮预算按人数现算', () => {
  assert.equal(GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER, 3);
  assert.equal(GROUP_PRIVATE_MEMORY_MEMBER_CHARS, 300);
  assert.equal(GROUP_PRIVATE_MEMORY_TOTAL_CHARS, 3000, '2400 装不下 8 人满额（8 × 300 + 7 个分隔符 = 2407），只作硬顶');
  assert.equal(GROUP_LINK_SUMMARY_MAX_CHARS, 200);
  assert.equal(PRIVATE_GROUP_MEMORY_MAX_ITEMS, 8);
  assert.equal(GROUP_PRIVATE_MEMORY_SCAN_LIMIT, 30, '候选池 30 条（原 20 条会把最旧那条永远挡在池外）');
  assert.equal(GROUP_PRIVATE_MEMORY_SCAN_OVERFETCH, 4, 'H3 读侧先超采 4 倍再滤掉群聊 tag（有界）');
});

// ──────────────── 问题 1：每轮预算按人数动态算（8 人不再跳过第 8 个） ────────────────

test(`每轮预算 = min(硬顶, 人数 × (每节 + 1))：8 人 ${8 * (GROUP_PRIVATE_MEMORY_MEMBER_CHARS + 1)}，20 人被硬顶`, () => {
  // 口径就是需求里的公式：+1 是块间换行分隔符的余量
  const expected = count => Math.min(GROUP_PRIVATE_MEMORY_TOTAL_CHARS, count * (GROUP_PRIVATE_MEMORY_MEMBER_CHARS + 1));
  for (const count of [1, 2, 6, 7, 8, 9, 10, 20, 50]) {
    assert.equal(resolveMemberMemoryBudget(count), expected(count), `${count} 人的预算`);
  }
  // 8 人：8 × 301 = 2408 ≤ 3000 —— 8 节满额（2407）刚刚装得下，这就是第 8 人不再被跳过的原因
  assert.equal(resolveMemberMemoryBudget(8), 2408);
  assert.ok(8 * GROUP_PRIVATE_MEMORY_MEMBER_CHARS + 7 <= resolveMemberMemoryBudget(8),
    '8 节顶满 + 7 个分隔符必须落在预算内');
  // 20 人：20 × 301 = 6020 被 3000 硬顶住（行为不变：超出的整节跳过 + log）
  assert.equal(resolveMemberMemoryBudget(20), GROUP_PRIVATE_MEMORY_TOTAL_CHARS);
  assert.equal(resolveMemberMemoryBudget(20), 3000);
  // 非法输入安全
  assert.equal(resolveMemberMemoryBudget(0), 0);
  assert.equal(resolveMemberMemoryBudget(-3), 0);
  assert.equal(resolveMemberMemoryBudget('x'), 0);
  assert.equal(resolveMemberMemoryBudget(null), 0);
});

test('问题 1 真机复现：8 人 × 每人 3 条 300 字 → 8 节全在、skipped 为空', async t => {
  const db = useMemDb(t);
  const long = '很长的私聊记忆内容。'.repeat(30);   // 300 字，正好顶满每节额度
  assert.equal(long.length, GROUP_PRIVATE_MEMORY_MEMBER_CHARS);
  const members = [];
  for (let i = 1; i <= 8; i++) {
    const id = 7000 + i;
    members.push({ id, display_name: `角色${i}` });
    for (let k = 0; k < GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER; k++) {
      seedMemory(db, {
        conversationId: `char_${id}`, judgment: `${long}${k}`, importance: 5 - k,
        updatedAt: `2026-08-0${k + 1} 10:00:00`,
      });
    }
  }

  const { result: collected, logs } = captureLogs(() => collectMemberPrivateMemoryBlocks(members));
  assert.equal(collected.blocks.length, 8, `8 个人人都要有一节（真机上第 8 人曾被跳过）：${logs.join(' | ')}`);
  assert.deepEqual(collected.skipped, [], '没有任何成员被跳过');
  assert.equal(collected.injected.length, 8);
  assert.equal(collected.budget, resolveMemberMemoryBudget(8));
  // 8 节顶满时实际占 8 × 300 + 7 个分隔符 = 2407 字（旧硬顶 2400 正是在这里丢掉第 8 人）
  assert.equal(collected.chars, 8 * GROUP_PRIVATE_MEMORY_MEMBER_CHARS + 7);
  assert.ok(collected.chars > 2400, '这个字数在旧的 2400 硬顶下确实装不下（本用例就是它的复现）');
  assert.ok(collected.chars <= collected.budget);
  assert.ok(!logs.some(l => l.includes('跳过')), `不该有跳过 log：${logs.join(' | ')}`);
});

test('问题 1 人数多（20 人 × 3 条 300 字）：被硬顶住、有成员整节跳过、不报错', async t => {
  const db = useMemDb(t);
  const long = '很长的私聊记忆内容。'.repeat(30);
  const members = [];
  for (let i = 1; i <= 20; i++) {
    const id = 7100 + i;
    members.push({ id, display_name: `角色${i}` });
    for (let k = 0; k < GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER; k++) {
      seedMemory(db, {
        conversationId: `char_${id}`, judgment: `${long}${k}`, importance: 5 - k,
        updatedAt: `2026-08-0${k + 1} 10:00:00`,
      });
    }
  }

  const { result: collected, logs } = captureLogs(() => collectMemberPrivateMemoryBlocks(members));
  assert.equal(collected.budget, GROUP_PRIVATE_MEMORY_TOTAL_CHARS, '20 × 301 = 6020 被硬顶到 3000');
  assert.ok(collected.chars <= GROUP_PRIVATE_MEMORY_TOTAL_CHARS, `实际 ${collected.chars} 必须 ≤ 硬顶 ${GROUP_PRIVATE_MEMORY_TOTAL_CHARS}`);
  assert.ok(collected.skipped.length > 0, '硬顶之外必须有人被跳过（行为不变）');
  assert.equal(collected.injected.length + collected.skipped.length, 20, '没被跳过的也没人"消失"');
  assert.ok(logs.some(l => l.startsWith('[memory]') && l.includes(`/${GROUP_PRIVATE_MEMORY_TOTAL_CHARS} 字`) && l.includes('跳过')),
    `跳过 log 里的分母要是实际生效的预算：${logs.slice(-2).join(' | ')}`);
  for (const block of collected.blocks) assert.ok(block.length <= GROUP_PRIVATE_MEMORY_MEMBER_CHARS);
});

// ──────────────── H1：私聊侧召回范围 ────────────────

test('H1 没群时：注入文本与旧实现逐字节一致（v3 开/关都比）', async t => {
  useMemDb(t);
  const results = [
    {
      memory_id: 'm1', conversation_id: 'char_1', memory_type: 'knowledge',
      judgment: '她喜欢喝美式', semantic_note: '她偏好美式咖啡', perspectives: ['主观感受'],
    },
    {
      memory_id: 'm2', conversation_id: 'char_1', memory_type: 'emotion',
      judgment: '她讨厌被放鸽子', semantic_note: '', perspectives: [],
    },
  ];
  // 旧实现（改动前 chat.js 内联的那段）
  const legacy = useV3 => results.map((m, i) => {
    const perspectives = Array.isArray(m.perspectives) ? m.perspectives.filter(Boolean) : [];
    const label = perspectives.length ? `${m.memory_type}|${perspectives[0]}` : m.memory_type;
    const text = (useV3 && m.semantic_note) || m.judgment;
    return `${i + 1}. [${label}] ${text}`;
  }).join('\n');

  assert.equal(formatPrivateChatMemoryLines(results, { useV3Injection: true }), legacy(true));
  assert.equal(formatPrivateChatMemoryLines(results, { useV3Injection: false }), legacy(false));
  // 没有群来源时不加任何前缀
  assert.ok(!formatPrivateChatMemoryLines(results).includes('【群聊'));
});

test('H1 带「群聊」tag 的 H2 记忆（落在 char_<id> 里）在私聊里也标群出处，不带 tag 的逐字节不变', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [id] });
  const results = [
    // H2 写的群→私聊记忆：在 char_<id> 里，只有 tag 能识别它来自群
    {
      memory_id: 'h2', conversation_id: `char_${id}`, memory_type: 'knowledge',
      tags: [GROUP_LINK_TAG, `群组:${groupId}`, '摸鱼群'],
      judgment: '在群「摸鱼群」里，你说：今晚谁带了香菜？',
    },
    // 普通私聊记忆：必须与改动前逐字节一致
    {
      memory_id: 'own', conversation_id: `char_${id}`, memory_type: 'knowledge',
      tags: ['私聊'], judgment: '她偷偷买的猫粮牌子',
    },
  ];

  assert.equal(isGroupSourcedMemory(results[0]), true, '带 tag 的就是群来源');
  assert.equal(isGroupSourcedMemory(results[1]), false, '不带 tag 的普通私聊记忆不算群来源');

  // 群名由 tag 里的 `群组:<id>` 惰性补查（chat.js 只在"命中里有群会话条目"时才预查群名表）
  const lines = formatPrivateChatMemoryLines(results).split('\n');
  assert.equal(lines[0], '1. 【群聊·摸鱼群】[knowledge] 在群「摸鱼群」里，你说：今晚谁带了香菜？');
  assert.equal(lines[1], '2. [knowledge] 她偷偷买的猫粮牌子', '不带 tag 的行与旧实现逐字节一致');

  // 传了群名表也一样（不重复查库）
  const explicit = formatPrivateChatMemoryLines(results, { groupNames: new Map([[`group_${groupId}`, '摸鱼群']]) });
  assert.equal(explicit, lines.join('\n'));
});

test('H1 带 tag 但定位不到群名：退化成【群聊】；群名表里有就带群名', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  seedGroup(db, { name: '夜谈群', memberIds: [id] });

  const noGroupTag = {
    memory_id: 't1', conversation_id: `char_${id}`, memory_type: 'knowledge',
    tags: [GROUP_LINK_TAG], judgment: '在群里说过的事',
  };
  assert.equal(formatPrivateChatMemoryLines([noGroupTag]).split('\n')[0], '1. 【群聊】[knowledge] 在群里说过的事');

  // tag 里的群 id 在 group_chats 里查不到（群被删了）→ 也只退化
  const deadGroup = {
    memory_id: 't2', conversation_id: `char_${id}`, memory_type: 'knowledge',
    tags: [GROUP_LINK_TAG, '群组:987654'], judgment: '群里那件旧事',
  };
  assert.equal(formatPrivateChatMemoryLines([deadGroup]).split('\n')[0], '1. 【群聊】[knowledge] 群里那件旧事');

  // 调用方直接给名字表（chat.js 的既有路径）照样能带群名
  const named = formatPrivateChatMemoryLines([{ ...deadGroup, tags: [GROUP_LINK_TAG, '群组:77'] }], {
    groupNames: new Map([['group_77', '夜谈群']]),
  });
  assert.equal(named.split('\n')[0], '1. 【群聊·夜谈群】[knowledge] 群里那件旧事');
});

test(`H1 带 tag 的记忆与群会话条目共用群来源额度（最多 ${PRIVATE_GROUP_MEMORY_MAX_ITEMS} 条）`, async t => {
  useMemDb(t);
  const groupHits = Array.from({ length: PRIVATE_GROUP_MEMORY_MAX_ITEMS }, (_, i) => ({
    memory_id: `g${i}`, conversation_id: 'group_7', memory_type: 'knowledge', judgment: `群会话第${i}件事`,
  }));
  const taggedHits = [
    { memory_id: 't0', conversation_id: 'char_1', tags: [GROUP_LINK_TAG, '群组:7'], memory_type: 'knowledge', judgment: 'H2 群里第0件事' },
    { memory_id: 't1', conversation_id: 'char_1', tags: [GROUP_LINK_TAG, '群组:7'], memory_type: 'knowledge', judgment: 'H2 群里第1件事' },
  ];
  const own = { memory_id: 'own', conversation_id: 'char_1', tags: ['私聊'], memory_type: 'knowledge', judgment: '普通私聊记忆' };

  const { result: selected, logs } = captureLogs(() => selectPrivateChatMemories([...groupHits, ...taggedHits, own]));
  assert.equal(selected.dropped, 2, '超出的两条 H2 群记忆被丢弃');
  assert.equal(selected.results.length, PRIVATE_GROUP_MEMORY_MAX_ITEMS + 1);
  assert.ok(selected.results.includes(own), '普通私聊记忆一条不动');
  assert.ok(logs.some(line => line.startsWith('[memory]') && line.includes('丢弃 2 条')), `应有丢弃 log：${logs.join(' | ')}`);
});

test('H1 没有群角色：检索范围就是她自己那个会话', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const other = seedCharacter(db, '乙');
  const groupId = seedGroup(db, { name: '别人的群', memberIds: [other] });

  assert.deepEqual(listCharacterGroupConversationIds(id, db), []);
  // 她不在别人的群里，别人的群会话不该进她的 scope
  assert.deepEqual(listCharacterGroupConversationIds(other, db), [`group_${groupId}`]);
  assert.deepEqual(listCharacterGroupConversationIds(0, db), []);
  assert.deepEqual(listCharacterGroupConversationIds(id + 999, db), []);
  assert.ok(groupId > 0);
});

test('H1 有群时：检索范围 = 自己的会话 + 她参与的所有群会话', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const other = seedCharacter(db, '乙');
  const g1 = seedGroup(db, { name: '摸鱼群', memberIds: [id, other] });
  const g2 = seedGroup(db, { name: '夜谈群', memberIds: [id] });
  seedGroup(db, { name: '她不在的群', memberIds: [other] });

  assert.deepEqual(listCharacterGroupConversationIds(id, db), [`group_${g1}`, `group_${g2}`]);
  const names = loadGroupNameMap([`group_${g1}`, `group_${g2}`], db);
  assert.equal(names.get(`group_${g1}`), '摸鱼群');
  assert.equal(names.get(`group_${g2}`), '夜谈群');
  assert.equal(groupMemoryTag(`group_${g1}`, names), '【群聊·摸鱼群】');
  assert.equal(groupMemoryTag('group_999', names), '【群聊】');
  assert.equal(groupMemoryTag(`group_${g1}`, null), '【群聊】');
  assert.equal(isGroupConversationId(`group_${g1}`), true);
  assert.equal(isGroupConversationId('char_1'), false);
});

test(`H1 群来源条目最多 ${PRIVATE_GROUP_MEMORY_MAX_ITEMS} 条：超了丢弃，她自己会话的记忆一条不动`, async t => {
  useMemDb(t);
  const groupHits = Array.from({ length: PRIVATE_GROUP_MEMORY_MAX_ITEMS + 2 }, (_, i) => ({
    memory_id: `g${i}`, conversation_id: 'group_7', memory_type: 'knowledge', judgment: `群里的第${i}件事`,
  }));
  const ownHits = [
    { memory_id: 'c1', conversation_id: 'char_1', memory_type: 'knowledge', judgment: '私下说过的事一' },
    { memory_id: 'c2', conversation_id: 'char_1', memory_type: 'emotion', judgment: '私下说过的事二' },
  ];
  const { result: selected, logs } = captureLogs(() => selectPrivateChatMemories([...groupHits, ...ownHits]));
  assert.equal(selected.dropped, 2);
  assert.equal(selected.results.filter(m => isGroupConversationId(m.conversation_id)).length, PRIVATE_GROUP_MEMORY_MAX_ITEMS);
  assert.equal(selected.results.filter(m => !isGroupConversationId(m.conversation_id)).length, 2);
  assert.ok(logs.some(line => line.startsWith('[memory]') && line.includes('丢弃 2 条')), `应有丢弃 log：${logs.join(' | ')}`);

  const lines = formatPrivateChatMemoryLines([...groupHits, ...ownHits], {
    groupNames: new Map([['group_7', '摸鱼群']]),
  }).split('\n');
  assert.equal(lines.length, PRIVATE_GROUP_MEMORY_MAX_ITEMS + 2, `${PRIVATE_GROUP_MEMORY_MAX_ITEMS} 条群的 + 2 条自己的`);
  assert.equal(lines[0], '1. 【群聊·摸鱼群】[knowledge] 群里的第0件事');
  assert.equal(lines[2], '3. 【群聊·摸鱼群】[knowledge] 群里的第2件事');
  assert.equal(lines[PRIVATE_GROUP_MEMORY_MAX_ITEMS], `${PRIVATE_GROUP_MEMORY_MAX_ITEMS + 1}. [knowledge] 私下说过的事一`);
  assert.equal(lines[PRIVATE_GROUP_MEMORY_MAX_ITEMS + 1], `${PRIVATE_GROUP_MEMORY_MAX_ITEMS + 2}. [emotion] 私下说过的事二`);
});

test('H1 端到端：群聊整理出来的群会话记忆，在她私聊的检索范围里能召回并标出处', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [id] });
  const groupConv = `group_${groupId}`;
  const rawId = seedRaw(db, groupConv, `[甲]: 我今晚带了香菜`);
  // 群聊整理（既有链路）落库的群会话记忆
  seedMemory(db, { conversationId: groupConv, judgment: '甲在群里说她今晚带了香菜', importance: 4 });
  // 她自己的私聊记忆
  seedMemory(db, { conversationId: `char_${id}`, judgment: '她喜欢香菜', importance: 3 });

  const scope = [`char_${id}`, ...listCharacterGroupConversationIds(id, db)];
  assert.deepEqual(scope, [`char_${id}`, groupConv]);
  const hits = await hybridSearch('香菜', { conversationIds: scope, topK: 7, timeoutMs: 8000 });
  const conversations = hits.map(h => h.conversation_id);
  assert.ok(conversations.includes(groupConv), `群里那条必须被召回：${JSON.stringify(conversations)}`);
  assert.ok(conversations.includes(`char_${id}`), '她自己的记忆也必须在');

  const lines = formatPrivateChatMemoryLines(hits, { groupNames: loadGroupNameMap(scope, db) });
  assert.ok(lines.includes('【群聊·摸鱼群】'), `群来源条目要标出处：${lines}`);
  assert.ok(lines.includes('她喜欢香菜'), '她自己的记忆照常注入');
  assert.ok(rawId > 0);
});

test(`H1 @memory 回想块：群来源条目同样标出处、同样最多 ${PRIVATE_GROUP_MEMORY_MAX_ITEMS} 条`, async t => {
  useMemDb(t);
  const results = [
    ...Array.from({ length: PRIVATE_GROUP_MEMORY_MAX_ITEMS + 2 }, (_, i) => ({
      memory_id: `g${i}`, conversation_id: 'group_7', injectionText: `群里的第${i}件事`, isHistorical: false,
    })),
    { memory_id: 'c1', conversation_id: 'char_1', injectionText: '私下说过的事', isHistorical: false },
  ];
  const block = formatMemoryRecallBlock('上次在群里说了什么', results, {
    groupNames: new Map([['group_7', '摸鱼群']]),
  });
  assert.equal((block.match(/【群聊·摸鱼群】/g) || []).length, PRIVATE_GROUP_MEMORY_MAX_ITEMS);
  assert.ok(block.includes('1. 【群聊·摸鱼群】[现行] 群里的第0件事'));
  assert.ok(block.includes('[现行] 私下说过的事'), '她自己的记忆不加前缀');
  assert.ok(!block.includes(`群里的第${PRIVATE_GROUP_MEMORY_MAX_ITEMS + 1}件事`), '超出的群条目要被丢掉');

  // 不传群名表也不能崩，只是退化成【群聊】
  const noNames = formatMemoryRecallBlock('q', [{ conversation_id: 'group_7', injectionText: 'x', isHistorical: false }]);
  assert.ok(noNames.includes('【群聊】[现行] x'));
  // 旧形态（没有 conversation_id 的结果）逐字节不变
  assert.ok(formatMemoryRecallBlock('q', [{ injectionText: '她不吃香菜', isHistorical: false }])
    .includes('1. [现行] 她不吃香菜'));
  assert.ok(formatMemoryRecallBlock('q', [], {}).includes('（没有想起任何相关记忆。）'));
});

// ──────────────── 群聊轮的 RAG scope（真机修正：私聊内容不得进共享群 prompt） ────────────────

test('群聊轮 RAG scope 只含本群会话：不含任何 char_ 前缀、含 group_<id>', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a, b] });
  const conversationId = `group_${groupId}`;

  const scope = buildGroupRoundMemoryScope(conversationId);
  assert.deepEqual(scope, [conversationId]);
  assert.ok(scope.includes(conversationId), '必须含本群会话');
  assert.equal(scope.some(id => String(id).startsWith('char_')), false, `scope 不能含成员私聊会话：${scope.join(',')}`);
  assert.deepEqual(buildGroupRoundMemoryScope(''), [], '没有会话 id 时不检索');
});

test('群聊轮 <rag_memories>：真机复现场景下私聊命中的记忆既不进参数也不进上下文', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a, b] });
  const conversationId = `group_${groupId}`;

  // 桩替掉 hybridSearch：先断言真正的检索参数，再故意把两条私聊命中混进返回里
  //（真机上第一轮 6 条命中全部来自私聊会话 —— 这里连"检索层不守scope"的最坏情况也一起挡掉）
  let seenQuery = null;
  let seenOptions = null;
  const block = await buildGroupRoundMemoryBlock('香菜', {
    conversationId,
    timeoutMs: 20,
    search: async (query, options) => {
      seenQuery = query;
      seenOptions = options;
      return [
        { conversation_id: `char_${a}`, memory_type: 'knowledge', judgment: '甲的私事：她偷偷买了猫粮' },
        { conversation_id: `char_${b}`, memory_type: 'emotion', judgment: '乙的私事：她怕黑' },
        { conversation_id: conversationId, memory_type: 'knowledge', judgment: '群里说过：今晚谁带了香菜' },
      ];
    },
  });

  assert.equal(seenQuery, '香菜');
  assert.deepEqual(seenOptions.conversationIds, [conversationId], '传给 hybridSearch 的 conversationIds 只能是本群会话');
  assert.equal(seenOptions.conversationIds.some(id => String(id).startsWith('char_')), false);
  assert.equal(seenOptions.topK, 6);
  assert.equal(seenOptions.queryTokenLimit, GROUP_ROUND_QUERY_TOKEN_LIMIT,
    '问题 3：群聊轮必须显式放宽分词上限（否则一句话多个主题时后半句关键词被截掉）');
  assert.ok(GROUP_ROUND_QUERY_TOKEN_LIMIT > QUERY_TOKEN_LIMIT_DEFAULT,
    `群聊轮的 ${GROUP_ROUND_QUERY_TOKEN_LIMIT} 必须大于默认的 ${QUERY_TOKEN_LIMIT_DEFAULT}`);

  assert.ok(block.includes('群里说过：今晚谁带了香菜'), `本群的记忆要注入：${block}`);
  assert.ok(!block.includes('私事'), `成员私聊记忆绝不能出现在群聊上下文里：${block}`);
  assert.ok(!block.includes('char_'), '上下文里不能出现任何 char_ 会话痕迹');
});

test('群聊轮 <rag_memories>：空结果 / 无 query 都不产空块', async t => {
  useMemDb(t);
  const conversationId = 'group_7';
  assert.equal(await buildGroupRoundMemoryBlock('香菜', {
    conversationId, timeoutMs: 20, search: async () => [],
  }), null);
  assert.equal(await buildGroupRoundMemoryBlock('', {
    conversationId, timeoutMs: 20, search: async () => [{ conversation_id: conversationId, memory_type: 'knowledge', judgment: 'x' }],
  }), null, '没有用户消息时不检索');
  assert.equal(await buildGroupRoundMemoryBlock('香菜', {
    conversationId: '', timeoutMs: 20, search: async () => [{ conversation_id: conversationId, memory_type: 'knowledge', judgment: 'x' }],
  }), null, '没有会话 id 时不检索');
  // 事件/奇遇/未互动事件照旧排除
  assert.equal(await buildGroupRoundMemoryBlock('香菜', {
    conversationId, timeoutMs: 20,
    search: async () => [{ conversation_id: conversationId, memory_type: 'knowledge', judgment: '【事件】雨夜告白' }],
  }), null);
});

test('groupChatEngine 源码级：群聊轮 RAG 调用点已收窄，旧的“本群 + 全体成员私聊”范围不存在了', async () => {
  const source = await readFile(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  assert.equal(source.includes('char_${member.id}'), false, '旧范围 [group_<id>, ...成员 char_<id>] 必须已被删除');
  assert.match(
    source,
    /const ragBlock = await buildGroupRoundMemoryBlock\(userMessage, \{ conversationId \}\);/,
    '群聊轮必须走只含本群会话的 buildGroupRoundMemoryBlock',
  );
  const scopeAt = source.indexOf('export function buildGroupRoundMemoryScope');
  const blockAt = source.indexOf('export async function buildGroupRoundMemoryBlock');
  assert.ok(scopeAt > 0 && blockAt > scopeAt, '两个函数都要在（收窄后的）实现里');
  // H3（成员私聊记忆的本人小节）仍是群聊 prompt 里私聊记忆的唯一入口
  assert.ok(source.includes('collectMemberPrivateMemoryBlocks(group.members)'), 'H3 链路必须保留');
  // 问题 3：只有群聊轮的 hybridSearch 调用传 queryTokenLimit（私聊口径不动）
  assert.match(source, /search\(query, \{ conversationIds, topK, queryTokenLimit: GROUP_ROUND_QUERY_TOKEN_LIMIT \}\)/,
    '群聊轮的检索调用必须传放宽后的分词上限');
});

test('问题 3 源码级：私聊召回调用点没有传 queryTokenLimit（默认 24 不变）', async () => {
  for (const relative of ['../src/routes/chat.js', '../src/services/memory/chatMemoryRecall.js', '../src/services/memory/activeSearch.js']) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.ok(!source.includes('queryTokenLimit'), `${relative} 不该出现 queryTokenLimit（私聊召回保持默认口径）`);
  }
  const searchSource = await readFile(new URL('../src/services/memorySearch.js', import.meta.url), 'utf8');
  assert.match(searchSource, /options\.queryTokenLimit/, 'hybridSearch 必须接收该可选参数');
  assert.match(searchSource, /queryTokens\(query, limit = QUERY_TOKEN_LIMIT_DEFAULT\)/,
    '分词函数的默认上限必须是 QUERY_TOKEN_LIMIT_DEFAULT');
  assert.equal(QUERY_TOKEN_LIMIT_DEFAULT, 24, '默认值仍是 24（历史口径）');
});

// ──────────────── H2：群聊一轮 → 她自己的私聊记忆 ────────────────

test('H2 群聊一轮：有发言的成员各写一条到 char_<id>，没发言的不写', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  const c = seedCharacter(db, '丙');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a, b, c] });
  const rawId = seedRaw(db, `group_${groupId}`, '[甲]: 你好\n[乙]: 晚上好');
  const group = {
    id: groupId, name: '摸鱼群',
    members: [{ id: a, display_name: '甲' }, { id: b, display_name: '乙' }, { id: c, display_name: '丙' }],
  };

  const { written } = await linkGroupRoundToPrivateMemories({
    group,
    rawId,
    userMessage: '今晚谁带了香菜？',
    speakerLines: [
      { characterId: a, text: '我带了香菜' },
      { characterId: b, text: '我不吃那个' },
      { characterId: a, text: '那我分给别人' },
    ],
  });

  assert.deepEqual(written.map(w => w.characterId).sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  const rowsA = activeMemories(db, `char_${a}`);
  const rowsB = activeMemories(db, `char_${b}`);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(activeMemories(db, `char_${c}`).length, 0, '没发言的成员不写');

  // 视角顺序：用户 → 我 → 其他人；正文 ≤200 字
  const textA = rowsA[0].judgment;
  assert.ok(textA.startsWith('在群「摸鱼群」里，'), textA);
  assert.ok(textA.includes(`${CHAT_USER}说：今晚谁带了香菜？`), textA);
  assert.ok(textA.includes(`我（甲）说：我带了香菜 那我分给别人`), textA);
  assert.ok(textA.includes('其他人：乙说：我不吃那个'), textA);
  assert.ok(textA.length <= GROUP_LINK_SUMMARY_MAX_CHARS, `正文必须 ≤${GROUP_LINK_SUMMARY_MAX_CHARS} 字，实际 ${textA.length}`);
  assert.equal(rowsA[0].importance, 4);
  assert.ok(rowsA[0].tags.includes(GROUP_LINK_TAG));
  assert.ok(rowsA[0].tags.includes(`群组:${groupId}`));
  // 群 raw id 刻意不落进私聊记忆的 raw 锚点（见模块头「设计取舍一」）
  assert.equal(rowsA[0].source_raw_start_id, null);
  assert.equal(rowsA[0].source_raw_end_id, null);
});

test('H2 同一轮同一人重复触发：靠 dedupeKey 幂等，不重复写', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a] });
  const rawId = seedRaw(db, `group_${groupId}`, '[甲]: 你好');
  const group = { id: groupId, name: '摸鱼群', members: [{ id: a, display_name: '甲' }] };
  const payload = { group, rawId, userMessage: '在吗', speakerLines: [{ characterId: a, text: '在的' }] };

  const first = await linkGroupRoundToPrivateMemories(payload);
  const second = await linkGroupRoundToPrivateMemories(payload);
  assert.equal(first.written.length, 1);
  assert.equal(second.written.length, 0, '第二次应被 content_hash 去重挡掉');
  assert.equal(activeMemories(db, `char_${a}`).length, 1);
});

test('H2 收尾日志写清那个数字是 rawId（不是"第几轮"）', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a] });
  const rawId = seedRaw(db, `group_${groupId}`, '[甲]: 你好');
  const group = { id: groupId, name: '摸鱼群', members: [{ id: a, display_name: '甲' }] };

  const { logs } = await captureLogsAsync(() => linkGroupRoundToPrivateMemories({
    group, rawId, userMessage: '在吗', speakerLines: [{ characterId: a, text: '在的' }],
  }));
  const line = logs.find(l => l.startsWith('[memory]') && l.includes('私聊记忆'));
  assert.ok(line, `应有写入 log：${logs.join(' | ')}`);
  assert.ok(line.includes(`rawId=${rawId}`), `日志要标明 rawId：${line}`);
  assert.ok(line.includes('私聊记忆 1 条'), line);
  assert.equal(line.includes('轮'), false, `rawId 不能被写成"轮次"：${line}`);
});

test('H2 正文上限 200 字：超长一轮被确定性截断', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a] });
  const rawId = seedRaw(db, `group_${groupId}`, '[甲]: 长篇');
  const group = { id: groupId, name: '摸鱼群', members: [{ id: a, display_name: '甲' }] };

  const longText = '这是一句很长的话用来撑爆上限。'.repeat(20);
  await linkGroupRoundToPrivateMemories({
    group, rawId,
    userMessage: longText,
    speakerLines: [{ characterId: a, text: longText }],
  });
  const rows = activeMemories(db, `char_${a}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].judgment.length, GROUP_LINK_SUMMARY_MAX_CHARS, '正好截到上限');
  assert.ok(rows[0].judgment.endsWith('…'));
});

test('H2 总开关关掉（config.features.memory === false）：整体不写', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [a] });
  const rawId = seedRaw(db, `group_${groupId}`, '[甲]: 你好');
  const group = { id: groupId, name: '摸鱼群', members: [{ id: a, display_name: '甲' }] };

  config.features = { ...config.features, memory: false };
  try {
    assert.equal(isGroupMemoryLinkEnabled(), false);
    const res = await linkGroupRoundToPrivateMemories({
      group, rawId, userMessage: '在吗', speakerLines: [{ characterId: a, text: '在的' }],
    });
    assert.deepEqual(res.written, []);
    assert.equal(activeMemories(db, `char_${a}`).length, 0);
  } finally {
    config.features = { ...config.features, memory: true };
  }
  assert.equal(isGroupMemoryLinkEnabled(), true);
});

test('H2 组装：没有可写内容时返回空串（不写空记忆）', () => {
  assert.equal(buildGroupLinkSummary({ groupName: '摸鱼群', memberName: '甲' }), '');
  const summary = buildGroupLinkSummary({
    groupName: '摸鱼群', chatUserName: '你', memberName: '甲',
    userMessage: '  在 吗  ', memberLines: ['在的'], otherLines: [{ name: '乙', text: '我也在' }],
  });
  assert.equal(summary, '在群「摸鱼群」里，你说：在 吗；我（甲）说：在的；其他人：乙说：我也在。');
});

// ──────────────── H3：群聊轮里注入「只属于她」的私聊记忆 ────────────────

test(`H3 每人最多 ${GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER} 条：按 重要性 × 时间 排序取前 N`, async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  seedMemory(db, { conversationId: `char_${a}`, judgment: '高重要但更旧', importance: 5, updatedAt: '2026-08-01 10:00:00' });
  seedMemory(db, { conversationId: `char_${a}`, judgment: '低重要但最新', importance: 2, updatedAt: '2026-08-05 10:00:00' });
  seedMemory(db, { conversationId: `char_${a}`, judgment: '高重要且更新', importance: 5, updatedAt: '2026-08-03 10:00:00' });
  seedMemory(db, { conversationId: `char_${a}`, judgment: '中重要', importance: 3, updatedAt: '2026-08-04 10:00:00' });

  const picked = rankPrivateMemories(readMemberPrivateMemories(a, {}), GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER);
  assert.equal(picked.length, GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER, '取满额度（重要性优先）');
  assert.deepEqual(picked.slice(0, 2).map(m => m.judgment), ['高重要且更新', '高重要但更旧'], '重要性优先、同重要性按时间倒序');
  if (GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER >= 3) {
    assert.equal(picked[2].judgment, '中重要', '第 3 个位置给 importance=3，而不是 importance=2 但更新的那条');
  }

  const block = buildMemberPrivateMemoryBlock('甲', picked);
  assert.ok(block.includes('高重要且更新'));
  assert.ok(block.includes('高重要但更旧'));
  assert.ok(!block.includes('低重要但最新'));
  assert.equal((block.match(/^- /gm) || []).length, GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER);
});

test(`候选池 ${GROUP_PRIVATE_MEMORY_SCAN_LIMIT} 条：最重要的那条哪怕最旧也能进候选池`, async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  // 24 条"更新但不太重要" + 1 条"最旧但最重要"，共 25 条：超过原候选池 20 条，
  // 原实现里最旧那条永远取不到（listActiveMemories 按 updated_at 倒序 LIMIT 20）
  for (let i = 0; i < 24; i++) {
    seedMemory(db, {
      conversationId: `char_${a}`, judgment: `日常琐事${i}`, importance: 2,
      updatedAt: `2026-08-${String((i % 9) + 1).padStart(2, '0')} 10:00:00`,
    });
  }
  const KEY = '最重要但最旧：她的家人生病住院了';
  seedMemory(db, { conversationId: `char_${a}`, judgment: KEY, importance: 5, updatedAt: '2026-07-01 10:00:00' });

  const pool = readMemberPrivateMemories(a, {});
  assert.equal(pool.length, 25, `候选池要覆盖全部 25 条（当前常量 ${GROUP_PRIVATE_MEMORY_SCAN_LIMIT}）`);
  assert.ok(pool.some(m => m.judgment === KEY), '候选池必须含那条最旧最重要的');
  const picked = rankPrivateMemories(pool, GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER);
  assert.equal(picked[0].judgment, KEY, '排序后它就是第一条，能真正被注入');

  // 把候选池手动调回 20 条即可复现原故障（这就是改 30 的理由）
  const legacyPool = readMemberPrivateMemories(a, { limit: 20 });
  assert.equal(legacyPool.length, 20);
  assert.ok(!legacyPool.some(m => m.judgment === KEY), '原 20 条候选池里确实看不到最旧那条');
});

test('H3 小节形状：成员限定 + 不产空块', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  seedMemory(db, { conversationId: `char_${a}`, judgment: '她和用户私下聊过的事' });

  const block = buildMemberPrivateMemoryBlock('甲', readMemberPrivateMemories(a, {}));
  assert.ok(block.startsWith('<member_private_memory name="甲">\n'));
  assert.ok(block.includes('【只有甲自己知道，其他人不知情，也不要替她说出来】'));
  assert.ok(block.endsWith('</member_private_memory>'));
  assert.ok(block.includes('- 你和用户私下聊过：她和用户私下聊过的事'));

  // 没有记忆的成员不产出小节
  assert.equal(buildMemberPrivateMemoryBlock('乙', readMemberPrivateMemories(b, {})), null);
  const collected = collectMemberPrivateMemoryBlocks([
    { id: a, display_name: '甲' }, { id: b, display_name: '乙' },
  ]);
  assert.equal(collected.blocks.length, 1);
  assert.deepEqual(collected.injected, [{ id: a, name: '甲', count: 1 }]);
  assert.ok(!collected.blocks.join('').includes('name="乙"'));
});

test('H3 只有「未互动事件」的成员不产块（那种记忆连"发生过"都不算）', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  seedMemory(db, { conversationId: `char_${a}`, judgment: '未互动事件：雨夜告白。用户没有赴约。' });
  assert.deepEqual(collectMemberPrivateMemoryBlocks([{ id: a, display_name: '甲' }]).blocks, []);
});

// ── 问题 2：H3 读侧滤掉带「群聊」tag 的 H2 记忆（群 prompt 里本来就有那些话） ──

test('问题 2 只有「群聊」tag 的成员：读侧一条都不给，不产小节（也不产空块）', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  seedMemory(db, { conversationId: `char_${a}`, judgment: '在群「摸鱼群」里，你说：今晚吃啥。', tags: [GROUP_LINK_TAG, '群组:9'] });
  seedMemory(db, { conversationId: `char_${a}`, judgment: '在群「摸鱼群」里，乙说：我不吃那个。', tags: [GROUP_LINK_TAG, '群组:9'] });

  assert.equal(isMemberPrivateOnlyMemory({ tags: [GROUP_LINK_TAG] }), false);
  assert.equal(isMemberPrivateOnlyMemory({ tags: ['私聊'] }), true);
  assert.deepEqual(readMemberPrivateMemories(a, {}), [], 'H3 读侧不喂"群里刚说过的话"');
  assert.equal(buildMemberPrivateMemoryBlock('甲', readMemberPrivateMemories(a, {})), null);
  assert.deepEqual(collectMemberPrivateMemoryBlocks([{ id: a, display_name: '甲' }]).blocks, [], '不产空块');
});

test(`问题 2 群聊 tag + 普通私聊记忆：小节只含后者，且条数按上限（${GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER}）取满`, async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  // 真机形态：H2 的群聊记忆 importance=4、更新更勤（数量和新鲜度都占优）
  for (let i = 0; i < 5; i++) {
    seedMemory(db, {
      conversationId: `char_${a}`, judgment: `在群「摸鱼群」里，你说：群里第${i}句话。`,
      tags: [GROUP_LINK_TAG, '群组:9'], importance: 4, updatedAt: `2026-08-1${i} 10:00:00`,
    });
  }
  const privateTexts = ['她偷偷买的猫粮牌子', '她其实怕黑', '她家人生病住院了', '她不吃香菜'];
  privateTexts.forEach((text, i) => {
    seedMemory(db, {
      conversationId: `char_${a}`, judgment: text, tags: ['私聊'],
      importance: 3, updatedAt: `2026-08-0${i + 1} 10:00:00`,
    });
  });

  const pool = readMemberPrivateMemories(a, {});
  assert.equal(pool.length, privateTexts.length, '候选池里只剩真私聊记忆');
  assert.ok(pool.every(m => !m.tags.includes(GROUP_LINK_TAG)));

  const block = collectMemberPrivateMemoryBlocks([{ id: a, display_name: '甲' }]).blocks[0];
  const bullets = block.match(/^- .*/gm) || [];
  assert.equal(bullets.length, GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER, '条数按上限取满（不被群聊记忆挤掉位置）');
  assert.ok(!block.includes('群里第'), `小节里不能有群聊记忆：${block}`);
  assert.ok(!block.includes('群里发生过'), '不该再走"群里发生过"那条分支');
  assert.equal((block.match(/你和用户私下聊过/g) || []).length, GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER);

  // H1 不受影响：这些记忆在**私聊**召回里照旧算群来源、照旧标出处
  const h1 = formatPrivateChatMemoryLines([
    { memory_id: 'h2', conversation_id: `char_${a}`, memory_type: 'knowledge', tags: [GROUP_LINK_TAG, '群组:9'], judgment: '在群「摸鱼群」里，你说：今晚吃啥。' },
  ]);
  assert.ok(h1.includes('【群聊'), `H1 仍然要带上这些记忆：${h1}`);
});

test('问题 2 H2 记忆把"最近 N 条"窗口占满时，真私聊记忆仍能进候选池（读侧超采）', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  // 比候选池窗口（GROUP_PRIVATE_MEMORY_SCAN_LIMIT）更多的群聊记忆，且全部更新更晚
  for (let i = 0; i < GROUP_PRIVATE_MEMORY_SCAN_LIMIT + 9; i++) {
    seedMemory(db, {
      conversationId: `char_${a}`, judgment: `在群「摸鱼群」里，你说：群里第${i}句话。`,
      tags: [GROUP_LINK_TAG, '群组:9'], importance: 4,
      updatedAt: `2026-08-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`,
    });
  }
  seedMemory(db, { conversationId: `char_${a}`, judgment: '她最重要的一条真私聊记忆', importance: 5, updatedAt: '2026-07-01 10:00:00' });

  const pool = readMemberPrivateMemories(a, {});
  assert.equal(pool.length, 1, '窗口被群聊记忆占满，但真私聊记忆还是被读到');
  assert.equal(pool[0].judgment, '她最重要的一条真私聊记忆');
  // 只读一次、有界：超采窗口就是 SCAN_LIMIT × 倍数（不够就返回实际条数，不报错）
  assert.ok(GROUP_PRIVATE_MEMORY_SCAN_LIMIT * GROUP_PRIVATE_MEMORY_SCAN_OVERFETCH >= GROUP_PRIVATE_MEMORY_SCAN_LIMIT + 10);
});

test(`H3 每人那一节最多 ${GROUP_PRIVATE_MEMORY_MEMBER_CHARS} 字（超长截断）`, async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  const long = '很长的私聊记忆内容。'.repeat(30);   // 300 字
  seedMemory(db, { conversationId: `char_${a}`, judgment: long, importance: 5, updatedAt: '2026-08-02 10:00:00' });
  seedMemory(db, { conversationId: `char_${a}`, judgment: long, importance: 4, updatedAt: '2026-08-01 10:00:00' });

  const block = buildMemberPrivateMemoryBlock('甲', readMemberPrivateMemories(a, {}));
  assert.ok(block.length <= GROUP_PRIVATE_MEMORY_MEMBER_CHARS, `每节 ≤${GROUP_PRIVATE_MEMORY_MEMBER_CHARS} 字，实际 ${block.length}`);
  assert.equal(block.length, GROUP_PRIVATE_MEMORY_MEMBER_CHARS, '额度会被用满');
  assert.ok(block.includes('…\n</member_private_memory>'), '超长部分截断成省略号');
});

test(`H3 多人 × 长历史不膨胀：全体合计 ≤${GROUP_PRIVATE_MEMORY_TOTAL_CHARS} 字，额度用完的成员本轮不注入并打 log`, async t => {
  const db = useMemDb(t);
  const members = [];
  const long = '很长的私聊记忆内容。'.repeat(30);
  for (let i = 1; i <= 20; i++) {
    const id = 9000 + i;
    members.push({ id, display_name: `角色${i}` });
    for (let k = 0; k < 10; k++) {
      seedMemory(db, {
        conversationId: `char_${id}`,
        judgment: `${long}${k}`,
        importance: 5,
        updatedAt: `2026-08-${String((k % 9) + 1).padStart(2, '0')} 10:00:00`,
      });
    }
  }

  const { result: collected, logs } = captureLogs(() => collectMemberPrivateMemoryBlocks(members));
  const total = collected.blocks.join('\n').length;
  assert.ok(total <= GROUP_PRIVATE_MEMORY_TOTAL_CHARS, `20 人 × 10 条长记忆，全体注入 ≤${GROUP_PRIVATE_MEMORY_TOTAL_CHARS} 字，实际 ${total}`);
  assert.ok(collected.blocks.length <= Math.ceil(GROUP_PRIVATE_MEMORY_TOTAL_CHARS / GROUP_PRIVATE_MEMORY_MEMBER_CHARS) + 1);
  for (const block of collected.blocks) {
    assert.ok(block.length <= GROUP_PRIVATE_MEMORY_MEMBER_CHARS);
  }
  assert.equal(collected.injected.length + collected.skipped.length, members.length);
  assert.ok(collected.skipped.length > 0, '额度用完的成员要被跳过');
  assert.ok(logs.some(l => l.startsWith('[memory]') && l.includes('额度已用完') && l.includes('跳过')),
    `应有跳过 log：${logs.slice(-3).join(' | ')}`);
});

test('H3 8 人群、每人 3 条中等长度记忆：人人有份（旧的 1800 字额度会挤掉后面的人）', async t => {
  const db = useMemDb(t);
  // 每条 46 字、每人 3 条 → 单节约 258 字（未触发截断），8 节合计约 2071 字：
  // 正好落在"1800 不够、2400 够"的区间，用来证明加额度的必要性
  const text = '她私下说过的中等长度记忆内容，具体到某件小事。'.repeat(2);
  assert.equal(text.length, 46);

  const members = [];
  for (let i = 1; i <= 8; i++) {
    const id = 8000 + i;
    members.push({ id, display_name: `角色${i}` });
    for (let k = 0; k < GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER; k++) {
      seedMemory(db, { conversationId: `char_${id}`, judgment: `${text}${k}`, importance: 5 - k });
    }
  }

  const { result: collected, logs } = captureLogs(() => collectMemberPrivateMemoryBlocks(members));
  assert.equal(collected.blocks.length, 8, `8 个人人都要有一节：${logs.join(' | ')}`);
  assert.deepEqual(collected.skipped, [], '全员都在额度内');
  assert.equal(collected.injected.length, 8);
  assert.ok(collected.chars <= GROUP_PRIVATE_MEMORY_TOTAL_CHARS, `全体 ${collected.chars} 字必须 ≤ ${GROUP_PRIVATE_MEMORY_TOTAL_CHARS}`);

  // 同样的输入在旧额度（1800）下就会有人被跳过 —— 这就是 1800 → 2400 的理由
  const legacy = collectMemberPrivateMemoryBlocks(members, { totalChars: 1800 });
  assert.ok(legacy.skipped.length > 0, '旧的 1800 字额度下确实装不下 8 人');
  assert.ok(legacy.blocks.length < 8);
});

test('H3 总开关关掉：一节都不注入；缺 id / 读失败都安全', async t => {
  const db = useMemDb(t);
  const a = seedCharacter(db, '甲');
  seedMemory(db, { conversationId: `char_${a}`, judgment: '私下聊过的事' });
  const members = [{ id: a, display_name: '甲' }];

  config.features = { ...config.features, memory: false };
  try {
    assert.deepEqual(collectMemberPrivateMemoryBlocks(members).blocks, []);
  } finally {
    config.features = { ...config.features, memory: true };
  }
  assert.equal(collectMemberPrivateMemoryBlocks(members).blocks.length, 1);

  // 非法成员 / 空入参不报错
  assert.deepEqual(collectMemberPrivateMemoryBlocks([]).blocks, []);
  assert.deepEqual(collectMemberPrivateMemoryBlocks(null).blocks, []);
  assert.deepEqual(collectMemberPrivateMemoryBlocks([{ id: 0 }, { id: 'x' }, null]).blocks, []);
  // 单成员读失败只 warn、不影响别人
  const boom = collectMemberPrivateMemoryBlocks([
    { id: 987654, display_name: '坏的' }, { id: a, display_name: '甲' },
  ], { readMemories: id => { if (id === 987654) throw new Error('db down'); return readMemberPrivateMemories(id, {}); } });
  assert.equal(boom.blocks.length, 1);
});

// ──────────────── 挂点（源码级） ────────────────

test('groupChatEngine 挂点：H3 在通用 directive 之后、催眠块之前；H2 是 fire-and-forget', async () => {
  const source = await readFile(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  const h3At = source.indexOf('collectMemberPrivateMemoryBlocks(group.members)');
  const hypnoAt = source.indexOf('collectHypnosisDirectiveBlocks(group.members)');
  const limitAt = source.indexOf('<round_message_limit>');
  // task-1 起 buildGroupContext 多了一个 excludeTimeRanges 选项（遗忘屏蔽），断言只锚到函数名
  const buildAt = source.indexOf('buildGroupContext(group, directiveBlocks', h3At);
  assert.ok(h3At > 0, 'runGroupRound 里没有调用 collectMemberPrivateMemoryBlocks');
  assert.ok(limitAt > 0 && limitAt < h3At, 'H3 必须排在通用 directive 之后');
  assert.ok(hypnoAt > h3At, 'H3 必须排在催眠块之前');
  assert.ok(buildAt > h3At, 'H3 必须在 buildGroupContext 之前');

  assert.ok(source.indexOf('linkGroupRoundToPrivateMemories({') > 0, '缺少 H2 写入调用');
  assert.match(
    source,
    /\.catch\(err => console\.warn\('\[group\] group→private memory link failed:', err\.message\)\)/,
    'H2 必须是 fire-and-forget（.catch 只 warn）',
  );
  assert.match(source, /Promise\.resolve\(\)\s*\n\s*\.then\(\(\) => linkGroupRoundToPrivateMemories\(/, 'H2 不能阻塞群聊收尾');
});

test('chat.js 挂点：群范围查询与 <rag_memories> 都在记忆总开关内、被 try/catch 兜住', async () => {
  const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  const guardAt = source.indexOf('if (config.features.memory) {');
  const scopeAt = source.indexOf('listCharacterGroupConversationIds(characterId, db)', guardAt);
  const pushAt = source.indexOf('dynamicBlocks.push(`<rag_memories>', guardAt);
  const catchAt = source.indexOf("console.error('[chat] memory search failed:'", guardAt);
  assert.ok(guardAt > 0 && scopeAt > guardAt, '群范围检索必须在 if (config.features.memory) 内');
  assert.ok(pushAt > scopeAt, '注入必须在同一段里');
  assert.ok(catchAt > pushAt, '整段必须被 try/catch 兜住');
  assert.ok(source.includes('formatPrivateChatMemoryLines'), '注入必须走 groupMemoryLink 的格式化');
  assert.ok(source.includes('selectPrivateChatMemories'), '必须走条数收敛');
});

test('整条链路没有真联网：fetch 只被系统内置嵌入/重排的兜底尝试过，且全部失败降级', () => {
  // hybridSearch 在嵌入不可用时会尝试系统内置通道；本文件的 fetch 一律抛错，
  // 说明"文本通道照样能召回"，也说明 H1/H2/H3 本身不依赖网络。
  assert.ok(networkAttempts > 0, 'end-to-end 测试应当尝试过内置通道并被挡下');
});
