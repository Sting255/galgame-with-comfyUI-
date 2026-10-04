import { getDb } from '../db/index.js';

function normalizeEnglishName(value) {
  const tokens = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return tokens ? tokens.join(' ') : '';
}

/** 中文（display_name 常见形态）不能在英文 prompt 里找，先识别出来直接跳过。 */
function hasHan(value) {
  return /[\p{Script=Han}]/u.test(String(value || ''));
}

/**
 * `Name (Series)` 形态的英文角色锚点 —— 库里**没有**英文名字段，但角色卡的 `base_prompt` 外观段
 * 普遍写成这个形态（真实库 8 行里 6 行的 base_prompt 有，例如
 * `Silver Wolf LV.999 (Honkai: Star Rail) has long wavy silver-grey hair …`、
 * `1girl, solo, Hyacine (Honkai: Star Rail), full body, …`），而 LLM 写画面描述时也用同一形态
 * （`Silver Wolf (Honkai: Star Rail)` / `March 7th (Honkai: Star Rail)`）。
 * 这是**数据驱动**的别名来源，不需要在代码里硬编码任何具体 IP 角色名。
 *
 * 首字母必须大写：这条约束不是洁癖 —— 第一版用"≤5 个小写词 + 括号"匹配时，
 * 真机那条外观段被切出 `… pair of black thigh-high stockings … (…)` ⇒ 生成别名 `silver`，
 * 于是 `bare thighs` 里的 `thighs` **误命中**银狼。要求大写词后，`thigh-high` 不再可能是名字。
 */
const NAME_TOKEN = "[A-Z][a-z]*(?:[0-9]+)?(?:'[A-Z]?[a-z]+)?";
const NAME_SERIES_RE = new RegExp(
  `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,4})\\s*\\(([A-Za-z][A-Za-z0-9'.:\\- ]*)\\)`,
  'g',
);

/** 角色卡里"你是<中文名>(<英文名>)"的自我介绍形态：`你是流萤(Firefly)` / `你是纳西妲(Nahida)`。 */
const GREETING_BRACKET_RE = /你是[^()\n]{0,20}[（(]([^（()）\n]{1,40})[）)]/g;

/**
 * 从一段文字里抽出英文别名。
 * 两类来源：① `Name (Series)` 形态；② `你是甲(English)` 自我介绍形态。去重由调用方做。
 */
function extractEnglishAliases(text) {
  const raw = String(text || '');
  if (!raw || !/[A-Za-z]/.test(raw)) return [];
  const found = [];
  for (const match of raw.matchAll(NAME_SERIES_RE)) {
    if (match[1]) found.push(match[1]);
  }
  for (const match of raw.matchAll(GREETING_BRACKET_RE)) {
    if (match[1]) found.push(match[1]);
  }
  return found.filter(candidate => /[A-Za-z]/.test(candidate));
}

/**
 * 一个角色可以被哪些字符串匹配到（成因 A3 修复 2026-10-01）。
 *
 * 旧实现只拿 `characters.name`（**内部 handle**：`silverwolflv999` / `theresaapocalypse` /
 * `hyacinthia` / `march7th`）归一化后要求它作为整词子串出现在英文 prompt 里，
 * 而 LLM 在画面描述里写的是 `Silver Wolf` / `Theresa Apocalypse` / `Hyacine` ⇒ **永远匹配不到**，
 * 匹配恒为空后又触发 `applyGroupImageNameFallback` 把发图人名字前置（见下），
 * 结果"谁说话就画成谁"。
 *
 * 别名来源，全部**数据驱动**、不硬编码任何 IP 角色名：
 *   ① `name`（handle）归一化后的形态：下划线/连字符会被抹成空格，所以 `raiden_mei` 收成
 *      `raiden mei`、`silverwolflv999` 收成 `silverwolflv999`（两侧都被同样归一化，整词命中，
 *      旧行为原样保留）；
 *   ② `display_name` 的**英文部分**：中文名不可能出现在英文 prompt 里，所以只取不含汉字的显示名
 *      （如 `Mei`）；含汉字的显示名（`银狼LV.999`）不参与匹配；
 *   ③ `base_prompt` / `short_prompt` 里的英文锚点：`Name (Series)` 与 `你是甲(English)` 两种形态。
 *      取整名（剥掉尾部版本/数字噪声：`Silver Wolf LV.999` → `silver wolf`），
 *      另收**去空格后 ≥10 字母的前缀**（`silver wolf lv 999` → `silver wolf`）。
 *      为什么要前缀：LLM 现实里常只写 `Silver Wolf`（不带括号系列名），不收就匹配不到。
 *      为什么限死"≥10 字母"：第一版做过逐词前缀展开，单字别名 `silver` 命中真机外观段里的
 *      `silver-grey hair`、`march` 命中 `the main focus` ⇒ 一条"没写任何角色名"的银狼画面同时匹配上
 *      银狼**和三月七**，比不匹配更糟；门槛抬高后 `silver`（6）与 `march`（5）都被排除。
 *      同一条门槛也让 `March 7th`（8 字母）进不了别名表 —— 三月七靠 handle `march7th` 命中；
 *      LLM 若只写 `March 7th` 且不带括号系列名，这一路匹配不到（宁可漏，不可错配）。
 *   ④ LoRA `triggerWord`：用户给 LoRA 填的触发词（常是 `silverwolf` 这种连写英文名）。
 * 短别名（去空格后 < 5 个字符）一律丢弃：`mei` / `rin` 这类两三个字母的词在普通英文描述里乱命中的代价
 * （把无关角色 LoRA 塞进链首）远大于漏匹配。
 */
