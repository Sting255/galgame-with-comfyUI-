/**
 * 角色生图人格统一组装入口
 *
 * 全库所有「角色 base_prompt / short_prompt + ## 你的外观」的生图人格拼接统一走这里，
 * 便于管理外观注入口径（此前各模块内联实现，正则锚点/截断边界/人称替换互不一致）。
 *
 * 两种 variant 对应历史两大拼接口径：
 *   - 'short'（默认）：short_prompt + 「## 你的外观」段到末尾。多角色参考/群聊资料卡/梦境等用。
 *   - 'full'：整卡 base_prompt（缺失时回退 short_prompt）。needImage 配图/日程拍照/事件/礼物/信件等用。
 *
 * 外观注入（角色外观系统）：当角色存在生效中的限时服饰（通用，可多套叠加）或
 * 角色专属形态（同时至多一套）时，外观段重组为三段式：
 *   标题行 → 【限时服饰/角色专属形态】清单 → 【基础外观】原正文（降级为填补参考）→ 【着装裁定】收尾。
 * 裁定放在末尾（收尾位置权重最高），逐条明确「整体替换、禁止混搭、被覆盖的原发型/原发色
 * 必须消失」——历史问题：基础外观的 danbooru 标签（如 pink hair）会把限时服饰已改写的部位
 * 又带回生成画面，仅靠一句优先级说明压不住。无特殊外观时输出与旧逻辑一致。
 */

import { getActiveOutfits } from './outfitService.js';
import { config } from '../config.js';
// 2026-10-02：她此刻戴着什么（跨场景可见）。走**注册表叶子**而不是直接 import toyService ——
// toyService 本来就 import 本文件，反过来 import 会成环。
import { wornToysBrief } from './wornToysBrief.js';
// 人格裁剪抽在零依赖的叶子模块里：emotionEngine 反过来 import 本文件（它要用 buildCharacterPersona），
// 所以这里**不能**直接 import emotionEngine（会成环，还会把 db/llm 拖进这个被 58 处引用的模块）。
import { cropPersonalityForEmotion } from './personalityCrop.js';

const APPEARANCE_HEADING_RE = /##\s*你的外观/;

// 「你」→ 第三人称名时跳过非人称代词的复合词：
//   迷｜你（迷你）、你｜们（你们）、你｜我（你我/你追我赶）、你｜好（你好）、你｜死（你死我活）。
// 历史问题：全量 replace(/你/g) 会把「迷你裙」写成「迷<角色名>裙」、「你们」写成「<角色名>们」。
const SECOND_PERSON_RE = /(?<!迷)你(?!们|我|好|死)/g;

/** 把第二人称「你」替换为角色名；person 为空时原样返回。 */
function toThirdPerson(text, person) {
  if (!person) return text;
  return String(text).replace(SECOND_PERSON_RE, () => person);
}

/**
 * 提取「## 你的外观」段（含标题，截到字符串末尾）。
 * 角色卡标准结构中外观是最后一段（见 routes/characters.js buildPersonaSystemPrompt），
 * 因此「到末尾」与「到下一个 ##」等价。
 * @param {string} basePrompt
 * @returns {string} 无该标题时返回 ''
 */
export function extractAppearanceSection(basePrompt) {
  const base = String(basePrompt || '');
  const m = base.match(APPEARANCE_HEADING_RE);
  return m ? base.slice(m.index) : '';
}

/**
 * 由生效外观生成注入文本块（纯函数，便于测试）。
 * 返回三段，由 injectOutfitsIntoAppearance 组装：
 *   - lead：特殊外观清单，安插在「## 你的外观」标题之后、原正文之前；
 *   - baseLabel：原正文的降级标注（写明冲突描述无效）；
 *   - tail：着装裁定，安插在原正文之后收尾（收尾位置权重最高，压制基础外观标签带偏）。
 * 着装裁定按生效外观组合分三种（两者都有 / 只有限时 / 只有专属）；无任何生效外观时返回 null。
 * @param {{limited?: Array<{name,description}>, exclusive?: {name,description}|null}} outfits
 * @returns {{lead: string, baseLabel: string, tail: string}|null} 无任何生效外观时返回 null
 */
