import { getDb } from '../db/index.js';
import { retrieveImagePromptKnowledge } from './imagePromptKnowledge.js';

const DEFAULT_CATEGORY_LIMIT = 2;
const CATEGORY_LIMITS = new Map([
  ['character_vocabulary', 2],
  ['clothing_vocabulary', 3],
  ['expression_pose_vocabulary', 3],
  ['environment_vocabulary', 4],
  ['scene_vocabulary', 3],
  ['object_vocabulary', 2],
  ['camera_vocabulary', 2],
  ['visual_style_vocabulary', 2],
  ['adult_pose_vocabulary', 2],
]);

const TAG_ALIASES = new Map([
  ['closed_eyes', ['eyes closed']],
  ['looking_at_viewer', ['looking at the viewer', 'direct eye contact', 'eye contact']],
  ['facing_away', ['back view', 'back facing']],
  ['from_behind', ['back view']],
  ['full_body', ['whole body']],
  ['close-up', ['closeup', 'headshot']],
  ['rain', ['rainy']],
]);

/**
 * 标签上限：正文之外最多再追加几个检索标签。
 *
 * 为什么要有：`selectExecutableTags` 原本只有**分类配额**（9 类 × 2~4 ≈ 上限 18 个），
 * 也就是说一条几十词的画面描述尾巴上最多能再堆 18 个 tag —— 权重上会和正文平起平坐甚至压过正文，
 * 真机日志（backend-2026-10-01.log:126）里那条末尾三个 tag 只是冰山一角。
 * 冲突组是**互斥**的，结构上不可能撞满，所以 6 个不会误伤正常链路：
 * 真机那条命中 solo+from back+low angle 共 3 个，留有余量。
 */
const MAX_APPENDED_TAGS = 6;

const CONFLICT_GROUPS = [
  ['close-up', 'close_up', 'full_body', 'wide_shot', 'cowboy_shot', 'upper_body'],
  ['from_front', 'from_behind'],
  ['from_above', 'from_below'],
  ['looking_at_viewer', 'facing_away', 'looking_away'],
  ['standing', 'sitting', 'lying', 'on_back'],
  ['open_mouth', 'closed_mouth'],
  ['spread_fingers', 'clenched_fist'],
  ['spread_legs', 'legs_together'],
];

/**
 * 数量锚点互斥组：`solo`（单人）与任何"不止一个人"的计数写法。
 * 与 CONFLICT_GROUPS 共用 `resolveSelectedConflicts` —— 即"检索同时命中 solo 与 2girls"时只留高分那个。
 */
const COUNT_CONFLICT_KEYS = ['solo', '1girl', '1boy', '2girls', '2boys', '3girls', '3boys', 'multiple_girls', 'multiple_boys'];

/** `ipk.count.solo` 的知识体明确要求"不要同时加入第二人的性别计数"；这些是程序侧已知的"不止一人"计数 tag。 */
const MULTI_PERSON_COUNT_TAGS = ['2girls', '2boys', '3girls', '3boys', 'multiple_girls', 'multiple_boys'];

