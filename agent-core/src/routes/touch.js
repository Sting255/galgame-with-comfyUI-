/**
 * SLG 动作系统（触摸互动）HTTP 接口 —— 阶段一（私聊 MVP）+ 阶段二（群聊动作 / 唤醒文案 / 新鲜度）
 *
 * 挂载：`app.js` 的 `app.use('/api/characters', wrapRouterAsync(touchRoutes))`。
 * 位置必须**早于** charactersRoutes（它的 `/:id` 通配会先吃掉这一族子路径），且**不能夹进**
 * intimate → characters 的紧邻区间（test/intimateApi.test.js 断言两者之间不夹别的挂载）。
 *
 * 端点：
 *   GET  /api/characters/:id/touch/actions   动作清单 + 逐条门控（前端动作条直接渲染；web-ui 不能 import agent-core）
 *   GET  /api/characters/:id/touch/state     每动作 { annoyance, tier, likeRatio } + 配额（阶段二面板用）
 *   POST /api/characters/:id/touch/:action   body { mode?: 'auto'|'instant'|'implicit', scene?, groupId? }
 *
 * 分层：门控 / 腻烦 / prompt / 解析 / 新鲜度判定全在零依赖纯函数 `services/touchActionService.js`
 * （docs/touch-system.md §1~§3）；本文件只做"读既有系统的值 → 调纯函数 → 落库 / 调模型 / 发消息"。
 * 动作块注入在两条消费链上：私聊 `routes/chat.js` 的 5.55 段、群聊 `services/groupChatEngine.js`
 * 的 `collectTouchActionBlocks()`（阶段二）。
 *
 * 口径（2026-09-30，Lead 裁决，逐条有注释）：
 *   · 门控拒绝 = HTTP **200** + `{ allowed:false, code, message }`（message 已是人话，前端直接 toast）；
 *     非法动作 / 非法角色 = 400，角色不存在 = 404，总开关关闭 = 409；
 *   · **instant 反应真的落库**：
 *     - 私聊：复用 `proactiveChatScheduler.writeProactiveMessage`（raw_messages + 分段 messages、
 *       is_proactive=1）并广播 `proactive_message`；
 *     - 群聊（task-17 阶段二）：写进 `group_<gid>` 会话 + `broadcast('group_message')`（形状逐字对齐
 *       `groupChatEngine.serializeMsg()`）—— 群聊页只认这条统一流事件（专题 §2.2「插入式发言」）；
 *   · 每日配额**独立计数**（system_settings 两个键，本地日期翻篇，0 = 不限，默认 100）：耗尽自动回落隐式；
 *   · Lv3 动作命中 `intimateActKey` 时**记一笔亲密看板流水**（2026-09-30 task-16 裁决：复用冻结管线、
 *     不新增 act_key；锚点 `touch:<touch_events.id>:<actKey>` ⇒ 一次动作只记一笔，重放幂等）；
 *   · 睡着时做重动作（tickle / pinch_cheek）→ 门控给 `wakesSleeping` → 这里调 `tempWake`（5 分钟，
 *     mode='phone'）**并挂 `wake_reaction`**（复用 `hypnosisService.attachWakeReaction`，task-17）：
 *     「被摸醒」要演惊醒/恍惚，不能只是悄悄醒了；
 *   · **事件新鲜度窗口**（task-17）：pending/done 超过 `touchActionService.TOUCH_EVENT_TTL_MS`（30 分钟）
 *     即作废（标 `expired`、不再注入）。判定只有一处：`touchEventCutoff()`，私聊 / 群聊两条链共用；
 *     本文件在每个入口（GET/POST）顺手清扫一次；
 *   · 群聊场景校验：群必须存在、且她必须是该群成员（否则事件永远没人消费）—— 404 / 400。
 */

import { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { chatSync } from '../llm/llm-client.js';
import { localDateKey, parseSqlUtc } from '../services/programTime.js';
// 2026-10-02：把"这场戏正进行到哪"也喂进反应 prompt ——
// 用户原话：「插入之后可以选一个自动继续插入 然后我可以继续去抚摸或者拍屁股捏其他地方或者插入玩具之类的」
// ⇒ 他一边插着一边拍她 / 摸她，在她眼里必须是**同一场戏**，不是两件无关的事。
import { buildIntimateScenePromptBlock } from '../services/intimateActionService.js';
import {
  DEFAULT_TOUCH_THRESHOLDS,
  TOUCH_LEVEL_LABELS,
  TOUCH_MODES,
  annoyanceTier,
  buildReactionPrompt,
  getTouchGate,
  listTouchActions,
  nextAnnoyance,
  normalizeTouchRequest,
  parseReactionOutput,
  resolveTouchMode,
  TOUCH_IMAGE_MODE_LABELS,
  TOUCH_IMAGE_MODES,
  buildTouchImagePrompt,
  normalizeTouchImageMode,
  shouldGenerateTouchImage,
  // task-30 对话式反应（默认）：全量喂料版 builder + 默认窗口
  buildConversationReactionPrompt,
  CONVERSATION_RECENT_LINES,
} from '../services/touchActionService.js';
import { buildImagePromptRuleBlock } from '../builtinRules.js';
import {
  emotionToPrompt,
  evolveEmotion,
  affinityToPrompt,
  loadAffinity,
  loadEmotionState,
  loadOath,
  saveEmotionSnapshot,
} from '../services/emotionEngine.js';
import { isBodyControlled, attachWakeReaction, getHypnosisState } from '../services/hypnosisService.js';
// 「图好了补挂到那条气泡上」的事件名与载荷口径（群聊/私聊两套 store 各认一条 —— 见模块头）
import { reactionImageUpdate } from '../services/reactionImageUpdate.js';
import { isSleeping, tempWake, formatScheduleContext } from '../services/scheduleManager.js';
// task-30 新喂料块：复用聊天轮/群聊轮的既有 builder，一行不重写
import { buildHypnosisStateBlock } from '../services/hypnosisPrompt.js';
import { buildIntimateProfileBlock } from '../services/intimatePrompt.js';
import { isAiEditAllowed, recordIntimateActs } from '../services/intimateService.js';
import { broadcastProactiveMessage } from '../services/notificationBus.js';
import { writeProactiveMessage } from '../services/proactiveChatScheduler.js';
import { broadcast } from '../services/unifiedStreamBus.js';
// 事件存取（读取 / 消费 / 过期清扫）：服务层唯一实现，见 task-24 P2-2
import { countPendingTouchEvents, countPendingTouchEventsByMode, expireStaleTouchEvents, parseStrictGroupId } from '../services/touchEventStore.js';
// §一③（三期）：围观决策纯函数（只读复用，不改 group 线）——即时反应顺带拉一位旁观者
import { planTouchBystander } from '../services/groupTouchConsumption.js';
// 2026-10-02：亲密刺激的**统一下游**（用户原话：「现在的玩具和催眠和心情和记忆好像是完全解耦的
// 一样 根本就没关联」）—— 触摸也推进敏感条、也写心情与记忆，不再只有推进面板自己那一套。
import { applyIntimateStimulus } from '../services/intimateStimulus.js';
// 出图联动（task-19）：复用既有生图链路（imageSkill）+ 既有落盘/记账入口，不新造 ComfyUI 调用
import { generateImage } from '../services/imageSkill.js';
import { saveBase64Image } from '../services/imagePaths.js';
import { recordCompletedImageTask } from '../services/imageTaskRecorder.js';

// §九 建议 3（2026-09-30）：私聊后台补图的**生命周期兜底** —— 超过这个时间没出图就放弃（只 warn），
// 避免 ComfyUI 挂死时那条 update 永远不来。90s 覆盖单卡串行排队的最坏情况（实测尾部 17~43s）。
export const TOUCH_IMAGE_BG_TIMEOUT_MS = 90_000;
import { buildCharacterAppearanceSection } from '../services/characterPersona.js';
import { charArtistOverride } from '../services/characterImageOpts.js';
import { invalidateGalleryCache } from './images.js';
// 统计聚合（task-19）：只读服务
import { getTouchStats, TOUCH_IMAGE_TASK_STYLE } from '../services/touchStatsService.js';
// 立绘表情联动（task-19）：立绘是服务端独占通道（只有 publishStandingKeys 能推表情），复用既有实现
import { getStandingDisplay, publishStandingKeys } from '../services/standingDisplay.js';
import { getCharacterEmojiMap } from '../services/emojiService.js';
import { randomUUID } from 'node:crypto';

const router = Router();

/** 睡着时被重动作弄醒的临时唤醒窗口（分钟）：与催眠触发前的 5 分钟同口径，确定性（不随机） */
export const TOUCH_WAKE_MINUTES = 5;

const DEFAULT_EMOTION_BASELINE = { valence: 0.5, arousal: 0.5, dominance: 0.5 };

// ── 开关（键由 Lead 在 config.js 加；**不存在 = 开**，所以加键前行为不变、加完零改动生效）──

/** 总开关：`config.features.touch`；关闭时所有写操作 409（读动作清单不拦，前端才好显示"功能已关闭"） */
function isTouchEnabled() {
  return config.features?.touch !== false;
}

/** 即时反应开关（"省额度模式"）：`config.features.touchInstant`；关掉后全部走隐式注入 */
function isInstantEnabled() {
  return config.features?.touchInstant !== false;
}

/**
 * 出图档位：`config.features.touchImageMode`（`always | smart | never`，**默认 smart**）。
 * 归一逻辑在服务层纯函数 `normalizeTouchImageMode`（非法/缺失一律回落 smart）。
 */
function readTouchImageMode() {
  return normalizeTouchImageMode(config.features?.touchImageMode);
}

/** 既有出图总开关：`imageGenMode === 'off'` 时一律不出图（本仓没有图片配额概念，故只尊重这个总开关） */
function isGlobalImageEnabled() {
  return config.features?.imageGenMode !== 'off';
}

/** 角色自己的 lora（与 chat.js / proactiveChatScheduler 同口径：character.loras 是 JSON 数组，脏数据忽略） */
function parseCharLoras(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter(l => l && l.path) : [];
  } catch {
    return [];
  }
}