export function buildOutfitInjectionBlocks(outfits, opts = {}) {
  const limited = Array.isArray(outfits?.limited) ? outfits.limited : [];
  const exclusive = outfits?.exclusive || null;
  if (limited.length === 0 && !exclusive) return null;

  // 归属（2026-10-02 用户：「角色的衣服容易串到一起」）：
  //   下面这些话原本是**无主**的 ——「画面必须完整呈现以下全部要素」「着装裁定（优先级…）」。
  //   单角色生图没问题；但多人同场（群聊成员卡 / 多人事件 / 朋友圈 / 梦境）时，
  //   模型读到"画面必须完整呈现全部要素"就会**把限时服饰穿到所有人身上**，
  //   并把各人的衣服配饰混着写 ⇒ 用户看到的正是"衣服串到一起"。
  //   所以：只要调用方给了 owner（多角色路径都会给），每段都写上**这是谁的**，
  //   并追加一条"不得混穿"的硬约束；**不给 owner 时输出与改动前逐字节一致**（单角色路径不受影响）。
  const owner = String(opts?.owner || '').trim();
  const own = owner ? `${owner}的` : '';

  const leadParts = [];
  if (limited.length > 0) {
    const lines = limited.map((o, i) => `${i + 1}. ${o.name}：${o.description}`);
    const head = owner
      ? `【${own}限时服饰（当前生效，优先级最高，多套同时叠加）——**只在描绘${owner}时**完整呈现以下全部要素，不要穿到同场其他角色身上】`
      : '【限时服饰（当前生效，优先级最高，多套同时叠加）——画面必须完整呈现以下全部要素】';
    leadParts.push(`${head}\n${lines.join('\n')}`);
  }
  if (exclusive) {
    // 只有专属形态时没有更高优先级，标注为最高
    const rank = limited.length > 0 ? '优先级次之' : '优先级最高';
    const head = owner
      ? `【${own}角色专属形态（当前生效，${rank}）——**只用在${owner}身上**，不要给同场其他角色】`
      : `【角色专属形态（当前生效，${rank}）——画面必须完整呈现以下全部要素】`;
    leadParts.push(`${head}\n1. ${exclusive.name}：${exclusive.description}`);
  }

  // 特殊外观指代与优先级说明按生效外观组合三选一（都无时本函数已返回 null，整段不注入）
  const both = limited.length > 0 && exclusive;
  const special = both ? '限时服饰与角色专属形态' : (limited.length > 0 ? '限时服饰' : '角色专属形态');
  const order = both
    ? '限时服饰 > 角色专属形态 > 基础外观'
    : (limited.length > 0 ? '限时服饰 > 基础外观' : '角色专属形态 > 基础外观');
  const baseLabel = owner
    ? `【${own}基础外观（仅用于填补${special}未提及的部位，与${special}冲突的描述无效）】`
    : `【基础外观（仅用于填补${special}未提及的部位，与${special}冲突的描述无效）】`;

  const replaceRule = both
    ? `- ${own}限时服饰与角色专属形态描写到的每个部位（发型、发色、服装、饰品、鞋袜等），其全部属性（颜色、长度、款式、材质）按上述优先级取最高者的描写，必须完全照此描绘——这是对基础外观对应部位的整体替换，不是叠加。`
    : `- ${own}${special}描写到的每个部位（发型、发色、服装、饰品、鞋袜等），其全部属性（颜色、长度、款式、材质）必须完全按${special}描绘——这是对基础外观对应部位的整体替换，不是叠加。`;
  const tailLines = [
    owner ? `【${own}着装裁定（只适用于${owner}一个人；优先级：${order}，逐条执行）】` : `【着装裁定（优先级：${order}，逐条执行）】`,
    replaceRule,
    `- ${own}基础外观中与上述特殊外观同部位或相冲突的描述一律作废，禁止出现在画面与提示词中；尤其当特殊外观改变了发型或发色时，${own || ''}基础外观的原发型、原发色必须完全消失，不得再出现。`,
    // 刻意不把「发型」列进沿用基础外观的部位举例（发型/发色是最常被限时服饰改写的部位）
    `- 只有特殊外观完全未提及的部位（瞳色、五官、体型等）才沿用基础外观。`,
  ];
  // 多人同场专用硬约束：不加这句，模型会把各角色的衣服/配饰来回串（用户 2026-10-02 的反馈）
  if (owner) {
    tailLines.push(`- **以上整段只属于${owner}一个人**：同场其他角色穿什么、戴什么、什么发型，与${owner}无关；不要把别人的衣服饰品写到${owner}身上，也不要把${owner}的着装写到别人身上。`);
  }

  return { lead: leadParts.join('\n\n'), baseLabel, tail: tailLines.join('\n') };
}

