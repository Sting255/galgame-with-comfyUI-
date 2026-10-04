/**
 * groupScriptProtocol.js —— 群聊「输出协议 + 剧本行解析」纯函数簇（§5.1 第 2 刀，纯搬家，2026-09-30）
 *
 * **纯搬家产物**：下列 8 个函数与它们私有的正则/常量从 groupChatEngine.js **逐字节**搬来，
 * 逻辑一行未动、导出名一个未改；groupChatEngine.js 仍从本文件 import + re-export 同一批符号
 * （对外面完全不变，intimateBackfill.js 等老调用方不受影响）。
 *
 * 职责：buildProtocolBlock（稳定块 [1] 输出协议）/ detectMentions / detectMentionAll /
 * formatGroupUserMessage（用户消息只读标记）/ extractEmbeddedGroupImagePrompt /
 * formatGroupImageLine（行协议解析）/ mergeGroupContinuationEmoji / parseScriptLine。
 *
 * 依赖方向：只依赖 config / db.getGlobalRule（只读系统规则）/ utils.groupImagePrompt /
 * emojiService，**不 import groupChatEngine**（避免循环依赖 / TDZ）。
 */

import { config } from '../config.js';
import { getGlobalRule } from '../db/index.js';
import { isImageRuleEcho, isImageRuleEchoStart, isPlaceholderImagePrompt } from '../utils/groupImagePrompt.js';
import { parseGroupEmojiText } from './emojiService.js';

export function detectMentions(text, members) {
  const hits = [];
  for (const m of members) {
    if (!m.display_name || m.display_name.length < 1) continue;
    if (text.includes(`@${m.display_name}`) || (m.display_name.length >= 2 && text.includes(m.display_name))) {
      hits.push(m);
    }
  }
  return hits;
}

// ── @全体成员（@所有人 / @全员）──
/** 与单人 @点名 区分：命中即要求本轮每一位群成员都发言 */
const MENTION_ALL_RE = /@\s*(?:全体成员|所有人|全员|全体)/;

export function detectMentionAll(text) {
  return MENTION_ALL_RE.test(String(text || ''));
}

/**
 * 稳定块 [1]：输出协议 + 活人感规则
 * 全局不变（仅依赖用户昵称和全局图片规则），排在群名片之前：
 * 所有群共享这段前缀缓存，且改群名/成员不会连带使协议部分失效
 */
