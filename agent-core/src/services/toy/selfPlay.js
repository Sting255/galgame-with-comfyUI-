/**
 * services/toy/selfPlay.js —— **她自己主动玩玩具**（独立判断路径 + 独立 prompt 块）
 *
 * 用户原话：「不能强制角色自己玩玩具」。此前只有"**用户命令她戴**"这一条链路
 * （`force_toy|<toyKey>|<intensity>` / 面板点装备），她本人没有任何主动性 —— 本文件补的就是这条。
 *
 * ## 与"用户命令她戴"的区别（刻意分成两条，不要合并）
 * | | 用户命令线（`routes/toys.js` equip / 催眠 force_toy） | 本文件（主动线） |
 * | --- | --- | --- |
 * | 谁发起 | 用户 | **她自己**（judge 通过才动） |
 * | 门控 | `gateToy`（好感/授权/催眠豁免） | **不用 gateToy**：她用的是自己身上的东西，只受"她自己愿不愿意"约束 |
 * | prompt 块 | `<worn_toys>`（状态）+ `<hypnosis_command kind="force_toy">`（命令） | **`<self_toy_play>`（独立块）** |
 * | 反应 prompt | `buildToyReactionPrompt`（你给她戴/摘/调） | `buildSelfPlayPrompt`（她自己动手） |
 *
 * ## 判定（纯函数，输入全部注入 ⇒ 单测不需要 DB，也不需要 sleep）
 * 驱动量：好感/誓约、淫乱度、情绪唤醒、独处与否、催眠、当日次数、距上次间隔、是否被"逗"。
 * 硬门槛（不满足直接 `not_yet`，连随机都不掷）：好感 < `minAffinity` 或 淫乱度 < `minLewdness`；
 * 冷却与当日上限各自硬拦。其余按加权分与 `random()` 比一次 —— **她有权拒绝**（`held_back`）。
 *
 * ## 秘密 / 明着 / 独处（三种叙事口径）
 *   · 独处（`alone`）：直接玩，聊天里只留痕迹（你打断了她正在做的事）；
 *   · 你在场 + 关系够深够敢（`bold`）：当着你面用，带挑逗；
 *   · 你在场但还害羞（`secret`）：**偷偷用**，只能从身体细节泄露，不许说出口。
 */

import { hash01 } from './mechanics.js';
import { buildImagePromptRuleBlock } from '../../builtinRules.js';

/** 判定阈值：写在这里就是收口点，别再在调用方写一份 */
export const SELF_PLAY_THRESHOLDS = Object.freeze({
  minAffinity: 55,      // 好感底线：低于这个数她不会自己动玩具
  minLewdness: 20,      // 淫乱度底线
  score: 0.6,           // 判定分门槛（roll < score 才会真的动手）
  cooldownMin: 25,      // 两次主动之间的最短间隔（分钟）
  maxPerDay: 4,         // 一天最多几次
  boldAffinity: 85,     // 当着你的面也敢玩的好感线
  boldLewdness: 60,     // 且淫乱度要达到这条
  encourageBonus: 0.12, // 被"逗"一下的加成（只加分，**不越过任何硬门槛**）
});

/** 判定码：UI / 日志 / 测试都用它，别用中文串去比 */
export const SELF_PLAY_CODES = Object.freeze({
  PLAY: 'self_play',              // 她真的自己动手了
  HELD_BACK: 'held_back',         // 够格但这一下没上头（她自己收住了）
  NOT_YET: 'not_yet',             // 关系/淫乱度还没到
  COOLDOWN: 'cooldown',           // 离上次太近
  DAILY_LIMIT: 'daily_limit',     // 今天已经够多了
  SLEEPING: 'sleeping',           // 睡着（除非在催眠里被指令驱动）
  NO_TOY: 'no_toy',               // 没有可用玩具
});

/**
 * 淫乱度 0~100（**派生量**，不是新增列）：亲密行为次数 + 玩具历史 + 主动次数。
 * 权重写死在这里，就是为了"她越来越敢"这件事可被单测复算。
 */
