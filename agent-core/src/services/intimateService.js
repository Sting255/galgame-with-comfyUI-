/**
 * 亲密档案与统计（角色数据看板）数据层
 *
 * 六张表，职责互不混用：
 *   - character_body_profile   静态档案（身高/三围/罩杯/备注/敏感带 + 是否注入），1:1，人工维护
 *   - character_intimate_log   行为流水（事实源），**唯一计数来源**，靠 (character_id, source_uid) 幂等
 *   - character_intimate_firsts 一次性里程碑（初次时间），可由流水派生，也可人工覆盖
 *   - character_intimate_stats 聚合缓存（可选，面板一次读取）
 *   - character_intimate_backfill   历史回填进度（每个角色一行，支持断点续跑）
 *   - character_intimate_suggestions AI 整理档案的待确认提议（未授权字段只落提议，不直接写库）
 *
 * 为什么统计只从流水聚合、不存计数器：
 *   撤回上一轮（chat.js /characters/:id/messages/last-round）、清空会话、角色删除都必须让看板数字
 *   自然回落。流水带 raw_id，跟着 rollbackMemoriesFromRawId 的同一处调用回滚即可；
 *   存计数器就一定会出现"数字降不回去"的脏数据。
 *
 * 词表口径：
 *   - 体位 key 直接取 image_prompt_knowledge 的 adult_pose_vocabulary 里的可执行 tag
 *     （英文 tag 作 key、中文 label 展示），与生图 prompt 同源，判定不需要模糊匹配
 *   - 该词表里有流体/事后类噪声包与带 A1111 权重的条目，分别由 NON_POSE_* 黑名单
 *     与剥权重别名处理（见 buildPositionIndex）
 *   - 行为分类（基础统计 / 破处信息）用下方 ACT_DEFINITIONS 词表，按顺序首个命中即归类；
 *     没命中的落 custom_label，不丢数据
 *
 * 边界：本模块只服务成年角色档案；不提供未成年体型相关的字段语义、默认值或提示词。
 */

import crypto from 'node:crypto';
import { getDb } from '../db/index.js';

/** 行为分类词表：按顺序匹配，首个命中即归类。tags 为可执行 tag 的小写子串。 */
export const ACT_DEFINITIONS = [
  { key: 'vaginal', label: '阴道', tags: ['vaginal', 'creampie', 'cum in pussy', 'mating press', 'missionary', 'cowgirl', 'doggystyle', 'sex from behind'] },
  { key: 'anal', label: '后庭', tags: ['anal', 'anus', 'ass gaping', 'anilingus'] },
  { key: 'oral', label: '口交', tags: ['fellatio', 'blowjob', 'deepthroat', 'irrumatio', 'cunnilingus'] },
  { key: 'hand', label: '手交', tags: ['handjob', 'fingering'] },
  { key: 'foot', label: '足交', tags: ['footjob'] },
  { key: 'breast', label: '乳交', tags: ['paizuri', 'titjob', 'breast sex'] },
  { key: 'thigh', label: '素股', tags: ['thigh sex', 'sumata', 'intercrural'] },
  { key: 'self', label: '自慰', tags: ['masturbat', 'vibrator', 'dildo'] },
  { key: 'climax', label: '高潮', tags: ['orgasm', 'climax', 'ahegao'] },
  { key: 'first_kiss', label: '初吻', tags: [] }, // 仅人工/LLM 记录，不做自动 tag 归类（kiss 太常见）
  // 正文兜底专用（见 intimateAutoRecord.recordUnspecifiedFromText）：那一轮确实命中了成人内容判定，
  // 但没有任何生图 prompt 可归类 —— 记成「未归类」，承认发生了但不猜具体行为。
  { key: 'unspecified', label: '未归类', tags: [] },
];

export const ACT_KEYS = new Set(ACT_DEFINITIONS.map(a => a.key));
export const SCENES = ['chat', 'group', 'event', 'dream', 'moment', 'mailbox', 'manual', 'hypnosis'];
export const PARTNER_KINDS = ['user', 'character', 'npc', 'self', 'unknown'];

/**
 * AI 逐字段修改权限键（与前端共用同一套字符串，改键名即破坏契约）。
 *   body           身高 / 三围 / 罩杯
 *   sensitiveZones 敏感带
 *   note           备注
 *   firsts         初次里程碑
 *   stats          允许自动记账写入流水
 */
export const AI_EDIT_KEYS = ['body', 'sensitiveZones', 'note', 'firsts', 'stats'];

/** 默认只放开统计：档案是用户的设定，不授权就一律不许模型改 */
export const AI_EDIT_DEFAULTS = ['stats'];

/**
 * 默认统计口径：用户↔角色 + 角色↔角色。
 *
 * 为什么把群聊（partner_kind='character'）也算进默认：群聊流水一直是这个口径写的，但默认视图
 * 只统计用户↔角色，导致"群聊里发生的事"记了却默认看不见（用户报的"群聊消息没引进看板"就有一层是这个）。
 * NPC 维度仍要用户在面板里显式勾选（镇民奇遇才写 npc，默认关着不打扰）。
 * 存量库的持久化口径由 db/index.js 的一次性迁移同步（旧默认 ['user'] → 新默认）。
 */
export const DEFAULT_VIEW_SCOPE = ['user', 'character'];

const MAX_ACT_COUNT = 99;
const MAX_FIELD_LEN = 60;
const MAX_NOTE_LEN = 300;
const MAX_ZONES = 30;
/** 单 token 元素只从"元素数 ≤2 的紧凑打包项"里认（详见 buildPositionIndex 的特异性守卫） */
const MAX_TIGHT_BUNDLE_TAGS = 2;

/**
 * 非体位包的英文 tag 关键词黑名单（只作用于**单 token 包**，见 isNonPoseBundle）。
 *
 * 为什么需要：adult_pose_vocabulary 里混着"流体 / 事后 / 生理反应"类的单 token 包
 * （cum→射精、aftersex→事后、peeing→排尿…）。它们会被 resolvePositionKey 精确命中，
 * 于是 `masterpiece, 1girl, nude, vaginal, cum, bedroom` 这种真实 prompt 会把「射精」
 * 顶进面板的「体位排行」——那不是体位，看板可信度会直接受损。
 * 取向与 MAX_TIGHT_BUNDLE_TAGS 守卫一致：宁可少归因，也不能误归因。
 *
 * 匹配方式：英文按**词边界**（\bcum\b）匹配 key，所以 'cum' 能命中 `cum on breast`、
 * 但不会误伤 `peeking out upper body`（含 'pee' 但不是 'pee' 这个词）。
 * 每条的依据：
 */
const NON_POSE_TAG_KEYWORDS = [
  { kw: 'cum', why: '精液/射精结果；`cum on breast`、`cum inside` 这类"精液沾在哪"同样是产物，不是体位' },
  { kw: 'creampie', why: '内射结果（词表里以 `ahegao with creampie` 出现）' },
  { kw: 'creamypie', why: '词表里 `creampie` 的错拼单 token 包，中文名同样是「内射」' },
  { kw: 'cumshot', why: '射精复合词（`hair cumshot`），`\\bcum\\b` 的词边界匹配不到，必须单列' },
  { kw: 'cumdrip', why: '精液滴落（`cumdrip`），体液' },
  { kw: 'facial', why: '颜射，属射精落点' },
  { kw: 'ejaculating', why: '射精进行中，生理反应' },
  { kw: 'ejaculation', why: '射精（`female ejaculation` 潮吹同属此类）' },
  { kw: 'gokkun', why: '吞精，属口交行为而非体位' },
  { kw: 'squirting', why: '潮吹/喷射，生理现象' },
  { kw: 'pussy juice', why: '爱液，体液' },
  { kw: 'pussy juices', why: '爱液的复数写法（`dripping pussy juices`），词边界匹配不到单数形式' },
  { kw: 'female orgasm', why: '女性高潮，生理反应；刻意**不写裸 `orgasm`**——实测它会误伤含该词的长自然语言体位包'
    + '（`photo of enjoying orgasm shocked woman…getting missionary anal fucked…` 的中文名是「传教士位肛交」，是真体位）' },
  { kw: 'aftersex', why: '事后状态（疲惫/满足），明确不是体位' },
  { kw: 'ahegao', why: '高潮失神表情，生理反应' },
  { kw: 'mind break', why: '精神崩溃（高潮过度），生理/心理反应' },
  { kw: 'heart-shaped pupils', why: '爱心瞳（迷恋/高潮），生理反应' },
  { kw: 'lactating', why: '泌乳/喷奶，生理现象' },
  { kw: 'lactation', why: '泌乳，生理现象' },
  { kw: 'breast feeding', why: '哺乳，生理现象而非体位' },
  { kw: 'peeing', why: '排尿（失禁类），生理现象' },
  { kw: 'pee', why: '排尿（覆盖 `pee on her` / `yellow pee` / `have to pee`；词边界保证不误伤 `peeking`）' },
  { kw: 'spasming', why: '痉挛，生理反应（当前词表无此单 token 包，按同一口径预置，防知识库同步后回退）' },
  { kw: 'convulsing', why: '抽搐，同上' },
];