/**
 * 把注入块安插进外观段，重组为三段式：标题行 → 特殊外观清单 → 基础外观（降级标注）→ 着装裁定。
 * 原文没有外观段时补一个「## 你的外观」段（此时无基础外观正文，不加 baseLabel）。
 * @param {string} appearance extractAppearanceSection 的返回值（可为 ''）
 * @param {{lead, baseLabel, tail}|null} blocks buildOutfitInjectionBlocks 的返回值（null 时不做任何事）
 * @returns {string}
 */
export function injectOutfitsIntoAppearance(appearance, blocks, opts = {}) {
  if (!blocks) return appearance;
  const { lead, baseLabel, tail } = blocks;
  // 无外观段时的兜底标题：给了 owner 就写成「## 德丽莎的外观」，否则维持原来的「## 你的外观」
  // （多人同场时"你的外观"会被读成"当前正在写的那个人的外观" ⇒ 正是衣服串味的入口之一）
  const owner = String(opts?.owner || '').trim();
  const fallbackHeading = owner ? `## ${owner}的外观` : '## 你的外观';
  if (!appearance.trim()) return `${fallbackHeading}\n${lead}\n\n${tail}`;
  const headingEnd = appearance.indexOf('\n');
  if (headingEnd === -1) return `${appearance}\n${lead}\n\n${tail}`;
  const heading = appearance.slice(0, headingEnd);
  const body = appearance.slice(headingEnd + 1);
  if (!body.trim()) return `${heading}\n${lead}\n\n${tail}`;
  return `${heading}\n${lead}\n\n${baseLabel}\n${body}\n\n${tail}`;
}

/**
 * 从人格卡最前面截取「名字 + IP」身份语料，供修正外观时作为身份上下文传给视觉模型
 * （见 routes/characters.js refine-appearance）：取首个空行前的段落，找到「来自」后取其之后
 * 第一个句号，从头截到该句号（含），并去掉卡片口吻前缀「你是」。
 * 例：你是Cyrene(Cyrene)。\n来自《崩坏：星穹铁道》。 → Cyrene(Cyrene)。\n来自《崩坏：星穹铁道》。
 * 「来自」只在开头段落里找：正文里更靠后的「来自」会把语料拉出整段身份设定。
 * 找不到「来自」或其后的句号（原创角色卡）时回退为 fallbackName。
 * @param {string} basePrompt
 * @param {string} [fallbackName] - 回退用语料（一般传 display_name）
 * @returns {string} 空卡且无 fallbackName 时返回 ''
 */
export function extractAppearanceIdentityCorpus(basePrompt, fallbackName = '') {
  const base = String(basePrompt || '');
  const paraEnd = base.indexOf('\n\n');
  const head = paraEnd >= 0 ? base.slice(0, paraEnd) : base.slice(0, 300);
  const laiIdx = head.indexOf('来自');
  if (laiIdx >= 0) {
    const periodIdx = head.indexOf('。', laiIdx);
    if (periodIdx >= 0) {
      return base.slice(0, periodIdx + 1).replace(/^你是/, '').trim();
    }
  }
  return String(fallbackName || '').trim();
}

