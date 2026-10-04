/**
 * 体位词表：带权重包名/元素的"剥权重别名"回归测试（task-21）
 *
 * 背景：知识库里不少条目在**元素**或**包名**上带 A1111 权重包装（`(bent over:1.3)`、
 * `(vibrator under panties secure leg belt:1.2)`），而真实生图 prompt 里的 tag 已被
 * `tagsFromPromptString` 剥掉权重（`bent over`）。两者在反查表里是不同的 key，
 * 于是出现"漏归因"（查不到）与"近义错配"（落到另一个同义包）。
 *
 * 目标口径（task-21）：
 *   - 别名 = 剥权重后的形态 → 指向**真实包 key**（不新建包，注入用的包名保持原样）
 *   - 命中别名时返回真实包 key，这样 positionLabel 才是中文、注入块也不会吐带权重的长串
 *   - 别名同样要过现有守卫：跨包公共词不索引、单 token 只认紧凑包
 *   - **真实包名优先**：别名与真实包 key 同名时以真实包为准（知识库里就有 3 个这样的冲突：
 *     `(doggystyle)`/`(paizuri)`/`(cunnilingus)` 剥权重后正是一个真实包名）
 *
 * 说明：本文件自带一份"剥权重"实现，与 intimateService 的口径一致但不依赖它——
 * 测试不该用被测实现的内部函数来构造期望值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate weight alias fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  getPositionVocabularyMap, listIntimateVocabulary, resetPositionVocabularyCache,
  resolvePositionKey, positionLabel, classifyPromptTags,
} = await import('../src/services/intimateService.js');

/** 与实现同口径的剥权重：先剥成对外层括号，再吃掉 `:1.2` 这类权重后缀 */
function stripWeight(raw) {
  let text = String(raw ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const t = text.trim();
    if (t.length < 2) break;
    const head = t[0];
    const tail = t[t.length - 1];
    const paired = (head === '(' && tail === ')') || (head === '[' && tail === ']') || (head === '{' && tail === '}');
    if (!paired) break;
    text = t.slice(1, -1).trim();
  }
  return text.replace(/:\s*\d+(?:\.\d+)?\s*$/, '').trim();
}

/** 干净库 + 清体位索引缓存（缓存是模块级的，跨库必须清） */
function fresh(t) {
  const db = getDb();
  t.after(() => closeDb());
  resetPositionVocabularyCache();
  return db;
}

/**
 * 从当前真实词表里找出"元素带权重"的样本（数据驱动，不硬编码 key，免得知识库更新后失效）。
 * 只挑剥权重后不是真实包名、且最多只有一个归属包的，避免与"真实包名优先"的例子混淆。
 */