const MIN_ALIAS_COMPACT_LENGTH = 5;
const MIN_PREFIX_COMPACT_LENGTH = 10;

/** 版本/后缀噪声词：`Silver Wolf LV.999` 里剥掉尾部的 `lv` / `999` 才是可匹配的名字。 */
const VERSION_SUFFIX_WORDS = new Set(['lv', 'lvl', 'ver', 'version']);

function isVersionSuffixToken(token) {
  return /^\d+$/.test(token) || VERSION_SUFFIX_WORDS.has(token);
}

export function buildCharacterAliases(character) {
  const aliases = new Set();
  const add = value => {
    const normalized = normalizeEnglishName(value);
    if (!normalized) return;
    const compact = normalized.replaceAll(' ', '');
    if (compact.length < MIN_ALIAS_COMPACT_LENGTH) return;
    aliases.add(normalized);
  };

  add(character?.name);
  if (!hasHan(character?.display_name)) add(character?.display_name);

  for (const source of [character?.base_prompt, character?.short_prompt]) {
    for (const candidate of extractEnglishAliases(source)) {
      const parts = normalizeEnglishName(candidate).split(' ').filter(Boolean);
      while (parts.length > 1 && isVersionSuffixToken(parts[parts.length - 1])) parts.pop();
      if (parts.length === 0) continue;
      const full = parts.join(' ');
      if (full.replaceAll(' ', '').length >= MIN_ALIAS_COMPACT_LENGTH) aliases.add(full);
      // 分隔符在归一化时会丢（`March 7th` → `march 7th`），重拼时补回空格以便命中。
      for (let take = parts.length - 1; take >= 1; take -= 1) {
        const alias = parts.slice(0, take).join(' ');
        if (alias.replaceAll(' ', '').length < MIN_PREFIX_COMPACT_LENGTH) break;
        aliases.add(alias);
      }
    }
  }

  for (const lora of parseCharacterLoras(character)) add(lora.triggerWord);

  return [...aliases];
}

export function parseCharacterLoras(character) {
  if (!character?.loras) return [];
  try {
    const parsed = typeof character.loras === 'string'
      ? JSON.parse(character.loras)
      : character.loras;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(lora => lora?.path && typeof lora.path === 'string')
      .map(lora => ({
        path: lora.path,
        weight: typeof lora.weight === 'number' ? lora.weight : 0.6,
        triggerWord: lora.triggerWord || '',
      }));
  } catch {
    return [];
  }
}

export function appendGroupImageSpeakerName(prompt, speaker) {
  const text = String(prompt || '').trim();
  const name = String(speaker?.name || '').trim();
  if (!name) return text;
  return text ? `${text}, ${name}` : name;
}