/**
 * 把整卡 base_prompt 按「## 你的外观」段切开，返回外观段之外的前后文。
 * 供「外观正文可编辑」的场景（routes/characters.js refine-appearance）在前端重组：
 * 重组公式恒为 before + '## 你的外观\n' + body + after，口径仍收口在本文件。
 * @param {string} basePrompt
 * @returns {{ before: string, after: string }}
 */
export function splitAppearanceSection(basePrompt) {
  const base = String(basePrompt || '');
  const m = base.match(APPEARANCE_HEADING_RE);
  if (!m) return { before: `${base.trimEnd()}\n\n`, after: '' };
  const next = base.indexOf('\n## ', m.index + 1);
  return {
    before: base.slice(0, m.index),
    after: next >= 0 ? base.slice(next) : '',
  };
}

/**
 * 用新外观正文重组 base_prompt 的「## 你的外观」段（不落库，由调用方决定去留）：
 * 已有该段 → 原位替换到下一个「## 」标题（外观段通常是最后一段，没有则替换到末尾）；
 * 没有该段 → 在卡末补一段。
 * @param {string} basePrompt
 * @param {string} newAppearanceBody - 新外观正文（不含「## 你的外观」标题行）
 * @returns {string}
 */
export function replaceAppearanceSection(basePrompt, newAppearanceBody) {
  const base = String(basePrompt || '');
  const section = `## 你的外观\n${String(newAppearanceBody || '').trim()}`;
  const m = base.match(APPEARANCE_HEADING_RE);
  if (!m) return `${base.trimEnd()}\n\n${section}`;
  const next = base.indexOf('\n## ', m.index + 1);
  const tail = next >= 0 ? base.slice(next) : '';
  return base.slice(0, m.index) + section + tail;
}

/**
 * 判断 base_prompt 的修改是否仅限「## 你的外观」段（含该段的增删）。
 * 以标题为界比较前缀：标题之前的正文一致（仅容忍标题前收尾空白的增删）即视为纯外观修改；
 * 两卡完全一致也返回 true（同样无需重生成）。
 * short_prompt（emotionEngine 的裁剪与 LLM 浓缩，后者明确排除外观描写）与日程模板人格
 * 都只取外观段之前的文本，纯外观修改无需触发它们重生成（routes/characters.js PUT /:id 用）。
 * @param {string} oldBase
 * @param {string} newBase
 * @returns {boolean}
 */
export function isAppearanceOnlyPromptChange(oldBase, newBase) {
  const oldStr = String(oldBase || '');
  const newStr = String(newBase || '');
  const oldM = oldStr.match(APPEARANCE_HEADING_RE);
  const newM = newStr.match(APPEARANCE_HEADING_RE);
  const oldPrefix = oldM ? oldStr.slice(0, oldM.index) : oldStr;
  const newPrefix = newM ? newStr.slice(0, newM.index) : newStr;
  return oldPrefix.trimEnd() === newPrefix.trimEnd();
}

/**
 * 组装角色完整外观段（含标题「## 你的外观」与生效外观注入）。
 * 供需要单独拿外观段的场景使用（如表情包 system3，自行决定是否保留标题行）。
 * @param {object} character - 至少含 base_prompt（注入查询需要 id）
 * @param {object} [opts] - 同 buildCharacterPersona 的 opts.outfits
 * @returns {string} base_prompt 无外观段且无生效外观时返回 ''
 */