export function lewdnessScore({ intimateActs = 0, toyEquips = 0, selfPlays = 0 } = {}) {
  const a = Math.min(1, Math.max(0, Number(intimateActs) || 0) / 30) * 50;
  const b = Math.min(1, Math.max(0, Number(toyEquips) || 0) / 20) * 30;
  const c = Math.min(1, Math.max(0, Number(selfPlays) || 0) / 10) * 20;
  return Math.round(Math.min(100, Math.max(0, a + b + c)));
}

/**
 * 主动玩的判断。
 *
 * @param {object} args
 * @param {number} args.affinity 好感
 * @param {boolean} args.isOath 誓约
 * @param {number} args.lewdness 淫乱度 0~100（`lewdnessScore` 派生）
 * @param {number} args.arousal 当前情绪唤醒 0~1（emotionEngine）
 * @param {boolean} args.alone 独处（没人在旁边）
 * @param {boolean} args.userPresent 用户在场
 * @param {boolean} args.hypnosisActive 在催眠中
 * @param {boolean} args.bodyControlled 完全控制
 * @param {boolean} args.sleeping 睡着
 * @param {'chat'|'group'} args.scene
 * @param {string[]} args.wornKeys 已戴
 * @param {string[]} args.availableKeys 可用的玩具 key（成年角色档案下的全部清单）
 * @param {number} args.minutesSinceLast 距上次主动多少分钟（Infinity = 从没做过）
 * @param {number} args.playsToday 今天已经主动几次
 * @param {boolean} args.encouraged 被用户逗了一下
 * @param {() => number} args.random 0~1 随机源（可注入 ⇒ 测试可复算）
 * @param {number} args.seed 选玩具/选模式的确定性种子（默认由 characterId 派生）
 * @returns {{play:boolean, code:string, reason:string, score:number, roll:number,
 *            action:'equip'|'bump'|null, toyKey:string|null, intensity:number, mode:string,
 *            curve:object|null, secret:boolean, bold:boolean, alone:boolean, lewdness:number}}
 */