/**
 * 多人画面判定词表（成因 A2 修复 2026-10-01）。
 *
 * 旧判据只查英文 `two|three|duo|couple|group|crowd|multiple|2girls|2boys|3girls|3boys` + `1girl 1boy`，
 * 于是"画面里明明两个女孩、后面却被强行追加 solo"。真机证据（backend-2026-10-01.log:126）那条串
 * 写的是 `the main focus is a girl with long wavy silver-grey hair … a small pink-haired girl in a
 * blue and white blouse kneels on the bed with a camera aimed at her … solo, from back, low angle`
 * —— 两个 `girl` 锚点，却因为没有任何英文数量词而判成单人。
 *
 * 判据分三层，任一层命中即视为多人：
 *   ① 数量词/数量 tag：中文（两个/两位/两名/两人/二人/俩/仨/三人/三个/三位/三名/四人…/多人/数人/
 *      众人/大家/一群/一伙/同框/合影/合照/群像/双人/情侣）与英文
 *      （two/three/four/several/multiple/duo/couple/crowd/group/group sex/threesome/`2girls`…/`1girl 1boy`/`two people`）；
 *   ② 角色锚点计数 ≥2：同一段文字里出现两个 `a girl` / `a boy` / `a woman` … 这类**带冠词的单人锚点**
 *      （真机那条正是这一层命中）；以及 `another girl` / `a second girl` / `the other girl` / `the second girl`
 *      这种"又一/第二个/另一个"写法；
 *   ③ `character(series)` 形态的 IP 名出现两次及以上（如 `March 7th (Honkai: Star Rail)` 与
 *      `Silver Wolf (Honkai: Star Rail)` 同框）—— 每个这样的名字就是一个角色锚点。
 *
 * 刻意**不**放的宽泛词（宁可漏判也不能误判成多人：误判会让"单人默认视线"等规则失效）：
 *   `people`（"no people" 会误命中）、裸 `multiple`（"multiple views / split screen / character sheet"
 *   是**构图**词不是人数 —— 真跑测试时这一条确实把单人设定图误判成多人了）、
 *   裸 `face`（分不出朝向，见下方冲突闸门注释）。
 */
const MULTI_PERSON_WORD_PATTERNS = [
  /\b(?:two|three|four|five|several|duo|couple|crowd|group|group sex|threesome|orgy)\b/,
  /\b[1-9]girls?\s+[1-9]boys?\b/,
  /\b[2-9](?:girls|boys)\b/,
  /\bmultiple (?:girls|boys|people|characters|women|men)\b/,
  /\btwo (?:people|girls|boys|women|men|persons|characters)\b/,
  /(?:两个|两位|两名|俩人|两人|二人|俩|仨|三个|三位|三名|三人|四人|四位|四名|多人|数人|众人|大家|一群|一伙|一对|双人|情侣|合影|合照|同框|群像)/,
];

/**
 * 带冠词的单人锚点：`a girl` / `an older woman` / `a small pink-haired girl` / `another girl` …
 * 两个即多人（真机那条正是靠这一层：`a girl …` + `a small pink-haired girl …`）。
 *
 * 三处细节都是真跑测试撞出来的：
 *   ① 冠词后允许最多 5 个单词：归一化会拆掉连字符（`a small pink-haired girl` → `a small pink haired girl`，
 *      4 个词），限量太小时真机那条的第二个人锚点会漏掉；
 *   ② `(?!of\b)` 挡住 `a pair of …` / `a lot of …` 这类量词短语
 *      （`a pair of black thigh-high stockings` 不是人）；
 *   ③ 也**排除** `her` / `his` / `its` 开头的短语："her bare thighs"、"her expression" 是**身体部位**
 *      不是第二个人（真跑测试时这一层把真机那条里的 `her bare thighs` 数成第三人，必须排除）。
 */
const PERSON_NOUN = 'girl|boy|woman|man|lady|guy|person|figure';
const SINGLE_PERSON_ANCHOR_RE = new RegExp(
  `\\b(?:a|an|another|the other|the second)\\s+(?!(?:her|his|its|their)\\b)(?!of\\b)(?:[a-z]+\\s+){0,5}(?:${PERSON_NOUN})\\b`,
  'g',
);

/**
 * `her sister` / `his brother` / `her friend` 这类**领属第二人**：单独出现一次即判多人。
 * 真机那条是 `a small pink-haired girl … with a camera aimed at her` —— 第二人靠 `a … girl` 命中；
 * 但 `a girl sits on the floor while her sister watches` 这种写法一个冠词锚点都没有，得靠这一条。
 */
const POSSESSIVE_SECOND_PERSON_RE = /\b(?:her|his|their)\s+(?:sister|brother|friend|mother|father|daughter|son|wife|husband|girlfriend|boyfriend|companion|classmate|roommate|partner)\b/;

