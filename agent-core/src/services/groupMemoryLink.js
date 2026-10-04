/**
 * 群聊 ⇄ 私聊 记忆互通（双向，所有角色默认生效，不做需要开关的实验功能）
 *
 * 用户裁决口径：「群里聊过的，私聊也记得」——像人类一样。
 *   H1 私聊侧的检索范围把「她所在的群」一并纳入（同一份记忆，不复制数据），群来源条目标出出处；
 *   H2 群聊一轮结束后，把「她这一轮在群里经历的事」写进她自己（`char_<id>`）的长期记忆；
 *   H3 群聊轮里给每个成员注入一节「只有她自己知道」的私聊记忆。
 *
 * 关键边界（真机实测后收窄）：**成员的私聊记忆只能通过 H3 进群聊 prompt**，
 *   群聊轮的 RAG（`<rag_memories>`）范围只含该群会话（见 `groupChatEngine.buildGroupRoundMemoryScope`）——
 *   否则她的私事会进到全体共享的群 prompt 里，别人也看得见，不像人类。
 *
 * 硬上限（本模块的第二目标：群聊 prompt 绝不随群人数/历史线性膨胀）：
 *   每人最多 GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER 条、每节最多 GROUP_PRIVATE_MEMORY_MEMBER_CHARS 字；
 *   全体合计的**每轮实际预算** = `resolveMemberMemoryBudget(人数)`（人数 ×（每节字数 + 块间分隔符），
 *   再被 GROUP_PRIVATE_MEMORY_TOTAL_CHARS 这个"硬顶"封顶）；群→私聊正文最多 GROUP_LINK_SUMMARY_MAX_CHARS 字；
 *   私聊 prompt 里群来源条目最多 PRIVATE_GROUP_MEMORY_MAX_ITEMS 条；候选池每人先扫
 *   GROUP_PRIVATE_MEMORY_SCAN_LIMIT 条。数值一律以本文件的导出常量为准（不要在注释/日志里抄数字），
 *   全部是导出常量，单测直接断言。
 *
 * 设计取舍一（写入端不落 raw 锚点）：`applyMemoryActions` 的 sourceRawStartId/sourceRawEndId 传 null。
 *   群聊 raw id 与私聊 raw id 共用 raw_messages 的全局自增序列，若把群 raw id 写进 `char_<id>` 的记忆行，
 *   两处既有逻辑会误伤：私聊撤回回滚（rollbackMemoriesFromRawId 按 conversation_id + source_raw_end_id 匹配）
 *   与催眠遗忘窗口（collectMemoriesInRange 按 raw id 区间归档）。幂等改由 dedupeKey 承担
 *   （`group_link:<groupId>:<rawId>:<charId>` 参与 content_hash，同一轮同一人重复触发不会重复写），
 *   出处改由 tags（'群聊' / `群组:<id>` / 群名）承担。
 *
 * 设计取舍二（不上 LLM）：H2 的正文是确定性拼接（用户说了什么 / 她说了什么 / 别人说了什么），
 *   群聊收尾多一次 LLM 调用既不划算也会拖慢收尾。
 */
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { applyMemoryActions, listActiveMemories, parseTags } from './memory/memoryRepository.js';

// ── 硬上限（导出常量；单测直接断言数值）──

/** 群聊轮里每个成员最多注入 3 条她的私聊记忆（原 2 条偏紧，用户反馈"太少了"） */
export const GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER = 3;
/** 每个成员那一节最多 300 字（超出截断） */
export const GROUP_PRIVATE_MEMORY_MEMBER_CHARS = 300;
/**
 * 全体成员合计的**硬顶**（不再是每轮预算本身）。
 *
 * 每轮真正的预算是 `resolveMemberMemoryBudget(人数)` 现算的
 * （人数 ×（每节字数 + 1），再被这个硬顶封顶）；本常量只负责"人再多也不会失控"。
 *
 * 为什么必须降级成硬顶（真机 8 人群实测）：原值 2400 = 8 × 300 把**节与节之间的换行分隔符**
 * 漏算了 —— 8 节顶满时实际是 8 × 300 + 7 = 2407 > 2400，于是第 8 个成员**每轮都被跳过**
 * （日志：`额度已用完（2106/2400 字），本轮跳过「辛」`）。真正的额度应是 8 × (300 + 1) = 2408，
 * 这里取 3000 留出余量（8 人满额 2407 也装得下），20 人时 20 × 301 = 6020 → 仍被 3000 硬顶住，
 * 超出的成员照旧整节跳过并打 log。
 * 真机实测：8 人群一轮 prompt 只占上游 100 万 token 窗口的 0.4%，这 3000 字没有风险。
 */