export function decideSelfPlay({
  affinity = 0, isOath = false, lewdness = 0, arousal = 0,
  alone = false, userPresent = true, hypnosisActive = false, bodyControlled = false, sleeping = false,
  scene = 'chat', wornKeys = [], availableKeys = [], minutesSinceLast = Infinity, playsToday = 0,
  encouraged = false, random = Math.random, seed = 0, thresholds = SELF_PLAY_THRESHOLDS,
} = {}) {
  const t = { ...SELF_PLAY_THRESHOLDS, ...(thresholds || {}) };
  const aff = Number(affinity) || 0;
  const lewd = Math.max(0, Math.min(100, Number(lewdness) || 0));
  const worn = Array.isArray(wornKeys) ? wornKeys.filter(Boolean) : [];
  const available = Array.isArray(availableKeys) ? availableKeys.filter(Boolean) : [];
  const base = {
    play: false, code: SELF_PLAY_CODES.NOT_YET, reason: '', score: 0, roll: 1,
    action: null, toyKey: null, intensity: 0, mode: 'steady', curve: null,
    secret: false, bold: false, alone: Boolean(alone), lewdness: lewd,
  };
  const deny = (code, reason) => ({ ...base, code, reason });

  if (available.length === 0) return deny(SELF_PLAY_CODES.NO_TOY, '她手上没有可用的玩具。');
  if (sleeping && !hypnosisActive) return deny(SELF_PLAY_CODES.SLEEPING, '她睡着了，不会自己去动玩具。');
  if (aff < t.minAffinity || lewd < t.minLewdness) {
    return deny(SELF_PLAY_CODES.NOT_YET, '关系还没到那一步，她自己不会去碰那些东西。');
  }
  if (Number(minutesSinceLast) < t.cooldownMin) {
    return deny(SELF_PLAY_CODES.COOLDOWN, '上一次刚过去没多久，她还没缓过来。');
  }
  if (Number(playsToday) >= t.maxPerDay) {
    return deny(SELF_PLAY_CODES.DAILY_LIMIT, '今天已经够多次了，她自己也没那个力气。');
  }

  // ── 加权分：每项都在注释里写清权重来源，改权重就是改"她多久自己玩一次" ──
  const affSpan = Math.max(1, 100 - t.minAffinity);
  const affFactor = Math.max(0, Math.min(1, (aff - t.minAffinity) / affSpan));   // 关系底子 0~1
  let score = 0;
  score += affFactor * 0.3;                                    // 好感 0.30
  if (isOath) score += 0.08;                                   // 誓约额外 0.08
  score += (lewd / 100) * 0.3;                                 // 淫乱度 0.30（越大越主动）
  score += Math.max(0, Math.min(1, Number(arousal) || 0)) * 0.15; // 当前情绪唤醒 0.15
  if (alone) score += 0.15;                                    // 独处 0.15（没人看着更敢）
  if (hypnosisActive) score += 0.18;                           // 催眠中 0.18（身体更容易自己动起来）
  if (bodyControlled) score += 0.05;                           // 完全控制再加 0.05
  if (encouraged) score += t.encourageBonus;                   // 被逗 0.12
  if (scene === 'group') score -= 0.1;                         // 有人在群里看着，她会收着
  score = Math.max(0, Math.min(1, score));

  const roll = typeof random === 'function' ? Number(random()) : Number(random);
  const safeRoll = Number.isFinite(roll) ? roll : 1;
  if (!(safeRoll < score)) {
    return {
      ...base, code: SELF_PLAY_CODES.HELD_BACK, score, roll: safeRoll,
      reason: score >= t.score ? '她动了一下念头，最后还是忍住了。' : '她还没上头，只是有点心不在焉。',
    };
  }

  // ── 她真的动手了：挑一件（挑不到没戴的就把身上的调高/换模式）──
  const seedNum = Number(seed) || 0;
  const unworn = available.filter(k => !worn.includes(k));
  let action = 'equip';
  let toyKey = null;
  if (unworn.length > 0) {
    // 淫乱度越高越敢挑"里面那几件"：清单已按大胆度升序传入
    const idx = Math.min(unworn.length - 1, Math.floor((lewd / 100) * unworn.length));
    toyKey = unworn[idx];
  } else {
    action = 'bump';
    toyKey = worn[Math.floor(hash01(seedNum, worn.length + 1) * worn.length) % worn.length] || worn[0];
  }

  const mode = lewd >= 70 ? (hash01(seedNum, 7) >= 0.5 ? 'random' : 'wave')
    : (lewd >= 45 ? 'pulse' : 'steady');
  const curve = lewd >= 80
    ? { type: 'ramp_up', from: 1, to: 5, durationSec: 900, loop: false }
    : (lewd >= 60 ? { type: 'wave', from: 1, to: 4, durationSec: 600, loop: true } : null);
  const intensity = action === 'equip'
    ? Math.max(1, Math.min(5, Math.round(1 + lewd / 25)))
    : 0; // bump 时由调用方在现有档位上 +1

  const bold = Boolean(userPresent) && !alone && aff >= t.boldAffinity && lewd >= t.boldLewdness;
  const secret = Boolean(userPresent) && !alone && !bold;
  const reason = bold
    ? '她当着你面就伸手去拿，一点遮掩的意思都没有。'
    : secret
      ? '她趁你没在看的时候，偷偷把玩具用上了。'
      : '一个人待着，她自己动手了。';
  return {
    play: true, code: SELF_PLAY_CODES.PLAY, reason, score, roll: safeRoll,
    action, toyKey, intensity, mode, curve, secret, bold, alone: Boolean(alone), lewdness: lewd,
  };
}

// ── 她自己动手的即时反应 prompt（与"用户命令"分开的一条）───────────────────────

/**
 * 自主反应 prompt：**完整 JSON 示例**（字段名 + 示例值 + 每字段要求），
 * 见 AGENTS.md「LLM 输出」三条硬要求。比命令线多两个字段：
 * `inner_thought`（她心里那句，不一定会说出口）与 `hidden`（有没有藏住），
 * 解析用 `parseSelfPlayOutput`（同一处收口，别在路由里自己 JSON.parse）。
 */