/** "又一/第二个/另一个"这类明示第二人的写法，单独出现一次就足以判多人。 */
const SECOND_PERSON_RE = /\b(?:another (?:girl|boy|woman|man|person|figure)|(?:a|the) second (?:girl|boy|woman|man|person|figure)|the other (?:girl|boy|woman|man|person|figure))\b/;

/** `Name (Series)` 形态的 IP 角色锚点（与 groupImageLoraMatcher 的 NAME_SERIES_RE 同形）。 */
const CHARACTER_ANCHOR_RE = /[A-Za-z][A-Za-z0-9'.\-]*(?:\s+[A-Za-z0-9'.\-]+){0,3}\s*\([A-Za-z][A-Za-z0-9'.:\- ]*\)/g;

function countMatches(text, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return (String(text || '').match(regex) || []).length;
}

function padText(value) {
  return ` ${String(value || '').trim()} `;
}

/**
 * 画面是否不止一个人（用于禁止注入 `solo`）。
 * 三层判据见 MULTI_PERSON_WORD_PATTERNS 上方注释。
 */
export function detectMultiPersonScene(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const normalized = normalizeForMatch(raw);
  if (!normalized) return false;
  const padded = padText(normalized);

  if (MULTI_PERSON_WORD_PATTERNS.some(pattern => pattern.test(normalized))) return true;
  if (SECOND_PERSON_RE.test(normalized)) return true;
  if (POSSESSIVE_SECOND_PERSON_RE.test(normalized)) return true;
  if (countMatches(padded, SINGLE_PERSON_ANCHOR_RE) >= 2) return true;
  if ((raw.match(CHARACTER_ANCHOR_RE) || []).length >= 2) return true;
  return false;
}

/**
 * 追加标签的**冲突闸门**：把要追加的 tag 与"正文里已经写着的对立面"比对，冲突就不追加。
 *
 * 为什么需要（成因 A2）：`composeImagePrompt` 旧实现把检索标签无条件拼到正文尾部 ——
 * `solo` 与正文里的两个女孩、`from back` 与正文里的"看镜头/正面"同时存在，模型只能二选一，
 * 结果就是"图与文字描述完全不一样"。`resolveSelectedConflicts` 只管**标签之间**互斥，
 * 管不到"标签 vs 正文"，所以必须在这里补一道。
 *
 * 反向闸门刻意**不写成"正文出现 face 就丢 from back"**：裸 `face` 分不出朝向
 * （`framing her face` / `face focus` / `face down` 都可能出现在背影里），拿它当判据会误伤合法
 * `from back`。只有**明确的朝向声明**才算数：
 *   · `from back` / `from behind` / `back view` / `facing away` ↔ 正文写着看镜头/正面
 *     （looking at the viewer、eye contact、from the front、facing the camera/viewer）；
 *   · `looking at viewer` ↔ 正文写着背影（from behind、back view、facing away）；
 *   · `from front` ↔ 正文写着背影。
 * 真机那条（"她在床上仰躺、相机对着她"）英文原文里**没有**任何正面朝向声明，所以 `from back` 会保留 ——
 * 与任务口径一致：没有硬证据不动它。反过来（模型自己写进正文的标签）一律不动：闸门只拦"程序追加"。
 */
const FRONT_VIEW_DECLARED_RE = /\b(?:looking at (?:the )?viewer|looking at (?:the )?camera|eye contact|direct eye contact|from (?:the )?front|facing (?:the )?(?:viewer|camera)|face (?:the )?viewer)\b/;
const BACK_VIEW_DECLARED_RE = /\b(?:from behind|from back|back view|back facing|facing away|back to (?:the )?(?:camera|viewer))\b/;
const INTERPERSONAL_RE = /\b(?:sex|sexual|hetero|yuri|penis|fellatio|paizuri|cunnilingus|doggystyle|mating press|gangbang|threesome|spitroast|kiss|kissing)\b/;

export function tagConflictsWithText(tag, text) {
  const key = normalizeTagKey(tag);
  if (!key) return false;
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  const haystack = padText(normalized);
  const has = pattern => pattern.test(haystack);

  if (key === 'solo') {
    if (detectMultiPersonScene(text)) return true;
    if (has(INTERPERSONAL_RE)) return true;
    return false;
  }
  if (['from_back', 'from_behind', 'back_view', 'facing_away'].includes(key)) {
    return has(FRONT_VIEW_DECLARED_RE);
  }
  if (key === 'looking_at_viewer') {
    return has(BACK_VIEW_DECLARED_RE);
  }
  if (key === 'from_front') {
    return has(BACK_VIEW_DECLARED_RE);
  }
  return false;
}

/**
 * 构图 / 裁切类标签**一律不自动追加**（2026-10-04 真机）。
 *
 * 症状（日志实证）：`Final prompt: … stands in a dim gymnasium near an east window…,
 * low angle view, thighs focus, thighs close-up` —— 正文已经把一个**场景**写好了，
 * 尾部这串构图标签又把它压回**身体特写**。用户看到的就是"永远只有一个特写、
 * 脸都进不了画框、更别说表情"。
 *
 * 判据：构图属于**画面描述本身**（规则里的 framing 一档），由写描述的人决定；
 * RAG 只在尾部追加"画面里有什么"，无权改写"镜头怎么摆"。需要特定的机位时，
 * 由场景正文自己写，或走 ipk.camera.* 那几条知识规则显式注入。
 */
const FRAMING_TAG_RE = /^(?:close[ -]?up|close ?shot|headshot|face ?focus|crotch ?focus|thighs? ?(?:focus|close[ -]?up)|ass ?(?:up ?view|focus)|chest ?focus|feet ?focus|from ?below|low ?angle(?: ?(?:view|shot))?|high ?angle(?: ?(?:view|shot))?|extreme close[ -]?up|upper ?body|lower ?body)$/i;

/**
 * 计算最终要追加的标签：先过冲突闸门、再丢掉正文里**已经逐字写过**的 tag，最后按分数取前
 * MAX_APPENDED_TAGS 个。与"标签之间互斥"（resolveSelectedConflicts）互补：这一步管"标签 vs 正文"。
 *
 * 为什么要多丢一道"正文里已经写过"：`selectExecutableTags` 用**整串包含**判断 tag 是否已在画面里，
 * 而它排除候选时只看"独立逗号段"（`exactPromptSegments`）。于是 `a girl lies on a bed seen from back,
 * low angle shot` 这种**标签词写在正文句子里**（不是独立段）的写法，会让 `night` / `low angle` 这类词
 * 既参与打分、又被重复追加到尾部 —— 真机那条 `… at night, …` 后面又跟一个 `night` 就是这么来的。
 * 用词边界逐词判断，避免 `midnight` 被误当 `night` 而漏追加。
 */
export function selectAppendableTags(selected, cleanedOriginalText) {
  // `phraseInPrompt` 约定第一个参数是**已归一化**的文本（调用点都先 `normalizeForMatch`），别直接把原文传进去。
  const normalizedOriginal = normalizeForMatch(cleanedOriginalText);
  const kept = [];
  const dropped = [];
  for (const item of selected) {
    if (FRAMING_TAG_RE.test(String(item.tag || '').trim())) {
      dropped.push({ tag: item.tag, knowledgeId: item.knowledgeId, reason: 'framing/crop tags are not auto-appended' });
      continue;
    }
    if (tagConflictsWithText(item.tag, cleanedOriginalText)) {
      dropped.push({ tag: item.tag, knowledgeId: item.knowledgeId, reason: 'conflicts with the picture description' });
      continue;
    }
    if (phraseInPrompt(normalizedOriginal, item.tag)) {
      dropped.push({ tag: item.tag, knowledgeId: item.knowledgeId, reason: 'already present in the picture description' });
      continue;
    }
    kept.push(item);
  }
  kept.sort((a, b) => b.score - a.score || b.priority - a.priority);
  const capped = kept.slice(0, MAX_APPENDED_TAGS);
  for (const item of kept.slice(MAX_APPENDED_TAGS)) {
    dropped.push({ tag: item.tag, knowledgeId: item.knowledgeId, reason: `beyond the ${MAX_APPENDED_TAGS}-tag append limit` });
  }
  return { appendable: capped, dropped };
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTagKey(value) {
  return normalizeForMatch(value).replace(/\s+/g, '_');
}

function phraseInPrompt(promptText, phrase) {
  const normalized = normalizeForMatch(phrase);
  if (!normalized) return false;
  if (/[\p{Script=Han}]/u.test(normalized)) {
    return promptText.includes(normalized);
  }
  return ` ${promptText} `.includes(` ${normalized} `);
}

function chineseHanBigrams(text) {
  const words = String(text || '').match(/[\u3400-\u9fff]+/g) || [];
  const grams = new Set();
  for (const word of words) {
    if (word.length === 1) grams.add(word);
    for (let index = 0; index < word.length - 1; index += 1) {
      grams.add(word.slice(index, index + 2));
    }
  }
  return [...grams];
}

// 中文不像英文可以用空格分词；用保守的 Han bigram 重叠容忍“地雷女/地雷系”这类近义措辞。
// 短 query 往往只与 label 共享一个 2 字词（如「初音未来口交」×「蹲姿口交」只共享「口交」），
// 单 gram 命中给中间分而不是一票否决，否则带注解/修饰的 label 永远无法被选为可执行 tag。
function scoreChineseLabelOverlap(labelText, matchText) {
  if (!/[\p{Script=Han}]/u.test(labelText || '') || !/[\p{Script=Han}]/u.test(matchText || '')) return 0;
  const labelGrams = chineseHanBigrams(labelText);
  if (labelGrams.length === 0) return 0;
  const matchGrams = new Set(chineseHanBigrams(matchText));
  const matched = labelGrams.filter(gram => matchGrams.has(gram)).length;
  if (matched === 0) return 0;
  if (matched === labelGrams.length) return 16;
  if (matched / labelGrams.length >= 0.5) return 14;
  return 10;
}

function scoreExecutableTag(promptText, entry) {
  const tag = String(entry?.tag || '').trim();
  if (!tag) return 0;
  const normalizedTag = normalizeForMatch(tag);
  if (!normalizedTag) return 0;

  // 打分沿用原口径（`prompt + ragQuery` 合并串）：**不改检索/选词**是本修复的纪律 ——
  // 问题在"无条件追加"，所以在追加阶段加闸门，而不是去动哪条 tag 该被选中。
  let score = 0;
  if (phraseInPrompt(promptText, normalizedTag)) score = 20;
  const label = normalizeForMatch(entry?.label);
  if (label && phraseInPrompt(promptText, label)) score = Math.max(score, 20);

  const key = normalizeTagKey(tag);
  for (const alias of TAG_ALIASES.get(key) || []) {
    if (phraseInPrompt(promptText, alias)) score = Math.max(score, 16);
  }

  if (score === 0) {
    score = scoreChineseLabelOverlap(label, promptText);
  }

  if (score === 0) {
    const parts = normalizedTag.split(' ').filter(part => part.length > 1);
    const matched = parts.filter(part => phraseInPrompt(promptText, part)).length;
    if (parts.length >= 2 && matched === parts.length) score = 12;
  }
  return score;
}

function exactPromptSegments(prompt) {
  return new Set(String(prompt || '')
    .split(/[,;\n]+/)
    .map(normalizeTagKey)
    .filter(Boolean));
}

function selectExecutableTags(prompt, items, ragQuery = '') {
  const promptText = normalizeForMatch(prompt);
  const ragQueryText = normalizeForMatch(ragQuery);
  const matchText = [promptText, ragQueryText].filter(Boolean).join('\n');
  const existingSegments = exactPromptSegments(prompt);
  const candidates = [];

  for (const item of items) {
    for (const entry of item.executableTags || []) {
      const tag = String(entry?.tag || '').trim();
      const tagParts = tag.split(',').map(part => part.trim()).filter(Boolean);
      const score = scoreExecutableTag(matchText, entry);
      if (score === 0) continue;
      candidates.push({
        tag,
        key: normalizeTagKey(tag),
        category: item.category,
        knowledgeId: item.id,
        score,
        priority: Number(item.priority || 0),
        reason: entry?.label ? `matched:${entry.label}` : 'matched:tag',
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.priority - a.priority || a.tag.length - b.tag.length);
  const selected = [];
  const seen = new Set();
  const categoryCounts = new Map();
  for (const candidate of candidates) {
    if (!candidate.key || seen.has(candidate.key) || existingSegments.has(candidate.key)) continue;
    const count = categoryCounts.get(candidate.category) || 0;
    const limit = CATEGORY_LIMITS.get(candidate.category) || DEFAULT_CATEGORY_LIMIT;
    if (count >= limit) continue;
    selected.push(candidate);
    seen.add(candidate.key);
    categoryCounts.set(candidate.category, count + 1);
  }
  return selected;
}

function addRuleTag(selected, tag, knowledgeId, category, reason, promptText) {
  if (phraseInPrompt(promptText, tag)) return;
  const key = normalizeTagKey(tag);
  const existing = selected.find(item => item.key === key);
  if (existing) {
    existing.score = Math.max(existing.score, 100);
    existing.reason = reason;
    existing.knowledgeId = knowledgeId;
    return;
  }
  selected.push({ tag, key, category, knowledgeId, score: 100, priority: 100, reason });
}

function removeSelectedTags(selected, keys, knowledgeId, reason, removedTags) {
  const removeKeys = new Set(keys.map(normalizeTagKey));
  for (let index = selected.length - 1; index >= 0; index--) {
    if (!removeKeys.has(selected[index].key)) continue;
    removedTags.push({ tag: selected[index].tag, knowledgeId, reason });
    selected.splice(index, 1);
  }
}

function applyKnowledgeRules(prompt, items, selected, ragQuery = '') {
  const promptText = normalizeForMatch(prompt);
  const ragQueryText = normalizeForMatch(ragQuery);
  const matchText = [promptText, ragQueryText].filter(Boolean).join('\n');
  const knowledgeIds = new Set(items.map(item => item.id));
  const removedTags = [];
  const removedPhrases = [];
  const appliedRules = [];
  // 规则按顺序生效：后面的规则要看到前面规则删掉的短语，否则会基于"已经不存在的文本"做判断。
  const livePromptText = () => normalizeForMatch(cleanOriginalPrompt(prompt, removedPhrases));

  if (knowledgeIds.has('ipk.count.solo')) {
    // 多人判据：① 英文/中文数量词 ② 画面里 ≥2 个角色锚点（`a girl` ×2、`another girl`、IP 名 ×2 等）。
    // 检索 query 也参与判定（中文描述里写「两个女孩」时，英文 prompt 可能一个人数词都没有）。
    const multiPerson = detectMultiPersonScene(livePromptText()) || detectMultiPersonScene(ragQueryText);
    if (!multiPerson) {
      addRuleTag(selected, 'solo', 'ipk.count.solo', 'count_identity', 'single-subject default', livePromptText());
      removeSelectedTags(selected, MULTI_PERSON_COUNT_TAGS, 'ipk.count.solo', 'conflicts with solo', removedTags);
      appliedRules.push('ipk.count.solo');
    } else {
      // 多人画面：不注入单人锚点，也不删正文里已有的计数 tag（旧的 removeSelectedTags 那段是对称错误的一半）。
      appliedRules.push('ipk.count.solo:skipped-multi-person');
    }
  }

  if (knowledgeIds.has('ipk.gaze.sleep') && /\b(sleep|sleeping|asleep|unconscious|nap|napping)\b/.test(matchText)) {
    addRuleTag(selected, 'closed_eyes', 'ipk.gaze.sleep', 'gaze', 'sleep requires closed eyes', livePromptText());
    removeSelectedTags(selected, ['looking_at_viewer', 'direct_eye_contact', 'open_eyes'], 'ipk.gaze.sleep', 'conflicts with sleeping', removedTags);
    removedPhrases.push(/\blooking at (?:the )?viewer\b/gi, /\bdirect eye contact\b/gi, /\beye contact\b/gi);
    appliedRules.push('ipk.gaze.sleep');
  }

  if (knowledgeIds.has('ipk.camera.closeup') && /\b(close up|closeup|headshot|face focus)\b/.test(matchText)) {
    addRuleTag(selected, 'close-up', 'ipk.camera.closeup', 'camera', 'explicit close-up framing', livePromptText());
    removeSelectedTags(selected, ['full_body', 'wide_shot'], 'ipk.camera.closeup', 'conflicts with close-up', removedTags);
    removedPhrases.push(/\bfull body\b/gi, /\bwide shot\b/gi);
    appliedRules.push('ipk.camera.closeup');
  } else if (knowledgeIds.has('ipk.camera.fullbody') && /\b(full body|whole body)\b/.test(matchText)) {
    addRuleTag(selected, 'full_body', 'ipk.camera.fullbody', 'camera', 'explicit full-body framing', livePromptText());
    removeSelectedTags(selected, ['close-up', 'close_up', 'headshot'], 'ipk.camera.fullbody', 'conflicts with full body', removedTags);
    removedPhrases.push(/\bclose[ -]?up\b/gi, /\bheadshot\b/gi);
    appliedRules.push('ipk.camera.fullbody');
  }

  if (knowledgeIds.has('ipk.gaze.away') && /\b(from behind|back view|facing away)\b/.test(matchText) && !/\bover shoulder\b/.test(matchText)) {
    removeSelectedTags(selected, ['looking_at_viewer'], 'ipk.gaze.away', 'conflicts with facing away', removedTags);
    removedPhrases.push(/\blooking at (?:the )?viewer\b/gi, /\bdirect eye contact\b/gi);
    appliedRules.push('ipk.gaze.away');
  }

  if (knowledgeIds.has('ipk.environment.night') && /\b(night|nighttime|evening)\b/.test(matchText)) {
    addRuleTag(selected, 'night', 'ipk.environment.night', 'environment', 'explicit night scene', livePromptText());
    removeSelectedTags(selected, ['bright_sunlight', 'daytime'], 'ipk.environment.night', 'conflicts with night', removedTags);
    appliedRules.push('ipk.environment.night');
  }

  if (knowledgeIds.has('ipk.environment.day') && /\b(day|daytime|morning|afternoon)\b/.test(matchText)) {
    removeSelectedTags(selected, ['night', 'moonlight'], 'ipk.environment.day', 'conflicts with daytime', removedTags);
    appliedRules.push('ipk.environment.day');
  }

  return { removedTags, removedPhrases, appliedRules };
}

function resolveSelectedConflicts(selected, removedTags) {
  // 数量锚点单独成组：`solo` 与 `2girls` / `1girl 1boy` 这类不能同时留在尾部。
  for (const group of [...CONFLICT_GROUPS, COUNT_CONFLICT_KEYS]) {
    const keys = new Set(group.map(normalizeTagKey));
    const matches = selected.filter(item => keys.has(item.key)).sort((a, b) => b.score - a.score || b.priority - a.priority);
    if (matches.length <= 1) continue;
    const keep = matches[0];
    for (const item of matches.slice(1)) {
      const index = selected.indexOf(item);
      if (index >= 0) selected.splice(index, 1);
      removedTags.push({ tag: item.tag, knowledgeId: item.knowledgeId, reason: `conflicts with ${keep.tag}` });
    }
  }
}

function cleanOriginalPrompt(prompt, removedPhrases) {
  let cleaned = String(prompt || '').trim();
  for (const pattern of removedPhrases) cleaned = cleaned.replace(pattern, '');
  return cleaned
    .replace(/\s+,/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
}

export function composeImagePrompt(prompt, items = [], { ragQuery = '' } = {}) {
  const selected = selectExecutableTags(prompt, items, ragQuery);
  const ruleResult = applyKnowledgeRules(prompt, items, selected, ragQuery);
  resolveSelectedConflicts(selected, ruleResult.removedTags);
  selected.sort((a, b) => b.score - a.score || b.priority - a.priority);

  const cleanedOriginal = cleanOriginalPrompt(prompt, ruleResult.removedPhrases);
  // 成因 A2：追加前先过"标签 vs 正文"冲突闸门 + 上限，而不是无条件 `[...selectedTags]` 拼尾。
  const { appendable, dropped } = selectAppendableTags(selected, cleanedOriginal);
  const selectedTags = appendable.map(item => item.tag);
  const promptRefined = [cleanedOriginal, ...selectedTags].filter(Boolean).join(', ');
  return {
    promptRefined: promptRefined || String(prompt || '').trim(),
    selectedTags: appendable.map(({ tag, category, knowledgeId, score, reason }) => ({ tag, category, knowledgeId, score, reason })),
    removedTags: [...ruleResult.removedTags, ...dropped],
    appliedRules: ruleResult.appliedRules,
  };
}

function emptySelection() {
  return { selectedTags: [], removedTags: [], appliedRules: [] };
}

function emptyRetrieval() {
  return { mode: 'none', items: [], knowledgeIds: [], knowledgeVersion: '' };
}

/**
 * 业务侧传入的中文描述优先作为 RAG query；没有中文时回退英文 prompt。
 */
export function resolveImageRagQuery(prompt, ragQuery) {
  const original = String(prompt || '').trim();
  const provided = String(ragQuery || '').trim();
  return /[\p{Script=Han}]/u.test(provided) ? provided : original;
}

export async function prepareImagePrompt(prompt, {
  scene = 'chat',
  ragQuery = '',
  disableRAG = false,
  alreadyPrepared = false,
  skipOptimization = false,
  // 不再落库：检索快照只是诊断留档，全项目无读者（曾占库 68%），需要时从返回值里看即可
  db = null,
  ragTimeoutMs = undefined,
} = {}) {
  const sceneAliases = { event: 'events', peek: 'schedule', gifts: 'gift', avatargen: 'avatar', town: 'town' };
  scene = sceneAliases[scene] || scene;
  const original = String(prompt || '').trim();
  if (!original) {
    return { promptOriginal: original, promptRefined: original, ragQuery: original, status: 'empty', scene, retrieval: emptyRetrieval(), selection: emptySelection() };
  }
  if (disableRAG) {
    return { promptOriginal: original, promptRefined: original, ragQuery: original, status: 'rag_disabled', scene, retrieval: { mode: 'rag_disabled', items: [], knowledgeIds: [], knowledgeVersion: '' }, selection: emptySelection() };
  }
  if (alreadyPrepared || skipOptimization) {
    return { promptOriginal: original, promptRefined: original, ragQuery: original, status: 'skipped', scene, retrieval: emptyRetrieval(), selection: emptySelection() };
  }

  const retrievalQuery = resolveImageRagQuery(original, ragQuery);
  const database = db || getDb();
  const retrieval = await retrieveImagePromptKnowledge(retrievalQuery, { scene, db: database, timeoutMs: ragTimeoutMs });
  const selection = composeImagePrompt(original, retrieval.items, { ragQuery: retrievalQuery });
  const foundTags = selection.selectedTags.map(item => item.tag);
  console.log(`[imagePromptKnowledge] query=${JSON.stringify(retrievalQuery.slice(0, 160))} mode=${retrieval.mode} duration=${retrieval.durationMs}ms tags=${JSON.stringify(foundTags)}`);
  const status = selection.promptRefined === original ? 'fallback' : 'deterministic';
  const result = { promptOriginal: original, ragQuery: retrievalQuery, promptRefined: selection.promptRefined, status, scene, retrieval, selection };
  // 结果只在内存中返回（promptRefined / retrieval 等），不写数据库
  return result;
}
