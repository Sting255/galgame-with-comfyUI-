/**
 * 亲密看板 · 自动记账入口（聊天 / 群聊 / 奇遇 / 梦境的统一调用点）
 *
 * 设计原则：
 *   1. **零额外 LLM 调用**：判定与归类全部走确定性规则——生图 prompt 的 tag 串
 *      （逗号分隔）→ tagsFromPromptString → classifyPromptTags → 词表命中。
 *   2. **幂等**：一律带上 raw_id（本轮 assistant 原始消息 id），recordIntimateActs 内部
 *      用 `auto:scene:raw<id>:actKey:position:partner:pid` 作 source_uid，
 *      重生成、断线重试、重复扫描都不会重复计数。
 *   3. **可回滚**：raw_id 与 chat.js 撤回一轮 / 清空会话用的是同一个锚点
 *      （见 rollbackMemoriesFromRawId 的调用处），所以看板数字能跟着记忆一起回落。
 *   4. **不碰身体档案**：本模块只写行为流水；身体信息永远由用户手动维护
 *      （除非用户在面板里显式把某字段的"允许 AI 修改"打开，那也走 intimateService 的权限闸门）。
 *   5. **判定对象是"这一轮"，不是"她那一半"**（2026-09-29 扩充）：正文兜底默认只看她这一轮的回复；
 *      **催眠轮**额外并入紧邻其前的用户消息。理由与边界见 isHypnosisRound / roundTextOf 的注释。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { classifyPromptTags, recordIntimateActs, tagsFromPromptString } from './intimateService.js';
import { containsExplicitAdultContent } from '../db/imagePromptKnowledgePolicy.js';
// 只借它的**权威判定** isBodyControlled（身体受控 + 未过期，过期即自动解除）；
// 不复制「active_until > now」这套口径，避免出现第二处实现（口径走收口点）。
// 依赖方向：intimateAutoRecord → hypnosisService → intimateService，无环。
import { isBodyControlled } from './hypnosisService.js';

/** 无法归类但确实发生了成人内容的兜底 act_key（仅在调用方显式要求时才记） */
export const ACT_UNSPECIFIED = 'unspecified';

const EMPTY = Object.freeze({ inserted: 0, skipped: 0, blocked: false, acts: [] });

const positiveInt = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** 只做成人内容判定，不落库（给"要不要处理这一轮"的前置判断用） */
export function detectExplicitReply(text) {
  return containsExplicitAdultContent(text);
}

// ── 轮次正文（判定对象） ────────────────────────────────────────────────────────

/**
 * 「这一轮算不算催眠轮」——决定正文兜底要不要把**用户消息**一并纳入判定。
 *
 * 为什么需要它（2026-09-29 真机反馈「催眠的时候如果发生性交记录到面板里」）：
 *   催眠口径（尤其「完全控制」）明令她"只客观呈现身体反应与已经执行的动作，语气平淡、简短、直给"，
 *   `<reply_length>` 又压到 10~60 字 —— 露骨词几乎只落在**用户那一句指令**上。
 *   实测（真机日志原句 + :memory: 库）：user=「自慰吧」词表命中，她按口径回的
 *   "嗯……好。（指尖顺着裙摆边沿慢慢滑下去，动作有些发软）……" 词表**不命中** ⇒ 整轮零流水。
 *   判定对象本来就该是"这一轮"而不是"她那一半"：AI 判断（intimateAiJudge.judgeRound）送的正是
 *   `[用户消息, 她的回复]`（见 chat.js 的 judgeRoundInBackground），只有零 LLM 的正文兜底还只看后一半。
 *
 * 为什么**只在催眠轮**放宽：普通轮的既有口径必须逐字节不变（本轮验收要求），
 * 而普通轮里露骨词通常就在她自己的回复里，兜底本来就命中 —— 放宽只会徒增误报面。
 *
 * 权威判定复用 hypnosisService.isBodyControlled（身体受控 + 未过期，过期即自动解除）；
 * 任何异常（表缺失 / 总开关关闭抛错）一律按"不是催眠轮"处理：宁可不扩，不可误扩。
 */
function isHypnosisRound(characterId) {
  try {
    return isBodyControlled(characterId) === true;
  } catch {
    return false;
  }
}