export function buildCharacterAppearanceSection(character, opts = {}) {
  const outfits = resolveOutfits(character, opts.outfits);
  const appearance = extractAppearanceSection(character?.base_prompt);
  // 多角色场景调用方会传 opts.person（角色名）⇒ 着装段带上归属，避免"衣服串到一起"；
  // 不传时输出与改动前逐字节一致（单角色生图路径不受影响）
  const owner = typeof opts.person === 'string' ? opts.person : '';
  const withOutfits = injectOutfitsIntoAppearance(
    appearance,
    buildOutfitInjectionBlocks(outfits, { owner }),
    { owner },
  );
  // 2026-10-02 跨场景穿戴可见（用户原话：「如果戴上玩具之后 没有摘下的情况下 在其他的地方出图也得要
  // 看到玩具的所在…就算角色戴着玩具 但是就是没有出来玩具的图 这个是很不真实的」）——
  // 外观段是所有生图路径的必经之处，玩具接在这里 ⇒ 私聊图 / 群聊图 / 朋友圈图 / 亲密图 / 立绘 /
  // 报纸…全部自动带上。没戴（或玩具服务尚未加载）⇒ 空串 ⇒ 零注入、与改动前逐字节一致。
  const toys = wornToysBrief(character?.id, { scene: opts.scene, person: owner });
  return toys ? `${withOutfits}\n${toys}` : withOutfits;
}

function resolveOutfits(character, outfits) {
  if (outfits === null) return { limited: [], exclusive: null };
  if (outfits && typeof outfits === 'object') {
    if (Array.isArray(outfits)) return { limited: outfits, exclusive: null };
    return outfits;
  }
  return getActiveOutfits(character?.id);
}

/**
 * ★ 统一入口：组装角色生图人格。
 *
 * @param {object} character - characters 表行（至少含 base_prompt；short variant 还需要 short_prompt 与 id）
 * @param {object} [opts]
 * @param {'short'|'full'} [opts.variant='short'] - 'short' = short_prompt + 外观段（皆空时兜底整卡）；
 *                                                  'full' = 整卡 base_prompt（缺失回退 short_prompt）
 * @param {string|null} [opts.person=null] - 把该部分文本中的「你」替换为它（如 display_name、'角色'）。
 *                                           short variant 只替换外观段（short_prompt 本就是第三人称）；full variant 替换整卡。
 * @param {'auto'|null|Array|{limited,exclusive}} [opts.outfits='auto'] - 外观来源：
 *                                           'auto'/缺省 = 按 character.id 查询生效外观并注入；
 *                                           null = 不注入；数组 = 视作多套限时服饰；对象 = 显式 {limited, exclusive}
 * @param {string} [opts.joiner='\n'] - short variant 中 short_prompt 与外观段的连接符
 * @returns {string}
 */
export function buildCharacterPersona(character, opts = {}) {
  const variant = opts.variant || 'short';
  const person = typeof opts.person === 'string' ? opts.person : null;
  const joiner = typeof opts.joiner === 'string' ? opts.joiner : '\n';
  const outfits = resolveOutfits(character, opts.outfits);

  if (variant === 'full') {
    const base = String(character?.base_prompt || character?.short_prompt || '');
    const appearance = extractAppearanceSection(base);
    const injected = injectOutfitsIntoAppearance(appearance, buildOutfitInjectionBlocks(outfits, { owner: person }), { owner: person });
    let result;
    if (appearance) {
      result = base.slice(0, base.length - appearance.length) + injected;
    } else if (injected) {
      result = `${base.trimEnd()}\n\n${injected}`;
    } else {
      result = base;
    }
    return toThirdPerson(result, person);
  }

  // short variant
  // ⚠️ 2026-10-02：人格**不再读库里那份 `short_prompt`**。
  //    历史原因：`cropPersonalityForEmotion` 旧口径把人格硬截成 200 字（真实数据：德丽莎整卡 2212 字
  //    ⇒ 实际只有 200 字 = 9%，还切在半句上），而库里 8 个角色存的 `short_prompt` 正是那个旧口径的产物
  //    ⇒ 群聊成员资料卡 / 梦境 system3 / 多角色参考 otherPersona / maibot 桥**全都吃不到裁剪修复**。
  //    所以改成**运行时从 `base_prompt` 现裁**（与 `routes/characters.js` 同一口径），
  //    既不用写库、不用迁移（用户存档一个字节不动），也顺手摆脱了"库里那份可能已被浓缩坏掉"的隐患。
  //    兜底：`base_prompt` 为空或裁不出内容时，仍然退回库里那份 `short_prompt`（有总比没有好）。
  const basePrompt = String(character?.base_prompt || '');
  const storedShort = String(character?.short_prompt || '').trim();
  const displayName = String(character?.display_name || '').trim();
  // 现裁结果**只顶替原来那份 short_prompt 的位置**：
  //   · 这行本来有 short_prompt（真角色卡都是）⇒ 用人格现裁替换它（本债的目标）；
  //   · 这行没有 short_prompt（小镇 NPC、只有 persona 的行）⇒ **保持旧口径**（人格留空、只用外观段）——
  //     它们的 persona 常是一句人物速写，塞进"素材/外观需求"里是噪音（`townAssetRequest.test.js` 钉着这条）。
  const short = storedShort
    ? (basePrompt ? cropPersonalityForEmotion(basePrompt, person || displayName || 'assistant').trim() : '') || storedShort
    : '';
  const appearance = extractAppearanceSection(basePrompt);
  if (!short && !appearance) {
    // short_prompt 与外观段皆空：兜底整卡（与旧 maibot/dreamService 口径一致），
    // 此时无处锚定注入，跳过外观注入
    return basePrompt.trim();
  }
  let appearancePart = injectOutfitsIntoAppearance(appearance, buildOutfitInjectionBlocks(outfits, { owner: person }), { owner: person }).trim();
  appearancePart = toThirdPerson(appearancePart, person);
  return [short, appearancePart].filter(Boolean).join(joiner);
}

