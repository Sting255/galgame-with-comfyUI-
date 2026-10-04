/**
 * T2 信箱生成信件时检索「她所在的群」的长期记忆
 *
 * 验收（目标/操作流水.md §四 第 7 条）：
 *   ① 群里整理出来的记忆（`memory_fragments.conversation_id = 'group_<id>'`）在写信检索时能被召回、
 *      并作为素材进 prompt；
 *   ② 走既有收口：`groupMemoryLink.listCharacterGroupConversationIds` / `isGroupConversationId` /
 *      `groupOriginPrefix`，检索范围交给 `hybridSearch` 的 conversationIds —— 不新造并行检索；
 *   ③ 没有群记忆时，私聊素材与 prompt 结构逐字节不变；
 *   ④ 尊重既有开关（`config.features.memory` / `isGroupMemoryLinkEnabled()`）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络
 *（hybridSearch 会尝试系统内置嵌入，这里证明整条链路都没有真联网）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
let networkAttempts = 0;
globalThis.fetch = async url => {
  networkAttempts += 1;
  throw new Error(`mailboxGroupMemory fixture forbids network: ${url}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { GROUP_LINK_TAG } = await import('../src/services/groupMemoryLink.js');
const { hybridSearch } = await import('../src/services/memorySearch.js');
const {
  resolveMailboxMemoryScope,
  formatMailboxMemoryLines,
  buildMailboxMemorySection,
} = await import('../src/services/mailboxScheduler.js');

// ──────────────── 夹具（与 groupMemoryLink.test.js 同口径，避免两套造数姿势） ────────────────

function useMemDb(t) {
  const db = getDb();
  t.after(() => closeDb());
  return db;
}

let memorySeq = 0;
/** 直接造记忆行：需要精确控制 conversation_id / tags，走仓储 API 反而绕 */
function seedMemory(db, { conversationId, judgment, importance = 3, tags = ['测试'], updatedAt = '2026-08-01 10:00:00' }) {
  memorySeq += 1;
  const memoryId = `mem_mailbox_${memorySeq}`;
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
    .run(`mailbox_${displayName}`, displayName, `你是${displayName}，说话简短。`).lastInsertRowid);
}

function seedGroup(db, { name, memberIds }) {
  const groupId = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)')
    .run(name, '测试话题').lastInsertRowid);
  for (const id of memberIds) {
    db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(groupId, id);
  }
  return groupId;
}

/** 旧实现（改动前 mailboxScheduler 内联的那段）——「零行为变化」的逐字节基准 */
const legacyLines = memories => memories.map(m => `- [${m.memory_type || '记忆'}] ${m.judgment}`).join('\n');
const legacySection = memories => `【相关长期记忆】\n${legacyLines(memories)}`;

// ──────────────── ① 有群记忆：召回 + 标出处 + 进素材 ────────────────

test('写信检索包含她所在的群会话（scope = char_<id> + group_<id>）', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const other = seedCharacter(db, '乙');
  const g1 = seedGroup(db, { name: '摸鱼群', memberIds: [id, other] });
  const g2 = seedGroup(db, { name: '夜谈群', memberIds: [id] });
  seedGroup(db, { name: '她不在的群', memberIds: [other] });

  const scope = resolveMailboxMemoryScope(id, db);
  assert.deepEqual(scope.conversationIds, [`char_${id}`, `group_${g1}`, `group_${g2}`]);
  assert.deepEqual(scope.groupConversationIds, [`group_${g1}`, `group_${g2}`]);
  // 别人的群不进她的检索范围
  assert.equal(scope.conversationIds.some(cid => cid === `group_${3}` || cid.includes('她不在的群')), false);
  // 不传 db 时走 getDb() 同一份连接
  assert.deepEqual(resolveMailboxMemoryScope(id).conversationIds, scope.conversationIds);
  // 没有群的角色：范围就是她自己那个会话
  assert.deepEqual(resolveMailboxMemoryScope(other, db).groupConversationIds.length > 0, true, '乙在自己的群里');
});