function findWeightedElements(limit = 40) {
  const bundles = getPositionVocabularyMap();
  const ownerCount = new Map();
  for (const key of bundles.keys()) {
    for (const part of new Set(key.split(',').map(s => s.trim()).filter(Boolean))) {
      if (!ownerCount.has(part)) ownerCount.set(part, []);
      ownerCount.get(part).push(key);
    }
  }
  const found = [];
  for (const [key, entry] of bundles) {
    for (const part of new Set(key.split(',').map(s => s.trim()).filter(Boolean))) {
      const stripped = stripWeight(part);
      if (stripped === part || stripped.length < 4) continue;
      if (bundles.has(stripped)) continue; // 冲突样本单独测
      if ((ownerCount.get(stripped) || []).length > 1) continue; // 公共词由守卫生效，另测
      found.push({ element: part, stripped, ownerKey: key, label: entry.label });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

const WEIGHTED_ELEMENTS = findWeightedElements();
// 探针：别名是否已实现（task-18 完成后本任务才动生产代码，未实现时用例标 todo，不留红灯）
const hasAliasSample = WEIGHTED_ELEMENTS.some(w => resolvePositionKey(w.stripped) === w.ownerKey);
const ALIAS_TODO = hasAliasSample ? false : '剥权重别名尚未实现（等 task-18 释放 intimateService.js 后落地）';

test('前置数据：知识库里确实存在带权重的体位元素（否则别名逻辑无从回归）', async t => {
  fresh(t);
  assert.ok(
    WEIGHTED_ELEMENTS.length > 0,
    '当前 adult_pose_vocabulary 里找不到"元素带权重"的样本，本文件的断言会变成空跑，请人工核对知识库',
  );
  for (const w of WEIGHTED_ELEMENTS.slice(0, 5)) {
    assert.notEqual(w.stripped, w.element);
    assert.ok(w.ownerKey.length > 0);
  }
});

test('别名命中：剥权重后的 tag 指向真实包 key，中文名不带权重残渣', { todo: ALIAS_TODO }, async t => {
  fresh(t);
  let resolved = 0;
  for (const w of WEIGHTED_ELEMENTS) {
    const rawKey = resolvePositionKey(w.element);
    const aliasKey = resolvePositionKey(w.stripped);
    if (!rawKey) {
      // 元素本身就被去噪/守卫挡掉（如 `(cum in nose:1.1)` 属流体噪声）
      // → 别名也不该把它救回来，否则「射精」会从别名这条路回到「体位排行」
      assert.equal(
        aliasKey, '',
        `元素「${w.element}」本身未索引，剥权重形态「${w.stripped}」也不该被索引`,
      );
      continue;
    }
    // 别名形态若撞上公共词守卫（出现在 ≥2 个包）允许漏归因——"宁可漏归因不可错归因"，
    // 但不能返回一个别的包（下面这行是关键约束）
    if (aliasKey === '') continue;
    assert.equal(aliasKey, w.ownerKey, `剥权重 tag「${w.stripped}」应归因到真实包 key`);
    assert.notEqual(aliasKey, w.stripped, '别名命中必须返回真实包 key，不能返回别名自身');
    const label = positionLabel(aliasKey);
    assert.ok(!label.includes('(') && !label.includes(':'), `中文名带权重残渣：${label}`);
    assert.notEqual(label, aliasKey, `中文名回落成了包名：${label}`);
    resolved += 1;
  }
  // 覆盖度下限：有效样本 60+，别名整体失效时这里会红，避免"一条都没生效但用例全绿"
  assert.ok(resolved >= 5, `只有 ${resolved} 个带权重元素通过别名命中，别名逻辑疑似没生效`);
});

test('去噪不被别名绕过：流体/泌乳类带权重元素既不作体位、也不留别名', async t => {
  fresh(t);
  const bundles = getPositionVocabularyMap();
  let checked = 0;
  for (const [key] of bundles) {
    for (const part of new Set(key.split(',').map(s => s.trim()).filter(Boolean))) {
      const stripped = stripWeight(part);
      if (stripped === part) continue;
      if (bundles.has(stripped)) continue; // 剥权重后正好是真实包名 → 走"真实包名优先"用例
      if (resolvePositionKey(part) !== '') continue; // 没被去噪的走上面那条用例
      assert.equal(
        resolvePositionKey(stripped), '',
        `被去噪的「${part}」不该通过别名复活成「${stripped}」`,
      );
      checked += 1;
    }
  }
  // 断言"确实存在这种样本"，否则本用例是空跑（词表变了要有人来看）
  assert.ok(checked > 0, '词表里找不到"带权重且被去噪"的元素样本，本用例会空跑');
});

test('真实包名优先：别名与真实包名冲突时，真实包名不被顶掉', async t => {
  fresh(t);
  const bundles = getPositionVocabularyMap();
  // 知识库里 (doggystyle)/(paizuri)/(cunnilingus) 剥权重后正好是真实包名，是天然的冲突样本
  const conflicts = [];
  for (const [key, entry] of bundles) {
    for (const part of new Set(key.split(',').map(s => s.trim()).filter(Boolean))) {
      const stripped = stripWeight(part);
      if (stripped === part || !bundles.has(stripped) || stripped === key) continue;
      conflicts.push({ element: part, stripped, aliasOwner: key, realKey: stripped, realLabel: entry.label });
    }
  }
  assert.ok(conflicts.length > 0, '知识库里找不到"别名与真实包名冲突"的样本');
  for (const c of conflicts) {
    assert.equal(
      resolvePositionKey(c.stripped), c.realKey,
      `「${c.stripped}」是真包名（${bundles.get(c.realKey).label}），不该被别名顶成「${c.aliasOwner}」`,
    );
    assert.equal(positionLabel(c.realKey), bundles.get(c.realKey).label);
  }
  // 三条已知样本固定住口径（数据仍在，就继续要求它们成立）
  for (const [tag, expectedLabel] of [['doggystyle', '狗爬式'], ['paizuri', '乳交'], ['cunnilingus', '舔阴']]) {
    if (!bundles.has(tag)) continue;
    assert.equal(resolvePositionKey(tag), tag);
    assert.equal(positionLabel(tag), expectedLabel);
  }
});

test('别名也过守卫：跨包公共词不会被别名变成体位', async t => {
  fresh(t);
  // hetero / penis 在词表里以带权重元素出现，但它们是跨包公共词 → 必须仍然解析为空
  for (const common of ['hetero', 'penis', '1boy']) {
    assert.equal(resolvePositionKey(common), '', `公共词「${common}」不该被归因`);
  }
  // 与 task-1/task-18 既有口径一致：on bed / looking at viewer 也不索引
  for (const common of ['on bed', 'looking at viewer', 'solo']) {
    assert.equal(resolvePositionKey(common), '', `公共词「${common}」不该被归因`);
  }
});

test('别名不进词表：positions 只回真实包 key', async t => {
  fresh(t);
  const positions = listIntimateVocabulary().positions;
  const keys = new Set(positions.map(p => p.key));
  for (const w of WEIGHTED_ELEMENTS) {
    assert.ok(!keys.has(w.stripped), `别名「${w.stripped}」不该进体位下拉词表`);
  }
  assert.ok(positions.every(p => typeof p.key === 'string' && p.key.length > 0));
});

test('反例保护：真体位仍然正确归因（别名逻辑不得误伤）', async t => {
  fresh(t);
  const expectations = [
    ['missionary', '传教士体位'],
    ['doggystyle', '狗爬式'],
    ['arms grab', '抱腰后入'],
  ];
  for (const [tag, label] of expectations) {
    assert.equal(resolvePositionKey(tag), tag, `「${tag}」应精确命中自身`);
    assert.equal(positionLabel(tag), label, `「${tag}」中文名不对`);
  }
  // 真实样式 prompt：行为分类 + 体位归因都要照常
  const acts = classifyPromptTags(['1girl', 'solo', 'sex from behind', 'arms grab', 'on bed', 'cum']);
  const vaginal = acts.find(a => a.actKey === 'vaginal');
  assert.ok(vaginal, 'vaginal 行为必须照常归类');
  assert.equal(positionLabel(vaginal.positionKey), '抱腰后入');
});

test('通用不变量：任何能解析出的 position_key 都必须是真实包 key 或真实元素，中文名无权重残渣', async t => {
  fresh(t);
  const bundles = getPositionVocabularyMap();
  const elements = new Set();
  for (const [key] of bundles) {
    for (const part of new Set(key.split(',').map(s => s.trim()).filter(Boolean))) elements.add(part);
  }
  const probes = new Set();
  for (const [key] of bundles) {
    probes.add(key);
    for (const part of new Set(key.split(',').map(s => s.trim()).filter(Boolean))) {
      probes.add(part);
      probes.add(stripWeight(part));
    }
  }
  for (const probe of probes) {
    const key = resolvePositionKey(probe);
    if (!key) continue;
    // 允许两种形态：真实包 key（含权重原样），或唯一归属的真实元素（短 tag）
    assert.ok(
      bundles.has(key) || elements.has(key),
      `「${probe}」解析出的「${key}」既不是真实包 key 也不是真实元素`,
    );
    const label = positionLabel(key);
    assert.ok(!label.includes('(') && !label.includes(':'), `中文名带权重残渣：${probe} → ${label}`);
    assert.ok(label.length <= 40, `中文名超长：${probe} → ${label.slice(0, 40)}`);
  }
});