/** 中文名关键词黑名单（作用于 label，补充英文没覆盖的条目，如 `female ejaculation`→潮吹） */
const NON_POSE_LABEL_KEYWORDS = [
  { kw: '射精', why: 'cum / ejaculating / ejaculation 的中文名' },
  { kw: '射出', why: 'ejaculation 的另一种中文名' },
  { kw: '内射', why: 'creampie / creamypie / cum inside 的中文名' },
  { kw: '颜射', why: 'facial 的中文名' },
  { kw: '吃精', why: 'gokkun 的中文名' },
  { kw: '潮吹', why: 'female ejaculation / squirting 的中文名' },
  { kw: '喷射', why: '潮吹喷射（`(motion blur…squirting…)`）的中文名' },
  { kw: '沾精', why: '精液落点（肚子沾精 / 额上沾精 / 臀上沾精 / 衣物沾精）' },
  { kw: '喷奶', why: 'lactating 的中文名' },
  { kw: '哺乳', why: 'lactation 的中文名' },
  { kw: '喂奶', why: 'breast feeding 的中文名' },
  { kw: '事后', why: 'aftersex 的中文名' },
  { kw: '爱心瞳', why: 'heart-shaped pupils 的中文名' },
  { kw: '精神崩溃', why: 'mind break 的中文名' },
  { kw: '排尿', why: 'peeing 的中文名' },
  { kw: '失神', why: '高潮失神，生理反应（当前无命中条目，按同一口径预置）' },
  { kw: '失禁', why: '失禁，生理现象（当前无命中条目，按同一口径预置）' },
  { kw: '痉挛', why: '痉挛，生理反应（当前无命中条目，按同一口径预置）' },
];

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 预编译成词边界正则：只建一次，buildPositionIndex 每行知识都不用重复编译 */
const NON_POSE_TAG_RES = NON_POSE_TAG_KEYWORDS.map(entry => ({
  re: new RegExp(`\\b${escapeRegExp(entry.kw)}\\b`, 'i'),
  why: entry.why,
}));

/**
 * 通用画面词黑名单（task-23 方案 B）：渲染 / 画质 / 镜头 / 分辨率 / 背景 / 构图 类的**元素**。
 *
 * 为什么需要：紧凑守卫写成 `if (!form.includes(' ') && …)`，**带空格的元素完全绕过守卫**，
 * 于是 `professional lighting` / `ultra high res` 这类通用词会从二十多 tag 的大场景包借中文名，
 * 在「体位排行」里显示成「高潮后展穴」（task-23 实测 10 例，见 test/intimateMultiWordGuard.test.js）。
 *
 * 为什么不做"收紧守卫"（方案 A：去掉 `!form.includes(' ')` 豁免）：实测 A 会砍掉 **25.4%** 的真体位
 * （90/354 条，含 `on all fours`「床上肛交后入」、`full nelson`「背后锁臂」、`doggystyle anal`
 * 「肛交内射特写」）；B 只砍 **0.8%**（3/354，且都是 79~103 字符的长自然语言句，逐字出现在真实
 * prompt 里概率≈0），同时把 300 条语料的误归因从 150 条压到 0、召回率保持 100%。
 *
 * 匹配方式：**按词序列整词匹配**（hasWordPhrase），不是子串 includes ——
 * 子串会把 `river` 匹配进 `piledriver`（真体位）、把 `view` 匹配进 `viewer`。
 * 作用范围：只作用于**单个元素**（与去噪同一侧）；多 token 打包项与 bundles 一律不动。
 */
const GENERIC_SCENE_TAG_KEYWORDS = [
  // ── 光线 ──
  { kw: 'lighting', why: '光照描述，属画面渲染' },
  { kw: 'light', why: '光' },
  { kw: 'light rays', why: '光线' },
  { kw: 'volumetric lighting', why: '体积光' },
  { kw: 'cinematic lighting', why: '电影感光照' },
  { kw: 'cinematic light', why: '同上一词的变体' },
  { kw: 'professional lighting', why: '专业布光' },
  { kw: 'perfect lighting', why: '完美光照' },
  { kw: 'warm lighting', why: '暖光' },
  { kw: 'studio lighting', why: '影棚布光' },
  // ── 画质 / 渲染 ──
  { kw: 'quality', why: '画质词' },
  { kw: 'best quality', why: '画质词' },
  { kw: 'high quality', why: '画质词' },
  { kw: 'masterpiece', why: '画质词' },
  { kw: 'award winning', why: '评奖式画质词' },
  { kw: 'award winning photo', why: '评奖式画质词' },
  { kw: 'resolution', why: '分辨率' },
  { kw: 'ultra high res', why: '高分辨率' },
  { kw: 'high res', why: '高分辨率' },
  { kw: '8k', why: '分辨率标记' },
  { kw: '4k', why: '分辨率标记' },
  { kw: 'render', why: '渲染方式' },
  { kw: 'ray tracing', why: '光线追踪（渲染技术）' },
  { kw: 'photorealistic', why: '写实渲染' },
  { kw: 'realistic', why: '写实风' },
  { kw: 'realistic style', why: '写实风' },
  { kw: 'analog photography', why: '胶片摄影风' },
  { kw: 'grain', why: '颗粒感' },
  { kw: 'cinematic', why: '电影感' },
  { kw: 'vignette', why: '暗角' },
  { kw: 'ambient occlusion', why: '环境光遮蔽（渲染技术）' },
  { kw: 'contrast', why: '对比度' },
  { kw: 'high contrast', why: '高对比度' },
  { kw: 'saturation', why: '饱和度' },
  { kw: 'saturated', why: '高饱和' },
  { kw: 'vibrant', why: '色彩鲜艳' },
  { kw: 'colored', why: '配色描述' },
  { kw: 'texture', why: '材质/纹理' },
  { kw: 'skin texture', why: '皮肤纹理' },
  { kw: 'skin pores', why: '皮肤毛孔' },
  { kw: 'anatomy', why: '解剖结构（画质向）' },
  { kw: 'detailed', why: '细节度' },
  { kw: 'detailed face', why: '面部细节度' },
  { kw: 'magnum opus', why: '画质润色词' },
  { kw: 'intricate details', why: '细节润色词' },
  // ── 镜头 / 焦距 ──
  { kw: 'lens', why: '镜头' },
  { kw: 'lens flare', why: '镜头光晕' },
  { kw: 'fisheye lens', why: '鱼眼镜头' },
  { kw: 'flare', why: '光晕' },
  { kw: 'bokeh', why: '背景虚化' },
  { kw: 'blur', why: '模糊' },
  { kw: 'blurry', why: '模糊' },
  { kw: 'depth of field', why: '景深' },
  { kw: 'shallow depth of field', why: '浅景深' },
  { kw: 'motion blur', why: '运动模糊' },
  { kw: 'motion line', why: '动势线（画面效果）' },
  { kw: 'motion lines', why: '动势线' },
  { kw: 'focus', why: '对焦' },
  { kw: 'sharp', why: '锐度' },
  { kw: 'closeup', why: '特写取景' },
  { kw: 'close up', why: '特写取景' },
  { kw: 'extra closeup', why: '特写取景' },
  { kw: 'camera', why: '机位' },
  { kw: 'shot', why: '镜头/取景' },
  { kw: 'angle', why: '拍摄角度' },
  // ── 构图 / 取景 ──
  { kw: 'framing', why: '构图' },
  { kw: 'composition', why: '构图' },
  { kw: 'background', why: '背景' },
  { kw: 'foreground', why: '前景' },
  { kw: 'portrait', why: '人像取景' },
  { kw: 'full body', why: '全身取景' },
  { kw: 'full body view', why: '全身取景' },
  { kw: 'full body shot', why: '全身取景' },
  { kw: 'full body portrait', why: '全身取景' },
  { kw: 'full body picture', why: '全身取景' },
  { kw: 'full photo', why: '整幅取景' },
  // ── 视角 ──
  { kw: 'view', why: '视角' },
  { kw: 'viewer', why: '观看者视角' },
  { kw: 'perspective', why: '透视' },
  { kw: 'top view', why: '俯视视角' },
  { kw: 'side view', why: '侧视视角' },
  { kw: 'front side view', why: '前侧视角' },
  { kw: 'view from behind', why: '后视视角（描述机位，不是体位）' },
  { kw: 'back of viewer', why: '观看者背影' },
  { kw: 'looking at', why: '视线方向' },
  { kw: 'looking up', why: '视线方向' },
  { kw: 'looking down', why: '视线方向' },
  { kw: 'not looking towards the camera', why: '视线方向' },
  // ── 画面润色 / 提示词套话 ──
  { kw: 'ultra cute', why: '润色套话' },
  { kw: 'beautiful', why: '润色套话' },
  { kw: 'beautiful face', why: '润色套话' },
  { kw: 'photo of', why: '提示词套话（"一张…的照片"）' },
  { kw: 'a photo of', why: '提示词套话' },
];