test('① 端到端：群会话记忆在写信检索里能召回，并带【群聊·群名】出处进素材', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [id] });
  const groupConv = `group_${groupId}`;
  // 群里整理链路落的群会话记忆（conversation_id = group_<id>）
  seedMemory(db, { conversationId: groupConv, judgment: '甲在群里说她今晚带了香菜', importance: 4 });
  // 她自己的私聊记忆
  seedMemory(db, { conversationId: `char_${id}`, judgment: '她喜欢香菜', importance: 3 });

  const section = await buildMailboxMemorySection(id, '香菜', { search: hybridSearch, timeoutMs: 8000 });
  assert.ok(section, '必须有素材段');
  assert.ok(section.startsWith('【相关长期记忆】\n'), section);
  assert.ok(section.includes('甲在群里说她今晚带了香菜'), `群里那条必须被召回：${section}`);
  assert.ok(section.includes('【群聊·摸鱼群】'), `群来源条目要标出处：${section}`);
  assert.ok(section.includes('她喜欢香菜'), '她自己的记忆照常注入');

  // 检索范围断言：真正传给 hybridSearch 的是「自己 + 所在群」，没有别的群
  let seenOptions = null;
  await buildMailboxMemorySection(id, '香菜', {
    timeoutMs: 8000,
    search: async (query, options) => { seenOptions = options; return []; },
  });
  assert.equal(seenOptions.topK, 3, 'topK 仍是既有口径 3（不随群数量膨胀）');
  assert.equal(seenOptions.queryTokenLimit, undefined, '私聊/信箱口径不传宽松分词上限');
  assert.deepEqual(seenOptions.conversationIds, [`char_${id}`, groupConv]);
});

test('① 无群记忆但有群：命中里没有群来源时逐字节等于旧实现', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  seedGroup(db, { name: '摸鱼群', memberIds: [id] });
  seedMemory(db, { conversationId: `group_${seedGroup(db, { name: '空群', memberIds: [id] })}`, judgment: '群里的旧事' });

  const section = await buildMailboxMemorySection(id, '香菜', {
    search: async () => [
      { conversation_id: `char_${id}`, memory_type: 'knowledge', judgment: '她喜欢香菜' },
      { conversation_id: `char_${id}`, memory_type: 'emotion', judgment: '她讨厌被放鸽子' },
    ],
  });
  assert.equal(section, legacySection([
    { memory_type: 'knowledge', judgment: '她喜欢香菜' },
    { memory_type: 'emotion', judgment: '她讨厌被放鸽子' },
  ]), '没有群来源命中时，素材段与改动前逐字节一致');
  assert.ok(!section.includes('【群聊'), section);
});

// ──────────────── ② 无群：零行为变化（逐字节） ────────────────

test('② 没有群的角色：检索范围只有她自己那个会话，素材逐字节等于旧实现', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const other = seedCharacter(db, '乙');
  const otherGroup = seedGroup(db, { name: '别人的群', memberIds: [other] });
  assert.ok(otherGroup > 0);

  assert.deepEqual(resolveMailboxMemoryScope(id, db), {
    conversationIds: [`char_${id}`], groupConversationIds: [],
  });

  // 用真 hybridSearch 跑一遍（含 FTS/ngram/向量/实体四路降级），证明确实不联网、结果正常
  seedMemory(db, { conversationId: `char_${id}`, judgment: '她喜欢香菜' });
  // 真跑一遍 hybridSearch：嵌入/重排那两路会尝试外呼，但被夹具整段挡死（抛错即降级），
  // 召回由文本（FTS/ngram）通道完成 —— 所以下面这条素材必须仍然被召回，且行为与旧实现逐字节一致。
  const section = await buildMailboxMemorySection(id, '香菜', { search: hybridSearch, timeoutMs: 8000 });
  assert.equal(section, legacySection([{ memory_type: 'knowledge', judgment: '她喜欢香菜' }]));
  assert.ok(networkAttempts > 0, '夹具确实挡下了嵌入/重排的外呼（否则这个用例没在证明"不真联网"）');
});

test('② 纯格式化：没有群来源时与旧字符串逐字节一致（含缺字段兜底）', async t => {
  useMemDb(t);
  const results = [
    { conversation_id: 'char_1', memory_type: 'knowledge', judgment: '她喜欢香菜' },
    { conversation_id: 'char_1', memory_type: 'emotion', judgment: '她讨厌被放鸽子' },
    { conversation_id: 'char_1', judgment: '没有类型字段' },
  ];
  assert.equal(formatMailboxMemoryLines(results), legacyLines(results));
  assert.equal(formatMailboxMemoryLines([]), '');
  assert.equal(formatMailboxMemoryLines(null), '');
  assert.ok(!formatMailboxMemoryLines(results).includes('【群聊'));
});

// ──────────────── ③ 开关 ────────────────

