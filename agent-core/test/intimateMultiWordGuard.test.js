/**
 * 体位反查：多词元素的紧凑守卫收紧（task-23）
 *
 * 背景：紧凑守卫写成 `if (!form.includes(' ') && 元素数 > MAX_TIGHT_BUNDLE_TAGS) continue;`，
 * **带空格的元素完全绕过守卫**，于是 `professional lighting` / `ultra high res` 这类通用画面词
 * 会从二十多 tag 的大场景包里借中文名，在面板「体位排行」显示成「高潮后展穴」这类荒唐条目。
 *
 * 落地的是**方案 B（定向黑名单）而不是方案 A（去掉豁免）**，因为 task-23 实测：
 *   - 方案 A：砍掉 25.4% 的真体位（90/354，含 `on all fours`「床上肛交后入」、`full nelson`
 *     「背后锁臂」、`doggystyle anal`「肛交内射特写」）→ 远超 10% 阈值，否决。
 *   - 方案 B：只砍 0.8%（3/354，且都是 79~103 字符的长自然语言句，逐字出现在真实 prompt 里
 *     概率≈0）；同一套 300 条合成语料上，误归因 150 → 0、召回率保持 100%。
 *
 * 本文件锁四件事：
 *   1. 反例保护：真体位（含**受豁免的多词元素**）一条不少，且 `river`/`viewer`/`peeking` 这类
 *      词边界对照必须不被误伤 —— 子串匹配正是 task-23 测量里把 `piledriver` 打成空的原因；
 *   2. 集合级：所有"命中共用通用画面词"的**元素**都不可再解析；多 token 打包项与 bundles 不动；
 *   3. 语料级：正样本全命中、负样本 0 误归因；
 *   4. 别名不被绕过：带权重形态 `(professional lighting:1.2)` 与剥权重形态都不许成为体位。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络。
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate multi-word guard fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  classifyPromptTags,
  getPositionVocabularyMap,
  listIntimateVocabulary,
  positionLabel,
  resolvePositionKey,
  tagsFromPromptString,
} = await import('../src/services/intimateService.js');

/** 通用画面词（本测试自带的独立子集，故意窄于生产黑名单：只断言生产必须拦住的那些） */
const GENERIC_PHRASES = [
  'lighting', 'light', 'quality', 'best quality', 'masterpiece', 'resolution', 'ultra high res', '8k', '4k',
  'photorealistic', 'cinematic', 'vignette', 'contrast', 'texture', 'anatomy', 'detailed', 'magnum opus',
  'lens', 'lens flare', 'bokeh', 'blur', 'blurry', 'depth of field', 'motion blur', 'motion line', 'focus', 'sharp',
  'closeup', 'close up', 'camera', 'shot', 'angle', 'framing', 'composition', 'background', 'foreground',
  'portrait', 'full body', 'full photo', 'view', 'viewer', 'perspective', 'looking at', 'looking up',
  'award winning', 'photo of', 'beautiful', 'ultra cute',
];

/** 真体位（含受豁免的多词元素与词边界对照）：必须继续命中 */
const POSE_KEEP = [
  ['missionary', '传教士体位'],
  ['doggystyle', '狗爬式'],
  ['arms grab', '抱腰后入'],
  ['69', '69式'],
  ['reverse cowgirl', '女上反骑'],
  ['paizuri', '乳交'],
  ['cunnilingus', '舔阴'],
  ['on all fours', '床上肛交后入'],
  ['full nelson', '背后锁臂'],
  ['doggystyle anal', '肛交内射特写'],
  ['anal gape', '肛口内射'],
  ['hda piledriver', '倒立插入式'],
  ['piledriver doggystyle', '倒插后入'],
  ['peeking out upper body', '探头'],
  ['walk-in', '进门被发现'],
  ['sitting on face', '坐脸'],
  ['standing footjob', '站立足交'],
];