/** tag → 词序列（按非字母数字切分；`+`/`#` 保留，避免 `8k`、`c++` 之类被切碎） */
const splitTagWords = value => String(value ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);

/**
 * 整词短语匹配：命中"连续的整词序列"才算。
 * `river` 不会命中 `piledriver`（真体位）、`view` 不会命中 `viewer`、`pee` 不会命中 `peeking` ——
 * 子串匹配正是 task-23 测量里误伤真体位 `piledriver` 的原因。
 */
function hasWordPhrase(tag, phrase) {
  const form = splitTagWords(tag);
  const words = splitTagWords(phrase);
  if (words.length === 0 || words.length > form.length) return false;
  for (let start = 0; start + words.length <= form.length; start += 1) {
    let hit = true;
    for (let offset = 0; offset < words.length; offset += 1) {
      if (form[start + offset] !== words[offset]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/** 单个元素是否"通用画面词"（只对元素调用；多 token 打包项不走这里） */
function isGenericSceneTag(tag) {
  const raw = String(tag ?? '');
  return GENERIC_SCENE_TAG_KEYWORDS.some(entry => hasWordPhrase(raw, entry.kw));
}

const str = (value, max = MAX_FIELD_LEN) => String(value ?? '').trim().slice(0, max);
/**
 * 体位 key 归一化：**必须 slice 之后再 trim**，保证幂等。
 * str() 是"先 trim 再 slice"——截断正好切在空白处时结果会以空格结尾（实测 25 个打包 key
 * 长 120、以 "nude++, " 收尾）。那种 key 存进索引后再走一次 str() 会被 trim 成 119 字符，
 * 于是 positionLabel(bundle.key) 反而查不到自己，前端"体位排行"就会显示 120 字符英文串。
 */
const normPositionKey = raw => str(raw, 120).trim().toLowerCase();
const clampInt = (value, min, max, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * 角色 / 行 id：非法（0、负数、NaN 等脏值）一律归 0，交给调用方抛 invalid。
 * 刻意不用 clampInt（min=1 会把 0 悄悄夹成 1：权限查询会答成 1 号角色的权限、
 * 清空数据会清到别人头上）。
 */
const toId = value => {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const nowIso = () => new Date().toISOString();

/**
 * occurred_at 统一规范化为 ISO+Z：SQLite `datetime('now')` 产出的是**无时区标记的 UTC 串**
 * （"2026-09-28 05:55:59"），直接落库会与 nowIso() 的 ISO 格式混存——前端按本地时间解析偏 8 小时、
 * ORDER BY 字符串比较空格格式恒排在 T 格式之前。任何调用方传 SQLite 串都在这里转成 ISO+Z
 * （与 intimateBackfill 的 toIso 同口径，收口在 recordIntimateActs 一处）。
 */
function toIsoOrNull(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    const date = new Date(`${raw.slice(0, 19).replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? raw : date.toISOString();
  }
  return raw; // 已是 ISO / 异常值：原样透传（不猜）
}

function parseZones(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .map(z => ({
        key: str(z?.key, 32),
        label: str(z?.label, 24),
        level: clampInt(z?.level, 0, 5, 0),
      }))
      .filter(z => z.key || z.label)
      .slice(0, MAX_ZONES);
  } catch {
    return [];
  }
}

/** 解析 JSON 数组字段；不是数组 / 解析失败返回 null，由调用方决定回落口径 */
function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const list = JSON.parse(String(raw ?? ''));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** 规范化 AI 修改权限：只留白名单键、去重、保序；脏数据按"不给权限"处理（权限判定必须 fail-closed） */
function normalizeAiEditFields(value) {
  const list = value === undefined || value === null ? AI_EDIT_DEFAULTS : parseJsonArray(value);
  if (!list) return [];
  const out = [];
  for (const item of list) {
    const key = str(item, 24);
    if (!AI_EDIT_KEYS.includes(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * 规范化统计口径：只留合法 partner_kind；空 / 非法 / 脏数据一律回落到默认 ['user','character']（DEFAULT_VIEW_SCOPE）。
 *
 * 刻意不允许"空数组 = 全部"：口径是减法操作（取消勾选），要是清空勾选反而看到更多数据，
 * 用户会以为看板坏了。想看全部请在面板上勾满三类（前端提供"全选"），
 * 只有请求参数层的逃生门 `partnerKinds=all` 才表示不过滤（见 resolvePartnerFilter）。
 */
function normalizeViewScope(value) {
  const list = value === undefined || value === null ? DEFAULT_VIEW_SCOPE : parseJsonArray(value);
  const out = [];
  if (list) {
    for (const item of list) {
      const kind = str(item, 24).toLowerCase();
      if (!PARTNER_KINDS.includes(kind)) continue;
      if (!out.includes(kind)) out.push(kind);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_VIEW_SCOPE];
}

/** 请求里的 partnerKinds：支持数组与 "user,character" 串；空/非法一律视作未传 */
function normalizePartnerKinds(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const item of list) {
    const kind = str(item, 24).toLowerCase();
    if (!PARTNER_KINDS.includes(kind)) continue;
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

/** 请求参数里的"不过滤"逃生门（调试 / 内部用，面板不要拿它表达"全部"） */
const ALL_PARTNER_KINDS = 'all';

function partnerKindTokens(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : String(value).split(',')).map(item => str(item, 24).toLowerCase());
}

/**
 * 解析本次统计口径：
 *   1. 显式 partnerKinds=all → 不过滤（逃生门）
 *   2. 显式 partnerKinds（合法 partner_kind 列表）→ 用它
 *   3. 否则用角色档案的 viewScope（已保证至少一个口径，不会是空）
 */
function resolvePartnerFilter(characterId, partnerKinds) {
  if (partnerKindTokens(partnerKinds).includes(ALL_PARTNER_KINDS)) return [];
  const explicit = normalizePartnerKinds(partnerKinds);
  if (explicit.length > 0) return explicit;
  return getBodyProfile(characterId).viewScope;
}

/** 拼 partner_kind 过滤子句；kinds 为空则不过滤（原地往 params 追加占位参数） */
function partnerFilterClause(kinds, params) {
  if (!kinds || kinds.length === 0) return '';
  params.push(...kinds);
  return ` AND partner_kind IN (${kinds.map(() => '?').join(', ')})`;
}

function actLabel(actKey, customLabel = '') {
  const def = ACT_DEFINITIONS.find(a => a.key === actKey);
  return def?.label || customLabel || actKey;
}

// ── 体位词表（与生图 tag 同源） ──

let positionIndexCache = null;

/** 清空体位词表索引缓存（知识库同步后或测试中调用） */
export function resetPositionVocabularyCache() {
  positionIndexCache = null;
}

/** 打包 key 按逗号拆成单个 tag（trim + 小写 + 去空 + 去重） */
function splitBundleTags(bundleKey) {
  const out = [];
  for (const part of String(bundleKey || '').split(',')) {
    const tag = part.trim().toLowerCase();
    if (!tag) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 是否"单 token 包"（key 本身就是单个 tag，如 cum / 69 / bdsm）。
 * 去噪过滤只作用于这一类：多 token 的真体位组合（如 `arms grab, sex from behind`）一律不动。
 */
function isSingleTokenBundle(key) {
  const parts = splitBundleTags(key);
  return parts.length === 1 && parts[0] === key;
}

/**
 * 单个 tag 是否属于"非体位"噪声（流体 / 事后 / 生理反应）—— 只按英文词匹配。
 * 反查表（tagToBundle）用它拦"单元素 tag"：`cum on breast` 这类 tag 本身不是体位的包，
 * 却会借所属打包项的包名（实测显示成「昏睡颜射」「射精」）混进「体位排行」。
 */
function isNonPoseTag(tag) {
  const raw = String(tag ?? '');
  return NON_POSE_TAG_RES.some(entry => entry.re.test(raw));
}

/**
 * 单 token 包是否属于"非体位"噪声：英文 key 或中文 label 命中黑名单都算。
 * 只对单 token 包调用——多 token 打包体位项不走这里（见 isSingleTokenBundle）。
 */
function isNonPoseBundle(key, label) {
  if (isNonPoseTag(key)) return true;
  return NON_POSE_LABEL_KEYWORDS.some(entry => String(label).includes(entry.kw));
}

/**
 * 剥权重后的"别名查表形态"：`(bent over:1.3)` → `bent over`。
 * 本来就没有权重包装（剥完与原文一致）时返回 ''，调用方跳过。
 *
 * 为什么需要别名：知识库里不少**元素**或**包名**带 A1111 权重包装，而真实生图 prompt 的 tag
 * 已经过 tagsFromPromptString 剥干净。两种形态在反查表里是两个不同的 key，
 * 不补别名就会出现"漏归因"（`bent over` 查不到）与"近义错配"（落到另一个同义包）。
 */
function weightAliasOf(raw) {
  const alias = normPositionKey(stripTagWeight(raw));
  const original = normPositionKey(raw);
  return alias && alias !== original ? alias : '';
}

/**
 * 构建体位词表索引（一次构建、缓存复用）。知识库里的 adult_pose_vocabulary 绝大多数是
 * "逗号连接的整段 tag"（如 key=`arms grab, sex from behind`），而真实生图 prompt 是
 * 一个个单独的 tag，精确查包名永远查不到，所以要多一张反查表：
 *
 *   bundles     Map<打包 key, {key,label,group}>：面板下拉/注入用的那一份，只含打包 key
 *   tagToBundle Map<单个 tag, 所属打包 key>：**只保留全局唯一归属、且够具体的元素**。
 *               出现 ≥2 次的公共词（实测 on bed=5 个包、looking at viewer=34 个包）一律丢弃；
 *               单 token 元素还要求所属打包项足够紧凑（元素数 ≤ MAX_TIGHT_BUNDLE_TAGS），
 *               否则会误归因：实测 `1girl` 全局只归属 `panty job, panties on penis, 1girl`，
 *               不挡的话任何含 1girl 的 prompt 都会被算成"内裤手交"。
 *               宁可漏归因，也不能把无关画面算成套。
 *   aliasToBundle Map<剥权重形态, 真实包 key>：知识库里不少元素/包名带 A1111 权重
 *               （`(bent over:1.3)`、包名 `(vibrator under panties secure leg belt:1.2)`），
 *               而真实 prompt 的 tag 已被 tagsFromPromptString 剥干净，不补别名就会漏归因。
 *               命中的是**真实包 key**（不是别名本身），这样 positionLabel 能出中文，
 *               注入块也不会吐出带权重的长串；注入用的包名保持原样，剥权重会丢强调语义。
 *               真实包名优先由 resolvePositionKey 的查询顺序保证（bundles 先查）。
 *   labelByKey  Map<key, 中文名>：打包 key、单元素 key、别名都在，供 positionLabel 兜底
 *
 * 去噪（见 NON_POSE_TAG_KEYWORDS / NON_POSE_LABEL_KEYWORDS）：知识库混着"流体 / 事后 /
 * 生理反应"类的单 token 包与单元素 tag（cum→射精、aftersex→事后…）。它们**只作用于单个 token**，
 * 因此在索引的两侧各拦一次：单 token 包不进 bundles（词表与下拉里就没有它），
 * 单元素 tag 不进 tagToBundle（`cum on breast` 不会借包名变成体位）。
 * 多 token 的真体位组合（arms grab, sex from behind 等）两侧都不动，仍然照常命中。
 * 行为统计不受影响：act 归类走 ACT_DEFINITIONS，与体位索引无关。
 *
 * 说明：单 token 的打包项（key 本身就是单个 tag，如 bdsm / 69）走"精确命中包名"分支，
 * 不需要进反查表。
 */
function buildPositionIndex() {
  if (positionIndexCache) return positionIndexCache;

  const bundles = new Map();
  let rows = [];
  try {
    rows = getDb().prepare(
      `SELECT executable_tags FROM image_prompt_knowledge
       WHERE is_active = 1 AND category = 'adult_pose_vocabulary'`
    ).all();
  } catch {
    rows = [];
  }
  for (const row of rows) {
    let tags = [];
    try { tags = JSON.parse(row.executable_tags || '[]'); } catch { tags = []; }
    if (!Array.isArray(tags)) continue;
    for (const item of tags) {
      const key = normPositionKey(item?.tag);
      if (!key) continue;
      const label = str(item?.label, 40) || key;
      // 去噪：流体 / 事后 / 生理反应类的**单 token 包**不进体位索引 ——
      // 于是它既不出现在词表（前端下拉）里，也不会被 resolvePositionKey 命中而污染「体位排行」。
      // 行为统计不受影响：act 归类走 ACT_DEFINITIONS，与体位索引无关（cum 不作为体位，但 vaginal 照记）。
      if (isSingleTokenBundle(key) && isNonPoseBundle(key, label)) continue;
      if (!bundles.has(key)) bundles.set(key, { key, label, group: str(item?.group, 40) });
    }
  }

  const bundleParts = new Map(); // 打包 key → 拆好的元素
  const owners = new Map();      // 查表形态（元素原样 / 剥权重别名）→ {count, bundleKey}
  const aliasForms = new Set();  // 上面哪些形态是"剥权重别名"（命中后要返回真实包 key）
  /** 登记一个查表形态的归属；同一形态出现在 ≥2 个包里就算公共词，后面一律不索引 */
  const claim = (lookup, bundleKey, viaAlias = false) => {
    if (!lookup) return;
    const owner = owners.get(lookup);
    if (owner) owner.count += 1;
    else owners.set(lookup, { count: 1, bundleKey });
    if (viaAlias) aliasForms.add(lookup);
  };
  for (const key of bundles.keys()) {
    const parts = splitBundleTags(key);
    bundleParts.set(key, parts);
    for (const tag of parts) {
      if (tag === key) continue; // 单 token 打包项：走精确命中
      // 去噪（反查侧）：**单个元素**是流体/事后/生理反应类的，也不许成为"体位"。
      // 只作用于元素，多 token 打包项本身仍然完整保留（arms grab / sex from behind 照旧命中）；
      // 不拦的话 `cum on breast` 会借所属打包项的包名（实测显示成「昏睡颜射」）进「体位排行」。
      // 别名登记在这行之后：被去噪的元素连别名都不补，否则「射精/泌乳」会从别名这条路回来。
      if (isNonPoseTag(tag)) continue;
      // 通用画面词（task-23 方案 B）：渲染/画质/镜头/构图类的**元素**同样不许成为"体位" ——
      // 它们会从二十多 tag 的大场景包借中文名（实测 `professional lighting` → 「高潮后展穴」）。
      // 与去噪同一取向：宁可少归因，也不能误归因；别名一并不登记，否则会从别名这条路回来。
      // 只作用于元素：多 token 打包项与 bundles 都不动（`arms grab` 等照旧命中）。
      if (isGenericSceneTag(tag)) continue;
      claim(tag, key);
      const alias = weightAliasOf(tag);
      if (alias && !isGenericSceneTag(alias)) claim(alias, key, true);
    }
    // 包名自身带权重（实测 11 个，如 `(vibrator under panties secure leg belt:1.2)`）：
    // 把剥权重形态也登记到同一个真实包；bundles 里的包名保持原样不动。
    claim(weightAliasOf(key), key, true);
  }

  const tagToBundle = new Map();
  const aliasToBundle = new Map();
  for (const [form, owner] of owners) {
    if (owner.count !== 1) continue; // 公共词：出现 ≥2 次，一律不索引
    if (!form.includes(' ') && bundleParts.get(owner.bundleKey).length > MAX_TIGHT_BUNDLE_TAGS) continue;
    // 别名命中返回真实包 key；真实元素命中沿用"返回该 tag 自身"的既有口径
    if (aliasForms.has(form) && !bundles.has(form)) aliasToBundle.set(form, owner.bundleKey);
    else tagToBundle.set(form, owner.bundleKey);
  }

  const labelByKey = new Map();
  for (const [key, entry] of bundles) labelByKey.set(key, entry.label);
  for (const [tag, bundleKey] of tagToBundle) {
    // 单元素 key 自身没有中文名，借用它所属打包项的中文名，否则 byPosition 只能显示英文 tag
    if (!labelByKey.has(tag)) labelByKey.set(tag, bundles.get(bundleKey).label);
  }
  for (const [alias, bundleKey] of aliasToBundle) {
    // 别名单独查中文名时也借用真实包的中文名
    if (!labelByKey.has(alias)) labelByKey.set(alias, bundles.get(bundleKey).label);
  }

  positionIndexCache = { bundles, tagToBundle, aliasToBundle, labelByKey };
  return positionIndexCache;
}

/**
 * 读取体位词表（打包 key 那一份）。
 * @returns {Map<string, {key: string, label: string, group: string}>} key = 英文 tag 包
 */
export function getPositionVocabularyMap() {
  return buildPositionIndex().bundles;
}

/**
 * 把一个 prompt tag 解析成 position_key：
 *   1. 精确命中打包 key（单 token 打包项在这里命中）→ 返回该包名
 *   2. 命中剥权重别名 → 返回**真实包 key**（不是别名本身：这样 positionLabel 出中文、
 *      注入块也不会吐出带权重的长串）
 *   3. 命中唯一归属的单元素 tag → 返回**该 tag 自身**（短、干净，前端直接可用）
 *   4. 公共元素 / 不认识 → ''
 * 顺序即优先级：真实包名永远优先于别名（知识库里 (doggystyle) 剥权重后正是真实包 doggystyle）。
 * @param {string} tag
 * @returns {string}
 */
export function resolvePositionKey(tag) {
  const key = normPositionKey(tag);
  if (!key) return '';
  const index = buildPositionIndex();
  if (index.bundles.has(key)) return key;
  if (index.aliasToBundle.has(key)) return index.aliasToBundle.get(key);
  if (index.tagToBundle.has(key)) return key;
  return '';
}

/** position_key → 中文展示名：打包 key 用包名，单元素 key 借所属打包项的中文名，最后回落原 key */
export function positionLabel(positionKey) {
  const key = normPositionKey(positionKey);
  if (!key) return '';
  const index = buildPositionIndex();
  return index.bundles.get(key)?.label || index.labelByKey.get(key) || key;
}

/**
 * 面板用词表：行为分类 + 体位选项。
 * positions 保持"只回打包 key"（680 条单元素不该进下拉），另附拆好的 tags 供前端搜索。
 */
export function listIntimateVocabulary() {
  const positions = [...getPositionVocabularyMap().values()]
    .map(entry => ({ ...entry, tags: splitBundleTags(entry.key) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  return {
    acts: ACT_DEFINITIONS.map(({ key, label }) => ({ key, label })),
    positions,
  };
}

/** 剥掉 A1111 权重包装：`(tag:1.2)` / `((tag))` / `[tag]` / `{tag}` → `tag` */
function stripTagWeight(raw) {
  let text = String(raw ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const t = text.trim();
    if (t.length < 2) break;
    const head = t[0];
    const tail = t[t.length - 1];
    const paired = (head === '(' && tail === ')')
      || (head === '[' && tail === ']')
      || (head === '{' && tail === '}');
    if (!paired) break;
    text = t.slice(1, -1).trim();
  }
  // 权重后缀只可能出现在括号写法里，剥完括号再吃掉 `:1.2`
  return text.replace(/:\s*\d+(?:\.\d+)?\s*$/, '').trim();
}

/**
 * 生图 prompt 字符串 → 规范化 tag 数组。
 *
 * 为什么需要它：chat.js 往 raw_messages.prompt 存的是英文 tag 逗号串（tags.prompt），
 * 不是数组。自动记账（record 接口直传 tags）与历史回填（扫 raw_messages）两条链路
 * 都必须先过这里，tag 形态才一致，classifyPromptTags 的匹配口径才不会分叉。
 *
 * 口径：按逗号切分 → 剥权重包装 → trim / 小写 / 去空 / 去重 → 截断到 maxTags。
 *
 * @param {string|string[]} prompt 生图 prompt 串，或已经是数组的 tag 列表
 * @param {{maxTags?: number}} [options]
 * @returns {string[]}
 */
export function tagsFromPromptString(prompt, { maxTags = 200 } = {}) {
  const limit = clampInt(maxTags, 1, 1000, 200);
  const pieces = Array.isArray(prompt)
    ? prompt.flatMap(item => (typeof item === 'string' ? item.split(',') : [item]))
    : (typeof prompt === 'string' ? prompt.split(',') : []);
  const out = [];
  for (const piece of pieces) {
    const tag = str(stripTagWeight(piece), 120).toLowerCase();
    if (!tag) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 把一轮生图 prompt 的可执行 tag 归类成行为记录（确定性、零 LLM 成本）。
 * @param {string[]} tags
 * @returns {Array<{actKey: string, positionKey: string}>}
 */
export function classifyPromptTags(tags = []) {
  const lowered = tags.map(t => str(t, 120).toLowerCase()).filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (actKey, positionKey) => {
    const uid = `${actKey}|${positionKey}`;
    if (seen.has(uid)) return;
    seen.add(uid);
    out.push({ actKey, positionKey });
  };

  // 取第一个能解析成体位的 tag（打包 key 精确命中，或唯一归属的单元素）
  const matchedPosition = lowered.map(resolvePositionKey).find(Boolean) || '';
  for (const def of ACT_DEFINITIONS) {
    if (def.tags.length === 0) continue;
    const hit = lowered.some(t => def.tags.some(frag => t.includes(frag)));
    if (!hit) continue;
    // 体位只在"插入类"行为上归因，避免把 oral 也算成某个体位
    const position = ['vaginal', 'anal'].includes(def.key) ? matchedPosition : '';
    push(def.key, position);
  }
  return out;
}

// ── 静态档案 ──

const EMPTY_PROFILE = Object.freeze({
  characterId: 0,
  height: '', bust: '', waist: '', hip: '', cup: '', note: '',
  sensitiveZones: [], injectEnabled: false,
  aiEditFields: AI_EDIT_DEFAULTS, viewScope: DEFAULT_VIEW_SCOPE, backfillEnabled: true,
  // AI 判断行为（task-32）：默认关 —— 开了以后每轮回复落库后会异步多一次 LLM 判定
  aiJudgeEnabled: false,
  updatedAt: null,
});

/** 空档（含数组副本，避免调用方改动到共享默认值） */
function emptyProfile(characterId = 0) {
  return {
    ...EMPTY_PROFILE,
    characterId,
    sensitiveZones: [],
    aiEditFields: [...AI_EDIT_DEFAULTS],
    viewScope: [...DEFAULT_VIEW_SCOPE],
  };
}

/** 读取身体档案；没有行时返回空档（不写库） */
export function getBodyProfile(characterId) {
  const id = toId(characterId);
  if (!id) return emptyProfile();
  const row = getDb().prepare('SELECT * FROM character_body_profile WHERE character_id = ?').get(id);
  if (!row) return emptyProfile(id);
  return {
    characterId: id,
    height: row.height || '',
    bust: row.bust || '',
    waist: row.waist || '',
    hip: row.hip || '',
    cup: row.cup || '',
    note: row.note || '',
    sensitiveZones: parseZones(row.sensitive_zones),
    injectEnabled: row.inject_enabled === 1,
    aiJudgeEnabled: row.ai_judge_enabled === 1,
    aiEditFields: normalizeAiEditFields(row.ai_edit_fields),
    viewScope: normalizeViewScope(row.view_scope),
    backfillEnabled: row.backfill_enabled !== 0,
    updatedAt: row.updated_at || null,
  };
}

/**
 * 某个权限键是否允许 AI 修改。
 * 没有档案行 = 用户没表过态，按 AI_EDIT_DEFAULTS（只放开 stats）算；
 * 有档案行就看行里存的名单，脏数据 fail-closed。
 * @param {number} characterId
 * @param {'body'|'sensitiveZones'|'note'|'firsts'|'stats'} fieldKey
 * @returns {boolean}
 */
export function isAiEditAllowed(characterId, fieldKey) {
  const key = str(fieldKey, 24);
  if (!AI_EDIT_KEYS.includes(key)) return false;
  const id = toId(characterId);
  if (!id) return false;
  return getBodyProfile(id).aiEditFields.includes(key);
}

/**
 * 写入/更新身体档案（白名单字段，未传的字段保持原值）。
 * @param {number} characterId
 * @param {{height?:string,bust?:string,waist?:string,hip?:string,cup?:string,note?:string,sensitiveZones?:Array,
 *          injectEnabled?:boolean,aiEditFields?:string[],viewScope?:string[],backfillEnabled?:boolean}} patch
 */
export function upsertBodyProfile(characterId, patch = {}) {
  const id = toId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id);
  if (!exists) throw new Error('character not found');

  const current = getBodyProfile(id);
  const next = {
    height: patch.height !== undefined ? str(patch.height) : current.height,
    bust: patch.bust !== undefined ? str(patch.bust) : current.bust,
    waist: patch.waist !== undefined ? str(patch.waist) : current.waist,
    hip: patch.hip !== undefined ? str(patch.hip) : current.hip,
    cup: patch.cup !== undefined ? str(patch.cup, 12) : current.cup,
    note: patch.note !== undefined ? str(patch.note, MAX_NOTE_LEN) : current.note,
    sensitiveZones: patch.sensitiveZones !== undefined ? parseZones(JSON.stringify(patch.sensitiveZones)) : current.sensitiveZones,
    injectEnabled: patch.injectEnabled !== undefined ? (patch.injectEnabled ? 1 : 0) : (current.injectEnabled ? 1 : 0),
    aiEditFields: patch.aiEditFields !== undefined ? normalizeAiEditFields(patch.aiEditFields) : current.aiEditFields,
    viewScope: patch.viewScope !== undefined ? normalizeViewScope(patch.viewScope) : current.viewScope,
    backfillEnabled: patch.backfillEnabled !== undefined ? (patch.backfillEnabled ? 1 : 0) : (current.backfillEnabled ? 1 : 0),
    aiJudgeEnabled: patch.aiJudgeEnabled !== undefined ? (patch.aiJudgeEnabled ? 1 : 0) : (current.aiJudgeEnabled ? 1 : 0),
  };

  db.prepare(
    `INSERT INTO character_body_profile
       (character_id, height, bust, waist, hip, cup, note, sensitive_zones, inject_enabled,
        ai_edit_fields, view_scope, backfill_enabled, ai_judge_enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET
       height = excluded.height, bust = excluded.bust, waist = excluded.waist, hip = excluded.hip,
       cup = excluded.cup, note = excluded.note, sensitive_zones = excluded.sensitive_zones,
       inject_enabled = excluded.inject_enabled, ai_edit_fields = excluded.ai_edit_fields,
       view_scope = excluded.view_scope, backfill_enabled = excluded.backfill_enabled,
       ai_judge_enabled = excluded.ai_judge_enabled,
       updated_at = excluded.updated_at`
  ).run(id, next.height, next.bust, next.waist, next.hip, next.cup, next.note,
    JSON.stringify(next.sensitiveZones), next.injectEnabled,
    JSON.stringify(next.aiEditFields), JSON.stringify(next.viewScope), next.backfillEnabled,
    next.aiJudgeEnabled, nowIso());

  return getBodyProfile(id);
}

/** 注入开关（面板上的"让角色知晓这些信息"） */
export function setInjectEnabled(characterId, enabled) {
  return upsertBodyProfile(characterId, { injectEnabled: !!enabled });
}

/** AI 判断行为开关（面板上的"是否默认开启 AI 判断"，task-32） */
export function setAiJudgeEnabled(characterId, enabled) {
  return upsertBodyProfile(characterId, { aiJudgeEnabled: !!enabled });
}

// ── 行为流水 ──

function buildSourceUid({ source, scene, actKey, positionKey, partnerKind, partnerId, rawId, msgId, explicit }) {
  if (explicit) return str(explicit, 160);
  const anchor = Number(rawId) > 0 ? `raw${rawId}` : (Number(msgId) > 0 ? `msg${msgId}` : '');
  if (source === 'manual') return `manual:${crypto.randomUUID()}`;
  if (!anchor) {
    // 没有 raw/msg 锚点就无法去重：退化为一次性 uid，宁可漏记也不虚高
    console.warn('[intimate] record without raw/msg anchor, dedupe disabled');
    return `${source}:${crypto.randomUUID()}`;
  }
  return `${source}:${scene}:${anchor}:${actKey}:${positionKey}:${partnerKind}:${partnerId}`;
}

/**
 * 记一笔（或多笔）行为。幂等：同一 (character, source_uid) 只落一行。
 *
 * 权限闸门：非人工记账（auto / llm）必须先被授权 stats，否则整批不落库并返回 blocked。
 * 人工补录（source='manual'）是用户自己在面板上点的，一律放行。
 *
 * @param {number} characterId
 * @param {{scene?:string, partnerKind?:string, partnerId?:number, rawId?:number, msgId?:number,
 *          source?:'auto'|'llm'|'manual', confidence?:number, occurredAt?:string,
 *          acts:Array<{actKey:string, positionKey?:string, customLabel?:string, count?:number, climaxCount?:number, sourceUid?:string}>}} payload
 * @returns {{inserted:number, skipped:number, blocked:boolean}}
 */
export function recordIntimateActs(characterId, payload = {}) {
  const id = toId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) throw new Error('character not found');

  const scene = SCENES.includes(payload.scene) ? payload.scene : 'chat';
  const source = ['auto', 'llm', 'manual'].includes(payload.source) ? payload.source : 'auto';

  if (source !== 'manual' && !isAiEditAllowed(id, 'stats')) {
    return { inserted: 0, skipped: 0, blocked: true };
  }
  const partnerKind = PARTNER_KINDS.includes(payload.partnerKind) ? payload.partnerKind : 'user';
  const partnerId = clampInt(payload.partnerId, 0, Number.MAX_SAFE_INTEGER, 0);
  const rawId = clampInt(payload.rawId, 0, Number.MAX_SAFE_INTEGER, 0);
  const msgId = clampInt(payload.msgId, 0, Number.MAX_SAFE_INTEGER, 0);
  const confidence = Math.min(1, Math.max(0, Number(payload.confidence ?? 1) || 0));
  const occurredAt = toIsoOrNull(payload.occurredAt) || nowIso();
  const acts = Array.isArray(payload.acts) ? payload.acts : [];

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO character_intimate_log
       (character_id, source_uid, act_key, position_key, custom_label, partner_kind, partner_id,
        scene, act_count, climax_count, raw_id, msg_id, source, confidence, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let inserted = 0;
  let skipped = 0;
  const run = db.transaction(() => {
    for (const act of acts) {
      const actKey = str(act?.actKey, 48);
      if (!actKey) continue;
      const positionKey = str(act?.positionKey, 120).toLowerCase();
      const uid = buildSourceUid({
        source, scene, actKey, positionKey, partnerKind, partnerId, rawId, msgId, explicit: act?.sourceUid,
      });
      const result = stmt.run(
        id, uid, actKey, positionKey, str(act?.customLabel, 48), partnerKind, partnerId, scene,
        clampInt(act?.count, 1, MAX_ACT_COUNT, 1), clampInt(act?.climaxCount, 0, MAX_ACT_COUNT, 0),
        rawId, msgId, source, confidence, occurredAt
      );
      if (result.changes > 0) inserted++; else skipped++;
    }
  });
  run();

  if (inserted > 0) {
    refreshFirsts(id);
    invalidateStatsCache(id);
  }
  return { inserted, skipped, blocked: false };
}

/**
 * 按 raw_id 回滚（撤回一轮 / 清空会话联动）。
 * @returns {{deleted:number, characters:number[]}}
 */
export function rollbackIntimateByRawId(rawId) {
  const raw = clampInt(rawId, 0, Number.MAX_SAFE_INTEGER, 0);
  if (!raw) return { deleted: 0, characters: [] };
  const db = getDb();
  const ids = db.prepare('SELECT DISTINCT character_id FROM character_intimate_log WHERE raw_id = ?')
    .all(raw).map(r => r.character_id);
  if (ids.length === 0) return { deleted: 0, characters: [] };
  const result = db.prepare('DELETE FROM character_intimate_log WHERE raw_id = ?').run(raw);
  for (const id of ids) {
    refreshFirsts(id);
    invalidateStatsCache(id);
  }
  return { deleted: result.changes, characters: ids };
}

/**
 * 按 raw_id 区间回滚（群聊撤回一轮 / 解散群：一次覆盖一整段 raw 区间）。
 *
 * 与 rollbackIntimateByRawId 保持同一套语义：先查出受影响角色 → 删流水 → 逐角色重算里程碑 + 失效统计缓存。
 * 两个安全边界：
 *   1. min < 1 或 max < min → 直接 no-op。raw_id = 0 表示"没有 raw 锚点"（人工补录、奇遇事件流水用显式
 *      source_uid），与 rollbackIntimateByRawId(0) 同口径：raw 维度的回滚永远不许碰到它们。
 *   2. **调用点必须传 conversationId**：raw_messages.id 是全库自增，一个会话的 raw 不是连续段——
 *      只按 BETWEEN 删，会把落在同一 id 区间里的其他会话（私聊 / 另一个群）的流水一起删掉。
 *      传入 conversationId 后，区间先收敛成"该会话真实拥有的 raw id"再删。
 *      并且必须在 DELETE raw_messages **之前**调用：raw 删掉后 raw_id → conversation_id 的对应关系就没了，
 *      再也分不清哪些流水属于这个会话。
 *
 * @param {number} minRawId
 * @param {number} maxRawId
 * @param {{conversationId?: string}} [options]
 * @returns {{deleted:number, characters:number[]}}
 */
export function rollbackIntimateByRawIdRange(minRawId, maxRawId, { conversationId = '' } = {}) {
  const min = clampInt(minRawId, 0, Number.MAX_SAFE_INTEGER, 0);
  const max = clampInt(maxRawId, 0, Number.MAX_SAFE_INTEGER, 0);
  if (min < 1 || max < min) return { deleted: 0, characters: [] };

  const db = getDb();
  const scope = conversationId
    ? 'raw_id IN (SELECT id FROM raw_messages WHERE conversation_id = ? AND id BETWEEN ? AND ?)'
    : 'raw_id BETWEEN ? AND ?';
  const params = conversationId ? [String(conversationId), min, max] : [min, max];

  const ids = db.prepare(`SELECT DISTINCT character_id FROM character_intimate_log WHERE ${scope}`)
    .all(...params).map(r => r.character_id);
  if (ids.length === 0) return { deleted: 0, characters: [] };

  const result = db.prepare(`DELETE FROM character_intimate_log WHERE ${scope}`).run(...params);
  for (const id of ids) {
    refreshFirsts(id);
    invalidateStatsCache(id);
  }
  return { deleted: result.changes, characters: ids };
}

/** 删除单条流水（人工纠错） */
export function deleteIntimateLog(characterId, logId) {
  const db = getDb();
  const row = db.prepare('SELECT character_id FROM character_intimate_log WHERE id = ?').get(toId(logId));
  if (!row) return false;
  if (Number(row.character_id) !== Number(characterId)) return false;
  db.prepare('DELETE FROM character_intimate_log WHERE id = ?').run(logId);
  refreshFirsts(row.character_id);
  invalidateStatsCache(row.character_id);
  return true;
}

/**
 * 列出流水（倒序）。
 * partnerKinds 未传时用档案 viewScope；传 'all' 表示不过滤（逃生门）。
 */
export function listIntimateLogs(characterId, { limit = 50, offset = 0, partnerKinds } = {}) {
  const id = toId(characterId);
  if (!id) return [];
  const params = [id];
  const clause = partnerFilterClause(resolvePartnerFilter(id, partnerKinds), params);
  params.push(clampInt(limit, 1, 200, 50), Math.max(0, clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0)));
  return getDb().prepare(
    `SELECT id, act_key AS actKey, position_key AS positionKey, custom_label AS customLabel,
            partner_kind AS partnerKind, partner_id AS partnerId, scene, act_count AS actCount,
            climax_count AS climaxCount, raw_id AS rawId, msg_id AS msgId, source, confidence,
            occurred_at AS occurredAt
     FROM character_intimate_log WHERE character_id = ?${clause}
     ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params);
}

/** 清空某角色的看板数据（保留身体档案），用于"清空会话/重置统计" */
export function clearIntimateData(characterId) {
  const id = toId(characterId);
  if (!id) return { logs: 0, firsts: 0 };
  const db = getDb();
  const logs = db.prepare('DELETE FROM character_intimate_log WHERE character_id = ?').run(id).changes;
  const firsts = db.prepare('DELETE FROM character_intimate_firsts WHERE character_id = ?').run(id).changes;
  invalidateStatsCache(id);
  return { logs, firsts };
}

// ── 里程碑（初次） ──

/**
 * 由流水重算里程碑：初次时间 = MIN(occurred_at)。
 * source='manual' 的行是人工结论，不被流水覆盖；流水里已消失的自动行会被清掉（回滚后回落）。
 */
export function refreshFirsts(characterId) {
  const id = toId(characterId);
  if (!id) return;
  const db = getDb();
  const derived = db.prepare(
    `SELECT act_key AS actKey, MIN(occurred_at) AS firstAt, MIN(raw_id) AS rawId
     FROM character_intimate_log WHERE character_id = ? GROUP BY act_key`
  ).all(id);
  const derivedKeys = new Set(derived.map(d => d.actKey));

  const run = db.transaction(() => {
    for (const row of derived) {
      const existing = db.prepare('SELECT source FROM character_intimate_firsts WHERE character_id = ? AND act_key = ?')
        .get(id, row.actKey);
      if (existing && existing.source === 'manual') continue;
      db.prepare(
        `INSERT INTO character_intimate_firsts (character_id, act_key, first_at, source_raw_id, source, updated_at)
         VALUES (?, ?, ?, ?, 'derived', ?)
         ON CONFLICT(character_id, act_key) DO UPDATE SET
           first_at = excluded.first_at, source_raw_id = excluded.source_raw_id,
           source = 'derived', updated_at = excluded.updated_at`
      ).run(id, row.actKey, row.firstAt, clampInt(row.rawId, 0, Number.MAX_SAFE_INTEGER, 0), nowIso());
    }
    const rows = db.prepare('SELECT act_key AS actKey, source FROM character_intimate_firsts WHERE character_id = ?').all(id);
    for (const row of rows) {
      if (row.source === 'manual') continue;
      if (derivedKeys.has(row.actKey)) continue;
      db.prepare('DELETE FROM character_intimate_firsts WHERE character_id = ? AND act_key = ?').run(id, row.actKey);
    }
  });
  run();
}

/** 人工设定里程碑（覆盖自动派生，来源标记为 manual） */
export function setFirstAt(characterId, actKey, { firstAt = null, note = '' } = {}) {
  const id = toId(characterId);
  const key = str(actKey, 48);
  if (!id || !key) throw new Error('invalid argument');
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) throw new Error('character not found');
  db.prepare(
    `INSERT INTO character_intimate_firsts (character_id, act_key, first_at, source_raw_id, source, note, updated_at)
     VALUES (?, ?, ?, 0, 'manual', ?, ?)
     ON CONFLICT(character_id, act_key) DO UPDATE SET
       first_at = excluded.first_at, source = 'manual', note = excluded.note, updated_at = excluded.updated_at`
  ).run(id, key, firstAt ? String(firstAt) : null, str(note, MAX_NOTE_LEN), nowIso());
  return listFirsts(id).find(f => f.actKey === key) || null;
}

export function listFirsts(characterId) {
  const id = toId(characterId);
  if (!id) return [];
  return getDb().prepare(
    `SELECT act_key AS actKey, first_at AS firstAt, source_raw_id AS sourceRawId, source, note
     FROM character_intimate_firsts WHERE character_id = ? ORDER BY first_at IS NULL, first_at ASC`
  ).all(id).map(row => ({ ...row, label: actLabel(row.actKey) }));
}

// ── 聚合统计 ──

function invalidateStatsCache(characterId) {
  try {
    getDb().prepare('DELETE FROM character_intimate_stats WHERE character_id = ?').run(characterId);
  } catch { /* 缓存表缺失时不影响主流程 */ }
}

/**
 * 聚合看板数据：一律从流水现算（单角色数据量在千行级，代价可忽略）。
 *
 * 统计口径：partnerKinds 未传时用档案 viewScope（默认只看 user）；汇总与各分组
 * 只算过滤后的行。初次里程碑（firsts）是"事实"、与口径无关，不参与过滤。
 *
 * @param {number} characterId
 * @param {{partnerKinds?: string[]|string}} [options]
 * @returns {{totalActs:number,totalClimax:number,actKinds:number,firstAt:string|null,lastAt:string|null,
 *            partnerKinds:string[],byAct:Array,byPosition:Array,byPartner:Array,byScene:Array}}
 */
export function getIntimateStats(characterId, { partnerKinds } = {}) {
  const id = toId(characterId);
  const empty = {
    totalActs: 0, totalClimax: 0, actKinds: 0, firstAt: null, lastAt: null, partnerKinds: [],
    byAct: [], byPosition: [], byPartner: [], byScene: [],
  };
  if (!id) return empty;
  const db = getDb();
  const filter = resolvePartnerFilter(id, partnerKinds);

  const totalsParams = [id];
  const totals = db.prepare(
    `SELECT COALESCE(SUM(act_count),0) AS totalActs, COALESCE(SUM(climax_count),0) AS totalClimax,
            COUNT(DISTINCT act_key) AS actKinds, MIN(occurred_at) AS firstAt, MAX(occurred_at) AS lastAt
     FROM character_intimate_log WHERE character_id = ?${partnerFilterClause(filter, totalsParams)}`
  ).get(...totalsParams);

  const firstMap = new Map(listFirsts(id).map(f => [f.actKey, f.firstAt]));
  const actParams = [id];
  const byAct = db.prepare(
    `SELECT act_key AS actKey, MAX(custom_label) AS customLabel,
            SUM(act_count) AS count, SUM(climax_count) AS climax
     FROM character_intimate_log WHERE character_id = ?${partnerFilterClause(filter, actParams)}
     GROUP BY act_key ORDER BY count DESC, actKey ASC`
  ).all(...actParams).map(row => ({
    ...row,
    label: actLabel(row.actKey, row.customLabel || ''),
    firstAt: firstMap.get(row.actKey) || null,
  }));

  const positionParams = [id];
  const byPosition = db.prepare(
    `SELECT position_key AS positionKey, SUM(act_count) AS count
     FROM character_intimate_log WHERE character_id = ? AND position_key != ''
       ${partnerFilterClause(filter, positionParams)}
     GROUP BY position_key ORDER BY count DESC, positionKey ASC`
  ).all(...positionParams).map(row => ({
    ...row,
    // position_key 可能是单元素（不在打包词表里），必须过 positionLabel 才拿得到中文名
    label: positionLabel(row.positionKey),
  }));

  const partnerParams = [id];
  const byPartner = db.prepare(
    `SELECT partner_kind AS partnerKind, partner_id AS partnerId, SUM(act_count) AS count
     FROM character_intimate_log WHERE character_id = ?${partnerFilterClause(filter, partnerParams)}
     GROUP BY partner_kind, partner_id ORDER BY count DESC`
  ).all(...partnerParams);

  const sceneParams = [id];
  const byScene = db.prepare(
    `SELECT scene, SUM(act_count) AS count FROM character_intimate_log WHERE character_id = ?${partnerFilterClause(filter, sceneParams)}
     GROUP BY scene ORDER BY count DESC`
  ).all(...sceneParams);

  return {
    totalActs: Number(totals?.totalActs) || 0,
    totalClimax: Number(totals?.totalClimax) || 0,
    actKinds: Number(totals?.actKinds) || 0,
    firstAt: totals?.firstAt || null,
    lastAt: totals?.lastAt || null,
    partnerKinds: filter,
    byAct,
    byPosition,
    byPartner,
    byScene,
  };
}

// ── 历史回填进度 ──

/**
 * 回填进度行（真正扫库的引擎见后续任务，本模块只负责状态读写）。
 * 无行时返回 idle 空状态：面板据此显示"未回填 / 可回填"。
 */
export function getBackfillState(characterId) {
  const id = toId(characterId);
  const empty = { characterId: id, status: 'idle', lastRawId: 0, scanned: 0, inserted: 0, error: '', updatedAt: null };
  if (!id) return empty;
  let row = null;
  try {
    row = getDb().prepare('SELECT * FROM character_intimate_backfill WHERE character_id = ?').get(id);
  } catch {
    row = null; // 表缺失（老库未迁移完）时按未回填处理，不影响看板其余部分
  }
  if (!row) return empty;
  return {
    characterId: id,
    status: str(row.status, 24) || 'idle',
    lastRawId: clampInt(row.last_raw_id, 0, Number.MAX_SAFE_INTEGER, 0),
    scanned: clampInt(row.scanned, 0, Number.MAX_SAFE_INTEGER, 0),
    inserted: clampInt(row.inserted, 0, Number.MAX_SAFE_INTEGER, 0),
    error: str(row.error, MAX_NOTE_LEN),
    updatedAt: row.updated_at || null,
  };
}

/**
 * 写入回填进度（白名单字段，未传保持原值）。status 不做白名单，留给回填引擎扩展状态机。
 */
export function saveBackfillState(characterId, patch = {}) {
  const id = toId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) throw new Error('character not found');
  const current = getBackfillState(id);
  const next = {
    status: patch.status !== undefined ? (str(patch.status, 24) || current.status) : current.status,
    lastRawId: patch.lastRawId !== undefined ? clampInt(patch.lastRawId, 0, Number.MAX_SAFE_INTEGER, current.lastRawId) : current.lastRawId,
    scanned: patch.scanned !== undefined ? clampInt(patch.scanned, 0, Number.MAX_SAFE_INTEGER, current.scanned) : current.scanned,
    inserted: patch.inserted !== undefined ? clampInt(patch.inserted, 0, Number.MAX_SAFE_INTEGER, current.inserted) : current.inserted,
    error: patch.error !== undefined ? str(patch.error, MAX_NOTE_LEN) : current.error,
  };
  db.prepare(
    `INSERT INTO character_intimate_backfill
       (character_id, status, last_raw_id, scanned, inserted, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET
       status = excluded.status, last_raw_id = excluded.last_raw_id, scanned = excluded.scanned,
       inserted = excluded.inserted, error = excluded.error, updated_at = excluded.updated_at`
  ).run(id, next.status, next.lastRawId, next.scanned, next.inserted, next.error, nowIso());
  return getBackfillState(id);
}

/**
 * 面板一次读取：档案 + 里程碑 + 统计 + 计数 + 回填进度（不含流水明细与全局词表）。
 * counts.logs 跟随当前统计口径，allLogs 是未过滤总数，便于面板提示"还有 N 条不在口径内"。
 */
export function getIntimatePanel(characterId, { partnerKinds } = {}) {
  const id = toId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  const filter = resolvePartnerFilter(id, partnerKinds);
  const countParams = [id];
  const logs = Number(db.prepare(
    `SELECT COUNT(*) AS n FROM character_intimate_log WHERE character_id = ?${partnerFilterClause(filter, countParams)}`
  ).get(...countParams)?.n) || 0;
  const allLogs = Number(db.prepare('SELECT COUNT(*) AS n FROM character_intimate_log WHERE character_id = ?').get(id)?.n) || 0;
  return {
    characterId: id,
    profile: getBodyProfile(id),
    firsts: listFirsts(id),
    stats: getIntimateStats(id, { partnerKinds }),
    counts: { logs, allLogs },
    backfill: getBackfillState(id),
  };
}