/**
 * 真实出图实现：调既有 `imageSkill.generateImage` → `saveBase64Image` 落盘 → 返回 URL 列表。
 * 与 chat.js 的配图链路同一条（同样的 loras / customWorkflow / 画师串拼装），不新造 ComfyUI 调用。
 */
async function defaultTouchImageGenerator(character, prompt, { scene = 'chat' } = {}) {
  const opts = {};
  const loras = parseCharLoras(character.loras);
  if (loras.length > 0) opts.loras = loras;
  if (character.custom_workflow) opts.customWorkflow = character.custom_workflow;
  const artist = charArtistOverride(character);
  if (artist !== null) opts.artist = artist;
  const result = await generateImage(prompt, { scene, ...opts });
  if (!result?.success || !result.images?.length) {
    return { urls: [], promptRefined: result?.promptRefined || prompt, error: result?.error || 'no images' };
  }
  const urls = [];
  for (const img of result.images) {
    const filename = Date.now() + '_' + (img.filename || 'comfy.png');
    urls.push(saveBase64Image('chat', filename, img.base64));
  }
  return { urls, promptRefined: result.promptRefined || prompt };
}

let touchImageGenerator = defaultTouchImageGenerator;

/** 测试接缝（与 intimateAiEdit / intimateAiJudge 同款做法）：换成假生成器就不会真去连 ComfyUI（也不落盘） */
export function __setTouchImageGeneratorForTest(fn) {
  touchImageGenerator = typeof fn === 'function' ? fn : defaultTouchImageGenerator;
}

/**
 * 出图联动（task-19）：档位 → 判定 → 组 prompt → 生成。
 *
 * 失败一律只 warn 且返回 null —— **绝不影响动作本身**（反应消息、事件落库、记账都不受牵连）。
 * @returns {Promise<{urls:string[], prompt:string, promptRefined:string}|null>}
 */
/** §一③：群里除她以外的成员行（围观候选；调用方已校验过 id 是群成员） */
function readGroupMemberRows(groupId) {
  try {
    return getDb().prepare(
      'SELECT c.id, c.name, c.display_name FROM group_members m JOIN characters c ON c.id = m.character_id WHERE m.group_id = ?'
    ).all(Number(groupId)) || [];
  } catch (err) {
    console.warn('[touch] 读取群成员失败（本轮不拉围观）:', err?.message || err);
    return [];
  }
}

/**
 * §一③：把 LLM 写在 reaction_text 末尾的围观行（`[名字]: 台词`）拆出来。
 * 命中就返回她的正文 + 围观台词（围观台词由调用方作为**另一个角色**的群消息发出去）。
 */
function splitBystanderLine(text, name) {
  const raw = String(text || '');
  const who = String(name || '').trim();
  if (!who) return { herText: raw.trim(), bystanderText: '' };
  const escaped = who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp('^\\s*\\[?' + escaped + '\\]?\\s*[:：]');
  const kept = [];
  const taken = [];
  for (const line of raw.split(/\r?\n/)) {
    if (lineRe.test(line)) taken.push(line.replace(lineRe, '').trim());
    else kept.push(line);
  }
  return { herText: kept.join('\n').trim(), bystanderText: taken.join(' ').trim() };
}

async function generateTouchImageForReaction({ character, action, reactionText, imagePrompt = '', annoyance, scene = 'chat' }) {
  try {
    const mode = readTouchImageMode();
    // 概率缩放由**调用方**传进去（touchActionService 是零依赖模块，自己不读 config）
    if (!shouldGenerateTouchImage({
      mode,
      level: action?.level || 1,
      enabled: isGlobalImageEnabled(),
      chanceScale: config.features?.touchImageChanceScale,
    })) return null;
    const prompt = buildTouchImagePrompt({
      actionKey: action?.key || '',
      appearance: buildCharacterAppearanceSection(character, { outfits: 'auto' }),
      reactionText,
      // 专题三期 §一①：优先用这一轮反应里 LLM 现写的画面（图文同源）；缺失才回落 TOUCH_IMAGE_HINTS
      imagePrompt,
      annoyance,
      scene,
    });
    if (!prompt) return null;
    const result = await touchImageGenerator(character, prompt, { scene });
    if (!result?.urls?.length) {
      console.warn('[touch] 出图失败（不影响动作）:', result?.error || 'no images');
      return null;
    }
    return { urls: result.urls, prompt, promptRefined: result.promptRefined || prompt };
  } catch (err) {
    console.warn('[touch] 出图异常（不影响动作）:', err?.message || err);
    return null;
  }
}

/** 把图片 URL 并进 messages.images（与 chat.js 一致：合并去重，不覆盖已有图） */
function attachImagesToMessage(msgId, urls) {
  if (!msgId || !urls?.length) return [];
  try {
    const row = getDb().prepare('SELECT images FROM messages WHERE id = ?').get(msgId);
    let existing = [];
    try { existing = JSON.parse(row?.images || '[]'); } catch { existing = []; }
    const merged = [...new Set([...(Array.isArray(existing) ? existing : []), ...urls])];
    getDb().prepare('UPDATE messages SET images = ? WHERE id = ?').run(JSON.stringify(merged), msgId);
    invalidateGalleryCache();
    return merged;
  } catch (err) {
    console.warn('[touch] 挂图失败:', err?.message || err);
    return [];
  }
}

/** 记账到 image_tasks（style='touch-action'）：相册能看到这次出图，统计端点也据此数「出图数」 */
function recordTouchImageTask({ conversationId, prompt, promptRefined, urls }) {
  try {
    recordCompletedImageTask({
      conversationId,
      promptOriginal: prompt,
      promptRefined,
      outputPaths: urls,
      style: TOUCH_IMAGE_TASK_STYLE,
    });
  } catch (err) {
    console.warn('[touch] 出图记账失败（不影响图片本身）:', err?.message || err);
  }
}

/**
 * 立绘表情联动（task-19 ②）：按即时反应里的 `facial_expression` 推一次立绘表情。
 *
 * 立绘是**服务端独占**通道（前端只有 state / active 两个只读接口），既有唯一驱动点是 chat.js 的
 * `publishStandingKeys(standingTurn, emojiKeys)`；这里**复用同一套**：
 *   ① 立绘窗口切到她（chat.js 也是先 select；同一角色时是 no-op）；
 *   ② `begin(characterId, turnId)` → `publishStandingKeys(turn, [key])` → `complete(turn)`；
 *   ③ 表情 key 从她的表情包 Map（key 就是中文名，如「害羞」）里**匹配** `facial_expression`：
 *      精确 → 包含 → 被包含；匹配不到就跳过（不报错、不猜）。
 *
 * @returns {string|null} 命中的 emoji key（诊断用；没命中就是 null）
 */
function driveStandingExpression(characterId, facialExpression) {
  const label = String(facialExpression || '').trim();
  if (!label) return null;
  try {
    const emojiMap = getCharacterEmojiMap(characterId);
    const keys = [...emojiMap.keys()];
    if (keys.length === 0) return null;
    const hit = keys.find(k => k === label)
      || keys.find(k => label.includes(k))
      || keys.find(k => k.includes(label));
    if (!hit) return null;
    const display = getStandingDisplay();
    display.select(characterId);
    const turn = display.begin(characterId, randomUUID());
    publishStandingKeys(turn, [hit]);
    display.complete(turn);
    return hit;
  } catch (err) {
    console.warn('[touch] 立绘表情联动失败（不影响动作）:', err?.message || err);
    return null;
  }
}

/**
 * 群聊 Lv3（敏感档）开关：`config.features.touchGroupAdult`，**默认关**。
 *
 * 关着的时候群聊里的 Lv3 一律 `group_adult_blocked`（隐私边界：别在群里当众演限制级）——
 * 这与加这个开关之前的行为**完全一致**；用户在设置页显式打开后才放行。
 * 前端 `GET .../touch/actions?scene=group` 会拿到生效值（返回体的 `allowGroupAdult`），别自己写死 false。
 */
function isGroupAdultAllowed() {
  return config.features?.touchGroupAdult === true;
}

// ── 每日即时反应配额（独立计数；机制照 services/intimateAiJudge.js 的 aiJudge 配额）──
//
// 为什么独立：即时反应是小调用，但用户连点动作条会持续烧额度 ⇒ 专题 §2.1 要求"独立计数 + 耗尽回落隐式"。
// 键名写进 docs/touch-system.md，设置页将来要调就调这两个键（本文件不碰 config.js / db/settings.js）。

/** 每日上限设置键（0 = 不限制） */
export const TOUCH_INSTANT_LIMIT_SETTING_KEY = 'touch_instant_daily_limit';
/** 计数键：一行存 { date, used }，跨天自动归零 */
export const TOUCH_INSTANT_QUOTA_SETTING_KEY = 'touch_instant_quota';
/** 默认上限：100 次/天（专题没给数字，2026-09-30 Lead 批准以此为准，可配） */
export const DEFAULT_TOUCH_INSTANT_DAILY_LIMIT = 100;

function readSettingValue(key) {
  return getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(key) ?? null;
}

function writeSettingValue(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
  ).run(key, String(value));
}