/** 紧邻该 raw 之前、同一会话里最后一条 user 消息（没有就返回空串） */
function previousUserText(db, conversationId, rawId) {
  try {
    const row = db.prepare(
      `SELECT content FROM raw_messages
        WHERE conversation_id = ? AND id < ? AND role = 'user'
        ORDER BY id DESC LIMIT 1`
    ).get(String(conversationId), rawId);
    return String(row?.content || '');
  } catch {
    return '';
  }
}

/**
 * 这一轮的"轮次正文"：她这一轮的回复；**催眠轮**额外并入紧邻其前的用户消息。
 * @param {object} row raw_messages 行（至少要 id / conversation_id / content）
 * @returns {{text:string, hypnosis:boolean}}
 */
function roundTextOf(db, row, characterId) {
  const own = String(row?.content || '');
  if (!isHypnosisRound(characterId)) return { text: own, hypnosis: false };
  const previous = previousUserText(db, row?.conversation_id, row?.id);
  return { text: previous ? `${previous}\n${own}` : own, hypnosis: true };
}

/**
 * 按生图 prompt（或已切好的 tag 数组）记账。
 * @param {object} params
 * @param {number} params.characterId
 * @param {string} [params.prompt]  生图 prompt 字符串（英文 tag 逗号分隔）
 * @param {string[]} [params.tags]  已切好的 tag 数组（优先于 prompt）
 * @param {number} [params.rawId]   本轮 assistant raw_messages.id（幂等锚点，必传才安全）
 * @param {number} [params.msgId]
 * @param {string} [params.scene]   chat | group | event | dream | moment | mailbox
 * @param {string} [params.partnerKind] user | character | npc | self | unknown
 * @param {number} [params.partnerId]
 * @param {string} [params.occurredAt]
 * @param {boolean} [params.allowUnspecified] 有成人内容但无 tag 可归类时，是否记一条 unspecified
 */
export function recordFromPrompt({
  characterId,
  prompt = '',
  tags = null,
  rawId = 0,
  msgId = 0,
  scene = 'chat',
  partnerKind = 'user',
  partnerId = 0,
  occurredAt,
  allowUnspecified = false,
} = {}) {
  const list = Array.isArray(tags) && tags.length > 0 ? tags : tagsFromPromptString(prompt);
  const acts = list.length > 0 ? classifyPromptTags(list) : [];

  if (acts.length === 0) {
    // 没有可归类的 tag：默认什么都不记（避免用猜测污染统计）。
    // 调用方明确要求时，才落一条 unspecified，让面板能显示"有活动但未归类"。
    if (!allowUnspecified || !containsExplicitAdultContent(prompt)) return { ...EMPTY };
    const res = recordIntimateActs(characterId, {
      scene, partnerKind, partnerId, rawId, msgId, source: 'auto', occurredAt,
      acts: [{ actKey: ACT_UNSPECIFIED }],
    });
    return { ...res, acts: [{ actKey: ACT_UNSPECIFIED, positionKey: '' }] };
  }

  const res = recordIntimateActs(characterId, {
    scene, partnerKind, partnerId, rawId, msgId, source: 'auto', occurredAt, acts,
  });
  return { ...res, acts };
}

/**
 * 会话尾部记账：读该会话"最近一条带生图 prompt 的 assistant 原始消息"，按它的 raw_id 记账。
 *
 * 语义边界（重要，调用方必须遵守）：
 *   本函数找的是"最近一条 **带 prompt** 的 assistant raw"，而不是"最后一条 assistant raw"。
 *   原因是 prompt 可能被合并进更早的那条 raw（needImage 的 merge 分支会 UPDATE 上一条），
 *   也可能在其后又插入了一条无 prompt 的占位 raw（纯图无文时主流程会补一条 '...'）。
 *   因此**调用方必须先用本轮是否真的产出了 prompt 来把关**（chat.js 里是
 *   `if (tags.prompt) recordIntimateFromTail(...)`），否则在一轮纯文本回复里调用它，
 *   会去命中更早那次生图的 raw —— 虽然因为 source_uid 幂等不会重复计数，但那不是本意。
 *
 * 为什么按尾部读而不是在每个落库分支里各调一次：
 *   chat.js 里 assistant 原始消息有多个落库分支（主流式 / needImage 新建 / needImage 合并回上一条 /
 *   纯文本），逐个挂钩容易漏且会重复。read-after-write 地从库里取，只需一个调用点。
 *
 * @param {object} params
 * @param {number} params.characterId
 * @param {string} params.conversationId
 * @param {string} [params.scene]
 * @param {string} [params.partnerKind]
 * @param {number} [params.partnerId]
 * @param {boolean} [params.forceTextFallback] 这一类轮次"必须入账"：① 归类拿不到任何行为时，
 *   **无条件**再跑一次正文兜底（不要求"角色正在被催眠"）；② 本轮**根本没有生图 prompt** 时
 *   （自动触发的主动轮没配图 / 配图 prompt 生成失败），退到该会话最后一条 assistant raw 兜底。
 *   默认 false ⇒ 现有行为逐字节不变。唯一使用者是 `proactiveChatScheduler.forceProactiveNow()`
 *   的自动触发轮（催眠「强制高潮」，见 routes/hypnosis.js 的 command 分支）：那一轮不经 chat.js，
 *   正文只在这条路径上过一遍，而 task-42 起「强制高潮不需要催眠、随时都能触发」⇒ 不能靠
 *   isBodyControlled 兜。
 * @returns {{inserted:number, skipped:number, blocked:boolean, acts:Array, rawId:number}}
 */
