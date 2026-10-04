/**
 * 体位词表去噪：流体 / 事后 / 生理反应类单 token 包不再被当成"体位"
 *
 * 背景：`adult_pose_vocabulary` 里混着 `cum`→射精、`aftersex`→事后、`peeing`→排尿 这类
 * **单 token 包**。它们会被 resolvePositionKey 精确命中，于是
 * `masterpiece, 1girl, nude, vaginal, cum, bedroom` 这种真实 prompt 会把「射精」顶进
 * 面板的「体位排行」——那不是体位，看板可信度直接受损。
 *
 * 本文件锁四件事：
 *   1. 噪声条目从词表与解析两侧都清掉（`resolvePositionKey` 不再命中，也不会借包名混进来）；
 *   2. **反例保护**：真体位（missionary / doggystyle / 抱腰后入…）与多 token 打包项一条不少；
 *   3. 词边界不误伤：`peeking out upper body`（含 'pee'）仍然命中；
 *   4. 行为统计不受影响：`vaginal` 照常计入 byAct，只是不作为"体位"归因。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络。
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate position noise fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  classifyPromptTags,
  getIntimateStats,
  getPositionVocabularyMap,
  listIntimateVocabulary,
  positionLabel,
  recordIntimateActs,
  resetPositionVocabularyCache,
  resolvePositionKey,
  tagsFromPromptString,
} = await import('../src/services/intimateService.js');

/** 去噪后应彻底消失的单 token 包（= 实测被移除的 23 条，逐条都在黑名单上有依据） */
const NOISE_KEYS = [
  'cum', 'cum inside', 'cum on breast', 'cum on ass', 'cum on belly', 'cum on forehead++++', 'cum on cloth',
  'creamypie', 'ejaculating', 'ejaculation', 'female ejaculation', 'facial', 'gokkun',
  'aftersex', 'mind break', 'heart-shaped pupils', 'ahegao with creampie',
  'lactating', 'lactation', 'breast feeding', 'peeing', 'pee on her',
  "(motion blur:1.2) and (blurry foreground:1.15) and (woman's pussy juice is squirting onto the camerae:1.2) and (wet lens",
];

/** 真体位反例：去噪后必须继续命中（含"多 token 包的唯一元素"这条路径） */
const MUST_HIT = [
  ['missionary', '传教士体位'],
  ['doggystyle', '狗爬式'],
  ['arms grab', '抱腰后入'],
  ['69', '69式'],
  ['reverse cowgirl', '女上反骑'],
  ['paizuri', '乳交'],
  ['cunnilingus', '舔阴'],
];

/** 反查侧（多 token 包的唯一元素）里的流体/射精/排尿 tag，也必须不再成为体位 */
const NOISE_REVERSE_INDEX = [
  'cum on breast', 'projectile cum', 'cum on tongue', 'cum in anus', 'cum pool', 'excessive cum',
  'hair cumshot', 'dripping pussy juices', 'yellow pee', 'female orgasm',
];

function seedDb(t) {
  const db = getDb();
  t.after(() => closeDb());
  return db;
}