/**
 * 生图交叉参考信息（私聊 needImage / 画风测试共用）：身份行 + 外观段（含外观注入），
 * 「你」→角色名替换。
 * @param {object} char - characters 表行（至少含 base_prompt, display_name）
 * @param {object} [opts] - 同 buildCharacterPersona 的 opts.outfits / opts.variant 无关字段
 * @returns {string}
 */
export function buildImageCrossRefInfo(char, opts = {}) {
  const base = String(char?.base_prompt || '');
  const person = char?.display_name || '';
  const parts = [];

  const nl = base.indexOf('\n');
  const firstLine = (nl >= 0 ? base.slice(0, nl) : base).trim();
  if (firstLine) {
    let cut = -1;
    let start = 0;
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === '，' || firstLine[i] === '。') {
        if (firstLine.slice(start, i).includes('来自')) { cut = i; break; }
        start = i + 1;
      }
    }
    const identity = (cut >= 0 ? firstLine.slice(0, cut) : firstLine).replace(/^你是/, '').replace(/。$/, '').trim();
    if (identity) parts.push(identity);
  }

  const appearance = extractAppearanceSection(base);
  // ★ 交叉参考**永远**带归属：这段是"画面里还有谁"的说明，多人同框时最容易被穿错衣服，
  //   所以这里不做"可选 owner"——一律用 char.display_name 写清这是谁的着装。
  const injected = injectOutfitsIntoAppearance(
    appearance,
    buildOutfitInjectionBlocks(resolveOutfits(char, opts.outfits), { owner: person }),
    { owner: person },
  );
  if (injected) {
    parts.push(toThirdPerson(injected, person));
  }
  return parts.join('\n');
}

/**
 * 用户（玩家本人）的生图交叉参考信息：画面里提到用户名字时注入其自述资料。
 *
 * 用户不是 characters 表的一行，没有身份行、没有外观段、没有 LoRA，资料唯一来源是
 * config.user（性别 / 外观 / 说明三项自述）。与 buildImageCrossRefInfo 对齐：只返回
 * 内容，不含 `[名字]` 标题行（标题由调用方拼），调用方也不得把用户并入角色 LoRA 列表。
 * @returns {string}
 */
export function buildUserImageCrossRefInfo() {
  const parts = [];
  if (config.user?.gender) parts.push(`性别：${config.user.gender}`);
  if (config.user?.appearance) parts.push(`外观：${config.user.appearance}`);
  if (config.user?.persona) parts.push(`其他说明：${config.user.persona}`);
  // 三项全空时不能返回空串：空块会让模型只看到标题行而自由发挥用户长相
  if (parts.length === 0) return '（用户未填写个人资料，按普通人处理）';
  return parts.join('；');
}

