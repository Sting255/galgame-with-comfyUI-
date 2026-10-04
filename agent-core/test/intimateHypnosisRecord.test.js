/**
 * 亲密看板 × 催眠轮记账回归（2026-09-29，用户报「催眠的时候如果发生性交记录到面板里」）
 *
 * 真机缺口（两条确定性记账路径在催眠轮都会空手而归，详见 intimateAutoRecord.js 的注释）：
 *   A. 正文兜底只扫「她这一轮的回复」：催眠口径（完全控制 = 语气平淡、简短、直给；
 *      \`<reply_length>\` 10~60 字）把露骨词压到**用户那一句指令**上
 *      → user=「自慰吧」词表命中、她的回复不命中 ⇒ 整轮零流水。
 *   B. 有生图 prompt 时归类/兜底是互斥的：催眠「强制高潮」轮强制走生图管线，
 *      prompt 由生图助手自拟（散文式英文场景描述，不含归类 tag）
 *      → 归类空手而归、正文兜底又进不到（chat.js 的 else 分支）⇒ 整轮零流水。
 *
 * 修法（只改 intimate*.js，不动 chat.js）：
 *   1. \`recordUnspecifiedFromRawId\` 的判定文本在**催眠轮**并入紧邻其前的用户消息（roundTextOf）；
 *   2. \`recordFromConversationTail\` 在归类拿不到任何行为时，催眠轮再跑一次正文兜底（同一 raw_id 锚点）。
 *   两条都以 \`hypnosisService.isBodyControlled\` 为唯一判定（不复制「active_until > now」口径）。
 *
 * 本文件覆盖：修复前后差异（催眠轮记一笔 / 普通轮零行为变化）、幂等、不双重计数、
 * 总开关、以及"解除催眠后回到普通轮行为"。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import（config 在 import 期读环境变量）；
 * globalThis.fetch 直接抛错挡网络——本文件不应产生任何真实外部请求。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate hypnosis record fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { listIntimateLogs, ACT_DEFINITIONS } = await import('../src/services/intimateService.js');
const {
  recordUnspecifiedFromRawId, recordFromConversationTail, ACT_UNSPECIFIED,
} = await import('../src/services/intimateAutoRecord.js');
const { hypnotize, wake, issueCommand } = await import('../src/services/hypnosisService.js');

config.dbPath = ':memory:';
after(() => closeDb());

/** 真机日志（完整/backend-2026-09-29.log 2173-2176）里她按完全控制口径回的原句：一个成人词都不含 */
const HYPNOSIS_REPLY = '嗯……好。\n（指尖顺着裙摆边沿慢慢滑下去，动作有些发软）\n手……有点不太听使唤……\n你……能看着我吗？';
/** 用户那一句指令：命中 EXPLICIT_ADULT_PATTERN（自慰） */
const USER_COMMAND = '自慰吧';
/** 强对照：她自己正文里就有成人词 */
const EXPLICIT_REPLY = '她忍不住叫了出来，高潮来得又急又猛。';
/** 生图助手给催眠轮自拟的散文式 prompt：不含 classifyPromptTags 认识的 tag */
const PROSE_PROMPT = 'A dim dormitory bedroom at night, Nahida on all fours, trembling, moonlight';
/** 可归类的生图 prompt（vaginal + oral） */
const TAGGED_PROMPT = '1girl, creampie, fellatio, bedroom';