export function buildSelfPlayPrompt({
  toyLabel = '玩具', part = '身上', effect = '', intensity = 1, maxIntensity = 5,
  mode = 'steady', modeRhythm = '', modePhaseText = '', curve = null, curveText = '',
  action = 'equip', secret = false, bold = false, alone = false, hypnosisActive = false,
  lewdness = 0, userName = '用户', extraContext = '',
} = {}) {
  const doing = action === 'bump' ? '自己把身上那件的档位又调高了' : '自己动手把那件东西用上了';
  const how = bold
    ? '她就当着' + userName + '的面做这件事，不躲也不解释。'
    : secret
      ? '她**偷偷**做的：' + userName + '在旁边，她不想被看出来，所以只能从身体细节泄露（呼吸、坐姿、突然的停顿、一句话说到一半断掉），**不许直接说出口**。'
      : '她一个人待着的时候做的，正好被打断。';
  const system = [
    '你在扮演一个成年角色。下面这件事是**她自己主动做的**（不是' + userName + '命令她，也不是' + userName + '替她戴上的），请以第一人称给出她的即时反应。',
    '事实：她' + doing + '「' + toyLabel + '」（' + part + '），当前 ' + intensity + '/' + maxIntensity + ' 档；模式：' + (modeRhythm || mode) + '，此刻' + (modePhaseText || '正在被刺激') + '。',
    effect ? ('这件玩具的效果语义：' + effect) : '',
    curveText ? ('强度曲线：' + curveText) : '',
    '她的状态：淫乱度 ' + lewdness + '/100' + (hypnosisActive ? '，正处于催眠中（更容易顺着身体的冲动走）' : '') + '。',
    how,
    extraContext ? ('额外上下文：' + extraContext) : '',
    '',
    '【写作要求】',
    '- reaction_text：1~4 句第一人称中文，写身体与情绪的真实反应（自己动手的那种"明知道不该、但还是做了"的紧张与快感）。',
    '- 悄悄玩时：**不许出现"我把玩具用上了/我戴上了"这类直白交代**，只写身体与语气的异常。',
    '- image_prompt：英文，直接描述此刻正在发生的画面——姿势、表情、身体反应、衣着现状、玩具的位置与可见形态（手上的动作、内裤轮廓、被含住的乳尖等）。不要用暗示性遮掩，如实描述。',
    '- inner_thought：一句中文内心独白（她心里在说什么/在忍什么，10~30 字）。',
    '- emotion_delta：三个数值（valence / arousal / dominance），范围 -0.3~0.3，自己玩时 arousal 冲得更高、dominance 略升。',
    '- facial_expression：一个简短的中文表情词（如「脸红咬唇」「眼神躲开」「失神」）。',
    '- annoyed：布尔，她被打断得不耐烦/被撞见尴尬为 true，否则 false。',
    '- hidden：布尔，她有没有把这件事藏住（悄悄玩且没被发现 = true）。',
    '',
    '严格按下面的 JSON 输出，不要输出任何解释或 JSON 以外的文字：',
    '{',
    '  "reaction_text": "（她的反应，1~4 句第一人称中文；偷偷玩时只写身体细节，不交代自己做了什么）",',
    '  "image_prompt": "english: she is alone with the toy on herself, pose, expression, clothing state, where the toy is and how it shows",',
    '  "inner_thought": "（一句内心独白，10~30 字中文）",',
    '  "emotion_delta": { "valence": 0.06, "arousal": 0.24, "dominance": 0.05 },',
    '  "facial_expression": "脸红咬唇",',
    '  "annoyed": false,',
    '  "hidden": true',
    '}',
    '',
  // Authoritative image rules: the author requires this block in EVERY image path.
  // Without it a multi-character frame collapses into one person / a merged blob.
  buildImagePromptRuleBlock(),
].filter(Boolean).join('\n');
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: '（现在给出她这一刻的反应）' }],
    temperature: 0.85,
    max_tokens: 560,
  };
}

/**
 * 主动线输出解析：复用触摸链的 `parseReactionOutput`（同一套越界夹取口径），
 * 再补两个本线独有字段。**解析失败不写脏数据**（ok=false）。
 * @param {string} text LLM 原文
 * @param {(text:string)=>object} parseReaction 解析器（注入以便单测；默认由 toyService 传 touchActionService.parseReactionOutput）
 */