export function recordFromConversationTail({
  characterId,
  conversationId,
  scene = 'chat',
  partnerKind = 'user',
  partnerId = 0,
  forceTextFallback = false,
} = {}) {
  if (!positiveInt(characterId) || !conversationId) return { ...EMPTY, rawId: 0 };
  let row = null;
  try {
    row = getDb().prepare(
      `SELECT id, conversation_id, content, prompt FROM raw_messages
       WHERE conversation_id = ? AND role = 'assistant' AND prompt IS NOT NULL AND prompt != ''
       ORDER BY id DESC LIMIT 1`
    ).get(String(conversationId));
  } catch (err) {
    console.warn('[intimate] tail lookup failed:', err.message);
    return { ...EMPTY, rawId: 0 };
  }
  if (!row?.prompt) {
    // 强制入账的轮次允许"本轮没有生图 prompt"：自动触发的主动消息不一定配图
    // （动机没抽到 imageGen / 生图 prompt 生成失败 / 非催眠态点强制高潮时指令块为空）。
    // 此时锚点退到该会话**最后一条 assistant raw** —— 调用方（proactiveChatScheduler）是在
    // writeProactiveMessage 之后立刻调用的，那条就是本轮。
    // 判定文本只用这条 raw 自己的正文：主动消息的"上一句 user"可能是很久以前的消息，
    // 并进来会让一条旧指令给无关的一轮背账（与催眠轮 live 路径不同）。
    if (forceTextFallback !== true) return { ...EMPTY, rawId: 0 };
    let latest = null;
    try {
      latest = getDb().prepare(
        `SELECT id, content FROM raw_messages
          WHERE conversation_id = ? AND role = 'assistant'
          ORDER BY id DESC LIMIT 1`
      ).get(String(conversationId));
    } catch (err) {
      console.warn('[intimate] forced tail lookup failed:', err.message);
      return { ...EMPTY, rawId: 0 };
    }
    if (!latest) return { ...EMPTY, rawId: 0 };
    const forced = recordUnspecifiedFromText({
      characterId,
      rawId: latest.id,
      text: String(latest.content || ''),
      scene,
      partnerKind,
      partnerId,
    });
    return { ...forced, rawId: latest.id };
  }

  const result = recordFromPrompt({
    characterId,
    prompt: row.prompt,
    rawId: row.id,
    scene,
    partnerKind,
    partnerId,
  });

  // 归类拿不到任何行为时，**催眠轮 / 显式要求兜底的轮次**继续跑一次正文兜底（同一 raw_id 锚点，幂等）。
  // forceTextFallback 由调用方显式打开（proactiveChatScheduler 的自动触发强制高潮轮：
  // 它不经 chat.js，且 task-42 起"强制高潮不需要催眠"，所以不能只靠 isBodyControlled 判定）。
  //
  // 为什么必须补这一步：催眠「强制高潮」轮在 chat.js 走的是"强制出图"分支（路径 D'），
  // prompt 由生图助手按上下文自拟 —— 是散文式英文场景描述，几乎不含归类词表里的 tag
  // （实测：prompt="A dim dormitory bedroom at night, Nahida on all fours, trembling" + 正文
  //  "……被从后面进入，忍不住叫出声……高潮了……" ⇒ classifyPromptTags 空手而归、整轮零流水）。
  // 而 chat.js 的两处挂点是互斥的（`if (tags.prompt) 归类 else 兜底`），有 prompt 就永远进不到 else，
  // 所以这条兜底只能在尾部记账里补，不能指望调用方。
  if (result.inserted === 0 && result.skipped === 0 && result.blocked === false) {
    const round = roundTextOf(getDb(), row, characterId);
    if (round.hypnosis || forceTextFallback === true) {
      const fallback = recordUnspecifiedFromText({
        characterId,
        rawId: row.id,
        text: round.text,
        scene,
        partnerKind,
        partnerId,
      });
      if (fallback.inserted > 0 || fallback.blocked) return { ...fallback, rawId: row.id };
    }
  }
  return { ...result, rawId: row.id };
}