test('③ 记忆总开关关闭：不查群、不检索、不产素材段', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [id] });
  seedMemory(db, { conversationId: `group_${groupId}`, judgment: '甲在群里说她今晚带了香菜' });
  seedMemory(db, { conversationId: `char_${id}`, judgment: '她喜欢香菜' });

  const original = config.features.memory;
  config.features.memory = false;
  t.after(() => { config.features.memory = original; });
  try {
    assert.deepEqual(resolveMailboxMemoryScope(id, db), {
      conversationIds: [`char_${id}`], groupConversationIds: [],
    });
    let searchCalls = 0;
    const section = await buildMailboxMemorySection(id, '香菜', {
      search: async () => { searchCalls += 1; return []; },
    });
    assert.equal(section, null, '开关关闭时不产素材段');
    assert.equal(searchCalls, 0, '开关关闭时一次检索都不发（更不会连网络）');
  } finally {
    config.features.memory = original;
  }
  // 开关打开后同一场景恢复正常
  const back = await buildMailboxMemorySection(id, '香菜', { search: hybridSearch, timeoutMs: 8000 });
  assert.ok(back && back.includes('甲在群里说她今晚带了香菜'), back);
});

test('③ 空命中不产空段', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  assert.equal(await buildMailboxMemorySection(id, '香菜', { search: async () => [] }), null);
  // 检索抛错按旧行为吞掉（catch(() => [])），不产段也不冒泡
  assert.equal(await buildMailboxMemorySection(id, '香菜', { search: async () => { throw new Error('boom'); } }), null);
  assert.ok(db);
});

// ──────────────── 群出处：H2 tag 形态 / 群名缺失降级 ────────────────

test('群出处：群会话条目与带「群聊」tag 的 H2 记忆都标出处，群名查不到退化成【群聊】', async t => {
  const db = useMemDb(t);
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { name: '摸鱼群', memberIds: [id] });
  const lines = formatMailboxMemoryLines([
    { conversation_id: `group_${groupId}`, memory_type: 'knowledge', judgment: '群里的第0件事' },
    {
      conversation_id: `char_${id}`, memory_type: 'knowledge', tags: [GROUP_LINK_TAG, '群组:' + groupId, '摸鱼群'],
      judgment: '在群「摸鱼群」里，你说：今晚谁带了香菜？',
    },
    { conversation_id: `char_${id}`, memory_type: 'knowledge', tags: [GROUP_LINK_TAG], judgment: '群里那件旧事' },
    { conversation_id: `char_${id}`, memory_type: 'knowledge', tags: ['私聊'], judgment: '她偷偷买的猫粮牌子' },
  ], { groupIds: [`group_${groupId}`] }).split('\n');

  assert.equal(lines[0], '- 【群聊·摸鱼群】[knowledge] 群里的第0件事');
  assert.equal(lines[1], '- 【群聊·摸鱼群】[knowledge] 在群「摸鱼群」里，你说：今晚谁带了香菜？');
  assert.equal(lines[2], '- 【群聊】[knowledge] 群里那件旧事', '定位不到群名时退化，不报错');
  assert.equal(lines[3], '- [knowledge] 她偷偷买的猫粮牌子', '普通私聊记忆与旧实现逐字节一致');
});

// ──────────────── 源码级：调用点确实走了收口 ────────────────

test('源码级：mailboxScheduler 的检索范围由 groupMemoryLink 收口，不再只查本会话', async () => {
  const source = await readFile(new URL('../src/services/mailboxScheduler.js', import.meta.url), 'utf8');
  assert.ok(source.includes('listCharacterGroupConversationIds'), '必须复用 groupMemoryLink 的群会话查询');
  assert.match(source, /const memorySection = await buildMailboxMemorySection\(charId, userContent\);/,
    'generateReplyData 必须走新的素材段构建函数');
  assert.equal(source.includes("hybridSearch(userContent, { conversationId: convId, topK: 3, timeoutMs: 15000 })"), false,
    '旧的「只查本会话」调用必须已删除');
  // 不越过收口自己去查群表
  assert.equal(/FROM group_members/.test(source), false, '不要在信箱里重写一份群成员查询');
  // groupMemoryLink 本体不在本次改动范围（T1 的写范围相邻），这里只做存在性断言
  const linkSource = await readFile(new URL('../src/services/groupMemoryLink.js', import.meta.url), 'utf8');
  assert.match(linkSource, /export function listCharacterGroupConversationIds/);
});

test('源码级：prompt 里的长期记忆仍走【相关长期记忆】素材段（LLM 输出规则不受影响）', async () => {
  const source = await readFile(new URL('../src/services/mailboxScheduler.js', import.meta.url), 'utf8');
  assert.match(source, /mat2Parts\.push\(memorySection\)/, '素材段仍拼进 system 2');
  assert.match(source, /【相关长期记忆】/, '段落标题保留');
  // 本次只改素材来源，没有新增/修改 LLM 的 JSON 字段，示例仍在
  assert.ok(source.includes('"paperPrompt"') && source.includes('请只返回JSON，不要输出任何解释。'),
    'JSON 示例与「只返回 JSON」约束原样保留');
});