export function buildProtocolBlock() {
  const chatUserName = config.user.nickname || '用户';
  const imagePromptFieldGuide = (getGlobalRule('image_prompt')?.rule_content || '').trim();
  // 规范原文单独成块放在协议末尾：内联进协议行的「{}」里会被模型当成要照抄的模板，
  // 直接输出成 `{Describe the image as ...}`，既污染气泡又烧掉整轮输出预算。
  const imageRulesBlock = imagePromptFieldGuide
    ? `\n\n<image_prompt_rules>\n（以下规范只决定 {} 里的英文画面描述怎么写。它是写作规范、不是要填进 {} 的内容，任何情况下都不得原样出现在群聊消息里）\n${imagePromptFieldGuide}\n</image_prompt_rules>`
    : '';
  return `<group_chat_rules>
你一个人扮演群聊中的【全部角色】，根据聊天记录续写接下来的群聊消息。

输出协议（严格遵守）：
- 每条消息独占一行，格式为「角色名: 消息内容」，角色名必须是 <group_info> 中的群成员名字
- 每轮有消息条数上限（按群人数与话题动态设定，见本轮指令中的“消息上限”）；上限只是最多条数、不是必须凑满，全部说完后最后单独一行输出 [END]
- **禁止替用户「${chatUserName}」发言**
- <user_message read_only="true">...</user_message> 是真实用户已经说过的话，只用于理解上下文；禁止输出该标记，禁止续写或模仿其中的用户发言
- 发图只有一种合法格式：角色先发一条普通文字说自己在拍什么，下一行紧跟同一位角色的发图行；发图行 = 角色名 + 冒号 + 空格 + 一对成对的花括号，花括号里放这张图的完整英文画面描述（怎么写见文末 <image_prompt_rules>），形如：
  角色名: 给你们看
  角色名: {a girl in a yukata holding a sparkler on a rooftop at night, warm lantern light}
- 上面两行只是格式示范，台词和那串英文都要换成你自己这一轮的台词和画面；花括号里只能是本轮新写的英文画面描述，不许写中文、不许写规范原文或本协议文字
- 严禁用「[拍了一张图]」「[举起手机]」「（发来照片）」等动作、旁白或占位符代替花括号画面描述；出现发图意图就必须输出合法发图行
- 历史聊天不会提供旧图片的画面描述或占位符；禁止凭空输出空的 {...}，花括号内必须是本轮新写的完整英文画面描述
- 输出发图行前自行检查：**{}内必须是本轮新写的、全英文的场景描写**

像真人一样聊天：
- 口语化、短句，长短错落：很多消息只有几个字、一个语气词或一个即时反应，例如“？？？”“不是吧”“啊？”“行吧”“救命”“然后呢”；禁止每条都是完整、工整的书面句
- 可以省略主语、使用半句话、停顿和口头衔接，例如“我刚才差点……”“不是，你先等会儿”“主要是吧”“算了当我没说”；但不要所有人都使用同一种口癖
- 同一个人可以把一句话拆成两三条连续发送，也可以刚说完就被别人插话。示例（A/B/C 仅表示不同角色，不要原样输出字母）：
  A: 等下
  A: 你认真的？
  C: 我就知道会这样
- 接话要紧贴上一条，而不是每个人各说各的。示例：
  A: 我已经在路上了
  B: 你半小时前也这么说
  A: 这次是真的
  C: 信不了一点
- 日常话题可以一问一答、顺手追问，不需要每句话都推进剧情。示例：
  A: 我刚点了奶茶
  B: 什么味
  A: 芋泥
  B: 给我留一口
- 偶尔需要解释、吐槽或讲事情时可以说稍长一句，随后立刻穿插短反应；不要把所有消息机械地切成相同长度
- 谁有话谁说，同一个人可以连发几条；也允许有人潜水不说话，不必人人到场
- 角色之间互动要真实：接梗、抬杠、拆台、开玩笑、追问细节、@点名怼人都可以，别一团和气互相吹捧
- 允许小跑题：聊着聊着岔开话题、想起别的事，比"围着主题开会"更像真群聊
- 每个角色严守自己的人格、口癖、和其他人的关系，说话方式必须一眼能区分；禁止重复别人刚说过的意思
- 爱发图：聊到正在做的事、看到的东西、吃的喝的、去过的地方、自拍表情包时，主动配一张图
- 禁止括号动作描写、禁止方括号动作描写、禁止旁白、禁止总结式客套发言；颜文字可以正常使用，但不能把动作藏进括号
${imageRulesBlock}
</group_chat_rules>`;
}

