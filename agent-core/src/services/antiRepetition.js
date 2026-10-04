/**
 * 反重复 / 反钻牛角尖检测器（专题·车轱辘话与钻牛角尖 · 阶段一 L1-1 + L2）
 *
 * 设计口径（冻结点 2026-09-30）：
 *   - **纯函数**：输入「她最近 N 轮说过的原文 + 情绪快照」，输出要注入的指令块或 null。
 *     不读全局 config、不查库、不调 LLM —— 单测可以直接喂合成样本（见 test/antiRepetition.test.js）。
 *     查库（取最近 N 轮 assistant 原文 / 最近情绪快照）放在本文件的 fetchRecentAssistantTurns，
 *     由 routes/chat.js 用**已经过滤过催眠遗忘窗口**的口径调用。
 *   - 两个检测器：
 *       · detectRepetition —— 车轱辘话：最近几轮两两 bigram 重叠率
 *       · detectTopicLock  —— 钻牛角尖：同一情绪极值连续多轮 + 还在同一个话题上
 *   - 阈值全部导出常量，真机调参不改逻辑（专题 §三「关键实现约束」）。
 *
 * 与催眠的优先级（专题 §五 风险表最后两行）：
 *   催眠「完全控制」轮**就是要重复执行指令**，检测器必须显式跳过 —— 见 opts.hypnosisActive。
 *
 * 与 L4（输出层检测 / 自动升级）的关系（阶段二，2026-09-30 追加）：
 *   阶段一保持**温和**（用户裁决）；阶段二才做升级。升级不是"再来一次 LLM 调用"，而是**下一轮把约束升档**：
 *     · 输出侧检测：给每一轮算「与上一轮的 bigram 重叠率」（overlap），顺带算出末尾连续高重叠的段数；
 *       这个数字**每轮都算**（零成本），无论升级开关开没开 —— 用户/阶段二调参都靠它。
 *     · 自动升级：末尾连续高重叠 ≥ `REPETITION_ESCALATED_PAIRS` 段（默认 3 段 = 最近 4 轮都在打转）
 *       → 下一轮注入 <anti_repetition mode="escalated">（更强的约束）；
 *       重叠率回落 → 自动降档到 strong / mild / none（**保证可回落，不"赶话题"**）。
 *     · 开关关闭（`antiRepetitionEscalation === false`）→ 完全按阶段一的 base 阈值判定，行为与阶段一一致。
 *   重写兜底（再请求一次 LLM 替换输出）**未实现**：需要额外调用 + 替换已流式输出的内容，
 *   本项目的流式协议没有替换语义，属于专题 L4 里"默认关"的那半；见 docs/anti-repetition.md §十。
 */

// ── 阈值常量（真机调参只动这里）──

/** 话题重叠率达到该值算「同一话题在打转」（2×共享 bigram / 两轮 bigram 总数） */
export const REPETITION_HIGH_OVERLAP = 0.6;
/** 强档：连续这么多段「高重叠」才点名话题（3 轮=2 段） */
export const REPETITION_STRONG_CONSECUTIVE = 2;

// ── 阶段二：输出侧检测 + 自动升级 ──

/**
 * 升级阈值：重叠率达到该值才算「这一轮明显是在复述上一轮」（比 base 阈值严）。
 * 与 base 阈值分开是刻意的：0.6 是"同一话题在打转"的提醒线；0.75 是"这句话我基本说过一遍了"的升档线。
 */
export const REPETITION_ESCALATED_OVERLAP = 0.75;
/** 连续这么多段都超过升级阈值才升档（3 段 = 最近 4 轮都在复述）——升级要慢，回落要快 */
export const REPETITION_ESCALATED_PAIRS = 3;
/**
 * 撤档阈值：升级态**没有记忆**（完全由"末尾连续段"推导），因此只要末尾不再有 ≥1 段超升级阈值的
 * 复述，`escalatedRunLength` 立刻归零、本轮就退回 base 档位 —— 这就是"退路"：
 * 升档要连续 3 段（慢），回落只要断 1 段（快），且刻意**不引入**"再观察 N 轮才撤"的粘滞逻辑，
 * 免得把"她已经不重复了，却还在被要求换话题"的赶话题手感做出来。
 * 下面这个常量只用于**日志文案**（说明退路参数），不参与判定。
 */
export const REPETITION_ESCALATION_RELEASE_PAIRS = 1;

// ── D2 · 重写兜底（reroll）──

/**
 * 一轮最多重写几次。**成本上限写死在这里**（每次重写 = 一次真实 LLM 调用）。
 * 用户裁决：只重写一次；重写后仍复读也不再重写（防打爆额度）。
 */
export const REPETITION_REROLL_MAX_ATTEMPTS = 1;

/**
 * 是否要为本轮输出做一次重写（纯判定：不读配置、不发请求、不抛错）。
 *
 * 触发条件（用户裁决 2026-09-30，全部满足才 fire）：
 *   1. 开关打开（`features.antiRepetitionReroll`，**默认关**；关着时第一个判断就返回 disabled）
 *   2. 检测器给了结论，且档位达到**既有**阈值 —— `strong` 或 `escalated`
 *      （复用既有判定，不新造检测器；`mild` 属于阶段一的「温和」，不重写）
 *   3. 本轮还没重写过（`firedCount < REPETITION_REROLL_MAX_ATTEMPTS`）
 *   4. 不是催眠「完全控制」轮（那轮本来就该照指令重复）
 *   5. 客户端还在（断开了就别再白花一次调用）
 *
 * @param {{enabled?:boolean, result?:object|null, firedCount?:number, hypnosisActive?:boolean, clientGone?:boolean}} input
 * @returns {{fire:boolean, reason:string, instruction:string|null, maxAttempts:number}}
 */
export function shouldReroll({ enabled = false, result = null, firedCount = 0, hypnosisActive = false, clientGone = false } = {}) {
  const maxAttempts = REPETITION_REROLL_MAX_ATTEMPTS;
  const deny = (reason) => ({ fire: false, reason, instruction: null, maxAttempts });
  if (enabled !== true) return deny('disabled');                        // 默认关 = 零变化
  if (clientGone) return deny('client_gone');
  if (hypnosisActive) return deny('hypnosis');
  if (Number(firedCount) >= maxAttempts) return deny('already_rerolled');
  if (!result) return deny('no_result');
  const mode = result.mode;
  if (mode !== 'strong' && mode !== 'escalated' && result.escalate !== true) return deny('below_threshold');
  const reason = (mode === 'escalated' || result.escalate === true) ? 'repetition_escalated' : 'repetition_strong';
  return { fire: true, reason, instruction: buildRerollInstruction(result.topicKeywords || []), maxAttempts };
}