/**
 * 正文兜底记账：本轮没有任何可归类的生图 prompt，但**正文**命中了成人内容判定 →
 * 记一笔 ACT_UNSPECIFIED（"未归类"）。
 *
 * 为什么只记「未归类」而不细分行为：
 *   现有词表是按生图 tag（英文逗号串）建的，拿去切中文叙事会大量误报（task-25 已实测：
 *   扩展黑名单仍残留、白名单化损失过大）。所以这里只用项目现成的**二值判定**
 *   `containsExplicitAdultContent`（它自带中文词表），承认"确实发生了但不知道是什么"，不猜。
 *
 * 幂等：锚点仍是 raw_messages.id（source_uid 形如 `auto:chat:raw<id>:unspecified::user:0`），
 *   同一轮重复调用只落一行；撤回/清空时与记忆一起按同一锚点回滚。
 *
 * @param {object} params
 * @param {number} params.characterId
 * @param {number} params.rawId   本轮 assistant raw_messages.id（幂等锚点）
 * @param {string} params.text    待判定的正文
 * @param {string} [params.scene] chat | group | event | dream | moment | mailbox
 * @param {string} [params.partnerKind] user | character | npc | self | unknown
 * @param {number} [params.partnerId]
 * @param {string} [params.occurredAt]
 */
export function recordUnspecifiedFromText({
  characterId,
  rawId,
  text = '',
  scene = 'chat',
  partnerKind = 'user',
  partnerId = 0,
  occurredAt,
} = {}) {
  if (!positiveInt(characterId) || !positiveInt(rawId)) return { ...EMPTY };
  // 总开关：调用方也各自把着（chat.js 包装 / 群聊引擎 / 回填路由），这里再兜一层——
  // 正文兜底是新增路径，宁可在最底层就保证"关掉看板时一个字都不写"。
  if (config.features?.intimate === false) return { ...EMPTY };
  if (!containsExplicitAdultContent(text)) return { ...EMPTY };
  const res = recordIntimateActs(characterId, {
    scene,
    partnerKind,
    partnerId,
    rawId,
    source: 'auto',
    occurredAt,
    acts: [{ actKey: ACT_UNSPECIFIED }],
  });
  return { ...res, acts: [{ actKey: ACT_UNSPECIFIED, positionKey: '' }] };
}

/**
 * 按 raw_id 读回正文后兜底（实时路径用：raw 刚落库，read-after-write，与 recordFromConversationTail 同款）。
 * 只读该 raw 自己的正文，不去扫"最后一条"——调用方明确知道本轮 raw_id，少一层猜测；
 * **催眠轮**再把紧邻其前的用户消息并进来（见 roundTextOf：催眠口径把露骨词压到用户那一侧）。
 */
export function recordUnspecifiedFromRawId({ characterId, rawId, scene = 'chat', partnerKind = 'user', partnerId = 0 } = {}) {
  if (!positiveInt(characterId) || !positiveInt(rawId)) return { ...EMPTY };
  let row = null;
  try {
    row = getDb().prepare('SELECT id, conversation_id, content FROM raw_messages WHERE id = ?').get(rawId);
  } catch (err) {
    console.warn('[intimate] text fallback lookup failed:', err.message);
    return { ...EMPTY };
  }
  if (!row) return { ...EMPTY };
  const { text } = roundTextOf(getDb(), row, characterId);
  return recordUnspecifiedFromText({ characterId, rawId: row.id, text, scene, partnerKind, partnerId });
}