/** 知识库里 adult_pose_vocabulary 的全部原始打包 key（未过滤口径，用来证明"该留的留着"） */
function rawVocabularyKeys() {
  const rows = getDb().prepare(
    `SELECT executable_tags FROM image_prompt_knowledge
     WHERE is_active = 1 AND category = 'adult_pose_vocabulary'`
  ).all();
  const keys = new Set();
  for (const row of rows) {
    let tags = [];
    try { tags = JSON.parse(row.executable_tags || '[]'); } catch { continue; }
    for (const item of tags) {
      const key = String(item?.tag ?? '').trim().toLowerCase().slice(0, 120).trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

const positions = () => listIntimateVocabulary().positions;

// ──────────────── 该去的去 ────────────────

test('23 条流体/事后/生理反应单 token 包不再进词表，也不再被 resolve 命中', async t => {
  seedDb(t);
  const all = positions();
  for (const key of NOISE_KEYS) {
    assert.ok(!all.some(p => p.key === key), `「${key}」不该再出现在体位词表里`);
    assert.equal(resolvePositionKey(key), '', `resolvePositionKey('${key}') 必须为 ''`);
  }
});

test('反查侧：多 token 包的唯一流体元素也不会借包名变成体位', async t => {
  seedDb(t);
  for (const tag of NOISE_REVERSE_INDEX) {
    assert.equal(resolvePositionKey(tag), '', `「${tag}」不该被当成体位（会借所属包的中文名混进排行）`);
  }
});

test('真实 prompt：vaginal + cum 不再把「射精」顶进体位（去噪前 positionKey=cum）', async t => {
  seedDb(t);
  const prompt = 'masterpiece, best quality, 1girl, nude, vaginal, cum, bedroom, soft lighting';
  const acts = classifyPromptTags(tagsFromPromptString(prompt));
  assert.deepEqual(acts.map(a => a.actKey), ['vaginal'], '行为统计照常');
  assert.deepEqual(acts.map(a => a.positionKey), [''], '体位归因必须为空（去噪前这里是 cum）');
  assert.equal(positionLabel('cum'), 'cum', '不在索引里的 key 只回落原样，不会显示「射精」');
});

test('缓存重建后过滤依然生效（resetPositionVocabularyCache 不会绕过黑名单）', async t => {
  seedDb(t);
  assert.equal(resolvePositionKey('cum'), '');
  resetPositionVocabularyCache();
  assert.equal(resolvePositionKey('cum'), '');
  assert.equal(resolvePositionKey('aftersex'), '');
});

// ──────────────── 该留的留 ────────────────

test('反例保护：真体位（含多 token 包的唯一元素）继续命中', async t => {
  seedDb(t);
  for (const [tag, label] of MUST_HIT) {
    assert.equal(resolvePositionKey(tag), tag, `「${tag}」应继续命中`);
    assert.equal(positionLabel(tag), label, `「${tag}」的中文名应为「${label}」`);
  }
  // 任务里点名的组合：sex from behind + arms grab
  const tagList = tagsFromPromptString('1girl, sex from behind, arms grab, cum, wall');
  const [act] = classifyPromptTags(tagList);
  assert.equal(act.actKey, 'vaginal');
  assert.equal(act.positionKey, 'arms grab');
  assert.equal(positionLabel(act.positionKey), '抱腰后入');
});

test('多 token 打包体位项一条不少（集合级对比：只动单 token 包）', async t => {
  seedDb(t);
  const rawMulti = [...rawVocabularyKeys()].filter(k => k.includes(',')).sort();
  const nowMulti = [...getPositionVocabularyMap().keys()].filter(k => k.includes(',')).sort();
  assert.ok(rawMulti.length > 400, `知识库多 token 包数量异常：${rawMulti.length}`);
  assert.deepEqual(nowMulti, rawMulti, '多 token 打包体位项必须与知识库逐条一致');
  // 词表返回形状不变
  for (const p of positions()) {
    assert.equal(typeof p.key, 'string');
    assert.equal(typeof p.label, 'string');
    assert.ok(Array.isArray(p.tags));
  }
});

test('词边界不误伤：含 pee 的 peeking out upper body 仍命中', async t => {
  seedDb(t);
  assert.equal(resolvePositionKey('peeking out upper body'), 'peeking out upper body');
  assert.equal(positionLabel('peeking out upper body'), '探头');
  // 另一条负向对照：walk-in 里的 'in' 不该被任何关键词波及
  assert.equal(resolvePositionKey('walk-in'), 'walk-in');
});

// ──────────────── 行为统计不受影响 ────────────────

test('行为统计不受影响：cum 不作为体位，但 vaginal 照常计入 byAct', async t => {
  const db = seedDb(t);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES ('lin', 'lin', '旅客')`
  ).run();
  const characterId = Number(lastInsertRowid);

  const acts = classifyPromptTags(tagsFromPromptString('1girl, nude, vaginal, cum, bedroom'));
  assert.equal(acts.length, 1);
  assert.equal(acts[0].actKey, 'vaginal');
  assert.equal(acts[0].positionKey, '');

  recordIntimateActs(characterId, { scene: 'chat', partnerKind: 'user', rawId: 7, acts });
  const stats = getIntimateStats(characterId, { partnerKinds: 'all' });
  assert.equal(stats.totalActs, 1);
  assert.deepEqual(stats.byAct.map(a => [a.actKey, a.count]), [['vaginal', 1]], 'byAct 仍按行为统计');
  assert.deepEqual(stats.byPosition, [], 'byPosition 不该出现「射精」这类噪声');
});