/** 规整上限：0（不限）或正整数；其余（负数 / 小数 / 非数字 / 空）→ null（回落默认） */
export function normalizeTouchInstantLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function getTouchInstantDailyLimit() {
  try {
    const parsed = normalizeTouchInstantLimit(readSettingValue(TOUCH_INSTANT_LIMIT_SETTING_KEY));
    return parsed === null ? DEFAULT_TOUCH_INSTANT_DAILY_LIMIT : parsed;
  } catch {
    return DEFAULT_TOUCH_INSTANT_DAILY_LIMIT;
  }
}

/** 库读写都挂掉时的内存兜底（至少同进程内数得住；重启会重置） */
let memoryQuota = { date: null, used: 0 };

function readUsedToday(date) {
  try {
    const raw = readSettingValue(TOUCH_INSTANT_QUOTA_SETTING_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (parsed?.date !== date) return 0; // 跨天：昨天的不算今天
    const used = Number.parseInt(parsed?.used, 10);
    return Number.isFinite(used) && used > 0 ? used : 0;
  } catch {
    return null; // 读不到 → 交给内存兜底
  }
}

/** 配额三件套：{ dailyLimit, usedToday, remaining, unlimited, exhausted } */
export function buildTouchQuotaStatus(dailyLimit, usedToday) {
  const limit = normalizeTouchInstantLimit(dailyLimit) ?? DEFAULT_TOUCH_INSTANT_DAILY_LIMIT;
  const used = Math.max(0, Number.parseInt(usedToday, 10) || 0);
  const unlimited = limit === 0;
  return {
    dailyLimit: limit,
    usedToday: used,
    remaining: unlimited ? null : Math.max(0, limit - used),
    unlimited,
    exhausted: !unlimited && used >= limit,
  };
}

export function getTouchQuotaStatus({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  const used = stored !== null ? stored : (memoryQuota.date === date ? memoryQuota.used : 0);
  return buildTouchQuotaStatus(getTouchInstantDailyLimit(), used);
}

/** 真正要调模型之前消耗一次配额（与 aiJudge 同口径：只在真的会调模型时扣） */
function consumeTouchQuota({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  const base = stored !== null ? stored : (memoryQuota.date === date ? memoryQuota.used : 0);
  const used = base + 1;
  memoryQuota = { date, used };
  try {
    writeSettingValue(TOUCH_INSTANT_QUOTA_SETTING_KEY, JSON.stringify({ date, used }));
  } catch (err) {
    console.warn('[touch] 配额计数写库失败，计数暂只存在内存:', err?.message || err);
  }
  return buildTouchQuotaStatus(getTouchInstantDailyLimit(), used);
}

// ── 动作偏好 like_ratio：一次性初始化 + 每轮微调（task-24 P1-1）──────────────
//
// 背景：改动前 `like_ratio` 是**死字段** —— 只有 upsertStateRow 写它，写的永远是读出来的旧值，
// 于是全角色手感一致、【你的偏好】永远显示「谈不上偏好（1.00）」。
// 现在：① 首次对该角色做动作时，按人格卡**一次批量调用**给出 16 个动作的偏好（幂等，标记落 system_settings）；
//       ② 每次即时反应按她的反应微调：annoyed ×0.95（下限 0.5）、valence>0.1 ×1.05（上限 2）。
// 两者都是旁路：失败只 warn，**绝不让动作本身失败**。

/** 偏好初始化的幂等标记（system_settings，每角色一行；只在**成功**时写） */
export const TOUCH_LIKE_RATIO_INIT_KEY_PREFIX = 'touch_like_ratio_init_';
/** 初始化允许区间（专题 §2.1：0.5~1.5，1 = 谈不上偏好） */
export const TOUCH_LIKE_RATIO_INIT_MIN = 0.5;
export const TOUCH_LIKE_RATIO_INIT_MAX = 1.5;
/** 微调后的整体区间（下限同初始化，上限放宽到 2 —— 用户裁决） */
export const TOUCH_LIKE_RATIO_FLOOR = 0.5;
export const TOUCH_LIKE_RATIO_CEIL = 2;

function isLikeRatioInitialized(characterId) {
  try {
    return readSettingValue(TOUCH_LIKE_RATIO_INIT_KEY_PREFIX + characterId) === '1';
  } catch {
    return false;
  }
}

/** 初始化 prompt：人格 + 16 条动作清单 + **完整 JSON 示例**（AGENTS.md 硬要求） */
function buildLikeRatioInitPrompt(character) {
  const name = character?.display_name || character?.name || '她';
  const persona = readPersona(character) || '（没有额外人格设定，按普通成年女性的日常好恶判断即可）';
  const list = listTouchActions({}).map(action => `- ${action.key}（${action.label}）：${action.promptDesc}`).join('\n');
  const example = JSON.stringify(Object.fromEntries(listTouchActions({}).map(a => [a.key, 1])), null, 0);
  const system = [
    `你在为角色「${name}」设定**肢体接触偏好倍率**：每个动作给一个 0.5~1.5 的数字。`,
    '1 = 谈不上偏好；>1 = 喜欢、会主动迎合；<1 = 不自在、会躲、会不耐烦。',
    '只按她的人格与性格来定，不要编造剧情，也不要给全部动作同一个数字。',
  ].join('\n');
  const user = [
    '【她的人格】',
    persona,
    '',
    '【动作清单】（键就是 JSON 的键）',
    list,
    '',
    '【输出要求】',
    '只输出**一个 JSON 对象**：键 = 上面 16 个动作 key，值 = 0.5~1.5 的数字（可带两位小数）。',
    '必须覆盖全部 16 个键；不要输出解释、不要用代码块、不要在 JSON 前后加任何文字。',
    '示例（格式照这个来，数字请按人格自己定）：',
    example,
  ].join('\n');
  return { system, user, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], label: 'touch-like-ratio-init' };
}

/** 解析初始化输出：容忍代码块/前后夹话；非法/越界值夹取；缺的键补 1（保证 16 行齐全） */
export function parseLikeRatioInit(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = {};
  let hits = 0;
  for (const action of listTouchActions({})) {
    const value = Number(parsed[action.key]);
    if (Number.isFinite(value)) {
      result[action.key] = Math.min(TOUCH_LIKE_RATIO_INIT_MAX, Math.max(TOUCH_LIKE_RATIO_INIT_MIN, value));
      hits += 1;
    } else {
      result[action.key] = 1;
    }
  }
  return hits > 0 ? result : null;
}

/** 写偏好（**不动 annoyance**：只覆盖 like_ratio），返回写入行数 */
function writeLikeRatios(characterId, ratios) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO character_touch_state (character_id, action_key, annoyance, like_ratio, updated_at)
     VALUES (?, ?, 0, ?, datetime('now'))
     ON CONFLICT(character_id, action_key) DO UPDATE SET
       like_ratio = excluded.like_ratio,
       updated_at = datetime('now')`
  );
  let written = 0;
  for (const [actionKey, value] of Object.entries(ratios)) {
    stmt.run(characterId, actionKey, Number(value));
    written += 1;
  }
  return written;
}

/**
 * 首次动作时的一次性偏好初始化（幂等：成功落标记；失败只 warn ⇒ 下次动作会重试）。
 *
 * C2（审查 2026-09-30）：**不再由动作 handler 直接 await** —— 见 `scheduleTouchLikeRatioInit`。
 * 本函数保持"成功才落标记、失败可重试"的语义与返回值不变，只是被挪到动作之后异步跑。
 * @returns {Promise<boolean>} 这次是否真的初始化成功
 */
export async function ensureTouchLikeRatios(character) {
  const characterId = Number(character?.id);
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return false;
  // 「省额度模式」（touchInstant=false）承诺"一次模型都不调" ⇒ 初始化也必须一起省掉
  if (!isInstantEnabled()) return false;
  if (isLikeRatioInitialized(characterId)) return false;
  try {
    const prompt = buildLikeRatioInitPrompt(character);
    const raw = await chatSync(prompt.messages, { temperature: 0.3, max_tokens: 500, label: prompt.label, retries: 0 });
    const ratios = parseLikeRatioInit(raw);
    if (!ratios) {
      console.warn('[touch] 偏好初始化解析失败（下次动作会重试）:', String(raw || '').slice(0, 80));
      return false;
    }
    writeLikeRatios(characterId, ratios);
    writeSettingValue(TOUCH_LIKE_RATIO_INIT_KEY_PREFIX + characterId, '1');
    console.log(`[touch] like_ratio initialized for char ${characterId}: ${Object.keys(ratios).length} actions`);
    return true;
  } catch (err) {
    console.warn('[touch] 偏好初始化失败（不影响动作，下次动作重试）:', err?.message || err);
    return false;
  }
}

// C2（审查 2026-09-30）：偏好初始化的「中间方案」。
//
// 现状问题：首次动作 handler 里 `await ensureTouchLikeRatios(character)` ⇒ 用户点第一下要串行等
// 「初始化调用 + 反应调用」两次 LLM，首次手感明显变慢（LAN 网关间歇不可达时更糟）。
// 改法：**动作走完全程、反应已发之后，再把初始化 fire-and-forget 出去** —— 本次动作用默认 1.0，
// 初始化完成后**下次动作**生效（比「先 fire-and-forget 再做动作」更稳：不占首次关键路径，
// 也不和反应调用抢闸门并发）。
//
// 幂等与失败重试**不变**：成功仍靠 system_settings 标记（`isLikeRatioInitialized`），失败不落标记 ⇒
// 下次动作自然重试。额外加一条「同角色在飞合并」：连点 5 下只发一次初始化（标记没落之前防重复发）。
// 全程吞异常：后台任务的失败绝不能变成 unhandled rejection（DB 已关、网关不可达都算）。
const _touchLikeRatioInitInFlight = new Set();

/**
 * 把偏好初始化排到后台（不 await）。同角色已有一次在飞时直接跳过（连点合并）。
 * @returns {boolean} 这次是否真的排了后台任务
 */
export function scheduleTouchLikeRatioInit(character) {
  const characterId = Number(character?.id);
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return false;
  if (_touchLikeRatioInitInFlight.has(characterId)) return false;
  _touchLikeRatioInitInFlight.add(characterId);
  Promise.resolve()
    .then(() => ensureTouchLikeRatios(character))
    .catch(err => {
      console.warn('[touch] 偏好初始化后台任务异常（已忽略，下次动作会重试）:', err?.message || err);
      return false;
    })
    .then(() => { _touchLikeRatioInitInFlight.delete(characterId); });
  return true;
}

/**
 * 即时反应后的偏好微调（task-24 P1-1 用户裁决）：
 *   · `annoyed === true`      → ×0.95，下限 0.5；
 *   · `valence > 0.1`         → ×1.05，上限 2。
 * 两条独立判定（同一轮都满足就依次生效）。失败只 warn，返回 null。
 * @returns {number|null} 微调后的值（没有行/异常 = null）
 */
export function tuneTouchLikeRatio(characterId, actionKey, { annoyed = false, valence = 0 } = {}) {
  try {
    const row = readStateRow(characterId, actionKey);
    if (!row) return null;
    let next = Number(row.like_ratio) || 1;
    if (annoyed === true) next = Math.max(TOUCH_LIKE_RATIO_FLOOR, next * 0.95);
    if (Number(valence) > 0.1) next = Math.min(TOUCH_LIKE_RATIO_CEIL, next * 1.05);
    next = Math.round(next * 1000) / 1000;
    if (next === Number(row.like_ratio)) return next;
    getDb().prepare(
      `UPDATE character_touch_state SET like_ratio = ?, updated_at = datetime('now')
        WHERE character_id = ? AND action_key = ?`
    ).run(next, characterId, actionKey);
    return next;
  } catch (err) {
    console.warn('[touch] 偏好微调失败（不影响动作）:', err?.message || err);
    return null;
  }
}

// ── 既有系统的值（服务层不 import，全在这里读；docs/touch-system.md §3.1）──

function parseCharacterId(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function getCharacterRow(id) {
  return getDb().prepare('SELECT * FROM characters WHERE id = ?').get(id) || null;
}

function readGateInputs(id) {
  return {
    affinity: loadAffinity(id),
    isOath: Boolean(loadOath(id)),
    hypnotized: isBodyControlled(id),
    sleeping: Boolean(isSleeping(id).sleeping),
    intimateAuthorized: isAiEditAllowed(id, 'stats'),
  };
}

// 过期清扫 / 待消费读取 / 消费标记都在服务层 `services/touchEventStore.js`（task-24 P2-2 搬家）：
// 私聊链（chat.js）与群聊链（groupChatEngine）各自从服务层 import，不再有路由→路由的反向依赖。
/** 群聊动作的目标必须是该群成员（路由入口校验；不校验的话会落进"永远取不到/静默作废"的坏行） */
function isGroupMember(groupId, characterId) {
  return Boolean(getDb().prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND character_id = ? LIMIT 1'
  ).get(groupId, characterId));
}

/** 上次同一动作的时间戳：character_touch_state.updated_at 是 SQLite 无时区 UTC 串 → 按 UTC 解析 */
function readStateRow(id, actionKey) {
  return getDb().prepare(
    'SELECT annoyance, like_ratio, updated_at FROM character_touch_state WHERE character_id = ? AND action_key = ?'
  ).get(id, actionKey) || null;
}

function upsertStateRow(id, actionKey, annoyance, likeRatio) {
  getDb().prepare(
    `INSERT INTO character_touch_state (character_id, action_key, annoyance, like_ratio, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(character_id, action_key) DO UPDATE SET
       annoyance = excluded.annoyance,
       like_ratio = excluded.like_ratio,
       updated_at = datetime('now')`
  ).run(id, actionKey, Math.round(annoyance), Number(likeRatio));
}

/**
 * Lv3 动作 → 亲密看板记账（2026-09-30 task-16 裁决：复用冻结管线，不新增 act_key）。
 *
 * 幂等锚点 = `touch:<touch_events.id>:<actKey>`：**一次动作只记一笔**，重放（路由重试、
 * 或将来群聊侧再走一遍）都只落一行；`raw_id` 保持 0 —— 本仓 `raw_id` 语义固定指向
 * `raw_messages.id`，塞事件 id 会污染"撤回一轮按 raw_id 删流水"的链路（与奇遇 / 镇民奇遇同口径）。
 *
 * · `source='manual'`：这是用户自己点出来的动作，与「强制高潮」「面板人工补录」同待遇，绕过
 *   aiEditFields 权限闸门（Lv3 的「亲密授权」已经在门控那一步判过了）；
 * · `scene` 复用既有 `'chat'`：**不新增 SCENES 枚举值**（与镇民奇遇复用 `'event'` 同口径，
 *   见 docs/intimate-dashboard.md §3 的"不新增 SCENES"说明）；触摸发生在私聊里，也算实话；
 * · `climaxCount` 不写（触摸不是高潮，别去动面板的「高潮次数」）；
 * · 失败只 warn：记账是旁路，绝不能影响动作本身（与 hypnosisService.recordForcedClimax 同款）。
 */
function recordTouchIntimate(characterId, action, eventId) {
  const actKey = action?.intimateActKey;
  if (!actKey) return null;
  if (config.features.intimate === false) return null;
  const sourceUid = `touch:${eventId}:${actKey}`;
  try {
    const result = recordIntimateActs(characterId, {
      scene: 'chat',
      partnerKind: 'user',
      partnerId: 0,
      source: 'manual',
      rawId: 0,
      acts: [{ actKey, count: 1, sourceUid }],
    });
    return { actKey, sourceUid, inserted: result.inserted, skipped: result.skipped, blocked: result.blocked };
  } catch (err) {
    console.warn('[touch] 亲密看板记账失败:', err?.message || err);
    return null;
  }
}

function insertTouchEvent(row) {
  const result = getDb().prepare(
    `INSERT INTO touch_events
       (character_id, group_id, action_key, mode, annoyance, like_ratio, reaction, facial_expression,
        emotion_delta, annoyed, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    row.characterId, row.groupId || null, row.actionKey, row.mode,
    Math.round(row.annoyance || 0), Number(row.likeRatio || 1),
    row.reaction || '', row.facialExpression || '',
    row.emotionDelta ? JSON.stringify(row.emotionDelta) : '',
    row.annoyed ? 1 : 0, row.status, row.error || ''
  );
  return Number(result.lastInsertRowid);
}

// ── task-30：四块新喂料（各自 try/catch；一块挂了不影响其它块，更不影响动作）──────────
//
// 全部复用既有 builder（与 chat.js / groupChatEngine 同款），一行不重写：
//   · affinityToPrompt(loadAffinity(id))               关系/好感档位（emotionEngine）
//   · formatScheduleContext(id)                        她此刻正在做的事（scheduleManager）
//   · buildIntimateProfileBlock(id, { chatUserName })   亲密档案（intimatePrompt；开关关/档案空 → 空串）
//   · buildHypnosisStateBlock(state, { chatUserName })  催眠状态（hypnosisPrompt；没催眠 → 空串）
//
// 测试接缝：单测要验"某块抛错时其余块照常注入"，所以四个 builder 放在可替换的对象里。
const defaultTouchFeedBuilders = {
  affinity: ({ characterId }) => affinityToPrompt(loadAffinity(characterId)),
  schedule: ({ characterId }) => formatScheduleContext(characterId),
  intimate: ({ characterId, userName }) => buildIntimateProfileBlock(characterId, { chatUserName: userName }),
  hypnosis: ({ characterId, userName, characterName }) => {
    const state = getHypnosisState(characterId);
    if (!state?.active) return '';
    return buildHypnosisStateBlock(state, { chatUserName: userName, subject: characterName });
  },
};
let touchFeedBuilders = { ...defaultTouchFeedBuilders };
/** 测试接缝：patch 传哪几个就替换哪几个；传 null 复位 */
export function __setTouchFeedBuildersForTest(patch) {
  touchFeedBuilders = patch ? { ...defaultTouchFeedBuilders, ...patch } : { ...defaultTouchFeedBuilders };
}

/**
 * 收集四块喂料；**每块独立 try/catch**（拿不到/抛错就跳过，绝不让动作失败）。
 * @returns {{affinityBlock:string, scheduleBlock:string, intimateBlock:string, hypnosisBlock:string, blocks:string[], failed:string[]}}
 */
function collectTouchReactionFeed({ characterId, userName, characterName, scene }) {
  const ctx = { characterId, userName, characterName, scene };
  const out = { affinityBlock: '', scheduleBlock: '', intimateBlock: '', hypnosisBlock: '', blocks: [], failed: [] };
  const fields = { affinity: 'affinityBlock', schedule: 'scheduleBlock', intimate: 'intimateBlock', hypnosis: 'hypnosisBlock' };
  for (const name of Object.keys(fields)) {
    const field = fields[name];
    try {
      const value = touchFeedBuilders[name] ? touchFeedBuilders[name](ctx) : '';
      const text = String(value || '').trim();
      if (text) { out[field] = text; out.blocks.push(name); }
    } catch (err) {
      out.failed.push(name);
      console.warn('[touch] 反应喂料块 ' + name + ' 失败（跳过，不影响动作）:', err?.message || err);
    }
  }
  return out;
}

/** 同一动作是否刚到过（防同一摸演两遍）：取该角色上一条同动作事件，5 分钟内才回执 */
function readRecentSameAction(characterId, actionKey, { excludeEventId = 0, now = Date.now() } = {}) {
  try {
    const row = getDb().prepare(
      `SELECT id, created_at FROM touch_events
        WHERE character_id = ? AND action_key = ? AND id != ?
        ORDER BY id DESC LIMIT 1`
    ).get(characterId, actionKey, Number(excludeEventId) || 0);
    if (!row?.created_at) return null;
    const at = parseSqlUtc(row.created_at);
    if (!at) return null;
    const minutesAgo = (Number(now) - at.getTime()) / 60000;
    if (!Number.isFinite(minutesAgo) || minutesAgo < 0 || minutesAgo > 5) return null;
    return { minutesAgo, id: Number(row.id) };
  } catch (err) {
    console.warn('[touch] 同动作回执读取失败（跳过）:', err?.message || err);
    return null;
  }
}
function updateTouchEvent(id, patch) {
  getDb().prepare(
    `UPDATE touch_events
        SET reaction = ?, facial_expression = ?, emotion_delta = ?, annoyed = ?, status = ?, error = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    patch.reaction || '', patch.facialExpression || '',
    patch.emotionDelta ? JSON.stringify(patch.emotionDelta) : '',
    patch.annoyed ? 1 : 0, patch.status || 'pending', patch.error || '', id
  );
}

/**
 * 最近 N 条对话（给即时反应 prompt 当上下文；拿不到就是空数组）。
 *
 * ⚠️ 会话要按场景传：私聊 `char_<id>`、群聊 `group_<gid>`。群聊里**绝不能**拿私聊记录当上下文
 * （那条反应会当众发出来，等于把私密对话泄漏到群里）。
 *
 * task-30：窗口从 2 条扩到 `limit`（对话式默认 8，快速版仍传 2 ⇒ 行为逐字节不变）。
 */
function readRecentLines(conversationId, { userName = '', characterName = '', group = false, limit = 2 } = {}) {
  const size = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 2));
  try {
    const rows = getDb().prepare(
      'SELECT role, content FROM raw_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
    ).all(conversationId, size).reverse();
    return rows.map(row => {
      const text = String(row.content || '').slice(0, 200);
      // 群聊 raw 自带「[名字]: 」前缀，原样用即可
      return group ? text : `${row.role === 'user' ? userName : characterName}：${text}`;
    });
  } catch {
    return [];
  }
}

/**
 * 群聊「插入式发言」（专题 §2.2，task-17 追加）：把这一条反应写进**群会话**并广播 `group_message`。
 *
 * 为什么必须写群会话：群里对某人做动作时，反应如果走私聊写入器（writeProactiveMessage → `char_<id>`），
 * 用户就只能在私聊里看到它 —— 群聊页只认统一流的 `group_message`（`routes/groups.js` 的 emit →
 * `web-ui/src/stores/groups.js` 的 `_enqueue`）。
 *
 * 形状**逐字对齐** `groupChatEngine.serializeMsg()`（那是群聊页唯一认的形态）：
 *   `{ id, group_id, role:'assistant', content, seq, speaker_character_id, speaker_name, created_at }`
 * （外加两个附加字段 `source:'touch'` / `touch:{action,eventId}`，前端忽略未知字段）
 * · raw_messages 与群聊引擎同口径：raw 正文自带 `[名字]: ` 说话人前缀；
 * · messages 一行 = 一个气泡（即时反应就 1~2 句，不再分句），`seq` 取该会话当前最大值 +1；
 * · `speaker_character_id` 必须是**被摸的那个角色**，群聊页据此渲染成她的气泡。
 */
function writeGroupTouchMessage(groupId, character, content, { eventId, actionKey } = {}) {
  const db = getDb();
  const conversationId = `group_${groupId}`;
  const speakerName = character.display_name || character.name || '角色';
  const rawResult = db.prepare(
    "INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
  ).run(conversationId, `[${speakerName}]: ${content}`);
  const rawId = Number(rawResult.lastInsertRowid);
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM messages WHERE conversation_id = ?').get(conversationId);
  const seq = Number(seqRow?.s ?? -1) + 1;
  const msgResult = db.prepare(
    `INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id)
     VALUES (?, ?, 'assistant', ?, ?, ?)`
  ).run(conversationId, rawId, content, seq, Number(character.id));
  const msgId = Number(msgResult.lastInsertRowid);
  return {
    rawId,
    msgId,
    seq,
    payload: {
      id: msgId,
      group_id: Number(groupId),
      role: 'assistant',
      content,
      seq,
      speaker_character_id: Number(character.id),
      speaker_name: speakerName,
      created_at: new Date().toISOString(),
      source: 'touch',
      touch: { action: actionKey || '', eventId: eventId || 0 },
    },
  };
}

/**
 * 即时反应的人格串：直接取角色自己的短人格（`short_prompt` → 回退 `base_prompt`）。
 *
 * ⚠️ 刻意**不套** `characterPersona.buildCharacterPersona`：AGENTS.md 的「角色生图人格组装」节明确
 * "非生图用途不套本入口"（本调用只是一次 200~400 token 的反应生成，不出图），专题 §2.1 的
 * `buildCharacterPersona(variant:'short')` 与此冲突 ⇒ 取角色字段本身，不做拼接。
 */
function readPersona(character) {
  const shortPrompt = String(character?.short_prompt || '').trim();
  if (shortPrompt) return shortPrompt;
  return String(character?.base_prompt || '').trim();
}

/** 心情快照锚点：必须是 messages.id（拿 raw_messages.id 会撞 FK，催眠手机 nudgeEmotionForClimax 踩过） */
function resolveLastMessageId(conversationId) {
  try {
    const row = getDb().prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversationId);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 应用心情增量并落一条快照（失败只 warn：心情是旁路，不能让动作本身失败）。
 * @param {object|null} delta 优先用模型给的 delta；没有就用动作定义里的静态 delta
 */
function applyTouchEmotion({ character, characterId, delta, reason, afterMsgId }) {
  try {
    if (!delta) return null;
    const db = getDb();
    const conversationId = `char_${characterId}`;
    const baseline = JSON.parse(character?.emotion_baseline || JSON.stringify(DEFAULT_EMOTION_BASELINE));
    const current = loadEmotionState(conversationId, baseline);
    const next = evolveEmotion(current, delta, baseline);
    const dominant = delta.dominance > 0.15 ? 'joy' : (Number(delta.valence) >= 0 ? 'joy' : 'sadness');
    const anchor = afterMsgId ?? resolveLastMessageId(conversationId);
    saveEmotionSnapshot(conversationId, anchor, next, dominant, loadAffinity(characterId), null, reason);
    return { applied: true, afterMsgId: anchor == null ? null : Number(anchor), delta, dominantEmotion: dominant };
  } catch (err) {
    console.warn('[touch] 心情写入失败:', err?.message || err);
    return null;
  }
}

function actionBrief(action) {
  return {
    key: action.key,
    label: action.label,
    level: action.level,
    levelLabel: TOUCH_LEVEL_LABELS[action.level] || `Lv${action.level}`,
    wakes: Boolean(action.wakes),
  };
}

// ── GET /:id/touch/actions ─────────────────────────────────────────────────

router.get('/:id/touch/actions', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    if (!getCharacterRow(id)) return res.status(404).json({ error: 'character not found' });
    const maxLevel = Number.parseInt(req.query?.maxLevel, 10);
    const actions = listTouchActions({ maxLevel: Number.isSafeInteger(maxLevel) ? maxLevel : undefined });
    const inputs = readGateInputs(id);
    const scene = req.query?.scene === 'group' ? 'group' : 'chat';
    const gate = {};
    for (const action of actions) {
      const result = getTouchGate({
        actionKey: action.key,
        ...inputs,
        scene,
        // 群聊 Lv3 只看设置开关（不再认 query：前端自己写死 false 的老路子已废弃）
        allowGroupAdult: isGroupAdultAllowed(),
        thresholds: DEFAULT_TOUCH_THRESHOLDS,
      });
      gate[action.key] = {
        allowed: result.allowed,
        code: result.code,
        message: result.message,
        wakesSleeping: result.wakesSleeping,
        exempt: result.exempt,
      };
    }
    res.json({
      characterId: id,
      actions: actions.map(actionBrief),
      gate,
      thresholds: { ...DEFAULT_TOUCH_THRESHOLDS },
      levels: { ...TOUCH_LEVEL_LABELS },
      features: {
        touch: isTouchEnabled(),
        instant: isInstantEnabled(),
        groupAdult: isGroupAdultAllowed(),
        imageMode: readTouchImageMode(),
      },
      // 生效值（前端据此决定群聊 Lv3 是否置灰；不要自己写死 false）
      allowGroupAdult: isGroupAdultAllowed(),
      imageModeLabels: { ...TOUCH_IMAGE_MODE_LABELS },
      quota: getTouchQuotaStatus(),
    });
  } catch (err) {
    console.error('[touch] actions error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'failed to list touch actions' });
  }
});

// ── GET /:id/touch/stats ───────────────────────────────────────────────────

/**
 * 统计聚合（task-19）：只读，供统计面板用。形状契约见 docs/touch-system.md §3.6。
 * 只读端点不拦总开关（前端要在开关关闭时也能看到历史统计）。
 */
router.get('/:id/touch/stats', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    if (!getCharacterRow(id)) return res.status(404).json({ error: 'character not found' });
    const stats = getTouchStats(id, { days: req.query?.days, recent: req.query?.recent });
    res.json({
      ...stats,
      // 生效开关与档位（面板直接显示，别自己猜默认值）
      features: {
        touch: isTouchEnabled(),
        instant: isInstantEnabled(),
        groupAdult: isGroupAdultAllowed(),
        imageMode: readTouchImageMode(),
      },
      imageModeLabels: { ...TOUCH_IMAGE_MODE_LABELS },
    });
  } catch (err) {
    console.error('[touch] stats error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'failed to load touch stats' });
  }
});

// ── GET /:id/touch/state ───────────────────────────────────────────────────

router.get('/:id/touch/state', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    if (!getCharacterRow(id)) return res.status(404).json({ error: 'character not found' });
    // task-28：支持 `?scene=chat|group&groupId=<n>`。**不传参数 = 私聊口径**（现有前端行为逐字节不变）。
    // 群聊口径数的是"这个群里还有几件事没演"（该群全体成员），私聊口径字段同时保留在 pendingCounts 里。
    const scene = req.query?.scene === 'group' ? 'group' : 'chat';
    let groupId = null;
    if (scene === 'group') {
      // **严格**正整数：旧实现用 parseInt ⇒ `groupId=1.5` 被截成 1、`3abc` 截成 3（独立验证者实测 200）。
      // 现在 `String(raw).trim()` 必须全是数字（`/^\d+$/`）且 > 0，否则一律 400。
      const parsed = parseStrictGroupId(req.query?.groupId);
      if (parsed === null) {
        return res.status(400).json({ error: 'invalid group id', code: 'INVALID_GROUP_ID' });
      }
      groupId = parsed;
    }
    // 顺手清扫过期事件：否则「还有 N 个动作等她回应」会把 30 分钟前的僵尸事件算进去。
    // 群聊口径下两个作用域都扫：保证 pendingCount（群）与 pendingCounts.chat 都不含僵尸事件。
    expireStaleTouchEvents({ characterId: id });
    if (groupId) expireStaleTouchEvents({ groupId });
    const rows = getDb().prepare(
      'SELECT action_key, annoyance, like_ratio, updated_at FROM character_touch_state WHERE character_id = ?'
    ).all(id);
    const states = {};
    for (const action of listTouchActions({})) {
      const row = rows.find(item => item.action_key === action.key) || null;
      states[action.key] = {
        annoyance: Number(row?.annoyance) || 0,
        tier: annoyanceTier(Number(row?.annoyance) || 0),
        likeRatio: row ? Number(row.like_ratio) : 1,
        updatedAt: row?.updated_at || null,
      };
    }
    // task-24 P0-2 / task-28 / 真机问题 3：前端要显示「还有 N 个动作等她回应」。
    // · `pendingCount` = **生效场景**下的计数（不传参数时 = 私聊，与旧行为逐字节一致）；
    //   口径 = **只数 `status='pending'`**（`done` = 反应已作为独立消息发过，不算「等」）。
    // · `pendingCounts` = 两个口径都给（chat 一定给；group 只在群聊口径下给，否则 null）。
    // · `pendingByMode` = 生效场景下按 mode 分开的 pending（前端分文案：隐式才说「跟她说句话吧」）。
    const chatPendingCount = countPendingTouchEvents(id);
    const pendingCount = groupId ? countPendingTouchEvents(id, { groupId }) : chatPendingCount;
    const pendingByMode = groupId
      ? countPendingTouchEventsByMode(id, { groupId })
      : countPendingTouchEventsByMode(id);
    res.json({
      characterId: id,
      states,
      quota: getTouchQuotaStatus(),
      pendingCount,
      pendingCounts: { chat: chatPendingCount, group: groupId ? pendingCount : null },
      pendingByMode,
      scene,
      groupId,
    });
  } catch (err) {
    console.error('[touch] state error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'failed to read touch state' });
  }
});

// ── POST /:id/touch/:action ────────────────────────────────────────────────

router.post('/:id/touch/:action', async (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });

  if (!isTouchEnabled()) {
    return res.status(409).json({ error: 'touch feature disabled', features: { touch: config.features?.touch } });
  }

  const scene = req.body?.scene === 'group' ? 'group' : 'chat';
  const normalized = normalizeTouchRequest({
    actionKey: req.params.action,
    characterId: req.params.id,
    groupId: req.body?.groupId,
    scene,
    mode: req.body?.mode,
  });
  if (!normalized.ok) {
    return res.status(400).json({ error: normalized.error, code: normalized.code });
  }

  const character = getCharacterRow(id);
  if (!character) return res.status(404).json({ error: 'character not found' });

  // 群聊场景：群必须存在、且她必须是这个群的成员（否则这条事件永远没人能消费）
  if (normalized.scene === 'group') {
    const group = getDb().prepare('SELECT id FROM group_chats WHERE id = ?').get(normalized.groupId);
    if (!group) return res.status(404).json({ error: 'group not found' });
    if (!isGroupMember(normalized.groupId, id)) return res.status(400).json({ error: 'character is not a member of this group' });
  }

  // 过期清扫（task-17）：先把该角色名下超窗口的 pending/done 标成 expired，再往下走
  expireStaleTouchEvents({ characterId: id });

  try {
    const action = normalized.action;
    const key = normalized.actionKey;
    const userName = config.user?.nickname || '用户';
    const characterName = character.display_name || character.name || '角色';

    const inputs = readGateInputs(id);
    const gate = getTouchGate({
      actionKey: key,
      ...inputs,
      scene: normalized.scene,
      allowGroupAdult: isGroupAdultAllowed(),
      thresholds: DEFAULT_TOUCH_THRESHOLDS,
    });
    // 门控拒绝 = 200 + { allowed:false, code, message }（Lead 裁决；前端拿 message 直接 toast）
    if (!gate.allowed) {
      return res.json({
        allowed: false,
        code: gate.code,
        message: gate.message,
        action: actionBrief(action),
        mode: null,
        eventId: null,
        reaction: null,
      });
    }

    // ⓪ 首次对该角色做动作 → 一次批量调用按人格初始化 16 个动作的偏好（task-24 P1-1；幂等）
    //    放在腻烦度之前，这样**这一次**动作就能用上模型给的值（而不是等下一次）。
    //    失败只 warn（内部已吞），绝不影响动作。
    // C2：后台初始化（不 await）—— 首次动作不再串行等它，本次用默认 1.0、下次生效
    scheduleTouchLikeRatioInit(character);

    // ① 腻烦度：先按流逝时间衰减、再判"是否连点"，落库（每角色 × 每动作一行）
    const prevRow = readStateRow(id, key);
    const likeRatio = prevRow ? Number(prevRow.like_ratio) || 1 : 1;
    const parsedUpdatedAt = prevRow?.updated_at ? parseSqlUtc(prevRow.updated_at) : null;
    const lastAt = parsedUpdatedAt ? parsedUpdatedAt.getTime() : null;
    const annoyanceResult = nextAnnoyance({
      current: prevRow ? Number(prevRow.annoyance) || 0 : 0,
      lastAt,
      now: Date.now(),
      likeRatio,
      // §4.1①：催眠轮**不叠加**腻烦（存量照常衰减）—— 门控已对 hypnotized 豁免，同口径。
      // 否则连点几下腻烦冲上 80 ⇒ 耐受档变 refusing ⇒「必须拍开手」和催眠块「无法反抗」打架。
      suppressGain: inputs.hypnotized === true,
      // 2026-10-02：击打类连点涨得更快（倍数写在动作定义里）——「打」和「摸」的玩法区别就在这
      actionKey: key,
    });
    upsertStateRow(id, key, annoyanceResult.annoyance, likeRatio);

    // ② 睡着时的重动作 → 临时唤醒 + **挂唤醒反应**（task-17）
    //    tempWake 只把她从睡眠里拉出来（5 分钟窗口，到期按日程睡回去）；
    //    「被摸醒」还得有专属演出，所以复用 task-42 的 wake_reaction（hypnosisService.attachWakeReaction，
    //    只写 pending_directive，不碰任何催眠状态列）——她下一轮聊天会演出「惊醒/恍惚」。
    let preWake = null;
    let wakeReaction = false;
    if (gate.wakesSleeping) {
      try {
        const woken = tempWake(id, { mode: 'phone', minutes: TOUCH_WAKE_MINUTES });
        preWake = { woken: Boolean(woken.ok), minutes: woken.minutes, reason: woken.reason || '' };
      } catch (err) {
        console.warn('[touch] 重动作临时唤醒失败:', err?.message || err);
        preWake = { woken: false, minutes: 0, reason: 'error' };
      }
      try {
        wakeReaction = attachWakeReaction(id);
      } catch (err) {
        console.warn('[touch] 挂唤醒反应失败:', err?.message || err);
      }
    }

    // ③ 走即时还是隐式（配额 / "省额度模式"开关都在纯函数里判）
    const quotaBefore = getTouchQuotaStatus();
    const resolvedMode = resolveTouchMode({
      mode: normalized.mode,
      instantEnabled: isInstantEnabled(),
      quotaExhausted: quotaBefore.exhausted,
    });

    const eventId = insertTouchEvent({
      characterId: id,
      groupId: normalized.groupId,
      actionKey: key,
      mode: resolvedMode.mode === TOUCH_MODES.INSTANT ? TOUCH_MODES.INSTANT : TOUCH_MODES.IMPLICIT,
      annoyance: annoyanceResult.annoyance,
      likeRatio,
      status: 'pending',
      reaction: '',
    });

    // Lv3 命中映射时立刻记一笔（与"即时/隐式"无关：这一下**真的发生了**，两种模式都记账）
    const intimateRecord = recordTouchIntimate(id, action, eventId);

    // 亲密刺激统一下游（2026-10-02）：触摸也推进敏感条 + 心情 + 记忆。
    // 用户原话：「角色在进入想做爱的模式 各种亲密动作都会累积到高潮敏感条里 而不是只要在推进面板里抽插才推进」。
    // 不 await（她是旁路：慢/失败都不能拖住"摸她一下"的响应）。
    Promise.resolve()
      .then(() => applyIntimateStimulus({
        characterId: id,
        character,
        source: 'touch',
        scene: normalized.scene === 'group' ? 'group' : 'chat',
        groupId: normalized.groupId || null,
        reason: `触摸互动：${action.label}`,
      }))
      .catch(err => console.warn('[touch] 刺激下游失败（不影响触摸本身）:', err?.message || err));

    const baseResponse = {
      allowed: true,
      code: 'ok',
      action: actionBrief(action),
      requestedMode: normalized.mode,
      mode: TOUCH_MODES.IMPLICIT,
      fallback: resolvedMode.fallback,
      notice: resolvedMode.notice,
      reason: resolvedMode.reason,
      eventId,
      status: 'pending',
      reaction: null,
      emotion: null,
      annoyance: {
        value: annoyanceResult.annoyance,
        tier: annoyanceResult.tier,
        repeated: annoyanceResult.repeated,
        gain: annoyanceResult.gain,
      },
      likeRatio,
      wakesSleeping: Boolean(gate.wakesSleeping),
      preWake,
      wakeReaction,
      quota: quotaBefore,
      // Lv3 的看板记账结果（null = 这个动作不记账 / 总开关关了 / 记账失败）
      intimate: intimateRecord,
    };

    if (resolvedMode.mode !== TOUCH_MODES.INSTANT) {
      // 隐式：不调模型，留 pending 等下一轮 chat.js 注入（反应由那一轮写出来）
      // 心情：动作定义里的静态 delta 立刻生效（专题 §1.2「喂 emotionEngine 的 instant delta」）
      baseResponse.emotion = applyTouchEmotion({
        character, characterId: id, delta: action.emotionDelta,
        reason: `触摸互动：${action.label}`, afterMsgId: null,
      });
      return res.json(baseResponse);
    }

    // ④ 即时反应：一次 200~400 token 的小调用
    const quotaAfter = consumeTouchQuota();
    baseResponse.quota = quotaAfter;
    baseResponse.mode = TOUCH_MODES.INSTANT;

    // §1.3（审查 2026-09-30）：客户端断开就中止这次上游调用，别空烧 token。
    // 必须监听 res 的 'close' 且判 writableEnded —— 与 chat.js 主链路同一套（req.on('close')
    // 在 Node ≥16 表示"请求体读完"，早在本处之前就触发过了，用它等于永远不 abort）。
    let clientGone = false;
    const upstreamAbort = new AbortController();
    res.on('close', () => {
      if (res.writableEnded) return; // 正常结束（我们自己 res.json）不算断开
      clientGone = true;
      upstreamAbort.abort();
    });

    let parsed = null;
    let reactionFeed = null;
    // §一③：围观者要在 ④ 的 try 里决策、在 ⑤ 的 try 里使用 ⇒ 提到 try 外声明
    let bystander = null;
    let bystanderName = '';
    try {
      const persona = readPersona(character);
      // 心情状态仍挂在角色自己的私聊会话上（全仓 emotion_snapshots 都是这个口径，本任务不动它）；
      // 但「最近对话」必须按场景取：群聊动作要读群会话，别把私聊记录带进群聊（会当众泄漏）。
      const conversationId = `char_${id}`;
      const contextConversationId = normalized.scene === 'group' ? `group_${normalized.groupId}` : conversationId;
      const baseline = JSON.parse(character.emotion_baseline || JSON.stringify(DEFAULT_EMOTION_BASELINE));
      const currentEmotion = loadEmotionState(conversationId, baseline);

      // task-30：默认「对话式」（全量喂料 + 放开输出）；`features.touchReactionMode === 'quick'` 一键回退旧口径。
      const reactionMode = config.features?.touchReactionMode === 'quick' ? 'quick' : 'conversation';
      const recentLines = readRecentLines(contextConversationId, {
        userName,
        characterName,
        group: normalized.scene === 'group',
        limit: reactionMode === 'conversation' ? CONVERSATION_RECENT_LINES : 2,
      });
      const feed = reactionMode === 'conversation'
        ? collectTouchReactionFeed({ characterId: id, userName, characterName, scene: normalized.scene })
        : { affinityBlock: '', scheduleBlock: '', intimateBlock: '', hypnosisBlock: '', blocks: [], failed: [] };
      const sameAction = reactionMode === 'conversation' ? readRecentSameAction(id, key, { excludeEventId: eventId }) : null;
      // §一③ 第二层：即时反应这一轮也把旁观者拉进来 —— 决策复用既有纯函数（默认 30% 概率、单轮最多 1 人）。
      // 不是额外调用：把「若有旁观者，另起一行写 [名字]: 一句」并进这次反应 prompt（省额度）。
      const bystanderPlan = normalized.scene === 'group' && normalized.groupId
        ? planTouchBystander({ members: readGroupMemberRows(normalized.groupId), excludeId: id })
        : null;
      bystander = bystanderPlan?.allowed ? bystanderPlan.member : null;
      bystanderName = bystander ? (bystander.display_name || bystander.name || '') : '';
      const shared = {
        actionKey: key,
        persona,
        characterName,
        userName,
        emotionText: emotionToPrompt(currentEmotion),
        likeRatio,
        annoyance: annoyanceResult.annoyance,
        recentLines,
        scene: normalized.scene,
        groupPeek: false,
        sleeping: Boolean(inputs.sleeping),
        // §4.1②：催眠轮把耐受行换成降级文案（prompt 自相打架是真机「还能反抗」的真根因）
        hypnotized: Boolean(inputs.hypnotized),
        // §一③：有旁观者时，要求她在 reaction_text 末尾另起一行写一句（`[名字]: 台词`）
        bystanderName,
        // 催眠块：对话式走新喂料（只在真催眠时非空）；快速版保持原样（空串）
        hypnosisBlock: reactionMode === 'conversation' ? feed.hypnosisBlock : '',
      };
      // 她此刻正被插着吗（2026-10-02）：触摸链原来只喂"亲密档案"，没有"这场戏进行中" ⇒
      // 「边插着边拍屁股」在她眼里会变成两件无关的事。并进 intimateBlock；取不到就当没有这场戏，绝不影响动作。
      try {
        const sceneNow = buildIntimateScenePromptBlock(id, { chatUserName: userName });
        if (sceneNow) {
          feed.intimateBlock = [feed.intimateBlock, sceneNow].filter(Boolean).join('\n\n');
          // 快速版走的是 `shared`（它在上面就已经组装好）⇒ 键存在时同步覆盖
          if (shared && Object.prototype.hasOwnProperty.call(shared, 'intimateBlock')) shared.intimateBlock = feed.intimateBlock;
        }
      } catch (err) {
        console.warn('[touch] 场景块注入失败（不影响动作）:', err?.message || err);
      }
      // 生图规范（原作者要求的那段 MUST：IP 角色写成 `Name \(Series\) \(hair color, eye color, distinctive features\)`
      // + 每个角色一句完整、各自不同的动作）—— 由**调用方**注入：`touchActionService.js` 是零依赖纯函数模块
      // （守卫 test/touchActionService.test.js:503 盯着"服务层不 import 任何东西"），它自己取不到规则。
      // 放在这里而不是分支里：conversation / 快速版两个构造器共用 `shared`，改一处两条路都覆盖。
      if (shared && typeof shared === 'object') shared.imagePromptRule = buildImagePromptRuleBlock();
      const prompt = reactionMode === 'conversation'
        ? buildConversationReactionPrompt({
          ...shared,
          affinityBlock: feed.affinityBlock,
          scheduleBlock: feed.scheduleBlock,
          intimateBlock: feed.intimateBlock,
          recentSameAction: sameAction,
        })
        : buildReactionPrompt(shared);
      const maxTokens = reactionMode === 'conversation' ? 500 : 300;
      // 可观测（真机调参用）：轮数 / 喂上的块 / 失败的块 / prompt 字符数；一行，不影响动作
      reactionFeed = {
        mode: reactionMode,
        rounds: prompt.meta?.rounds ?? recentLines.length,
        blocks: prompt.meta?.blocks || feed.blocks,
        failed: feed.failed,
        sameAction: Boolean(prompt.meta?.sameAction ?? sameAction),
        maxTokens,
      };
      console.log(`[touch] reaction feed mode=${reactionFeed.mode} rounds=${reactionFeed.rounds} blocks=${reactionFeed.blocks.join(',') || 'none'} failed=${reactionFeed.failed.join(',') || 'none'} chars=${prompt.system.length + prompt.user.length} sameAction=${reactionFeed.sameAction ? 'yes' : 'no'}`);
      const raw = await chatSync(prompt.messages, {
        temperature: 0.8, max_tokens: maxTokens, label: 'touch-reaction', retries: 1,
        signal: upstreamAbort.signal,   // §1.3：客户端断开 → 立即中止（abort 不重试，见 llm-client 的 throwIfSyncAborted）
      });
      parsed = parseReactionOutput(raw);
    } catch (err) {
      // 客户端断开（abort）与真失败同路径：事件留 pending，下一轮聊天照样演出这一下。
      console.warn('[touch] 即时反应调用失败，回落隐式注入:', clientGone ? 'client_disconnected' : (err?.message || err));
    }

    if (!parsed?.ok) {
      // 失败/解析不出来：**不回滚动作**，把事件留在 pending —— 下一轮聊天照样会演出这一下
      updateTouchEvent(eventId, { status: 'pending', error: parsed?.error || 'llm_failed' });
      baseResponse.reactionFeed = reactionFeed;
      baseResponse.mode = TOUCH_MODES.IMPLICIT;
      baseResponse.fallback = true;
      baseResponse.reason = 'instant_failed';
      baseResponse.emotion = applyTouchEmotion({
        character, characterId: id, delta: action.emotionDelta,
        reason: `触摸互动：${action.label}`, afterMsgId: null,
      });
      // 客户端已经走了：状态照旧落（事件 pending、心情已算），但没必要再写一个没人收的响应
      if (clientGone || res.writableEnded) return undefined;
      return res.json(baseResponse);
    }

    // ⑤ 反应**真的落库**（Lead 裁决）：
    //    · 私聊：复用主动聊天的写入器 → char_<id> 的 raw_messages + 分段 messages（is_proactive=1）+ proactive_message 广播；
    //    · 群聊（task-17 追加）：写进 group_<gid> 会话并 broadcast('group_message')，形状对齐 groupChatEngine.serializeMsg()
    //      —— 群聊页只认这条统一流事件（这就是专题 §2.2 的"插入式发言"）。
    let written = null;
    let groupWritten = null;
    let images = [];
    try {
      if (normalized.scene === 'group' && normalized.groupId) {
        // 群聊：**文字先上屏**（3 秒内看到她的反应），图生成完再 update 那条气泡
        //（与 groupChatEngine.generateGroupImage 的挂图方式一致：group_msg → group_msg_update）
        // §一③：把 LLM 写在末尾的围观行拆出来（她的气泡只留她自己的话），围观台词随后由**那位成员**发一条。
        const split = splitBystanderLine(parsed.reactionText, bystanderName);
        groupWritten = writeGroupTouchMessage(normalized.groupId, character, split.herText || parsed.reactionText, { eventId, actionKey: key });
        broadcast('group_message', groupWritten.payload);
        if (split.bystanderText && bystander) {
          try {
            const bystanderRow = getCharacterRow(bystander.id);
            if (bystanderRow) {
              const bystanderWritten = writeGroupTouchMessage(normalized.groupId, bystanderRow, split.bystanderText);
              broadcast('group_message', bystanderWritten.payload);
            }
          } catch (err) {
            console.warn('[touch] 围观插话写入失败（不影响她的反应）:', err?.message || err);
          }
        }
        const shot = await generateTouchImageForReaction({
          character, action, reactionText: parsed.reactionText, imagePrompt: parsed.imagePrompt, annoyance: annoyanceResult.annoyance, scene: 'group',
        });
        if (shot) {
          images = attachImagesToMessage(groupWritten.msgId, shot.urls);
          recordTouchImageTask({ conversationId: `group_${normalized.groupId}`, prompt: shot.prompt, promptRefined: shot.promptRefined, urls: shot.urls });
          // 事件名/载荷口径统一走 services/reactionImageUpdate.js（群聊 store 只认 group_message_update）
          const update = reactionImageUpdate({
            scene: 'group',
            groupPayload: groupWritten.payload,
            images,
            groupId: normalized.groupId,
            reactionText: parsed.reactionText,
            source: 'touch',
          });
          if (update) broadcast(update.event, update.payload);
        }
      } else {
        // §8.2（2026-09-30 真机反馈）：私聊改成与群聊同款的**两段式** —— 文字先上屏（~3s），图后台补。
        // 旧实现是「先出图再广播」（因为 `proactive_message` 当时没有 update 事件）：LLM 2~3s 就写好文字，
        // 却要陪 ComfyUI 一起等（实测单张 5s、排队时 10~40s）⇒ 「点一下要等快一分钟」的体感来源。
        // 现在：① 先写 + 先广播（**不带图**）；② 出图**不 await 主流程**；③ 图好了补一条 `proactive_message_update`。
        written = writeProactiveMessage(character, parsed.reactionText);
        if (written) {
          broadcastProactiveMessage({
            character_id: id,
            display_name: characterName,
            avatar_path: character.avatar_path || null,
            content: parsed.reactionText,
            segments: written.segments || [parsed.reactionText],
            msg_ids: written.msgIds,
            msg_id: written.firstMsgId,
            raw_id: written.rawId,
            images: [],   // 第一段**不带图**；图由第二段 `proactive_message_update` 补
            source: 'touch',
            touch: { action: key, label: action.label, eventId },
            created_at: new Date().toISOString(),
          });

          // 第二段：后台补图（**不 await**，主流程与响应都不等它）。失败只 warn、不发 update（文字已在屏上，无损）。
          const pendingMessage = written;
          // §九 建议 3（2026-09-30）：后台补图要有生命周期兜底 —— ComfyUI 挂死时 Promise 会永悬，
          // 那条 update 永远不来（文字已在屏上、无泄漏，但用户永远看不到图）。
          // 这里加 90 秒超时竞速：超时走 catch 只 warn，不再补图（下次出图照常）。
          Promise.resolve()
            .then(() => Promise.race([
              generateTouchImageForReaction({
                character, action, reactionText: parsed.reactionText, imagePrompt: parsed.imagePrompt, annoyance: annoyanceResult.annoyance, scene: 'chat',
              }),
              new Promise((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('touch image background timeout (90s)')),
                  TOUCH_IMAGE_BG_TIMEOUT_MS,
                );
                if (typeof timer.unref === 'function') timer.unref();
              }),
            ]))
            .then(shot => {
              if (!shot || !Array.isArray(shot.urls) || shot.urls.length === 0) return;
              const attached = attachImagesToMessage(pendingMessage.lastMsgId, shot.urls);
              recordTouchImageTask({ conversationId: `char_${id}`, prompt: shot.prompt, promptRefined: shot.promptRefined, urls: shot.urls });
              // 新事件（**别复用 group_message_update** —— 那是群聊 store 的契约）：前端按 msg_id 找到那条气泡挂图。
              // 口径统一走 services/reactionImageUpdate.js（私聊 = proactive_message_update）
              // ⚠️ 2026-10-03 复查：图写进的是**最后一条**（上面那行 attachImagesToMessage 用的 lastMsgId），
              //   而这里原来只传 firstMsgId ⇒ 她的反应被分句成多条气泡时，直播把图挂在第一条后面、
              //   刷新一次又跳到最后一条（用户看到"图会跑"）。两边必须锚同一个：**lastMsgId**。
              const update = reactionImageUpdate({
                scene: 'chat',
                target: { lastMsgId: pendingMessage.lastMsgId, firstMsgId: pendingMessage.firstMsgId, rawId: pendingMessage.rawId },
                images: attached,
                source: 'touch',
              });
              if (update) broadcast(update.event, update.payload);
            })
            .catch(err => {
              console.warn('[touch] 私聊配图后台生成失败（文字已上屏，不下发 update）:', err?.message || err);
            });
        }
      }
    } catch (err) {
      console.warn('[touch] 反应消息写入失败（只影响落库，不影响返回）:', err?.message || err);
      written = null;
      groupWritten = null;
    }

    // 立绘表情联动（task-19 ②）：即时反应成功后按她的表情推一次立绘（服务端独占通道；匹配不到就跳过）
    const standingExpression = driveStandingExpression(id, parsed.facialExpression);

    updateTouchEvent(eventId, {
      reaction: parsed.reactionText,
      facialExpression: parsed.facialExpression,
      emotionDelta: parsed.emotionDelta,
      annoyed: parsed.annoyed,
      status: 'done',
    });

    // ⑤b 偏好微调（task-24 P1-1）：被惹烦 ×0.95（下限 0.5）、明显开心 ×1.05（上限 2）。
    //     模型没给 delta 时用动作定义的静态 delta（与心情同口径）；失败只 warn。
    const likeRatioAfter = tuneTouchLikeRatio(id, key, {
      annoyed: parsed.annoyed,
      valence: parsed.emotionDelta?.valence ?? action.emotionDelta?.valence ?? 0,
    });

    // ⑥ 心情：优先用模型给的 delta，没有就用动作定义的静态 delta；锚点用刚写入的 messages.id
    baseResponse.emotion = applyTouchEmotion({
      character,
      characterId: id,
      delta: parsed.emotionDelta || action.emotionDelta,
      reason: `触摸互动：${action.label}`,
      // 锚点：私聊 = 刚写入的最后一条 messages.id；**群聊传 null**（task-24 P1-2）——
      // `applyTouchEmotion` 的快照永远挂在 `char_<id>` 会话上，喂群 messages.id 会变成
      // 「私聊情绪快照锚到群消息上」的语义错位（FK 不挂，纯语义脏）；传 null 让
      // resolveLastMessageId('char_<id>') 回落到私聊会话最后一条。
      afterMsgId: written?.lastMsgId ?? null,
    });

    baseResponse.status = 'done';
    baseResponse.reaction = {
      text: parsed.reactionText,
      facialExpression: parsed.facialExpression,
      annoyed: parsed.annoyed,
      emotionDelta: parsed.emotionDelta,
    };
    baseResponse.message = written ? { rawId: written.rawId, msgId: written.firstMsgId, msgIds: written.msgIds } : null;
    // 群聊插入式发言的回执（前端/群聊页靠 broadcast 渲染，这里只是诊断用）
    baseResponse.groupMessage = groupWritten
      ? { groupId: Number(normalized.groupId), msgId: groupWritten.msgId, rawId: groupWritten.rawId, seq: groupWritten.seq }
      : null;
    // 出图联动（task-19）：本轮挂上的图片 URL（空数组 = 没出图 / 出图失败）与生效档位
    baseResponse.images = images;
    baseResponse.imageMode = readTouchImageMode();
    // 立绘表情联动：命中的 emoji key（null = 没命中/没表情包，静默跳过）
    baseResponse.standingExpression = standingExpression;
    // task-30 可观测：这次反应喂了多少轮/哪几块喂上了（前端可忽略；真机调参看这里或日志）
    baseResponse.reactionFeed = reactionFeed;
    return res.json(baseResponse);
  } catch (err) {
    console.error('[touch] action error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'touch action failed' });
  }
});

export default router;