export const GROUP_PRIVATE_MEMORY_TOTAL_CHARS = 3000;

/**
 * 每轮实际生效的注入预算（纯函数，便于单测）：
 *   `effective = min(硬顶, 人数 × (每节字数 + 1))`
 *
 * `+ 1` 是**块间换行分隔符**的余量（N 节之间有 N-1 个 `\n`，按 N 个算即可保证 N 节都进得来）。
 * 口径：8 人 → 8 × 301 = 2408 ≤ 3000，人人有份；20 人 → 6020 被 3000 硬顶住，超出的整节跳过。
 *
 * @param {number} memberCount 本轮参与注入的成员数
 * @returns {number} 本轮合计可用字符数
 */
export function resolveMemberMemoryBudget(memberCount, {
  totalChars = GROUP_PRIVATE_MEMORY_TOTAL_CHARS,
  memberChars = GROUP_PRIVATE_MEMORY_MEMBER_CHARS,
} = {}) {
  const count = Math.floor(Number(memberCount));
  const hardCap = Number(totalChars);
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(hardCap) || hardCap <= 0) return 0;
  const perMember = Math.max(0, Number(memberChars) || 0) + 1;   // +1 = 块间换行分隔符余量
  return Math.min(hardCap, count * perMember);
}
/** 群→私聊写入的那条记忆正文上限 */
export const GROUP_LINK_SUMMARY_MAX_CHARS = 200;
/**
 * 私聊 prompt 里从群聊记忆检索到的条目上限。
 *
 * 原值 3 是拍脑袋的"防刷屏"默认，用户反馈"群聊就拉三条是不是太少了"——真正兜底的其实是
 * `hybridSearch` 的 `topK`（`settings.topK`，`memorySearch.js` 里夹到 1~20）：检索一共只会返回
 * topK 条，之前那 3 条上限意味着"群里的记忆最多只能占 3 个位置"。放宽到 8 之后，群来源条目可以
 * 填满检索结果（她自己会话的记忆仍然一条不动），**同时仍然是有界护栏**（不会因为群多而线性膨胀）。
 * 想让它更严/更松就改这个常量，或到记忆设置里调 topK。
 */
export const PRIVATE_GROUP_MEMORY_MAX_ITEMS = 8;

/**
 * 每人在私聊记忆里先扫多少条候选，再按 重要性 × 时间 排序取前 N（只读，不触发 embedding/网络）。
 *
 * 原值 20：真机确认她的记忆常多于 20 条，`listActiveMemories` 按更新时间倒序返回，
 * 于是**最旧的那条永远进不了候选池**（哪怕它最重要）。放宽到 30 覆盖常见量级，仍然只读一次、有界。
 */
export const GROUP_PRIVATE_MEMORY_SCAN_LIMIT = 30;
/**
 * H3 读侧的候选池超采倍数。
 *
 * H2 写的「群聊」记忆也落在 `char_<id>` 里（读侧会过滤掉，见 `readMemberPrivateMemories`），
 * 但它们同样占 `listActiveMemories` 的"最近 N 条"窗口：只按 `GROUP_PRIVATE_MEMORY_SCAN_LIMIT` 读一次再过滤，
 * 群聊轮数一多整窗就会被"群里刚说过的话"占满，她**真正的**私聊记忆反而一条都进不了候选池。
 * 所以先多读 `SCAN_LIMIT × 本倍数`（有界：30 × 4 = 120 行），过滤后再按 SCAN_LIMIT 截断。
 */