let seq = 0;
function seedCharacter(name) {
  const db = getDb();
  seq += 1;
  db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`${name}_${seq}`, `${name}${seq}`, '测试用成年角色');
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** 三态账本：催眠 = body_controlled(1) 且未过期。走服务层，保证与生产同一条路径 */
function hypnotizeNow(characterId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO backpack_items (name, description, effect_key, status, owner_key, source_type, collected_at)
     VALUES ('hypnosis_phone', '催眠手机', 'hypnosis_phone', 'ready', 'me', 'grant', datetime('now'))`
  ).run();
  hypnotize(characterId, { minutes: 30 });
}

function addRaw(characterId, role, content, prompt = null) {
  const db = getDb();
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, ?, ?, ?)')
    .run(`char_${characterId}`, role, content, prompt);
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

const logsOf = characterId => listIntimateLogs(characterId, { limit: 100, partnerKinds: 'all' });

// ── A. 正文兜底：催眠轮并入用户消息 ──────────────────────────────────────────

test('催眠轮：用户指令命中、她按完全控制口径回的短句不命中 → 仍记一笔「未归类」（修复前为 0）', () => {
  const id = seedCharacter('hyp_a');
  hypnotizeNow(id);
  addRaw(id, 'user', USER_COMMAND);
  const rawId = addRaw(id, 'assistant', HYPNOSIS_REPLY);

  const res = recordUnspecifiedFromRawId({ characterId: id, rawId, scene: 'chat', partnerKind: 'user' });
  assert.equal(res.inserted, 1, `催眠轮必须记一笔，实际 ${JSON.stringify(res)}`);

  const rows = logsOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actKey, ACT_UNSPECIFIED, '只承认"发生了"，不猜具体行为');
  assert.equal(rows[0].rawId, rawId, '幂等锚点仍必须是本轮 raw_id');
  assert.equal(rows[0].scene, 'chat');
  assert.equal(rows[0].partnerKind, 'user');
  assert.equal(rows[0].source, 'auto');

  // 重复调用（重连 / 重生成 / 重试）不翻倍
  const again = recordUnspecifiedFromRawId({ characterId: id, rawId });
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, 1);
  assert.equal(logsOf(id).length, 1);
});

test('普通轮零行为变化：同一对 user/assistant 文本，未催眠时一个字都不写', () => {
  const id = seedCharacter('plain_a');   // 不催眠
  addRaw(id, 'user', USER_COMMAND);
  const rawId = addRaw(id, 'assistant', HYPNOSIS_REPLY);

  const res = recordUnspecifiedFromRawId({ characterId: id, rawId });
  assert.deepEqual(res, { inserted: 0, skipped: 0, blocked: false, acts: [] });
  assert.equal(logsOf(id).length, 0);
});

test('普通轮回归：她自己正文命中成人内容时照旧记一笔（放宽没有动到原口径）', () => {
  const id = seedCharacter('plain_b');
  const rawId = addRaw(id, 'assistant', EXPLICIT_REPLY);
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId }).inserted, 1);
  assert.equal(logsOf(id)[0].actKey, ACT_UNSPECIFIED);
});

test('解除催眠 / 过期后回到普通轮口径（isBodyControlled 是唯一判定）', () => {
  const id = seedCharacter('hyp_b');
  hypnotizeNow(id);
  addRaw(id, 'user', USER_COMMAND);
  const rawA = addRaw(id, 'assistant', HYPNOSIS_REPLY);
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: rawA }).inserted, 1);

  wake(id, { mode: 'full' });   // 完全唤醒 → 不再受控
  addRaw(id, 'user', USER_COMMAND);
  const rawB = addRaw(id, 'assistant', HYPNOSIS_REPLY);
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: rawB }).inserted, 0, '解除后不得再并入用户消息');
  assert.equal(logsOf(id).length, 1);
});

test('催眠轮但会话里没有更早的用户消息 / raw 不存在 / 自己的回复本来就命中 → 各自零误报', () => {
  const id = seedCharacter('hyp_c');
  hypnotizeNow(id);

  // 会话第一条就是 assistant（没有可并入的用户消息）
  const firstRaw = addRaw(id, 'assistant', HYPNOSIS_REPLY);
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: firstRaw }).inserted, 0);

  // raw 不存在
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: 999999 }).inserted, 0);

  // 她自己的回复命中 → 照常一笔
  const explicitRaw = addRaw(id, 'assistant', EXPLICIT_REPLY);
  assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId: explicitRaw }).inserted, 1);
  assert.equal(logsOf(id).length, 1);
});

// ── B. 会话尾部：归类拿不到行为时，催眠轮接着跑正文兜底 ────────────────────────

test('催眠轮 + 散文式生图 prompt（无可归类 tag）+ 正文命中 → 记一笔，不再整轮丢账', () => {
  const id = seedCharacter('hyp_d');
  hypnotizeNow(id);
  const rawId = addRaw(id, 'assistant', '（身体被摆成跪姿，被从后面进入，忍不住叫出声）……高潮了……', PROSE_PROMPT);

  const res = recordFromConversationTail({ characterId: id, conversationId: `char_${id}`, scene: 'chat', partnerKind: 'user' });
  assert.equal(res.rawId, rawId, '锚点仍是尾部那条带 prompt 的 raw');
  assert.equal(res.inserted, 1, `强制高潮轮必须记一笔，实际 ${JSON.stringify(res)}`);
  const rows = logsOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actKey, ACT_UNSPECIFIED);
  assert.equal(rows[0].rawId, rawId);

  // 幂等
  const again = recordFromConversationTail({ characterId: id, conversationId: `char_${id}` });
  assert.equal(again.inserted, 0);
  assert.equal(logsOf(id).length, 1);
});

test('普通轮同样输入 → 零写入（互斥口径与旧行为逐字节一致；forceTextFallback 缺省 false）', () => {
  const id = seedCharacter('plain_c');
  addRaw(id, 'assistant', '（身体被摆成跪姿，被从后面进入，忍不住叫出声）……高潮了……', PROSE_PROMPT);
  // 不传 / 显式传 false：两种写法都必须零写入（默认值就是"逐字节不变"）
  const implicit = recordFromConversationTail({ characterId: id, conversationId: `char_${id}` });
  assert.equal(implicit.inserted, 0);
  const explicit = recordFromConversationTail({
    characterId: id, conversationId: `char_${id}`, forceTextFallback: false,
  });
  assert.equal(explicit.inserted, 0);
  assert.equal(logsOf(id).length, 0);
});

// ── B2. forceTextFallback：给「不经 chat.js 的自动触发轮」显式开兜底（task-9） ──

test('forceTextFallback=true：非催眠轮、归类拿不到行为时也跑一次正文兜底', () => {
  const id = seedCharacter('forced_a');   // **不催眠**（task-42：强制高潮不需要催眠）
  const rawId = addRaw(id, 'assistant', '（身体被摆成跪姿，被从后面进入，忍不住叫出声）……高潮了……', PROSE_PROMPT);

  const res = recordFromConversationTail({
    characterId: id, conversationId: `char_${id}`, scene: 'chat', partnerKind: 'user',
    forceTextFallback: true,
  });
  assert.equal(res.rawId, rawId);
  assert.equal(res.inserted, 1, `显式要求兜底时必须在同一 raw_id 上记一笔，实际 ${JSON.stringify(res)}`);
  const rows = logsOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actKey, ACT_UNSPECIFIED);
  assert.equal(rows[0].rawId, rawId);

  // 幂等：同一 raw 再调（自动轮重放 / 重试）不翻倍
  const again = recordFromConversationTail({
    characterId: id, conversationId: `char_${id}`, forceTextFallback: true,
  });
  assert.equal(again.inserted, 0);
  assert.equal(logsOf(id).length, 1);
});

test('forceTextFallback=true 不会扩大误报面：正文不命中 / 归类成功 / 总开关关闭 → 都不落「未归类」', () => {
  // ① 正文一个成人词都没有 → 什么都不记
  const plain = seedCharacter('forced_b');
  addRaw(plain, 'assistant', '今天天气不错，我们去河边走走吧。', PROSE_PROMPT);
  const plainRes = recordFromConversationTail({
    characterId: plain, conversationId: `char_${plain}`, forceTextFallback: true,
  });
  assert.equal(plainRes.inserted, 0);
  assert.equal(logsOf(plain).length, 0);

  // ② 归类成功 → 仍然只记归类那两笔，不叠「未归类」（同一 raw 一条兜底都不能多）
  const tagged = seedCharacter('forced_c');
  const taggedRaw = addRaw(tagged, 'assistant', '（被从后面进入，高潮了）', TAGGED_PROMPT);
  const taggedRes = recordFromConversationTail({
    characterId: tagged, conversationId: `char_${tagged}`, forceTextFallback: true,
  });
  assert.equal(taggedRes.inserted, 2);
  assert.deepEqual(logsOf(tagged).map(r => r.actKey).sort(), ['oral', 'vaginal']);
  assert.ok(logsOf(tagged).every(r => r.rawId === taggedRaw));

  // ③ 总开关关闭 → 一个字都不写
  const off = seedCharacter('forced_d');
  addRaw(off, 'assistant', '（身体被摆成跪姿，被从后面进入）……高潮了……', PROSE_PROMPT);
  const previous2 = config.features.intimate;
  config.features.intimate = false;
  try {
    assert.equal(recordFromConversationTail({
      characterId: off, conversationId: `char_${off}`, forceTextFallback: true,
    }).inserted, 0);
    assert.equal(logsOf(off).length, 0);
  } finally {
    config.features.intimate = previous2;
  }
});

test('forceTextFallback=true：本轮**根本没有生图 prompt**（自动触发轮没配图）也兜底；默认不兜底', () => {
  const id = seedCharacter('forced_e');   // 不催眠
  const rawId = addRaw(id, 'assistant', '（没配图的一轮）……高潮了……', null);

  // 默认（false）：保持旧口径 —— 找不到带 prompt 的尾部 raw 就什么都不做
  const off = recordFromConversationTail({ characterId: id, conversationId: `char_${id}` });
  assert.deepEqual({ inserted: off.inserted, rawId: off.rawId }, { inserted: 0, rawId: 0 });
  assert.equal(logsOf(id).length, 0);

  // 显式要求：退到该会话最后一条 assistant raw（调用方在 writeProactiveMessage 之后立刻调用）
  const on = recordFromConversationTail({
    characterId: id, conversationId: `char_${id}`, forceTextFallback: true,
  });
  assert.equal(on.rawId, rawId);
  assert.equal(on.inserted, 1, `没配图的强制轮也必须记一笔，实际 ${JSON.stringify(on)}`);
  assert.equal(logsOf(id)[0].actKey, ACT_UNSPECIFIED);
  assert.equal(logsOf(id)[0].rawId, rawId);

  // 幂等：同一 raw 重放不翻倍
  assert.equal(recordFromConversationTail({
    characterId: id, conversationId: `char_${id}`, forceTextFallback: true,
  }).inserted, 0);
  assert.equal(logsOf(id).length, 1);

  // 会话里一条 assistant raw 都没有（角色刚建/会话被清空）→ 仍零写入、零锚点
  const blank = seedCharacter('forced_f');
  const none = recordFromConversationTail({
    characterId: blank, conversationId: `char_${blank}`, forceTextFallback: true,
  });
  assert.equal(none.rawId, 0);
  assert.equal(none.inserted, 0);
});

test('催眠轮 + 可归类 prompt：仍走归类，且不叠「未归类」（不双重计数）', () => {
  const id = seedCharacter('hyp_e');
  hypnotizeNow(id);
  const rawId = addRaw(id, 'assistant', '（被从后面进入，高潮了）', TAGGED_PROMPT);

  const res = recordFromConversationTail({ characterId: id, conversationId: `char_${id}` });
  assert.equal(res.inserted, 2);
  assert.deepEqual(res.acts.map(a => a.actKey).sort(), ['oral', 'vaginal']);
  const keys = logsOf(id).map(r => r.actKey).sort();
  assert.deepEqual(keys, ['oral', 'vaginal'], '归类成功时不得再落 unspecified');
  assert.ok(logsOf(id).every(r => r.rawId === rawId));
});

// ── C. 总开关与挂点契约 ────────────────────────────────────────────────────

test('总开关 features.intimate=false：催眠轮的两条路径都零写入', () => {
  const id = seedCharacter('hyp_f');
  hypnotizeNow(id);
  addRaw(id, 'user', USER_COMMAND);
  const rawId = addRaw(id, 'assistant', HYPNOSIS_REPLY);
  // 尾部换成"散文 prompt"那条：总开关关掉时这条也一个字都不能写
  addRaw(id, 'assistant', '（被从后面进入）', PROSE_PROMPT);

  const previous = config.features.intimate;
  config.features.intimate = false;
  try {
    assert.equal(recordUnspecifiedFromRawId({ characterId: id, rawId }).inserted, 0);
    assert.equal(recordFromConversationTail({ characterId: id, conversationId: `char_${id}` }).inserted, 0);
    assert.equal(logsOf(id).length, 0);
  } finally {
    config.features.intimate = previous;
  }
});

test('强制高潮（按钮）本身那一笔仍在：scene=hypnosis、source=manual、锚点用本次催眠会话', () => {
  const id = seedCharacter('hyp_g');
  hypnotizeNow(id);
  const state = issueCommand(id, 'forced_climax');
  assert.equal(state.intimate.inserted, 1);
  assert.match(state.intimate.sourceUid, /^hypnosis:.+:forced_climax$/);
  const rows = logsOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actKey, 'climax');
  assert.equal(rows[0].scene, 'hypnosis');
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].rawId, 0, '按钮那一笔不占 raw_id，撤回聊天不会误删它');

  // 同一次催眠里重复点：幂等，不翻倍
  issueCommand(id, 'forced_climax');
  assert.equal(logsOf(id).length, 1);
});

test('口径收口：unspecified 标签仍由 ACT_DEFINITIONS 提供（面板可读）', () => {
  const entry = ACT_DEFINITIONS.find(item => item.key === ACT_UNSPECIFIED);
  assert.ok(entry);
  assert.equal(entry.label, '未归类');
  assert.deepEqual(entry.tags, [], '只有正文兜底与人工才会产生它');
});

test('源码级：催眠轮的两条放宽收口在 intimateAutoRecord.js，禁止被改回"只看她那一半"', () => {
  const source = fs.readFileSync(new URL('../src/services/intimateAutoRecord.js', import.meta.url), 'utf8');
  assert.match(source, /^import { isBodyControlled } from '\.\/hypnosisService\.js';$/m,
    '催眠判定必须复用 hypnosisService 的权威口径，不得自己写 SQL');
  assert.match(source, /function isHypnosisRound\(characterId\)/);
  assert.match(source, /function roundTextOf\(db, row, characterId\)/);
  assert.match(source, /const { text } = roundTextOf\(getDb\(\), row, characterId\);/,
    'recordUnspecifiedFromRawId 必须走 roundTextOf');
  assert.match(source, /if \(round\.hypnosis \|\| forceTextFallback === true\) \{/,
    '尾部记账必须保留"催眠轮 / 显式 forceTextFallback 再跑一次正文兜底"的分支');
  assert.match(source, /forceTextFallback = false,/, 'forceTextFallback 默认必须是 false（现有行为逐字节不变）');
  assert.match(source, /if \(forceTextFallback !== true\) return \{ \.\.\.EMPTY, rawId: 0 \};/,
    '没 prompt 时只有"强制入账的轮次"才退到最后一条 assistant raw（默认口径不变）');
  assert.match(source, /const fallback = recordUnspecifiedFromText\(\{/, '兜底必须复用同一个入口');
  assert.match(source, /if \(fallback\.inserted > 0 \|\| fallback\.blocked\) return \{ \.\.\.fallback, rawId: row\.id \};/);
});