/** 受豁免的多词通用词（task-23 实测会显示成「高潮后展穴」等）：必须已不可解析 */
const GENERIC_BLOCKED = [
  'professional lighting', 'ultra high res', 'cinematic lighting', 'ambient occlusion', 'high contrast',
  'full body shot', 'detailed face', 'ray tracing', 'depth of field', 'motion blur', 'intricate details',
  'shallow depth of field', 'looking at viewer', 'top view', 'front side view',
];

const positions = () => listIntimateVocabulary().positions;

function seedDb(t) {
  const db = getDb();
  t.after(() => closeDb());
  return db;
}

const splitWords = value => String(value ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
function hasPhrase(form, phrase) {
  const f = splitWords(form); const k = splitWords(phrase);
  if (k.length === 0 || k.length > f.length) return false;
  for (let i = 0; i + k.length <= f.length; i += 1) {
    let hit = true;
    for (let j = 0; j < k.length; j += 1) if (f[i + j] !== k[j]) { hit = false; break; }
    if (hit) return true;
  }
  return false;
}

/** 知识库里 adult_pose_vocabulary 的所有打包 key 与元素（独立于实现的原始数据） */
function rawVocabulary() {
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

function stripWeight(raw) {
  let t = String(raw ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const s = t.trim(); if (s.length < 2) break;
    const h = s[0]; const tl = s[s.length - 1];
    const paired = (h === '(' && tl === ')') || (h === '[' && tl === ']') || (h === '{' && tl === '}');
    if (!paired) break; t = s.slice(1, -1).trim();
  }
  return t.replace(/:[ ]*[0-9]+(\.[0-9]+)?[ ]*$/, '').trim();
}

// ──────────────── 该去的去 ────────────────

test('通用画面词元素不再被解析成体位（task-23 实测坏样本）', async t => {
  seedDb(t);
  for (const form of GENERIC_BLOCKED) {
    assert.equal(resolvePositionKey(form), '', `「${form}」不该再成为体位`);
  }
});

test('集合级：所有命中共用通用画面词的"元素"都不可再解析（只动元素，不动打包项）', async t => {
  seedDb(t);
  const bundleKeys = getPositionVocabularyMap();
  const elements = new Set();
  for (const key of rawVocabulary()) {
    for (const part of key.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      if (part === key) continue; // 单 token 打包项：走精确命中，不在本次元素口径内
      if (part) elements.add(part);
    }
  }
  const offenders = [];
  for (const element of elements) {
    // 真实包名优先（bundles 命中分支）：B 只作用于元素，包名一律保留
    if (bundleKeys.has(element)) continue;
    if (!GENERIC_PHRASES.some(p => hasPhrase(element, p))) continue;
    if (resolvePositionKey(element) !== '') offenders.push(element);
  }
  assert.deepEqual(offenders, [], '命中通用画面词的元素必须全部不可解析');
});

test('多 token 打包体位项与词表一条不少（集合级对比）', async t => {
  seedDb(t);
  const rawKeys = rawVocabulary();
  const rawMulti = [...rawKeys].filter(k => k.includes(',')).sort();
  const bundleKeys = getPositionVocabularyMap();
  const nowMulti = [...bundleKeys.keys()].filter(k => k.includes(',')).sort();
  assert.ok(rawMulti.length > 400, `知识库多 token 包数量异常：${rawMulti.length}`);
  assert.deepEqual(nowMulti, rawMulti, '多 token 打包项必须与知识库逐条一致');

  // 方案 B 只作用于"元素"，**不裁任何包名**：真包名一个都不能少（多 token 已在上面的集合相等里锁死；
  // 单 token 包由下面的条数断言兜住 —— 若 B 误裁包名，差值就会超过 task-18 去噪的 23 条）。
  const TASK18_NOISE_REMOVED = 23;
  assert.equal(positions().length, rawKeys.size - TASK18_NOISE_REMOVED, '词表条数应只受 task-18 去噪影响');
  for (const p of positions()) {
    assert.equal(typeof p.key, 'string');
    assert.equal(typeof p.label, 'string');
    assert.ok(Array.isArray(p.tags));
  }
});

test('别名不被绕过：带权重形态与剥权重形态都不许成为体位', async t => {
  seedDb(t);
  assert.equal(resolvePositionKey('(professional lighting:1.2)'), '');
  assert.equal(resolvePositionKey('professional lighting'), '');
  assert.equal(resolvePositionKey('(ultra high res:1.5)'), '');
  // 真体位的别名路径不受影响（task-21 的能力不回退）
  assert.notEqual(resolvePositionKey('on all fours'), '');
});

// ──────────────── 该留的留 ────────────────

test('反例保护：真体位继续命中，含受豁免的多词元素与词边界对照', async t => {
  seedDb(t);
  for (const [tag, label] of POSE_KEEP) {
    assert.equal(resolvePositionKey(tag), tag, `「${tag}」应继续命中`);
    assert.equal(positionLabel(tag), label, `「${tag}」的中文名应为「${label}」`);
  }
  // 子串匹配会误伤的三条对照：`river`→piledriver、`view`→viewer/peeking
  assert.equal(resolvePositionKey('hda piledriver'), 'hda piledriver');
  assert.equal(resolvePositionKey('piledriver doggystyle'), 'piledriver doggystyle');
  assert.equal(resolvePositionKey('peeking out upper body'), 'peeking out upper body');
  assert.equal(resolvePositionKey('walk-in'), 'walk-in');
});

test('跨包公共词仍然不索引（守卫不回退）', async t => {
  seedDb(t);
  for (const common of ['on bed', 'looking at viewer', 'sex from behind', 'hetero', 'penis', '1boy']) {
    assert.equal(resolvePositionKey(common), '', `公共词「${common}」不该被归因`);
  }
});

// ──────────────── 语料级 ────────────────

test('语料级：正样本 100% 命中、负样本 0 误归因（含别名/权重形态）', async t => {
  seedDb(t);
  const positives = POSE_KEEP.map(([tag]) => tag);
  const negatives = [...GENERIC_BLOCKED, ...GENERIC_PHRASES.map(p => `${p}:1.2`)];

  const positivePrompts = positives.map(tag => `masterpiece, 1girl, nude, vaginal, ${tag}, bedroom`);
  for (const prompt of positivePrompts) {
    const acts = classifyPromptTags(tagsFromPromptString(prompt));
    const key = acts.map(a => a.positionKey).find(Boolean) || '';
    assert.notEqual(key, '', `正样本 prompt 必须仍能归因：${prompt}`);
  }

  const negativePrompts = negatives.map(tag => `masterpiece, 1girl, nude, anal, ${tag}, bedroom`);
  const leaked = [];
  for (const prompt of negativePrompts) {
    const acts = classifyPromptTags(tagsFromPromptString(prompt));
    const key = acts.map(a => a.positionKey).find(Boolean) || '';
    if (key !== '') leaked.push(`${prompt} → ${key}(${positionLabel(key)})`);
  }
  assert.deepEqual(leaked, [], '负样本 prompt 不该归因出任何体位');
});

// ──────────────── 已知边界（交 task-25 方案 C） ────────────────

test('已知边界：单 token 通用包仍会进排行（方案 B 只作用于元素，task-25 C1 处理）', async t => {
  seedDb(t);
  // 方案 B 的口径是"元素级"：单 token 打包项（知识库自己的一条记录）不由它裁决。
  // 这些词对用户同样是"不是体位却出现在排行"，task-25 的 C1（扩展黑名单覆盖单 token 包）落地后，
  // 请把下面两条断言改为 resolvePositionKey(...) === ''。
  assert.equal(resolvePositionKey('mirror'), 'mirror', 'mirror→照镜子：单 token 通用包，task-25 C1 待收');
  assert.equal(resolvePositionKey('caught'), 'caught', 'caught→被发现：同上');
});