/**
 * 重写时追加的指令块（贴在原 user 消息之后）：说清「上一版作废、从头换一种说法」，
 * 避免她顺着上一版继续写（那正是车轱辘话的样子）。
 * @param {string[]} [topicKeywords] 刚复述过的话题词（可为空 → 用兜底措辞）
 */
export function buildRerollInstruction(topicKeywords = []) {
  const topics = (Array.isArray(topicKeywords) ? topicKeywords : []).filter(Boolean).slice(0, MAX_TOPIC_KEYWORDS);
  const named = topics.length > 0 ? topics.join('、') : '刚才那个话题';
  return '<anti_repetition_rewrite>\n'
    + '（系统提示：你上一条回复因为重复复述已被作废。请**重新**写一条完全不同的回复。）\n'
    + '不要再围绕「' + named + '」说同一件事，也不要衔接、延续上面那半句；'
    + '换一个角度、换一件具体的事，或者干脆把话题转向新的方向。字数与语气照旧。\n'
    + '</anti_repetition_rewrite>';
}

/**
 * 替换事件 `replace_last_assistant`（后端 → 前端 SSE）。
 *
 * 契约（前端由 hires-ui 接；字段与语义冻结在 docs/anti-repetition.md §12.4）：
 *   content:     string   —— 所有文本气泡拼起来（前端简单路径：整体替换）
 *   segments:    Array<{content, emojiKeys, stickerUrls, images}>
 *   reason:      'reroll' —— 为什么替换（后续可扩展）
 *   turn:        number   —— 服务端时间戳；前端用它校验"替换的是本轮"，防串轮
 *
 * 分段字段（**定名 2026-09-30，别猜**）：
 *   · `content`     文本（表情标记已剥掉）
 *   · `emojiKeys`   命中的表情 key 数组（可空；供日志/诊断，**前端不能拿它渲染**）
 *   · `stickerUrls` 表情图**真正渲染用的 url**，顺序与 `emojiKeys` 一一对应（前端没有 key→url 映射，
 *                   所以必须由后端下发）；**空数组/缺省 = 这轮没换表情**（前端保持原样，不清空）
 *   · `images`      普通图片 url 数组（既有语义）
 *
 * @param {{parsedSegments?:Array<{content?:string,emojiKeys?:string[],stickerUrls?:string[],images?:string[]}>, reason?:string}} input
 */
export function buildReplaceLastAssistantEvent({ parsedSegments = [], reason = 'reroll' } = {}) {
  const segments = (Array.isArray(parsedSegments) ? parsedSegments : []).map(seg => ({
    content: String(seg?.content || ''),
    emojiKeys: Array.isArray(seg?.emojiKeys) ? seg.emojiKeys : [],
    // 表情 url：优先用调用点显式给的 stickerUrls；没有就用 images（parseEmojiText 的 images 就是命中表情的 url）。
    // 注意 images 为空时 stickerUrls 也是空数组 —— 语义是"没换表情"，前端保持原样（不会清空）。
    stickerUrls: Array.isArray(seg?.stickerUrls) ? seg.stickerUrls : (Array.isArray(seg?.images) ? seg.images : []),
    images: Array.isArray(seg?.images) ? seg.images : [],
  }));
  return {
    event: 'replace_last_assistant',
    data: {
      content: segments.map(seg => seg.content).filter(Boolean).join('\n\n'),
      segments,
      reason: String(reason || 'reroll'),
      turn: Date.now(),
    },
  };
}
/** 温和档：至少要看几轮原文才有资格提示 */
export const REPETITION_MIN_TURNS = 2;
/** 单轮最长参与比较的字符数（超长轮次只取尾部，避免用一大段吃掉重叠率分母） */
export const MAX_TURN_CHARS = 240;
/** 关键词（话题词）最短长度 */
export const MIN_TOPIC_KEYWORD_LENGTH = 2;
/** 进指令块的话题词最多几个（多了会变成噪声） */
export const MAX_TOPIC_KEYWORDS = 3;

/** 情绪极值判定：V 或 A 达到该阈值（专题 §三：V/A 超 0.8 / 低 0.2） */
export const EMOTION_EXTREME_HIGH = 0.8;
export const EMOTION_EXTREME_LOW = 0.2;
/**
 * **遗留常量（仅 `isEmotionExtremeHeld` 这个"历史型"辅助函数在用，钻牛角尖已不再需要它）**。
 * 保留原因：外部可能有调用方/测试引用；且它清楚地标出"这个数字在真实存储里拿不到"——
 * 真实 `emotion_snapshots` 每会话只有一行（task-23 / P0-1 的根因），别再拿它当检测门槛。
 */
export const TOPIC_LOCK_MIN_EXTREME_TURNS = 4;
/**
 * **钻牛角尖真正的持续时间门槛**：文本侧（最近几轮原文）至少这么多轮仍在同一话题。
 * 语义 = 专题 §三「同一话题连续 ≥4 轮」——用轮数（而非快照条数）表达，因为在真实存储里
 * 只有原文历史是可得的。`window = 最近 TOPIC_LOCK_MIN_TOPIC_TURNS 轮` 且全部落在同一话题才注入。
 */
export const TOPIC_LOCK_MIN_TOPIC_TURNS = 4;
/**
 * **纯文本模式**的话题锁门槛（群聊侧，2026-09-30 / task-27 方案 B）。
 *
 * 群聊会话（`group_<gid>`）**没有任何情绪快照写入点**（`saveEmotionSnapshot` 的调用点全在 `char_<id>`），
 * 所以群聊不能做情绪判定 —— 这条门槛只数"最近几轮原文是否还在同一话题"，取 **6**：
 * 比私聊的 4 更保守，因为没有情绪佐证（"说话打转"≠"钻牛角尖"）。
 */
export const TOPIC_LOCK_MIN_TEXT_ONLY_TURNS = 6;
/** 逐轮 VAD 读数相减的最大跨度（历史型 `isEmotionExtremeHeld` 用；单行判定不需要） */
export const EMOTION_EXTREME_MAX_STEP = 0.2;

/**
 * 分词停用词：单字填充词与高频功能词。
 * 这些词在任何一轮里都出现，留在重叠率里会把「不同话题」也拉高，必须剔除。
 */
export const STOP_WORDS = Object.freeze([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '就', '都', '也',
  '不', '没', '很', '还', '又', '再', '吗', '呢', '吧', '啊', '呀', '哦', '噢', '嗯', '唉',
  '哈', '嘿', '喂', '嘛', '啦', '咯', '喔', '呜', '诶', '欸', '哎', '呃',
  '这', '那', '哪', '谁', '什么', '怎么', '为什么', '一个', '一下', '一点', '一些', '这样', '那样',
  '而已', '其实', '真的', '好像', '觉得', '知道', '可以', '应该', '所以', '但是', '然后', '因为',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'is', 'are', 'was', 'were', 'it', 'this', 'that',
]);