/**
 * 玩家信息块（私聊 / 群聊的**唯一入口**）
 * 2026-10-02 用户反馈：「角色对话还是有一些不遵从设定，和玩家的性别与自我描述」。
 *
 * 为什么必须收口到这一个函数：
 *   原先私聊（`routes/chat.js` 的 `<user_info>`）与群聊（`services/groupChatEngine.js` 的「用户信息：」）
 *   各拼一份，而且**都只是事实陈述**（"性别：男。其他说明：学校的老师"）；紧挨着的 `<user_relation>`
 *   却写着"这个身份为最高优先级" ⇒ 模型自然把性别/自述当**参考资料**而不是**设定**，
 *   于是出现"把玩家写成女生""用角色自己的身份替代玩家身份"这类跑偏。
 *   所以这里除了拼事实，还必须带上**遵从约束**，并且私聊/群聊共用同一份措辞，避免两条链再次跑偏。
 *
 * 取舍（写在这儿免得以后有人改坏）：
 *   · 字段缺失时**省略**该字段，不写"性别：未说明"这类空壳（空壳会被模型当成"确实未定"从而自由发挥）；
 *   · 三项全空时也只保留"发言来自真实用户" + 遵从约束，不再要求调用方另行兜底；
 *   · `opts.style` 只影响**称呼**：私聊按 prompt 里的 `user` 标记，群聊按群里显示的昵称；
 *   · `opts.worldHint`（默认开）追加一句"世界观里的性别措辞按玩家性别理解" —— 用来抵消
 *     部分世界观文本面向女性而玩家性别为男时的冲突（**只改提示词，不动 `world_settings` 数据**）。
 *
 * @param {{nickname?:string, gender?:string, persona?:string, appearance?:string}} [user] 传 `config.user`
 * @param {{style?:'chat'|'group', worldHint?:boolean, displayName?:string}} [opts]
 * @returns {string} 可直接塞进 prompt 的文本（不含外层标签，标签由调用方保留）
 */
export function buildUserInfoBlock(user = {}, opts = {}) {
  // 只认字符串：`config.user.*` 都是文本字段，`null / undefined / 数字 / 对象` 一律当作"没填"，
  // 否则 `appearance: 0` 会被 String() 变成 "外观特征：0" 这种空壳（单测③钉住了这条）。
  const pick = (v) => (typeof v === 'string' ? v.trim() : '');
  const style = opts.style === 'group' ? 'group' : 'chat';
  const name = pick(opts.displayName) || pick(user?.nickname) || '用户';

  const facts = [];
  if (pick(user?.gender)) facts.push(`性别：${pick(user.gender)}`);
  if (pick(user?.appearance)) facts.push(`外观特征：${pick(user.appearance)}`);
  if (pick(user?.persona)) facts.push(`其他说明：${pick(user.persona)}`);

  const who = style === 'group'
    ? `群里标记为「${name}」的发言来自真实用户`
    : `消息中标记为"user"的人是"${name}"`;

  const lines = [facts.length ? `${who}。${facts.join('。')}` : who];
  // 这一句是本次修复的核心：把玩家信息从"参考资料"升级为"必须遵从的设定"。
  // ⚠️ 措辞与 `services/wakeService.js` 里同名构造器**逐字一致**（那边服务"叫醒/延迟回复"两条链，
  //    这边服务"私聊/群聊"两条链）—— 同一个概念两份实现是可耻的，但两条链的**话术**绝不能不一样，
  //    否则模型在不同场景收到不同口径，用户感知仍然是"时灵时不灵"。统一口径由收尾提交负责。
  lines.push('以上是玩家本人的真实设定：性别、身份与自我描述以此为准，不要写成相反性别，也不要用你自己的性别或身份替代。');
  if (opts.worldHint !== false) {
    lines.push('（世界观里出现的性别措辞，一律按玩家自身的性别理解。）');
  }
  return lines.join(' ');
}