export const GROUP_PRIVATE_MEMORY_SCAN_OVERFETCH = 4;
/**
 * H2 写入的群聊记忆标记：H3 靠它区分「群里的经历」和「私下聊过的」；
 * 私聊召回侧（H1）也靠它给落在 `char_<id>` 里的群→私聊记忆补上「群聊」出处。
 */
export const GROUP_LINK_TAG = '群聊';
/** 群链接记忆的 tag：群组:<groupId>，方便按群回溯 */
export const GROUP_LINK_GROUP_TAG_PREFIX = '群组:';
/**
 * 截断的最后一条 bullet 至少留多少字符才值得保留。
 *
 * 必须明显大于 bullet 前缀（`- 你和用户私下聊过：` 就有 12~13 字）—— 否则剩余额度只剩十几字时
 * 会产出 `- 你和用户私下聊过：…` 这种几乎没有信息的空壳尾巴（真机 8 人群实测到过：
 * 戊/庚/辛 三节就是靠这种尾巴顶到 300 字的）。剩余额度不够就整条丢弃，小节短一点没关系。
 */
const MIN_TRUNCATED_TAIL = 40;

/**
 * 记忆总开关。与 `routes/chat.js` / `groupChatEngine.js` 的既有口径一致：
 * 只有总开关为真才参与记忆互通（`config.features.memory === false` 时整体不写/不注入）。
 */