/** 用户发言使用独占的只读标记，不再伪装成与角色相同的「名字: 台词」格式。 */
export function formatGroupUserMessage(content, chatUserName = config.user.nickname || '用户') {
  let text = String(content || '');
  const marked = text.match(/^<user_message read_only="true">\n?([\s\S]*?)\n?<\/user_message>$/);
  if (marked) return text;

  // 兼容旧记录：[用户名]: 内容 / 用户名: 内容。
  const escapedName = String(chatUserName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text.replace(new RegExp(`^\\[?${escapedName}\\]?\\s*[:：]\\s*`), '');
  return `<user_message read_only="true">\n${text}\n</user_message>`;
}

const EMBEDDED_IMG_RE = /\{([^{}]*)\}/g;

// 画面描述规则上限 800 字；超过两倍说明模型复读的不是画面而是整段文本（如规范原文）
const MAX_GROUP_IMAGE_PROMPT_CHARS = 2000;

/**
 * 兜底提取任意位置的 {...}。群聊协议将花括号保留给生图，因此即使模型把它
 * 单独换行或粘在台词后面，也不能让其中内容进入聊天气泡。
 */
export function extractEmbeddedGroupImagePrompt(body) {
  const source = String(body || '');
  const matches = [...source.matchAll(EMBEDDED_IMG_RE)];
  if (matches.length === 0) return null;

  const prompts = matches.map((match) => {
    let prompt = match[1].trim();
    const fieldWrapped = prompt.match(/^["'“”]?prompt["'“”]?\s*:\s*([\s\S]+)$/i);
    if (fieldWrapped) prompt = fieldWrapped[1].trim().replace(/^["'“]|["'”]$/g, '').trim();
    return prompt && !/^\.{3}$/.test(prompt) ? prompt : null;
  }).filter(Boolean)
    .filter(prompt => !isImageRuleEcho(prompt) && !isPlaceholderImagePrompt(prompt))
    .filter(prompt => prompt.length <= MAX_GROUP_IMAGE_PROMPT_CHARS);

  // 同一行出现多个花括号块时合并为一次图片任务，并确保所有块都不会泄漏到气泡。
  const text = source.replace(EMBEDDED_IMG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { prompt: prompts.length > 0 ? prompts.join(', ') : null, text };
}

/** 将纠错后的图片指令统一写回当前群聊协议格式。 */
export function formatGroupImageLine(speakerName, prompt) {
  return `[${String(speakerName || '').trim()}]: {${String(prompt || '').trim()}}`;
}

/**
 * 将无说话人的续写行合并到上一条群聊气泡，并按该说话人的表情包名册解析标记。
 */
export function mergeGroupContinuationEmoji(rec, continuation, emojiMap = new Map(), categoryKeys = []) {
  const parsed = parseGroupEmojiText(continuation, emojiMap, categoryKeys);
  if (parsed.invalidEmoji) return null;

  const images = [...new Set([...(rec.images || []), ...parsed.images])];
  const content = parsed.content
    ? (rec.content ? `${rec.content}\n${parsed.content}` : parsed.content)
    : (rec.content || '');
  return { content, images, hasImage: images.length > 0 };
}

/** 解析一行剧本。返回 {speaker, text, imagePrompt} 或 null（无效行） */
export function parseScriptLine(line, membersByName) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^\[?END\]?$/i.test(trimmed)) return { end: true };

  const m = trimmed.match(/^\[?([^:：\[\]]{1,20})\]?\s*[:：]\s*([\s\S]*)$/);
  if (!m) {
    // 防御：模型把生图规范原文当成一条消息输出（多为半截、花括号未闭合）→ 整行丢弃
    if (isImageRuleEchoStart(trimmed)) return null;
    const embeddedImage = extractEmbeddedGroupImagePrompt(trimmed);
    if (embeddedImage) {
      if (!embeddedImage.prompt) {
        return embeddedImage.text ? { continuation: embeddedImage.text } : null;
      }
      return {
        continuation: embeddedImage.text || null,
        imagePrompt: embeddedImage.prompt,
      };
    }
    return { continuation: trimmed };
  }

  const name = m[1].trim();
  const body = m[2].trim();
  // 防御：模型把生图规范原文当成这个角色的消息输出 → 整行丢弃
  if (isImageRuleEchoStart(body)) return null;
  const member = membersByName.get(name);
  // 有说话人格式但不是群成员：整行丢弃，避免用户台词被拼进上一位角色气泡。
  if (!member) return null;
  if (!body) return null;
  // 防御：模型照抄 transcript 里的图片占位符 → 丢弃，发图必须走 {...} 格式
  if (/^\[?发了一张图片\]?$/.test(body)) return null;
  if (/^<image_sent\s*\/>$/i.test(body)) return null;

  const embeddedImage = extractEmbeddedGroupImagePrompt(body);
  if (embeddedImage) {
    const visibleText = embeddedImage.text
      .replace(/\[[^\]]*(?:拍|自拍|照片|图片|手机|镜头|发来)[^\]]*\]/g, '')
      .trim();
    if (!embeddedImage.prompt) return visibleText ? { speaker: member, text: visibleText } : null;
    return {
      speaker: member,
      text: visibleText || null,
      imagePrompt: embeddedImage.prompt,
    };
  }

  // 防御：丢弃模型用方括号伪装的发图动作，发图只能走 {...}。
  if (/\[[^\]]*(?:拍|自拍|照片|图片|手机|镜头|发来)[^\]]*\]/.test(body)) {
    const cleaned = body.replace(/\[[^\]]*(?:拍|自拍|照片|图片|手机|镜头|发来)[^\]]*\]/g, '').trim();
    return cleaned ? { speaker: member, text: cleaned } : null;
  }
  return { speaker: member, text: body };
}