/**
 * 话题指纹排除词表（专题 §五：程序时间/日程话题会被误判钻牛角尖）。
 * 注意：这里的词**只在「话题锁死」检测里被排除**，不参与车轱辘话的重叠率计算 ——
 * 她连着几轮都在说日程，那也确实是在打转，L2 应该提示。
 */
export const TIME_SCHEDULE_WORDS = Object.freeze([
  '今天', '明天', '昨天', '后天', '前天', '早上', '上午', '中午', '下午', '晚上', '凌晨', '半夜',
  '时间', '小时', '分钟', '点', '点钟', '日子', '每天', '周一', '周二', '周三', '周四', '周五',
  '周六', '周日', '周末', '月', '号', '年', '日程', '安排', '计划', '睡不着', '睡觉', '起床',
  '醒了', '睡了', '白天', '夜里', '现在', '刚刚', '刚才', '待会', '一会儿', '等会儿',
]);

/**
 * 干净文本：去掉生图 JSON（`{"prompt":"..."}` 是系统附加在消息末尾的，不是她说的话）、
 * 各类引号/括号/标点/空白，只留下真正承载内容的字符。
 * 中文不做分词器依赖（项目里 queryTokens 走的是检索侧口径，这里刻意不耦合）。
 */
export function cleanTurnText(text) {
  if (text == null) return '';
  let s = String(text);
  // 生图 prompt JSON 连内容一起去掉；随后再兜一刀裸 "prompt" 字段
  s = s.replace(/\{\s*"prompt"\s*:[\s\S]*$/i, '');
  s = s.replace(/\{[^{}]*"prompt"\s*:[^{}]*\}/gi, '');
  s = s.replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
  // 标点/空白直接**删掉**会让相邻句子粘成一个长 run，于是公共子串会跨越句界把两句不相干的话
  // 连成一个「话题词」（如「睡觉‖我」）。统一换成 \u0001 当分隔符，公共子串就不会跨句。
  s = s.replace(/[^0-9A-Za-z_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g, '\u0001');
  return s;
}

/**
 * 子句边界：句界分隔符、换行，以及中文语气词/助词/标点。
 * 话题词提取要按这些边界切，否则公共子串会以「吧」「呢」「了」这种尾字开头
 * （真机形状：「…早点睡觉吧」重复 → 切出「是早点睡觉吧」，看了不知道指的是什么）。
 */
const CLAUSE_SPLIT_RE = /[\u0001\n\r，。！？；：、,.!?;:…—～~\s]+|[吧呢啊呀哦噢嘛啦咯喔呜诶欸哎呃]+/;

/** cleanTurnText + 抹掉句界分隔符：剥离生图 JSON、标点、空白后只留内容字符 */
export function cleanTurnTextFlat(text) {
  return cleanTurnText(text).replace(/\u0001/g, '');
}

/** 取尾窗：超长轮次只保留末尾（车轱辘话通常表现为「结尾又绕回同一个说法」） */
function tailWindow(text, maxChars = MAX_TURN_CHARS) {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** 一轮原文 → 字符 bigram 集合（已清洗 + 截尾窗） */
export function bigramsOf(text) {
  const s = tailWindow(cleanTurnText(text));
  const set = new Set();
  if (s.length === 1) {
    set.add(s);
    return set;
  }
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 两轮原文的 bigram 重叠率（Dice 系数）：2×|交集| / (|A|+|B|)，0~1。
 * 任一为空 → 0（无从判断，不注入）。
 */
export function bigramOverlapRate(a, b) {
  const setA = bigramsOf(a);
  const setB = bigramsOf(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const g of small) if (large.has(g)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

/**
 * 相邻轮逐段重叠率（oldest → newest 顺序求和，长度为 turns.length - 1）。
 * @returns {number[]}
 */
export function consecutiveOverlaps(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const rates = [];
  for (let i = 1; i < list.length; i++) rates.push(bigramOverlapRate(list[i - 1], list[i]));
  return rates;
}

/**
 * 话题词提取：找**她连着几轮都在重复的那段话**（跨轮最长公共子串），再从中挑话题词。
 *
 * 为什么不用「2 字滑窗统计词频」：中文没有分词器时，滑窗会造出大量跨词边界的噪声碎片
 * （「现在已经很晚了…」→ 「在已」「经很」），词频再高也不是话题。公共子串天然只保留
 * 「她真的重复说过」的连续片段（真机形状：「我真的很担心你这件事情」连着说三遍）。
 *
 * @param {string[]} turns - 参与比较的轮次原文（建议 3~4 轮，时间升序）
 * @param {{excludeWords?: string[], max?: number, minLength?: number}} [opts]
 *        excludeWords 用**包含**匹配（碎片如「明天早上」「天早」都要被时间/日程词拦住）
 * @returns {string[]} 话题词（长的优先，最多 opts.max 个）
 */
export function extractTopicKeywords(turns, { excludeWords = [], max = MAX_TOPIC_KEYWORDS, minLength = MIN_TOPIC_KEYWORD_LENGTH } = {}) {
  // 这里**保留** cleanTurnText 的句界分隔符：先按整段找公共子串，再把碎片切到 ≤6 字。
  // 若直接用扁平文本，整句重复会产出二十几字的「话题词」，点名等于把整句话塞进 prompt。
  const texts = (Array.isArray(turns) ? turns : [turns]).map(cleanTurnText)
    .filter(text => text.replace(/\u0001/g, '').length > 0);
  if (texts.length < 2) return [];    // 话题是「跨轮」概念，单轮没有可比对象
  const excludedList = excludeWords.map(cleanTurnTextFlat).filter(Boolean);
  const strip = cleanTurnTextFlat;    // 兜底：分隔符只是内部标记，不进最终文案

  // 候选 = 相邻轮的公共子串（相邻轮已经在打转，公共片段就是「同一话题」）；
  // 同一对文本里按位置取互不重叠的最长片段，避免整句话被切成好几段同名话题。
  const candidates = new Map(); // 候选词 → { count, len }
  for (let i = 1; i < texts.length; i++) {
    for (const rawSub of topCommonSubstrings(texts[i - 1], texts[i], minLength)) {
      // 长公共串只取「最后一个句内片段」当话题词（碎片过长就退到尾部 2~6 字）
      const rawFlat = String(rawSub || '').split(CLAUSE_SPLIT_RE).map(s => s.replace(/\u0001/g, ''))
        .sort((a, b) => b.length - a.length)[0] || '';
      const trimmed = trimFunctionEdges(rawFlat);
      const full = trimmed.length >= minLength ? trimmed : rawFlat;
      for (const word of keywordFragments(rawSub)) {
        const prev = candidates.get(word);
        if (prev) prev.count++;
        else candidates.set(word, { count: 1, len: word.length, full });
      }
    }
  }
  if (candidates.size === 0) return [];   // 没有跨轮重复片段 → 没有「话题」可点名

  // 完整的公共串（未截短）参与去重：截短只是为了给人看，包含关系要按完整片段判断
  const ranked = [...candidates.entries()]
    .filter(([word]) => !STOP_WORDS.includes(word))
    .filter(([word]) => !isExcludedWord(word, excludedList))
    .sort((a, b) => (b[1].full.length - a[1].full.length) || (b[1].count - a[1].count) || (b[1].len - a[1].len));

  const out = [];
  for (const [word, meta] of ranked) {
    // 完整片段已被选中的词包含 → 这词没有新信息（如整句里的「担心」），跳过
    if (out.some(kept => kept.includes(meta.full))) continue;
    // 与已选词互相包含 → 保留信息量更大的那个
    if (out.some(kept => kept.includes(word) || word.includes(kept))) continue;
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 话题词切分：把一段公共子串切成「句内 ≤6 字的尾片段」。
 * 例：「…早点睡觉吧‖（标记）」→ 尾部 6 字以内；长句只在末尾取词，避免把整段话当话题词。
 */
function keywordFragments(rawSub, maxChars = 18) {
  const out = [];
  for (const part of String(rawSub || '').split(CLAUSE_SPLIT_RE)) {
    let flat = part.replace(/\u0001/g, '');
    // 掐掉首尾的功能词碎片：「是早点睡觉吧」这种以「是」开头的片段不是话题词
    flat = trimFunctionEdges(flat);
    if (flat.length < MIN_TOPIC_KEYWORD_LENGTH) continue;
    out.push(flat.length > maxChars ? flat.slice(-maxChars) : flat);
  }
  return out;
}

/** 片段首尾功能词（只在首尾剔除，词中间的「的」不动） */
const EDGE_FUNCTION_CHARS = new Set('的是了在有和就都也还不没很又再吗呢吧啊呀哦嗯唉哈嘿喂嘛啦咯喔呜诶欸哎呃这将把被给让对跟向从到与及而且所以但是因为如果然后其实真的好像觉得知道可以应该一个一下一点一些什么怎么为什么这样那样你我他她它们'.split(''));

function trimFunctionEdges(text) {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE_FUNCTION_CHARS.has(text[start])) start++;
  while (end > start && EDGE_FUNCTION_CHARS.has(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * 是否为要排除的词。
 * 用「包含」而不是「相等」：清洗后每个汉字会连成一整条 run（如「明天早上的安排」），
 * 切出来的候选词（「明天早上」「天早」「上的」）永远不等于词表条目，
 * 只有包含关系才能把程序时间/日程类碎片挡住（专题 §五 的误判风险条）。
 */
function isExcludedWord(word, excludedList) {
  return excludedList.some(bad => bad && (word === bad || word.includes(bad)));
}

/**
 * 两个字符串的**最长公共连续子串**（逐个起点取值，含 O(n×m) 动态规划）。
 * 目标文本是聊天记录（几十~几百字），这个复杂度完全够用，不引入分词依赖。
 * `\u0001` 是 cleanTurnText 插入的句界分隔符：跨分隔符的匹配一律不算（否则会把
 * 不相干的两句话粘成一个「话题词」）。
 *
 * @returns {Array<{start:number,end:number,text:string}>} end 为开区间，text 已去掉分隔符
 */
export function longestCommonSubstrings(a, b, minLength = MIN_TOPIC_KEYWORD_LENGTH) {
  if (!a || !b) return [];
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  const found = [];
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (curr[j] < minLength) continue;
      // 只在「匹配不再向右延伸」时记录一次：否则同一段会被每个 i 重复记录
      const continues = (i < n && j < m && a[i] === b[j]);
      if (continues) continue;
      const start = i - curr[j];
      const raw = a.slice(start, i);
      // 掐掉分隔符：只保留其中最长的那个合法片段，长度重新算
      const best = raw.split('\u0001')
        .filter(fragment => fragment.length >= minLength)
        .sort((x, y) => y.length - x.length)[0];
      if (best) found.push({ start, end: i, text: best });
    }
    const tmp = prev; prev = curr; curr = tmp;
    curr.fill(0);
  }
  return found;
}

/**
 * 同一对文本里的公共子串，按「长 → 短」取互不重叠的前几段。
 * 目的：整句重复时不要把同一句话切成三段当成三个话题词。
 */
export function topCommonSubstrings(a, b, minLength = MIN_TOPIC_KEYWORD_LENGTH, limit = 2) {
  const sorted = longestCommonSubstrings(a, b, minLength)
    .sort((x, y) => (y.text.length - x.text.length) || ((y.end - y.start) - (x.end - x.start)));
  const picked = [];
  for (const item of sorted) {
    if (picked.some(p => item.start < p.end && p.start < item.end)) continue;   // 与已选片段重叠 → 跳过
    if (picked.some(p => p.text.includes(item.text) || item.text.includes(p.text))) continue;
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked.map(item => item.text);
}

/** 单个 VAD 读数是否落在极值区间（V/A 都是这样判："超 0.8 / 低 0.2"） */
export function isExtremeVad(value, { high = EMOTION_EXTREME_HIGH, low = EMOTION_EXTREME_LOW } = {}) {
  const v = Number(value);
  return Number.isFinite(v) && (v >= high || v <= low);
}

/**
 * 单个情绪快照是否处于极值。
 * 这是「钻牛角尖」检测**真正在用**的判定：`emotion_snapshots` 表每会话只保留最新一行
 * （`db/index.js:154` UNIQUE + `migrateEmotionSnapshotsUnique` + `INSERT OR REPLACE`），
 * 所以拿到的这一行 = 当前情绪；**持续性由文本侧（话题重叠）证明，不靠历史快照**。
 *
 * @param {{valence?:number,arousal?:number}} snapshot 一行快照（通常是合成后的当前 V/A）
 */
export function isCurrentEmotionExtreme(snapshot, opts = {}) {
  if (!snapshot) return false;
  return isExtremeVad(snapshot.valence, opts) || isExtremeVad(snapshot.arousal, opts);
}

/**
 * 情绪快照序列是否「一直贴着同一个极值」——**历史型**判定，只在调用方确实能拿到多行时才有意义。
 *
 * ⚠️ 2026-09-30 教训（task-23 / P0-1）：真实存储里 `emotion_snapshots` 每会话只有一行，
 * 于是这个"连续 N 行都极值"的判据永远不成立 ⇒ `<topic_progress>` 从未注入过。
 * 现在**钻牛角尖改走 `isCurrentEmotionExtreme`（当前一行）× 文本侧话题锁**；
 * 本函数保留给"确实拿得到历史"的调用方/测试，并按实际行数自适应（不足 minTurns 时用现有行），
 * 且它对单行极值同样返回 true —— 避免下一个人再写出"需要 4 行才成立"的死条件。
 *
 * @param {Array<{valence?:number,arousal?:number}>} snapshots 时间升序（最新在末尾）
 */
export function isEmotionExtremeHeld(snapshots, {
  minTurns = TOPIC_LOCK_MIN_EXTREME_TURNS,
  high = EMOTION_EXTREME_HIGH,
  low = EMOTION_EXTREME_LOW,
  maxStep = EMOTION_EXTREME_MAX_STEP,
} = {}) {
  const rows = (Array.isArray(snapshots) ? snapshots : [])
    .map(s => ({
      valence: Number(s?.valence),
      arousal: Number(s?.arousal),
    }))
    .filter(s => Number.isFinite(s.valence) || Number.isFinite(s.arousal));
  if (rows.length === 0) return false;

  // 自适应窗口：给多少行就看多少行（真实路径只给 1 行，也必须能成立）
  const recent = rows.slice(-Math.max(1, minTurns));
  const isExtreme = v => isExtremeVad(v, { high, low });
  const axisHeld = key => recent.every(r => isExtreme(r[key]))
    && recent.every((r, i) => i === 0 || Math.abs(r[key] - recent[i - 1][key]) <= maxStep);
  return axisHeld('valence') || axisHeld('arousal');
}

/** 检测结果里同时带上供日志/测试使用的数字 */
function makeResult(mode, { overlaps, topicKeywords, lockedTopic, skipped, reason }) {
  return {
    mode,                                   // 'escalated' | 'strong' | 'mild' | 'none'
    block: null,                            // 由调用方按 mode 取 anti_repetition / topic_progress 块
    topicLock: false,
    topicProgressBlock: null,
    overlaps,
    maxOverlap: overlaps.length > 0 ? Math.max(...overlaps) : 0,
    topicKeywords,
    lockedTopic: lockedTopic || null,
    skipped: skipped || null,               // 'hypnosis' 等
    reason: reason || '',
    // 阶段二：输出侧检测数字与升级状态
    escalate: false,                        // 本轮是否处于升级态（= 注入的是 escalated 块）
    trend: 'normal',                        // 'normal' | 'trending' | 'escalating'
    runLength: 0,                           // 末尾连续高重叠的段数（base 阈值）
    escalatedRunLength: 0,                  // 末尾连续超过升级阈值的段数
    escalated: false,                       // 与 escalate 同义（chat.js 的 wiring 用这个名字）
    maxEscalatedOverlap: 0,
  };
}

/**
 * 阶段二主检测：输出侧重叠率 + 自动升级 / 自动回落。
 *
 * @param {string[]} recentAssistantTurns 她最近几轮说过的话（时间升序，最新在末尾）
 * @param {{escalationEnabled?:boolean}} [opts] escalationEnabled=false → 完全按阶段一 base 阈值（行为与阶段一一致）
 * @returns {object} 与 detectRepetition 同形状 + { mode:'escalated', blockReady:true, trend, runLength, ... }
 */
export function detectRepetitionWithEscalation(recentAssistantTurns, { escalationEnabled = true } = {}) {
  const result = detectRepetition(recentAssistantTurns);
  const texts = (Array.isArray(recentAssistantTurns) ? recentAssistantTurns : [])
    .filter(t => cleanTurnTextFlat(t).length > 0);
  const escalatedFlags = result.overlaps.map(r => r >= REPETITION_ESCALATED_OVERLAP);

  // 末尾连续超升级阈值的段数（从尾巴往前数，遇低即停 → 回落自然发生）
  let escalatedRunLength = 0;
  for (let i = escalatedFlags.length - 1; i >= 0 && escalatedFlags[i]; i--) escalatedRunLength++;

  let runLength = 0;
  for (let i = result.overlaps.length - 1; i >= 0 && result.overlaps[i] >= REPETITION_HIGH_OVERLAP; i--) runLength++;

  const maxEscalatedOverlap = escalatedFlags.some(Boolean) ? Math.max(...result.overlaps) : 0;
  const canEscalate = escalationEnabled
    && escalatedRunLength >= REPETITION_ESCALATED_PAIRS
    && texts.length >= REPETITION_ESCALATED_PAIRS + 1;
  // trend 只在升级开关打开时才有意义：关掉 = 没有"在升档路上"这回事，恒为 normal。
  // trending 的口径是"窗口里已经出现过 ≥1 段超升级阈值的复述"（哪怕没连起来）——
  // 它是给真机调参看的早期信号，与"能不能升档"（要连续 3 段）是两件事。
  const trend = !escalationEnabled
    ? 'normal'
    : (canEscalate ? 'escalating' : (escalatedFlags.some(Boolean) ? 'trending' : 'normal'));

  // 升档：连续高复述 → escalated（比 strong 更硬，但仍然是"下一轮"的约束）
  // 回落：末尾不再是高复述 → 按 base 档位（strong / mild / none），退路比升档快一档
  if (!canEscalate) {
    return {
      ...result,
      escalate: false,
      escalated: false,
      trend,
      runLength,
      escalatedRunLength,
      maxEscalatedOverlap,
    };
  }

  const need = REPETITION_ESCALATED_PAIRS + 1;
  const rawKeywords = extractTopicKeywords(texts.slice(-need));
  const topicKeywords = rawKeywords.filter(word => !isExcludedWord(word, TIME_SCHEDULE_WORDS));
  const escalated = makeResult('escalated', {
    overlaps: result.overlaps,
    topicKeywords,
    skipped: null,
    reason: `escalated_run=${escalatedRunLength}/release_after=${REPETITION_ESCALATION_RELEASE_PAIRS}`
      + (topicKeywords.length === 0 ? '/keywords_time_schedule_only' : ''),
  });
  return {
    ...escalated,
    escalate: true,
    escalated: true,
    trend: 'escalating',
    runLength,
    escalatedRunLength,
    maxEscalatedOverlap,
  };
}

/** 车轱辘话检测：最近几轮两两 bigram 重叠率 → strong / mild / none */
export function detectRepetition(recentAssistantTurns) {
  const texts = (Array.isArray(recentAssistantTurns) ? recentAssistantTurns : [])
    .filter(t => cleanTurnTextFlat(t).length > 0);
  const overlaps = consecutiveOverlaps(texts);
  const highFlags = overlaps.map(r => r >= REPETITION_HIGH_OVERLAP);

  if (texts.length < REPETITION_MIN_TURNS || highFlags.length === 0) {
    return makeResult('none', { overlaps, topicKeywords: [], skipped: null, reason: texts.length < REPETITION_MIN_TURNS ? 'not_enough_turns' : 'no_pairs' });
  }

  // 强档：末尾连续两段都高重叠（= 最近 3 轮都在同一个话题上）
  let consecutiveHigh = 0;
  for (let i = highFlags.length - 1; i >= 0 && highFlags[i]; i--) consecutiveHigh++;

  if (consecutiveHigh >= REPETITION_STRONG_CONSECUTIVE) {
    // 取末尾「连续高重叠段 + 1」轮做话题词提取（跨轮公共子串至少需要两轮，多给一轮更稳）。
    // 强档仍按程序时间/日程词收一次口：连续几轮都在复述日程，点名「明天早上还要早起」比
    // 「刚才那个话题」更没用（牌面档位仍然照记，调参数据不受影响）。
    const rawKeywords = extractTopicKeywords(texts.slice(-Math.max(2, consecutiveHigh + 1)));
    const topicKeywords = rawKeywords.filter(word => !isExcludedWord(word, TIME_SCHEDULE_WORDS));
    return makeResult('strong', { overlaps, topicKeywords, skipped: null, reason: `consecutive_high=${consecutiveHigh}${topicKeywords.length === 0 ? '/keywords_time_schedule_only' : ''}` });
  }

  // 温和档：本段高重叠，或前一段也高（最近 3 轮里任意相邻两段打转）
  // 注意：2 轮高重叠 → highFlags 只有 1 段 → 落这里（温和档）；3 轮全高 → 上面已判强档。
  const lastHigh = highFlags[highFlags.length - 1] === true;
  const prevHigh = highFlags.length >= 2 && highFlags[highFlags.length - 2] === true;
  if (lastHigh || prevHigh) {
    // 温和档不点名话题：只有两轮证据时公共子串太容易是「同一句话」，点名反而误伤
    return makeResult('mild', { overlaps, topicKeywords: [], skipped: null, reason: lastHigh ? 'last_pair_high' : 'previous_pair_high' });
  }

  return makeResult('none', { overlaps, topicKeywords: [], skipped: null, reason: 'overlap_below_threshold' });
}

/**
 * 钻牛角尖检测：**当前情绪处于极值** × **文本侧证明话题已锁死多轮**（方案 A，2026-09-30）。
 *
 * 为什么不是"连续 N 条快照都是极值"：`emotion_snapshots` 每会话只保留最新一行（见
 * `isCurrentEmotionExtreme` 的注释），历史型判据在真实存储里**永远不成立**。
 * 现在拆成两半，各自都能在当前存储里拿到证据：
 *   1. **极值** ← 当前这一次情绪快照（单行即可判定）；
 *   2. **持续性** ← 她最近几轮原文的话题重叠（`consecutiveOverlaps`），窗口内 ≥
 *      `TOPIC_LOCK_MIN_TOPIC_TURNS` 轮仍在同一话题即算"锁死"。
 *
 * **两种模式**（同一套文本判定，不复制逻辑）：
 *   · 默认（私聊）：`当前情绪极值 × 文本 ≥ TOPIC_LOCK_MIN_TOPIC_TURNS(4) 轮` —— 语义逐字节不变；
 *   · `textOnly`（群聊）：**不做情绪判定**（群会话根本没有快照行，见 TOPIC_LOCK_MIN_TEXT_ONLY_TURNS），
 *     只要求 `文本 ≥ 6 轮`，reason 前缀 `text_only` 以便日志区分两类触发。
 *
 * @param {boolean} [opts.textOnly] 纯文本模式（群聊）
 * @param {boolean} [opts.allowEscalated] 只在"处于升级档"时为 true：此时返回的 locked 仅作记录，
 *        注入由升级块负责（两者不同时注入，见 buildAntiRepetitionInjection）
 */
export function detectTopicLock({ recentAssistantTurns = [], emotionSnapshots = [], allowEscalated = false, textOnly = false } = {}) {
  const texts = (Array.isArray(recentAssistantTurns) ? recentAssistantTurns : [])
    .filter(t => cleanTurnTextFlat(t).length > 0);
  const need = textOnly ? TOPIC_LOCK_MIN_TEXT_ONLY_TURNS : TOPIC_LOCK_MIN_TOPIC_TURNS;
  const suffix = (extra = '') => `${textOnly ? 'text_only' : 'current_extreme'}${extra}${allowEscalated ? '/escalated_owns_injection' : ''}`;

  if (!textOnly) {
    // 快照与轮次按"最新对齐"：真实存储只给 1 行（= 当前情绪），这里取最后一行即可
    const snapshots = Array.isArray(emotionSnapshots) ? emotionSnapshots : [];
    const current = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    if (!isCurrentEmotionExtreme(current)) {
      return { locked: false, topicKeywords: [], reason: 'current_emotion_not_extreme', durationTurns: 0, mode: 'private' };
    }
  }

  // 持续时间只能由文本侧证明：窗口 = 最近 need 轮
  const window = texts.slice(-need);
  if (window.length < need) {
    return { locked: false, topicKeywords: [], reason: `${suffix()}(not_enough_turns=${window.length}/need=${need})`, durationTurns: window.length, mode: textOnly ? 'text_only' : 'private' };
  }
  const overlaps = consecutiveOverlaps(window);
  const highTurns = overlaps.filter(r => r >= REPETITION_HIGH_OVERLAP).length + 1;
  if (highTurns < need) {
    return { locked: false, topicKeywords: [], reason: `${suffix()}(topic_changed=${highTurns}/need=${need})`, durationTurns: highTurns, mode: textOnly ? 'text_only' : 'private' };
  }

  const topicKeywords = extractTopicKeywords(window, { excludeWords: TIME_SCHEDULE_WORDS, max: MAX_TOPIC_KEYWORDS });
  if (topicKeywords.length === 0) {
    return { locked: false, topicKeywords: [], reason: `${suffix()}(no_topic_keyword)`, durationTurns: highTurns, mode: textOnly ? 'text_only' : 'private' };
  }
  return {
    locked: true,
    topicKeywords,
    durationTurns: highTurns,
    mode: textOnly ? 'text_only' : 'private',
    reason: `${suffix()}(duration_turns=${highTurns}/need=${need})`,
  };
}

// ── 注入块文案（口径只在 buildXxx 里改，调用点不拼字符串）──

const TOPIC_PROGRESS_BLOCK =
  '<topic_progress>\n'
  + '你已经在同一件事上停留了好几轮。像真人一样打断一下自己：被别的事情分心、临时改变主意、'
  + '或者做一个小决定推动生活往前走——把话题带到新的方向，不要继续围着同一件事打转。\n'
  + '</topic_progress>';

export function buildTopicProgressBlock() {
  return TOPIC_PROGRESS_BLOCK;
}

/**
 * `<anti_repetition mode="...">`
 * @param {'strong'|'mild'|'escalated'} mode
 * @param {string[]} topicKeywords
 */
export function buildAntiRepetitionBlock(mode, topicKeywords = []) {
  if (mode !== 'strong' && mode !== 'mild' && mode !== 'escalated') return null;
  const topics = topicKeywords.filter(Boolean).slice(0, MAX_TOPIC_KEYWORDS);
  // 阶段二升级档：比 strong 更硬（明确要求换话题）+ 说明"这是升级档"，让模型知道前几轮没走出循环
  if (mode === 'escalated') {
    const named = topics.length > 0 ? topics.join('、') : '刚才那个话题';
    return '<anti_repetition mode="escalated">\n'
      + `升级约束：你已经连续多轮在复述「${named}」，再这样下去对话会卡死。\n`
      + '这一轮必须**换话题或推进一件新的事**：给出一件具体的、之前没提过的信息，或者把注意力转向别的对象。'
      + `不要解释自己为什么重复，也不要再提「${named}」。\n`
      + '</anti_repetition>';
  }
  if (mode === 'strong') {
    const named = topics.length > 0 ? topics.join('、') : '刚才那个话题';
    return '<anti_repetition mode="strong">\n'
      + `你最近几轮都在围绕「${named}」打转：同样的观点、同样的安慰、只是换了措辞。\n`
      + '这一轮必须往前走——换一个角度、引入新的信息、推进一件具体的事，或者干脆转到别的话题。'
      + `不要再提「${named}」，也不要用近义说法把它再说一遍。\n`
      + '</anti_repetition>';
  }
  return '<anti_repetition mode="mild">\n'
    + '你最近两轮的说话方式和表达有些重复了。这一轮换一种说法或换一个角度，'
    + '别把刚说过的话再讲一遍。\n'
    + '</anti_repetition>';
}

/**
 * 主入口：算出本轮要注入的反重复 / 反钻牛角尖块。
 *
 * @param {object} input
 * @param {string[]} [input.recentAssistantTurns] 她最近几轮的回复原文，**时间升序（最新在末尾）**
 * @param {Array<{valence:number,arousal:number}>} [input.emotionSnapshots] 最近情绪快照，
 *        时间升序（最新在末尾），每轮回复一条；长度不足时只按已有的轮次判断
 * @param {boolean} [input.hypnosisActive] 本轮是否处于催眠「完全控制」态（true → 强制跳过注入）
 * @param {boolean} [input.escalationEnabled] 阶段二自动升级开关；false → 完全按阶段一 base 阈值判定
 * @param {boolean} [input.textOnlyTopicLock] 群聊纯文本模式（不做情绪判定，话题锁需 ≥6 轮）；默认 false = 私聊口径
 * @returns {{ mode:string, block:string|null, topicProgressBlock:string|null, topicKeywords:string[],
 *             overlaps:number[], maxOverlap:number, lockedTopic:string|null, skipped:string|null, reason:string,
 *             escalate:boolean, trend:string, runLength:number, escalatedRunLength:number,
 *             maxEscalatedOverlap:number, topicLock:boolean,
 *             topicLockSource:'text_only'|'private'|null }} topicLockSource 区分两条触发路径
 *             （群聊纯文本 / 私聊当前极值），与 reason 里的 `text_only` / `current_extreme` 标签一致
 */
export function buildAntiRepetitionInjection({
  recentAssistantTurns = [],
  emotionSnapshots = [],
  hypnosisActive = false,
  escalationEnabled = true,
  // 群聊侧（task-27 / 方案 B）：群会话没有情绪快照，<topic_progress> 走纯文本 ≥6 轮；
  // 默认 false = 私聊口径（当前极值 × 文本 ≥4 轮），逐字节不变。
  textOnlyTopicLock = false,
} = {}) {
  // 阶段二：检测 + 自动升级（escalationEnabled=false 时等价于阶段一的 detectRepetition）
  const repetition = detectRepetitionWithEscalation(recentAssistantTurns, { escalationEnabled });

  // 催眠完全控制轮：她就是要照指令重复执行，反重复块会直接打架 —— 显式跳过（专题 §五）
  if (hypnosisActive) {
    repetition.skipped = 'hypnosis';
    repetition.block = null;
    repetition.topicProgressBlock = null;
    repetition.topicLock = false;
    repetition.escalate = false;
    repetition.trend = 'normal';
    repetition.reason = 'hypnosis_full_control';
    return repetition;
  }

  const lock = detectTopicLock({
    recentAssistantTurns,
    emotionSnapshots,
    allowEscalated: repetition.escalate === true,
    textOnly: textOnlyTopicLock,
  });
  let topicProgressBlock = null;
  if (repetition.escalate) {
    // 升级档优先：比 <topic_progress> 更硬，两者不同时注入（同一轮只给一条最强约束）
    repetition.block = buildAntiRepetitionBlock('escalated', repetition.topicKeywords);
    repetition.topicProgressBlock = null;
    repetition.topicLock = lock.locked;              // 记录，但不注入
    repetition.lockedTopic = lock.locked ? lock.topicKeywords[0] : null;
    repetition.topicLockSource = lock.locked ? lock.mode : null;
    return repetition;
  }
  if (lock.locked) {
    topicProgressBlock = buildTopicProgressBlock();
  } else if (repetition.mode !== 'none') {
    repetition.block = buildAntiRepetitionBlock(repetition.mode, repetition.topicKeywords);
  }

  repetition.topicLock = lock.locked;
  repetition.lockedTopic = lock.locked ? lock.topicKeywords[0] : null;
  repetition.topicProgressBlock = topicProgressBlock;
  // 群聊/私聊两条触发路径必须在日志里可区分（task-27 要求）：reason 同时带
  //   · 车轱辘话那一侧的判定（如 consecutive_high=5）
  //   · 话题锁那一侧的来源（text_only = 群聊纯文本 / current_extreme = 私聊当前极值）
  repetition.topicLockSource = lock.locked ? lock.mode : null;
  // lock.reason 自带来源前缀（current_extreme(...) / text_only(...)），拼接时不能再补一个 tag。
  // 2026-09-30 独立验证者报的瑕疵：以前补了 tag，日志出现重复的 current_extreme current_extreme(...)；
  // 判定与注入块都不受影响（只是日志脏），旧测试只做 includes 所以没红。
  if (lock.reason && (lock.locked || textOnlyTopicLock)) {
    repetition.reason = repetition.reason
      ? `${repetition.reason} + ${lock.reason}`
      : lock.reason;
  }
  return repetition;
}

// ── L1-1：近端自身输出标注（静态块，零额外 LLM 调用）──

/**
 * `<recent_self_output_note>`：紧跟在活跃聊天历史之后，提醒模型「上面那些是你自己说过的话」。
 * 文案固定（不随轮次变化），因此对缓存前缀的影响只在用户消息尾部这一块。
 */
export function buildRecentSelfOutputNote() {
  return '<recent_self_output_note>\n'
    + '上面是你最近说过的话。注意：不要重复其中已表达过的观点、安慰或句式；'
    + '如果对方没有开启新话题，你应该自然推进或转移话题，而不是换个说法再说一遍。\n'
    + '</recent_self_output_note>';
}

/** L1-1 的块只在「真的有她自己说过的话」时注入（首轮/只有用户消息时不注入，零 token） */
export function shouldInjectRecentSelfOutputNote(recentAssistantTurns) {
  return (Array.isArray(recentAssistantTurns) ? recentAssistantTurns : [])
    .some(t => cleanTurnTextFlat(t).length > 0);
}

// ── 日志（专题 §六：日志可搜 `[anti-repetition]` 看每轮检测档位）──

export function formatAntiRepetitionLog({ result, turns, emotionSnapshots } = {}) {
  const mode = result?.mode || 'none';
  const overlap = (result?.maxOverlap ?? 0).toFixed(2);
  const parts = [
    `[anti-repetition] mode=${mode}`,
    `overlap=${overlap}`,
    `turns=${Array.isArray(turns) ? turns.length : 0}`,
    `emotionTurns=${Array.isArray(emotionSnapshots) ? emotionSnapshots.length : 0}`,
  ];
  if (result?.topicLock) parts.push(`topic_lock=${result.lockedTopic || 'on'}`);
  if (result?.skipped) parts.push(`skipped=${result.skipped}`);
  // 阶段二：升级态与连续高复述段数（trend=normal|trending|escalating）
  if (result?.trend && result.trend !== 'normal') parts.push(`trend=${result.trend}`);
  if (result?.escalated) parts.push(`escalated=1`);
  if (result?.escalatedRunLength) parts.push(`esc_run=${result.escalatedRunLength}`);
  if (result?.reason) parts.push(`reason=${result.reason}`);
  return parts.join(' ');
}

/**
 * 阶段二「输出侧检测」的量化记录（每轮一条，无论升级开关开没开）。
 *
 * 用途：给用户/调参一个可统计的复读率数据（专题 §六-3 的日志口径），并作为
 * "本轮注入的是哪一档"的审计行。**不写库、不回调**，只返回结构化数字。
 *
 * @param {{turns?:string[], result?:object}} input
 * @returns {{ mode:string, trend:string, overlap:number, escalatedRunLength:number, runLength:number,
 *             turns:number, escalated:boolean, lockedTopic:string|null, skipped:string|null }|null}
 */
export function buildAntiRepetitionMetrics({ turns = [], result = null } = {}) {
  if (!result) return null;
  return {
    // effectiveMode：本轮真正决定了注入内容的档位
    mode: result.escalated ? 'escalated' : (result.mode || 'none'),
    trend: result.trend || 'normal',
    overlap: Number((result.maxOverlap ?? 0).toFixed(3)),
    escalatedOverlap: Number((result.maxEscalatedOverlap ?? 0).toFixed(3)),
    runLength: result.runLength ?? 0,
    escalatedRunLength: result.escalatedRunLength ?? 0,
    turns: Array.isArray(turns) ? turns.length : 0,
    escalated: result.escalated === true,
    lockedTopic: result.lockedTopic || null,
    skipped: result.skipped || null,
  };
}

// ── 查库助手（口径与 contextAssembler.getSplitHistory 的活跃窗口一致）──

/**
 * 取最近 N 轮 assistant 原文（时间升序 = 最新在末尾），用于反重复检测。
 *
 * 与 getSplitHistory 的口径对齐：
 *   - 只看 id > sinceRawId（= rolling_summaries.end_msg_id，已摘要的不再进上下文）
 *   - 命中 excludeWindows（催眠遗忘窗口）的消息**不算她说过的话**，一并剔除
 * 查库失败一律返回空数组：反重复是增强项，绝不能影响聊天主流程。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} conversationId
 * @param {{limit?:number, sinceRawId?:number, excludeWindows?:Array<{fromRawId:number,toRawId:number}>}} [opts]
 * @returns {string[]}
 */
export function fetchRecentAssistantTurns(db, conversationId, { limit = 6, sinceRawId = 0, excludeWindows = [] } = {}) {
  try {
    const fetchLimit = Math.max(1, limit) * 3;
    const rows = db.prepare(`
      SELECT id, content FROM (
        SELECT id, content FROM raw_messages
        WHERE conversation_id = ? AND id > ? AND role = 'assistant'
        ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(conversationId, sinceRawId, fetchLimit);
    const filtered = excludeWindows.length > 0
      ? rows.filter(row => !isRawInWindows(row.id, excludeWindows))
      : rows;
    return filtered.slice(-Math.max(1, limit)).map(row => String(row.content || ''));
  } catch (err) {
    console.warn('[anti-repetition] fetchRecentAssistantTurns failed:', err.message);
    return [];
  }
}

function isRawInWindows(rawId, windows) {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  for (const window of windows) {
    const from = Number(window?.fromRawId);
    const to = Number(window?.toRawId);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (id >= lo && id <= hi) return true;
  }
  return false;
}

/**
 * 取最近 N 条情绪快照（时间升序 = 最新在末尾；V/A 取合成情绪用的 instant 列，
 * 与 emotionEngine.stateToPrompt 的 comp 口径一致：mood×0.4 + instant×0.6）。
 * 查库失败返回空数组（此时 topic_lock 检测自动失效，只保留车轱辘话检测）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} conversationId
 * @param {{limit?:number}} [opts]
 * @returns {Array<{valence:number,arousal:number}>}
 */
export function fetchRecentEmotionSnapshots(db, conversationId, { limit = 6 } = {}) {
  try {
    const rows = db.prepare(`
      SELECT valence, arousal, mood_valence, mood_arousal FROM (
        SELECT id, valence, arousal, mood_valence, mood_arousal FROM emotion_snapshots
        WHERE conversation_id = ?
        ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(conversationId, Math.max(1, limit));
    return rows.map(row => ({
      valence: mix(row.valence, row.mood_valence),
      arousal: mix(row.arousal, row.mood_arousal),
    }));
  } catch (err) {
    console.warn('[anti-repetition] fetchRecentEmotionSnapshots failed:', err.message);
    return [];
  }
}

/** mood×0.4 + instant×0.6；缺 mood 时退回 instant（老库行只有 instant 列） */
function mix(instant, mood) {
  const i = Number(instant);
  const m = Number(mood);
  if (!Number.isFinite(i)) return Number.isFinite(m) ? m : 0.5;
  // mood 缺失为 NULL → Number(null)=0（有限值！）会算成 0.6×instant，必须先判空
  if (mood === null || mood === undefined || !Number.isFinite(m)) return i;
  return m * 0.4 + i * 0.6;
}