export function isGroupMemoryLinkEnabled() {
  return Boolean(config.features?.memory);
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 截断到 max 个字符（含省略号）；未超长则原样返回 */
function clampChars(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

// ──────────────── H1：私聊侧检索把「她所在的群」纳入 ────────────────

/**
 * 她参与的所有群会话 id（形如 `group_<groupId>`）。
 * SQL 与 routes/chat.js 原内联查询逐字一致，抽出来只为可单测。
 */
export function listCharacterGroupConversationIds(characterId, db = getDb()) {
  const id = Number(characterId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return db.prepare(`
    SELECT 'group_' || group_id AS conversation_id
    FROM group_members WHERE character_id = ? ORDER BY group_id
  `).pluck().all(id);
}

/** 会话 id 是否属于群聊（群会话 id 前缀 group_） */
export function isGroupConversationId(conversationId) {
  return String(conversationId ?? '').startsWith('group_');
}

/** `group_<id>` → 群名（查 group_chats.name），供【群聊·群名】标注 */
export function loadGroupNameMap(conversationIds = [], db = getDb()) {
  const ids = [...new Set(
    (Array.isArray(conversationIds) ? conversationIds : [])
      .map(cid => Number(String(cid ?? '').replace(/^group_/, '')))
      .filter(id => Number.isInteger(id) && id > 0),
  )];
  const map = new Map();
  if (ids.length === 0) return map;
  const rows = db.prepare(`SELECT id, name FROM group_chats WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const row of rows) map.set(`group_${row.id}`, oneLine(row.name));
  return map;
}

/** 注入文本里的群出处前缀：有群名带群名，查不到群名退化成【群聊】 */
export function groupMemoryTag(conversationId, groupNames = null) {
  const name = groupNames instanceof Map ? groupNames.get(conversationId) : null;
  return name ? `【群聊·${name}】` : '【群聊】';
}

/** 记忆的 tags 统一成字符串数组（兼容仓储层直出的数组与 JSON 字符串两种形态） */
function tagList(memory) {
  return parseTags(memory?.tags).map(String);
}

/** 这条记忆是否带 `群聊` 标记（H2 写进 `char_<id>` 的「群→私聊」记忆的识别标志） */
export function hasGroupLinkTag(memory) {
  return tagList(memory).includes(GROUP_LINK_TAG);
}

/** 从 tags 里的 `群组:<id>` 反解群 id；没有或非法则 null */
export function groupIdFromMemoryTags(memory) {
  const tag = tagList(memory).find(value => value.startsWith(GROUP_LINK_GROUP_TAG_PREFIX));
  if (!tag) return null;
  const id = Number(tag.slice(GROUP_LINK_GROUP_TAG_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 一条记忆是不是「群来源」。两种形态：
 *   ① 群会话记忆：`conversation_id = 'group_<id>'`（群聊整理链路落的）；
 *   ② H2 群→私聊记忆：落在 `char_<id>` 里、**只带 `群聊` tag**（没有群会话 id，只能靠 tag 识别）。
 * ②原先被漏掉，导致她在私聊里说起群里的事时，prompt 里看不到出处。
 */
export function isGroupSourcedMemory(memory) {
  return isGroupConversationId(memory?.conversation_id) || hasGroupLinkTag(memory);
}

/**
 * 一条记忆的群出处前缀：`【群聊·<群名>】`（群名表里有）/`【群聊】`（查不到）；
 * 不是群来源就返回空串 —— **普通私聊记忆的输出必须与加出处之前逐字节一致**。
 */
export function groupOriginPrefix(memory, groupNames = null) {
  const conversationId = String(memory?.conversation_id ?? '');
  if (isGroupConversationId(conversationId)) return groupMemoryTag(conversationId, groupNames);
  const groupId = groupIdFromMemoryTags(memory);
  if (groupId) return groupMemoryTag(`group_${groupId}`, groupNames);
  return hasGroupLinkTag(memory) ? '【群聊】' : '';
}

/**
 * 补全群名表：H2 记忆落在 `char_<id>`、只有 `群组:<id>` tag，而调用方（`routes/chat.js`）只在
 * "命中里有群会话条目"时才去查群名表，于是这些记忆默认只能退化成【群聊】。
 * 这里只对**真的缺名**的群 id 惰性补查一次 `group_chats`（纯只读）；
 * 没有带 tag 的条目时一次查询都不发，普通私聊记忆的行为与改动前完全一致。
 */
function completeGroupNames(memories, groupNames = new Map()) {
  const map = groupNames instanceof Map ? groupNames : new Map();
  const missing = [];
  for (const memory of memories) {
    // 群会话条目由调用方通过 groupNames 负责，这里只补 H2 的 tag 形态
    if (isGroupConversationId(memory?.conversation_id)) continue;
    const groupId = groupIdFromMemoryTags(memory);
    const key = groupId ? `group_${groupId}` : null;
    if (key && !map.has(key)) missing.push(key);
  }
  if (missing.length === 0) return map;
  const merged = new Map(map);
  try {
    for (const [key, name] of loadGroupNameMap([...new Set(missing)])) merged.set(key, name);
  } catch (err) {
    // 群名只是锦上添花：查不到就退化成【群聊】，绝不因为少个名字打断召回
    console.warn('[memory] 群名补查失败，群出处退化成【群聊】:', err.message);
  }
  return merged;
}

/**
 * 条数收敛：来自群来源的条目最多 `maxGroupItems` 条，超了丢弃；
 * 她自己会话（`char_<id>`）的**普通**私聊记忆一条不动，顺序也保持原样。
 *
 * 群来源判定见 `isGroupSourcedMemory`：群会话条目与带 `群聊` tag 的 H2 条目一起占额度。
 *
 * @returns {{ results: any[], dropped: number }}
 */
export function selectPrivateChatMemories(results = [], { maxGroupItems = PRIVATE_GROUP_MEMORY_MAX_ITEMS } = {}) {
  const kept = [];
  let groupKept = 0;
  let dropped = 0;
  for (const item of Array.isArray(results) ? results : []) {
    if (!isGroupSourcedMemory(item)) {
      kept.push(item);
      continue;
    }
    if (groupKept >= maxGroupItems) {
      dropped++;
      continue;
    }
    groupKept++;
    kept.push(item);
  }
  if (dropped > 0) {
    console.log(`[memory] 私聊召回里群来源条目超过 ${maxGroupItems} 条，本轮丢弃 ${dropped} 条`);
  }
  return { results: kept, dropped };
}

/**
 * 私聊 `<rag_memories>` 的行格式化。
 * 非群来源的行与旧实现**逐字节一致**（`${i+1}. [${label}] ${text}`）；
 * 群来源的行（群会话条目、或带 `群聊` tag 的 H2 条目）在序号后插入
 * `【群聊】` / `【群聊·<群名>】`，让角色能自然地说"你上次在群里…"。
 */
export function formatPrivateChatMemoryLines(results = [], {
  groupNames = new Map(),
  useV3Injection = false,
  maxGroupItems = PRIVATE_GROUP_MEMORY_MAX_ITEMS,
} = {}) {
  const { results: kept } = selectPrivateChatMemories(results, { maxGroupItems });
  // 一个群来源条目都没有时连群名表都不补查（普通私聊记忆完全走老路径）
  const names = kept.some(isGroupSourcedMemory) ? completeGroupNames(kept, groupNames) : groupNames;
  return kept.map((memory, index) => {
    const perspectives = Array.isArray(memory?.perspectives) ? memory.perspectives.filter(Boolean) : [];
    const label = perspectives.length ? `${memory.memory_type}|${perspectives[0]}` : memory.memory_type;
    const text = (useV3Injection && memory?.semantic_note) || memory?.judgment;
    const prefix = groupOriginPrefix(memory, names);
    return `${index + 1}. ${prefix}[${label}] ${text}`;
  }).join('\n');
}

// ──────────────── H2：群聊一轮 → 她自己的私聊记忆 ────────────────

/**
 * 确定性拼接「她这轮在群里经历的事」，≤ GROUP_LINK_SUMMARY_MAX_CHARS 字。
 * 视角是**她自己**：用户说了什么 → 她说了什么 → 其他角色说了什么（顺序即重要性，超长先丢别人）。
 *
 * @returns {string} 空串表示这一轮没有可写的内容
 */
export function buildGroupLinkSummary({
  groupName = '',
  chatUserName = '用户',
  memberName = '',
  userMessage = '',
  memberLines = [],
  otherLines = [],
} = {}) {
  const place = groupName ? `在群「${groupName}」里` : '在群里';
  const segments = [];
  const userText = oneLine(userMessage);
  if (userText) segments.push(`${chatUserName}说：${userText}`);
  const mine = (Array.isArray(memberLines) ? memberLines : []).map(oneLine).filter(Boolean).join(' ');
  if (mine) segments.push(`我（${memberName}）说：${mine}`);
  const others = (Array.isArray(otherLines) ? otherLines : [])
    .map(item => `${oneLine(item?.name)}说：${oneLine(item?.text)}`)
    .filter(text => !text.endsWith('说：'))
    .slice(0, 3)
    .join('；');
  if (others) segments.push(`其他人：${others}`);
  if (segments.length === 0) return '';
  return clampChars(`${place}，${segments.join('；')}。`, GROUP_LINK_SUMMARY_MAX_CHARS);
}

/**
 * 群聊一轮结束：把「她在群里经历的事」写进她自己（`char_<id>`）的私聊长期记忆。
 *
 * - 只写给**本轮有发言**的成员，每人一条；
 * - 幂等：dedupeKey = `group_link:<groupId>:<rawId>:<charId>`，同一轮同一人重复触发不重复写；
 * - 失败只 warn，绝不向上抛（调用方是 fire-and-forget）；
 * - `config.features.memory === false` 时整体不写。
 *
 * @param {{ group: object, rawId: number, userMessage?: string, speakerLines?: Array<{characterId:number,text:string}>, eventTime?: string|null }} params
 * @returns {Promise<{ written: Array<{characterId:number, memoryId:string}> }>}
 */
export async function linkGroupRoundToPrivateMemories({
  group,
  rawId,
  userMessage = '',
  speakerLines = [],
  eventTime = null,
} = {}) {
  const written = [];
  if (!isGroupMemoryLinkEnabled()) return { written };
  const groupId = Number(group?.id);
  const roundRawId = Number(rawId);
  if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(roundRawId) || roundRawId <= 0) {
    return { written };
  }
  const groupName = oneLine(group?.name);
  const chatUserName = config.user?.nickname || '用户';
  const memberList = Array.isArray(group?.members) ? group.members : [];
  const memberName = id => {
    const member = memberList.find(m => Number(m?.id) === Number(id));
    return oneLine(member?.display_name || member?.name) || `角色${id}`;
  };

  // 按发言顺序聚合"谁说了什么"（保序 Map）
  const bySpeaker = new Map();
  for (const line of Array.isArray(speakerLines) ? speakerLines : []) {
    const characterId = Number(line?.characterId);
    const text = oneLine(line?.text);
    if (!Number.isInteger(characterId) || characterId <= 0 || !text) continue;
    if (!bySpeaker.has(characterId)) bySpeaker.set(characterId, []);
    bySpeaker.get(characterId).push(text);
  }

  for (const [characterId, texts] of bySpeaker) {
    const name = memberName(characterId);
    const otherLines = [];
    for (const [otherId, otherTexts] of bySpeaker) {
      if (otherId === characterId) continue;
      otherLines.push({ name: memberName(otherId), text: otherTexts.join(' ') });
    }
    const summary = buildGroupLinkSummary({
      groupName,
      chatUserName,
      memberName: name,
      userMessage,
      memberLines: texts,
      otherLines,
    });
    if (!summary) continue;
    try {
      const created = applyMemoryActions({
        conversationId: `char_${characterId}`,
        // 刻意不落 raw 锚点（见文件头「设计取舍一」）
        sourceRawStartId: null,
        sourceRawEndId: null,
        sourceMessageId: null,
        dedupeKey: `group_link:${groupId}:${roundRawId}:${characterId}`,
        eventTime,
        actions: [{
          action: 'create',
          sourceMemoryIds: [],
          memory: {
            memoryType: 'knowledge',
            subject: 'relationship',
            judgment: summary,
            reasoning: '',
            tags: [GROUP_LINK_TAG, `${GROUP_LINK_GROUP_TAG_PREFIX}${groupId}`, groupName, chatUserName, name].filter(Boolean),
            keywords: [GROUP_LINK_TAG, groupName, chatUserName, name].filter(Boolean),
            importance: 4,
            entities: [
              { name, role: 'subject' },
              ...(chatUserName ? [{ name: chatUserName, role: 'mention' }] : []),
              ...(groupName ? [{ name: groupName, role: 'mention' }] : []),
            ],
          },
        }],
      });
      if (created.length > 0) written.push({ characterId, memoryId: created[0].memory_id });
    } catch (err) {
      console.warn(`[memory] 群聊记忆写入私聊失败（${name}）:`, err.message);
    }
  }
  if (written.length > 0) {
    // 注意：这里能用的是**这轮触发来源 raw 消息的自增 id**，不是"第几轮"（轮次没有编号可比）
    console.log(`[memory] 群 ${groupId}（本批 rawId=${roundRawId}）→ 私聊记忆 ${written.length} 条`);
  }
  return { written };
}

// ──────────────── H3：群聊轮里注入「只属于她」的私聊记忆 ────────────────

function memoryTime(memory) {
  const raw = memory?.updated_at || memory?.created_at || memory?.event_time || '';
  const parsed = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 重要性 × 时间 排序（降序），取前 limit 条。
 * 同等重要性看时间，再同等看 id（新写的更大），保证排序确定、可断言。
 */
export function rankPrivateMemories(memories = [], limit = GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER) {
  return [...(Array.isArray(memories) ? memories : [])]
    .sort((a, b) => {
      const byImportance = (Number(b?.importance) || 0) - (Number(a?.importance) || 0);
      if (byImportance !== 0) return byImportance;
      const byTime = memoryTime(b) - memoryTime(a);
      if (byTime !== 0) return byTime;
      return (Number(b?.id) || 0) - (Number(a?.id) || 0);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * H3 只喂**真正的私聊记忆**：带 `群聊` tag 的 H2 记忆（`char_<id>` 里的"群里刚说过的话"）一律不算。
 *
 * 为什么（真机 8 人群实测）：H2 把每轮群里发生的事写进 `char_<id>` 并带 `群聊` tag，
 * 于是 H3 读侧把它们当私聊记忆选进来 —— 可它们的内容群 prompt 里本来就有（`<group_transcript>`），
 * 等于把刚说过的话再喂一遍，还从第 2 轮起把每人 top-3 占满、挤掉了她**真正的**私聊记忆。
 * 注意：**只作用于 H3 读侧**；H1（私聊召回）必须照旧带上它们 —— H2 的记忆出现在私聊里正是这个功能的目的。
 */
export function isMemberPrivateOnlyMemory(memory) {
  return !hasGroupLinkTag(memory);
}

/** 只读读她的私聊记忆（不触发 embedding / 网络），返回候选池 */
export function readMemberPrivateMemories(characterId, {
  limit = GROUP_PRIVATE_MEMORY_SCAN_LIMIT,
  scanMultiplier = GROUP_PRIVATE_MEMORY_SCAN_OVERFETCH,
} = {}) {
  const id = Number(characterId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const wanted = Math.floor(Number(limit));
  if (!Number.isFinite(wanted) || wanted <= 0) return [];
  // 先超采一段再过滤 `群聊` tag，最后按 limit 截断：只读一次、有界，且不会被 H2 记忆把候选窗占满
  const multiplier = Math.max(1, Math.floor(Number(scanMultiplier)) || 1);
  const scanned = listActiveMemories({ conversationId: `char_${id}`, limit: wanted * multiplier });
  return (Array.isArray(scanned) ? scanned : []).filter(isMemberPrivateOnlyMemory).slice(0, wanted);
}

/**
 * 「未互动事件」（用户根本没参与的事件）不进群聊注入：
 * 它连"发生过"都不算，写进群聊 prompt 只会误导其他角色（私聊的 <rag_memories> 也是同样口径）。
 */
export function isInjectablePrivateMemory(memory) {
  return !String(memory?.judgment || memory?.content || '').includes('未互动事件');
}

/**
 * 一条记忆 → 注入小节里的一行（群聊来源的记忆正文自带「在群「X」里」，不再套"私下聊过"）。
 *
 * 读侧（`readMemberPrivateMemories` / `collectMemberPrivateMemoryBlocks`）已经把带 `群聊` tag 的
 * H2 记忆整个滤掉了，这个分支只是兜底：万一有人绕过读侧直接传进来，至少不冒充"你和用户私下聊过"。
 */
export function formatMemberPrivateMemoryLine(memory) {
  const text = oneLine(memory?.judgment || memory?.content || '');
  if (!text) return '';
  return hasGroupLinkTag(memory) ? `- 群里发生过：${text}` : `- 你和用户私下聊过：${text}`;
}

/**
 * 组装单个成员的小节，整节（含标签与说明行）≤ `memberChars` 字，超长截断最后一条。
 * 一条都放不下时返回 null —— 调用方据此「没有记忆的成员不产出该小节」。
 *
 * 口径（产品已确认、**有意为之，不是泄漏**）：本小节只是把"她知道的事"告诉她本人；
 *   她**是否当众说出来由她自己决定** —— 成员会在群里主动讲出自己的私聊细节，这更像人，
 *   所以不做任何"禁止她提起"的硬约束（说明行里的"不要替她说出来"只约束**别的**角色）。
 */
export function buildMemberPrivateMemoryBlock(memberName, memories = [], { memberChars = GROUP_PRIVATE_MEMORY_MEMBER_CHARS } = {}) {
  // 名字进的是 XML 风格标签与说明行，去掉会破坏标签的字符（正常昵称不受影响）
  const name = (oneLine(memberName) || '角色').replace(/["<>&]/g, '');
  const limit = Number(memberChars);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const open = `<member_private_memory name="${name}">`;
  const notice = `【只有${name}自己知道，其他人不知情，也不要替她说出来】`;
  const close = `</member_private_memory>`;
  const head = `${open}\n${notice}`;
  const suffix = `\n${close}`;
  // 定长部分 = 开标签 + 说明行 + 正文前的换行 + 收尾换行 + 闭标签；每一行正文另算（含行间换行）
  const fixed = head.length + suffix.length + 1;
  if (fixed >= limit) return null;
  const bullets = memories.map(formatMemberPrivateMemoryLine).filter(Boolean).slice(0, GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER);
  if (bullets.length === 0) return null;

  const kept = [];
  let bodyChars = 0;   // 已放入正文的长度（含行间分隔符）
  for (const bullet of bullets) {
    const cost = (kept.length > 0 ? 1 : 0) + bullet.length;
    if (fixed + bodyChars + cost <= limit) {
      kept.push(bullet);
      bodyChars += cost;
      continue;
    }
    // 最后一条按剩余额度截断（留一个省略号）
    const remain = limit - fixed - bodyChars - (kept.length > 0 ? 1 : 0);
    if (remain >= MIN_TRUNCATED_TAIL) kept.push(`${bullet.slice(0, remain - 1)}…`);
    break;
  }
  if (kept.length === 0) return null;
  return `${head}\n${kept.join('\n')}${suffix}`;
}

/**
 * 群聊轮里给每个成员收集「只属于她」的私聊记忆小节。
 *
 * - 放在通用 directive 之后、催眠块之前（调用方决定位置）；
 * - 每人 ≤ `GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER` 条 / ≤ `GROUP_PRIVATE_MEMORY_MEMBER_CHARS` 字；
 *   全体合计 ≤ `resolveMemberMemoryBudget(人数)` 现算出来的**每轮预算**（人数 ×（每节字数 + 1），
 *   再被 `GROUP_PRIVATE_MEMORY_TOTAL_CHARS` 硬顶封顶），日志里的 N/M 用的就是这个 M；
 * - 只喂**真正的私聊记忆**：带 `群聊` tag 的 H2 记忆由读侧滤掉（见 `isMemberPrivateOnlyMemory`），
 *   这里再滤一遍兜住"自定义 readMemories 没过滤"的情况；
 * - 没记忆的成员不产出小节；额度用完的成员本轮不注入并打一条 log（不报错）；
 * - `config.features.memory === false` 时整体不注入；单成员读失败只 warn。
 *
 * @returns {{ blocks: string[], injected: Array<{id:number,name:string,count:number}>, skipped: Array<{id:number,name:string}>, chars: number, budget: number }}
 */
export function collectMemberPrivateMemoryBlocks(members = [], {
  readMemories = readMemberPrivateMemories,
  maxPerMember = GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER,
  memberChars = GROUP_PRIVATE_MEMORY_MEMBER_CHARS,
  totalChars = GROUP_PRIVATE_MEMORY_TOTAL_CHARS,
  enabled = isGroupMemoryLinkEnabled(),
} = {}) {
  const blocks = [];
  const injected = [];
  const skipped = [];
  if (!enabled) return { blocks, injected, skipped, chars: 0, budget: 0 };
  const memberList = (Array.isArray(members) ? members : [])
    .filter(member => Number.isInteger(Number(member?.id)) && Number(member?.id) > 0);
  // 每轮预算按人数现算（不再拿 hard-cap 当预算，否则 8 人 × 300 字 + 分隔符就装不下第 8 人）
  const budget = resolveMemberMemoryBudget(memberList.length, { totalChars, memberChars });
  let used = 0;
  for (const member of memberList) {
    const id = Number(member.id);
    const name = oneLine(member?.display_name || member?.name) || `角色${id}`;
    let memories = [];
    try {
      memories = readMemories(id, { limit: GROUP_PRIVATE_MEMORY_SCAN_LIMIT }) || [];
    } catch (err) {
      console.warn(`[memory] 私聊记忆读取失败（${name}）:`, err.message);
      continue;
    }
    const picked = rankPrivateMemories(
      memories.filter(isInjectablePrivateMemory).filter(isMemberPrivateOnlyMemory),
      maxPerMember,
    );
    if (picked.length === 0) continue;
    const block = buildMemberPrivateMemoryBlock(name, picked, { memberChars });
    if (!block) continue;
    const cost = block.length + (blocks.length > 0 ? 1 : 0);
    if (used + cost > budget) {
      skipped.push({ id, name });
      console.log(`[memory] 群聊私聊记忆注入额度已用完（${used}/${budget} 字），本轮跳过「${name}」`);
      continue;
    }
    used += cost;
    blocks.push(block);
    injected.push({ id, name, count: picked.length });
  }
  return { blocks, injected, skipped, chars: used, budget };
}