/**
 * 匹配为空时的兜底（成因 A3 修复 2026-10-01）。
 *
 * **旧行为（已废弃）**：描述里出现"人"却一个角色都没匹配到时，把 **`speaker.name`** 前置到整条 prompt
 * 最前面 ⇒ 真机日志 backend-2026-10-01.log:123-126 里，
 * `[group] image prompt added speaker name fallback: march7th` 紧接着
 * `march7th, a dimly lit dorm room at night, … a small pink-haired girl … `，
 * 即"发图人三月七"被硬塞进一条**正在描述银狼**的画面，同时 `generateGroupImage` 又把发图人 LoRA
 * 排到链首 ⇒ 画出来的是发图人而不是被描述的人。
 *
 * **新行为**：不加任何人物名锚点，原样返回。取舍理由：
 *   · 画面描述里没写名字时，"这人是谁"本就没有可靠信号，塞一个名字等于**替模型断言**；
 *   · 角色身份在群聊里已有更强、更明确的来源：描述里真的写了名字就走别名匹配（含
 *     `Name (Series)` 形态）；发图人本人则由 `generateGroupImage` 强制注入的 speaker LoRA 承担；
 *   · 描述里**真的出现**发图人时，别名匹配会命中他/她，`matchedCharacters` 非空 ⇒ 根本不会走到这里
 *     （见 `resolveGroupImageLoras` 与 `groupImagePipeline.js` 的 speaker LoRA 强制注入，两者都没动）。
 *
 * 保留 `describesPeople` 与 `fallbackApplied` 字段不是为了继续前置名字，而是给调用方留一个
 * **可观测信号**：`fallbackApplied === true` 现在表示"画面里有人、但一个角色都没认出来"，
 * `groupImagePipeline.js` 仍会打 `[group] image prompt added speaker name fallback: …` 日志
 * （日志文案未改，Lead 正在改该文件，这里不碰；语义已变为"未识别出角色"）。
 */
export function applyGroupImageNameFallback(prompt, matchedCharacters, speaker) {
  const text = String(prompt || '').trim();
  if ((matchedCharacters || []).length > 0 || !speaker?.name || !describesPeople(text)) {
    return { prompt: text, fallbackApplied: false };
  }
  return { prompt: text, fallbackApplied: true };
}

function describesPeople(prompt) {
  return /\b(girl|woman|lady|female|boy|man|male|person|people|couple|group|portrait|selfie|character|cosplay|waitress|student)\b/i.test(String(prompt || ''));
}

export function matchCharactersInImagePrompt(prompt, characters) {
  const normalizedPrompt = normalizeEnglishName(prompt);
  if (!normalizedPrompt) return [];

  const paddedPrompt = ` ${normalizedPrompt} `;
  const candidates = [];
  characters.forEach((character, characterIndex) => {
    for (const alias of buildCharacterAliases(character)) {
      let fromIndex = 0;
      while (fromIndex < paddedPrompt.length) {
        const start = paddedPrompt.indexOf(` ${alias} `, fromIndex);
        if (start < 0) break;
        candidates.push({
          character,
          characterIndex,
          start,
          end: start + alias.length + 2,
          specificity: alias.length,
          alias,
        });
        fromIndex = start + 1;
      }
    }
  });

  // Prefer the longest name when aliases overlap, e.g. raiden_mei over mei.
  candidates.sort((a, b) => b.specificity - a.specificity || a.start - b.start);
  const selectedRanges = [];
  const selectedCharacterIndexes = new Set();
  for (const candidate of candidates) {
    if (selectedCharacterIndexes.has(candidate.characterIndex)) continue;
    const overlaps = selectedRanges.some(range => candidate.start < range.end && candidate.end > range.start);
    if (overlaps) continue;
    selectedRanges.push({ start: candidate.start, end: candidate.end });
    selectedCharacterIndexes.add(candidate.characterIndex);
  }

  return characters.filter((_, index) => selectedCharacterIndexes.has(index));
}

export function collectCharacterLoras(characters) {
  const seenPaths = new Set();
  const loras = [];

  for (const character of characters) {
    for (const lora of parseCharacterLoras(character)) {
      if (seenPaths.has(lora.path)) continue;
      seenPaths.add(lora.path);
      loras.push(lora);
    }
  }

  return loras;
}

export function resolveGroupImageLoras(prompt, speaker = null) {
  const characters = getDb().prepare(`
    SELECT id, name, display_name, loras, artist_override, base_prompt, short_prompt
    FROM characters
    WHERE name IS NOT NULL AND trim(name) != ''
    ORDER BY id ASC
  `).all();
  const matchedCharacters = matchCharactersInImagePrompt(prompt, characters);
  const prepared = applyGroupImageNameFallback(prompt, matchedCharacters, speaker);

  return {
    prompt: prepared.prompt,
    fallbackApplied: prepared.fallbackApplied,
    matchedCharacters,
    loras: collectCharacterLoras(matchedCharacters),
  };
}