export function parseSelfPlayOutput(text, parseReaction) {
  const base = typeof parseReaction === 'function'
    ? parseReaction(text)
    : { ok: false, error: 'no parser', reactionText: '', imagePrompt: '', emotionDelta: null, facialExpression: '', annoyed: false };
  if (!base || base.ok !== true) {
    return { ...(base || {}), ok: false, innerThought: '', hidden: false };
  }
  let parsed = null;
  try {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
  } catch (err) {
    parsed = null;
  }
  const inner = parsed && typeof parsed.inner_thought === 'string' ? parsed.inner_thought.trim().slice(0, 60) : '';
  const hidden = parsed ? parsed.hidden === true : false;
  return { ...base, innerThought: inner, hidden };
}

// ── 独立 prompt 块（<self_toy_play>）────────────────────────────────────────────

/** 块长上限：照 `hypnosisPrompt.MAX_COMMAND_BLOCK_CHARS` 的先例，超了会被截断，所以钉住 */
export const MAX_SELF_PLAY_BLOCK_CHARS = 700;

/**
 * `<self_toy_play>`：她自己动手这件事的注入块。
 *
 * **与 `<worn_toys>` 完全分开**（独立函数、独立标签）：`<worn_toys>` 说的是"身上有什么、
 * 现在什么状态"，本块说的是"**这是她自己做的**"。混进一条会让模型把她自己的主动性演成
 * 用户命令（本任务明确要求分开）。
 *
 * @returns {string} 空输入返回 `''`（调用方据此零注入）
 */
export function buildSelfPlayBlock({
  toyLabel = '', part = '', effect = '', intensity = 1, maxIntensity = 5,
  mode = 'steady', modeRhythm = '', curveText = '', secret = false, bold = false, alone = false,
  action = 'equip', lewdness = 0, minutesAgo = 0, scene = 'chat', subjectName = '', userName = '用户',
} = {}) {
  const label = String(toyLabel || '').trim();
  if (!label) return '';
  const who = String(subjectName || '').trim() || '她';
  const you = String(userName || '').trim() || '用户';
  const lines = [];
  if (scene === 'group') lines.push('【本节只对「' + who + '」生效】');
  lines.push('<self_toy_play>');
  lines.push('【这是她自己做的——不是' + you + '的命令，也不许写成"被要求"】');
  const doing = action === 'bump' ? '自己把' + label + '的档位调高了' : '自己把' + label + '用上了';
  const when = minutesAgo > 0 ? ('（' + minutesAgo + ' 分钟前）') : '（刚刚）';
  lines.push(who + '趁没人管的时候' + doing + when + '：' + part + '，' + intensity + '/' + maxIntensity + ' 档，模式「' + (modeRhythm || mode) + '」。');
  if (effect) lines.push('它带来的感觉：' + effect);
  if (curveText) lines.push('强度还在变：' + curveText);
  if (bold) {
    lines.push('她是**当着' + you + '的面**做的，不打算遮掩：可以带一点挑衅/求关注的味道，但别写成炫耀式解说。');
  } else if (secret) {
    lines.push('她是**偷偷**做的：只能从身体细节泄露（呼吸变浅、坐姿换了、句子说到一半断掉、突然安静），**绝对不许自己交代"我用了玩具"**；' + you + '也没看出来。');
  } else {
    lines.push('她是一个人待着时做的（' + who + '独处）：被打断时会有被打断的不耐烦或慌张，看情境选一种。');
  }
  lines.push('淫乱度 ' + lewdness + '/100：这个数越高，她越不当回事、越容易顺着身体走。');
  lines.push('【别做的事】不要把这段写成状态解说，也不要在正文里复述上面任何一句设定；只让她这一轮的语气、动作、呼吸体现出来。');
  lines.push('</self_toy_play>');
  let block = lines.join('\n');
  if (block.length > MAX_SELF_PLAY_BLOCK_CHARS) block = block.slice(0, MAX_SELF_PLAY_BLOCK_CHARS);
  return block;
}
