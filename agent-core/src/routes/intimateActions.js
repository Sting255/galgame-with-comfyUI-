/**
 * 性爱交互「可点击推进」HTTP 接口（task-1，2026-10-01）
 *
 * 端点：
 *   GET  /api/intimate-actions/:id/state        面板一次读取：进行中状态 + 她的状态 + 体位清单 + 逐动作可用性
 *   POST /api/intimate-actions/:id/:action      body { positionKey? }（换姿势必带）
 *
 * 挂载建议（本文件只 `export default router`，挂载由 Lead 在 app.js 做）：
 *   `app.use('/api/intimate-actions', wrapRouterAsync(intimateActionRoutes));`
 *   ——**刻意用独立前缀**，不走 `/api/characters`：那一族里 `intimateRoutes` 与 `charactersRoutes`
 *   必须紧邻（test/intimateApi.test.js 断言两者之间不夹别的挂载），塞进去会把冻结契约打破；
 *   独立前缀也不受 `/:id` 通配吞子路径的影响，挂哪儿都行。
 *
 * 分层与口径：
 *   · 状态机 / 档位 / prompt 全在零依赖纯函数 `services/intimateActionService.js`（可脱离 HTTP 单测）；
 *   · 本文件只做"读既有系统的值 → 调纯函数 → 落库 / 调模型 / 发消息"，与 `routes/touch.js` 同款；
 *   · **每一次点击立刻产出一轮反应**（用户原话「还得让角色有反馈」）：
 *       LLM(chatSync, label='intimate-action') → `parseReactionOutput`（与触摸反应同一套 JSON 解析）
 *       → `writeProactiveMessage` 落 `char_<id>` 会话 → `broadcastProactiveMessage` 推给前端消息流。
 *     她的一轮反应因此在聊天里**立刻可见**（与触摸「即时反应」完全同一条上屏链路，前端零改动）。
 *   · 门控拒绝 = HTTP **200** + `{ allowed:false, code, message }`（message 已是人话，前端直接 toast），
 *     与触摸门控同口径；非法动作 / 非法体位 = 400，角色不存在 = 404，总开关关闭 = 409。
 *   · 记账：插入与高潮走 `recordIntimateActs`（source='manual'，与触摸 Lv3 动作同待遇，
 *     绕过 aiEditFields 权限闸门但尊重 `features.intimate`）；同一次插入只记一笔，
 *     幂等锚点 `intimateAction:<角色>:<action_seq>:<actKey>`。
 *   · 心情：走 `emotionEngine` 的既有链路（loadEmotionState → evolveEmotion → saveEmotionSnapshot），
 *     锚点用刚落库的 `messages.id`（不能塞 raw id，会撞 FK —— 催眠手机踩过）。
 *   · 立绘：复用服务端独占通道 `standingDisplay.publishStandingKeys`（与触摸反应同款）。
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { chatSync } from '../llm/llm-client.js';
import { toSqlUtc } from '../services/programTime.js';
import {
  buildIntimateActionPrompt,
  buildPanelSnapshot,
  buildPendingNote,
  describeActionBeat,
  expireIdleScene,
  getIntimateAction,
  getIntimateScene,
  planIntimateAction,
  // ⚠️ 2026-10-03：静默推进那一档的提示语要用它（"速度已调成「快」"）。
  //   漏了这一行 ⇒ 改一次自动速度就 **500**（`paceLabelOf is not defined`）——
  //   单测（纯状态机）与前端用例（只看请求形状）都照不到，是「写路径冒烟」抓出来的。
  paceLabelOf,
  resolveTargetPosition,
  saveIntimateScene,
  patchIntimateScene,
} from '../services/intimateActionService.js';
// 输出解析**直接复用触摸反应那一套**（字段与容错口径逐字同形：json 代码块包裹 / 前后夹话都能吃）
import { parseReactionOutput } from '../services/touchActionService.js';
import {
  affinityToPrompt,
  emotionToPrompt,
  evolveEmotion,
  loadAffinity,
  loadEmotionState,
  saveEmotionSnapshot,
} from '../services/emotionEngine.js';
import { getHypnosisState, isBodyControlled } from '../services/hypnosisService.js';
import { formatScheduleContext, isSleeping } from '../services/scheduleManager.js';
import { buildHypnosisStateBlock } from '../services/hypnosisPrompt.js';
import { buildIntimateProfileBlock } from '../services/intimatePrompt.js';
import { recordIntimateActs } from '../services/intimateService.js';
import { writeProactiveMessage } from '../services/proactiveChatScheduler.js';
import { broadcastProactiveMessage } from '../services/notificationBus.js';
// 2026-10-02：性爱动作也出图 —— 复用玩具那条现成的生成器（**外观感知**：prompt = 她这一下写的画面 + 角色外观段）
// 与"先发文本、图后补"同一套：文字先上屏，图好了再用 proactive_message_update 挂到那条气泡上。
import { generateToyImageForReaction, attachToyImagesToMessage } from '../services/toyService.js';
// 「图好了补挂到那条气泡上」的事件名与载荷口径（群聊/私聊两套 store 各认一条 —— 见模块头）
import { reactionImageUpdate } from '../services/reactionImageUpdate.js';
import { broadcast } from '../services/unifiedStreamBus.js';
// 2026-10-02：群聊维度。用户原话：「在群聊里进行点玩具和插入动作 消息会去到私聊里 这是不应该的
// 在哪里聊天就在哪里继续进行」—— 在此之前本文件把会话**写死**成 `char_<id>`（见下方注释），
// 于是群里点的动作、她的反应、配图全落到私聊。现在按请求带 `scene=group&groupId=<n>` 切到 `group_<gid>`，
// 写入形状与触摸链共用一份实现（services/groupInsertMessage.js），不传 scene 时**逐字保持旧行为**。
import { writeGroupInsertMessage, resolveSceneTarget } from '../services/groupInsertMessage.js';
// 自动插入 ticker 的场景登记：服务端要按自动速度替他"插一下"，它必须知道这一场是在私聊还是群里
// （否则群里开的自动抽插会把她的反应写进私聊 —— 正是用户报过的那类问题）。
// `noteReaction`：这一轮**真的出了一次完整反应**（含一次 LLM 调用）之后记账 ——
// 服务端 ticker 的"反应跳"据此退让，否则面板那一拍（20 秒）与服务端那一跳（20 秒）会叠成每 ~10 秒一次反应
// （2026-10-03 复查发现的额度洞）。
import { noteScene, noteReaction } from '../services/intimateAutoThrust.js';
// 2026-10-02 敏感度（用户提的新数值系统）：她的身体数值，独立于好感/心情。
import { getSensitivity } from '../services/sensitivityService.js';
// 亲密刺激统一下游（2026-10-02）：推进面板的每一下**也写心情与记忆**（用户原话：「角色在感受推进面板
// 的时候 不应该只是独立的加敏感值 也会加到心情系统里面去 还有记忆」）。累积由本文件原本的状态机算，
// 这里只传 amount:0 —— 下游照旧做 心情 + 记忆 + 广播（不重复累加）。
import { applyIntimateStimulus } from '../services/intimateStimulus.js';
import { getStandingDisplay, publishStandingKeys } from '../services/standingDisplay.js';
import { getCharacterEmojiMap } from '../services/emojiService.js';

const router = Router();

const DEFAULT_EMOTION_BASELINE = { valence: 0.5, arousal: 0.5, dominance: 0.5 };

/** 总开关：`config.features.intimateActions`；**不存在 = 开**（键由 Lead 在 config.js 加，加之前行为不变） */
function isIntimateActionEnabled() {
  return config.features?.intimateActions !== false;
}

/**
 * 即时反应开关：复用触摸那条「省额度模式」的键 `features.touchInstant`。
 * 关掉时动作**照常推进并落库**（那一下真的发生了），只是不立刻调模型 ——
 * 这一下会写进 `pendingNote`，下一轮任何一次推进的 prompt 里带出来补演，不丢剧情。
 */
function isInstantEnabled() {
  return config.features?.touchInstant !== false;
}

function parseCharacterId(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function getCharacterRow(id) {
  return getDb().prepare('SELECT * FROM characters WHERE id = ?').get(id) || null;
}

/** 人格串：取角色自己的短人格（short_prompt → 回退 base_prompt），口径与 routes/touch.js 一致 */
function readPersona(character) {
  const shortPrompt = String(character?.short_prompt || '').trim();
  if (shortPrompt) return shortPrompt;
  return String(character?.base_prompt || '').trim();
}

/** 最近 N 条对话（**按场景传会话**：私聊 `char_<id>`、群聊 `group_<gid>`；口径与 touch.js 同名函数一致 ——
 *  群聊里绝不能拿私聊记录当上下文，那条反应会当众发出来） */
function readRecentLines(conversationId, { userName = '', characterName = '', group = false, limit = 6 } = {}) {
  const size = Math.max(1, Math.min(20, Number.parseInt(limit, 10) || 6));
  try {
    const rows = getDb().prepare(
      'SELECT role, content FROM raw_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
    ).all(conversationId, size).reverse();
    return rows.map(row => {
      const text = String(row.content || '').slice(0, 200);
      // 群聊 raw 自带「[名字]: 」前缀，原样用；私聊才拼说话人
      return group ? text : `${row.role === 'user' ? userName : characterName}：${text}`;
    });
  } catch {
    return [];
  }
}

/**
 * 反应喂料（每块独立 try/catch：一块拿不到不影响这一下）：
 *   · 情绪 emotionToPrompt(loadEmotionState)      —— 与 chat.js / 触摸反应同一份情绪口径
 *   · 关系 affinityToPrompt(loadAffinity)
 *   · 日程 formatScheduleContext（她此刻本来在做什么：性爱是插入式事件，别把日程丢了）
 *   · 亲密档案 buildIntimateProfileBlock（开关关 / 档案空 → 空串，零注入）
 *   · 催眠块 buildHypnosisStateBlock（没催眠 → 空串）
 */
function collectFeed({ characterId, userName, characterName, character, conversationId = `char_${characterId}` }) {
  const out = { emotionText: '', affinityText: '', scheduleBlock: '', intimateBlock: '', hypnosisBlock: '', failed: [] };
  try {
    const baseline = JSON.parse(character?.emotion_baseline || JSON.stringify(DEFAULT_EMOTION_BASELINE));
    out.emotionText = emotionToPrompt(loadEmotionState(conversationId, baseline));
  } catch (err) {
    out.failed.push('emotion');
    console.warn('[intimate-action] 情绪块失败（跳过）:', err?.message || err);
  }
  try {
    out.affinityText = affinityToPrompt(loadAffinity(characterId));
  } catch (err) {
    out.failed.push('affinity');
    console.warn('[intimate-action] 关系块失败（跳过）:', err?.message || err);
  }
  try {
    out.scheduleBlock = formatScheduleContext(characterId);
  } catch (err) {
    out.failed.push('schedule');
    console.warn('[intimate-action] 日程块失败（跳过）:', err?.message || err);
  }
  try {
    out.intimateBlock = buildIntimateProfileBlock(characterId, { chatUserName: userName });
  } catch (err) {
    out.failed.push('intimate');
    console.warn('[intimate-action] 亲密档案块失败（跳过）:', err?.message || err);
  }
  try {
    const state = getHypnosisState(characterId);
    out.hypnosisBlock = state?.active
      ? buildHypnosisStateBlock(state, { chatUserName: userName, subject: characterName })
      : '';
  } catch (err) {
    out.failed.push('hypnosis');
    console.warn('[intimate-action] 催眠块失败（跳过）:', err?.message || err);
  }
  return out;
}

/** 心情快照锚点：必须是 messages.id（拿 raw_messages.id 会撞 FK） */
function resolveLastMessageId(conversationId) {
  try {
    const row = getDb().prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversationId);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** 应用心情增量并落一条快照（失败只 warn：心情是旁路，不能让动作失败） */
function applySceneEmotion({ character, characterId, delta, reason, afterMsgId }) {
  try {
    if (!delta) return null;
    // 心情永远写她自己的会话（不随场景分叉）：心情状态按"角色×会话"存，写进群会话会把全群成员的情绪
    // 混到同一行。⚠️ 必须写成这种**同文件可解析的 const**：守卫
    // `saveEmotionSnapshot 的调用点没有任何一个写 group_ 会话` 会解析调用点实参的声明，
    // 把参数默认值那种写法解析不到时会**直接判失败**（宁可红也不放过）—— 别改成解构默认值。
    const conversationId = `char_${characterId}`;
    const baseline = JSON.parse(character?.emotion_baseline || JSON.stringify(DEFAULT_EMOTION_BASELINE));
    const current = loadEmotionState(conversationId, baseline);
    const next = evolveEmotion(current, delta, baseline);
    const dominant = delta.dominance > 0.15 ? 'joy' : (Number(delta.valence) >= 0 ? 'joy' : 'sadness');
    const anchor = afterMsgId ?? resolveLastMessageId(conversationId);
    saveEmotionSnapshot(conversationId, anchor, next, dominant, loadAffinity(characterId), null, reason);
    return { applied: true, afterMsgId: anchor == null ? null : Number(anchor), delta, dominantEmotion: dominant };
  } catch (err) {
    console.warn('[intimate-action] 心情写入失败:', err?.message || err);
    return null;
  }
}

/** 立绘表情切帧（服务端独占通道；匹配不到就跳过）——与触摸反应的 driveStandingExpression 同款 */
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
    console.warn('[intimate-action] 立绘表情联动失败（不影响动作）:', err?.message || err);
    return null;
  }
}

/**
 * 亲密看板记账：插入 / 高潮各记一笔。
 *
 * 幂等锚点 = `intimateAction:<角色>:<action_seq>:<actKey>`：
 *   · action_seq 是这一场里的推进序号（每次点击 +1，落库在同一行），所以**一次点击最多一笔**，
 *     重放（网络重试 / 前端连点）不会把看板刷高；
 *   · raw_id 保持 0：本仓 raw_id 语义固定指向 raw_messages.id，塞别的会污染"按撤回删流水"链路；
 *   · source='manual'：用户自己点出来的，与触摸 Lv3 动作、面板人工补录同待遇；
 *   · 失败只 warn：记账是旁路，绝不能影响这一下本身。
 */
function recordSceneIntimate(characterId, savedState, effects) {
  const rec = effects?.record;
  if (!rec || !rec.actKey) return null;
  if (config.features.intimate === false) return null;
  const sourceUid = `intimateAction:${characterId}:${savedState.actionSeq}:${rec.actKey}`;
  try {
    const result = recordIntimateActs(characterId, {
      scene: 'chat',            // 复用既有 SCENES，不新增枚举值（与触摸 / 奇遇同口径）
      partnerKind: 'user',
      partnerId: 0,
      source: 'manual',
      rawId: 0,
      acts: [{
        actKey: rec.actKey,
        positionKey: rec.positionKey || '',
        count: 1,
        climaxCount: Number(rec.climaxCount) || 0,
        sourceUid,
      }],
    });
    return { actKey: rec.actKey, positionKey: rec.positionKey || '', sourceUid, ...result };
  } catch (err) {
    console.warn('[intimate-action] 亲密看板记账失败:', err?.message || err);
    return null;
  }
}

/** 面板/回执里的状态切片（GET 与 POST 逐字同形，前端只解析一处） */
function statePayload(snapshot) {
  return snapshot.state;
}

/**
 * 组装一次快照（GET 与 POST 共用）。她的三个状态值（好感 / 催眠 / 睡着）与喂料块由调用方读一次传进来，
 * 避免同一次请求里重复查库、重复拼块。
 */
function snapshotFor(id, state, { character = null, her = null, feed = null, enabled = isIntimateActionEnabled() } = {}) {
  const userName = config.user?.nickname || '用户';
  const characterName = character?.display_name || character?.name || '角色';
  const resolvedHer = her || readHerState(id);
  const resolvedFeed = feed || collectFeed({ characterId: id, userName, characterName, character });
  return buildPanelSnapshot(state, {
    affinity: resolvedHer.affinity,
    affinityText: resolvedFeed.affinityText,
    emotionText: resolvedFeed.emotionText,
    hypnotized: resolvedHer.hypnotized,
    sleeping: resolvedHer.sleeping,
    enabled,
    // 敏感度要一路传到面板（预演"一起到"可不可用、显示她有多敏感都靠它）
    sensitivity: resolvedHer.sensitivity,
    sensitivityInfo: resolvedHer.sensitivityInfo,
  });
}

/** 她此刻的真实状态（门控 + prompt 共用同一份读取，别两处各读一遍） */
function readHerState(id) {
  let affinity = 0;
  let hypnotized = false;
  let sleeping = false;
  try { affinity = loadAffinity(id); } catch { affinity = 0; }
  try { hypnotized = isBodyControlled(id); } catch { hypnotized = false; }
  try { sleeping = Boolean(isSleeping(id).sleeping); } catch { sleeping = false; }
  // 2026-10-02 敏感度（用户提的新数值系统，见 services/sensitivityService.js）：她"有多敏感"是她自己的
  // 持久数值（0~100，缓慢累加/回落，发情模式拉满）⇒ 同一个动作在不同角色、不同时期效果都不一样。
  // 面板上那个「好感」不再参与这条计算（好感管关系，敏感度管身体）。
  let sensitivity = 1;
  let sensitivityInfo = null;
  try {
    sensitivityInfo = getSensitivity(id);
    sensitivity = sensitivityInfo.multiplier;
  } catch { sensitivity = 1; }
  return { affinity, hypnotized, sleeping, sensitivity, sensitivityInfo };
}

function actionBrief(action) {
  return { key: action.key, label: action.label, hint: action.hint || '', tone: action.tone || '' };
}

// ── GET /:id/state ──────────────────────────────────────────────────────────

router.get('/:id/state', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const character = getCharacterRow(id);
    if (!character) return res.status(404).json({ error: 'character not found' });
    // 2026-10-02 群聊维度：面板在群里打开时会带 ?scene=group&groupId=<n>（不传 = 私聊，逐字保持旧行为）
    const scene = resolveSceneTarget(req, id);
    if (!scene.ok) return res.status(400).json({ error: scene.message, code: scene.code });
    // 空闲超时先收场（与 touch 的过期清扫同款：读入口顺手做一次）
    expireIdleScene(id);
    const state = getIntimateScene(id);
    const snapshot = snapshotFor(id, state, { character });
    return res.json({
      characterId: id,
      scene: scene.scene,
      groupId: scene.groupId,
      enabled: snapshot.enabled,
      features: { intimateActions: config.features?.intimateActions, instant: isInstantEnabled() },
      ...snapshot,
    });
  } catch (err) {
    console.error('[intimate-action] state error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'intimate action state failed' });
  }
});

// ── POST /:id/:action ───────────────────────────────────────────────────────

router.post('/:id/:action', async (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });

  if (!isIntimateActionEnabled()) {
    return res.status(409).json({
      error: 'intimate actions feature disabled',
      features: { intimateActions: config.features?.intimateActions },
    });
  }

  const character = getCharacterRow(id);
  if (!character) return res.status(404).json({ error: 'character not found' });

  const action = getIntimateAction(req.params.action);
  if (!action) return res.status(400).json({ error: 'unknown action', code: 'unknown_action' });

  // 换姿势必须带一个**词表里合法**的目标体位（非法一律 400，不给"点不动但没提示"的死按钮）
  const positionKeyRaw = req.body?.positionKey;
  let target = null;
  if (action.key === 'position') {
    target = resolveTargetPosition(positionKeyRaw);
    if (!target) return res.status(400).json({ error: 'invalid position', code: 'invalid_position' });
  }

  // 2026-10-02 群聊维度：`scene=group&groupId=<n>` ⇒ 会话切到 `group_<gid>`；不传 = 私聊（逐字保持旧行为）。
  // 群聊要做三项校验（群存在 / 她是成员 / groupId 合法）—— 失败给 400 + 人话，别把发言写进没人看的会话。
  const scene = resolveSceneTarget(req, id);
  if (!scene.ok) {
    return res.status(400).json({ allowed: false, code: scene.code, message: scene.message, error: scene.message });
  }
  // 登记场景给自动插入 ticker（自动插送的那一下也要写回同一个地方）。
  // ⚠️ `internal`：这一条是 ticker **自己发来的**推进（回声）⇒ 不登记、不续期 ——
  //   否则它的每一跳都会把自己的场景登记刷新一遍，SCENE_MEMO_TTL_MS 永远不生效：
  //   玩家在群里开自动、然后回私聊什么都不点，她的反应就会一直留在群里（代码审查那条）。
  //   玩家侧的动作（含面板那一拍）照旧**立刻覆盖**上一次登记 —— 私聊动作压掉群登记，反之亦然。
  noteScene(id, {
    scene: scene.scene,
    groupId: scene.groupId,
    internal: req.body?.internal === true,
  });

  try {
    expireIdleScene(id);
    const before = getIntimateScene(id);
    const userName = config.user?.nickname || '用户';
    const characterName = character.display_name || character.name || '角色';

    // 门控输入（与她此刻的真实状态同源）：三个值只读一次，门控 / 快照 / prompt 共用
    const her = readHerState(id);
    const { affinity, hypnotized, sleeping } = her;
    // 喂料块（情绪 / 关系 / 日程 / 亲密档案 / 催眠）：只拼一次，快照与 prompt 共用
    const feed = collectFeed({ characterId: id, userName, characterName, character });
    const snap = (state) => snapshotFor(id, state, { character, her, feed });

    // ① 状态机（纯函数）：算下一个状态 or 给出拒绝理由
    const planned = planIntimateAction(before, {
      // 她自己的敏感度（越敏感，同一个动作在她身上涨得越快 / 门槛越低 / 高潮越强）—— 见 readHerState
      sensitivity: her.sensitivity,
      actionKey: action.key,
      positionKey: positionKeyRaw,
      affinity,
      hypnotized,
      // 自动抽插的服务端补算需要"现在"（纯函数不碰 Date）—— 见 planIntimateAction 里的 autoTicks
      now: Date.now(),
      // 自动速度（2026-10-03 独立旋钮）：`auto` 动作带 `pace` 时只改自动速度；
      //   `auto: true` 表示"这一下是他自动插送的"（ticker 发来的那一轮，增益走 autoTickGain）
      pace: req.body?.pace,
      autoRun: req.body?.auto === true,
    });
    const brief = actionBrief(action);
    if (!planned.ok) {
      // 门控拒绝 = 200 + allowed:false（message 已是人话，前端直接 toast）
      const snapshot = snap(planned.next);
      return res.json({
        allowed: false,
        code: planned.code,
        message: planned.message,
        action: brief,
        mode: null,
        reaction: null,
        state: statePayload(snapshot),
        her: snapshot.her,
      });
    }

    // ② 落库（先落状态：这一下**真的发生了**，模型失败也不能回滚玩法状态）
    const nowSql = toSqlUtc(new Date());
    const persisted = saveIntimateScene(id, {
      ...planned.next,
      // startedAt 只在"这一场第一次推进"时落，之后不动（持续时间口径）；老行缺值时补上
      startedAt: (before.active && before.startedAt) ? before.startedAt : nowSql,
      lastActionAt: nowSql,
    });
    const beat = describeActionBeat({ actionKey: action.key, state: before, next: persisted, target, autoRun: planned.effects.autoTick === true });

    // ③ 亲密看板记账（插入 / 高潮；同一次点击只一笔）
    const intimateRecord = recordSceneIntimate(id, persisted, planned.effects);
    const position = snap(persisted).position;

    const baseResponse = {
      allowed: true,
      code: 'ok',
      action: brief,
      beat,
      position,
      climaxed: Boolean(planned.effects.climaxed),
      intimate: intimateRecord,
      pendingNote: persisted.pendingNote,
    };

    // ③.5 静默推进（`silent: true`）：自动插入的**状态跳** —— 只推进状态、广播状态，**不调模型**。
    //   为什么要有这一档（2026-10-03 复查）：ticker 每一跳都走完整链路的话，冲刺档 1.5 秒一跳
    //   = 每分钟 40 次 LLM 调用，用户开一小时就是上千次（钱和额度都是真的）。她的"反应"由
    //   反应跳（每 20 秒至多一次）与用户自己的操作负责，累积则靠这一档忠实地走。
    //   ⚠️ 2026-10-03 复查补：**只改自动速度**（面板上那一排页签）也不该烧一次模型调用 ——
    //   前端本来就是这么写的（`setAutoPace` 刻意不走 run()），可路由以前没有对应的早退 ⇒
    //   每点一下都是一次 chatSync + 一条气泡。所以"速度只是被改了"也走静默这一档。
    const speedOnly = planned.effects.autoChanged === 'pace';
    const silentJump = req.body?.silent === true && planned.effects.autoTick === true;
    if (silentJump || speedOnly) {
      const snapshot = snap(persisted);
      const climaxStrengthSilent = planned.effects.climaxed ? (planned.effects.climaxStrength || 3) : 0;
      // 静默状态跳**不进心情/记忆**：否则自动插入开着时（冲刺档 1.5 秒一次）会每分钟几十次地推她的
      // 情绪、还跟着写情绪快照 —— 只有"她真的到了"这种事件才值得留下痕迹。
      if (climaxStrengthSilent > 0) {
        Promise.resolve()
          .then(() => applyIntimateStimulus({
            characterId: id,
            character,
            source: 'intimate',
            amount: 0,
            scene: scene.scene,
            groupId: scene.groupId,
            reason: `她高潮了（强度 ${climaxStrengthSilent}/5）`,
            note: `和 ${userName} 的性爱里她到了（强度 ${climaxStrengthSilent}/5）`,
            climax: climaxStrengthSilent,
            // 自动插入的每一跳：敏感度走小份量 + 15 秒节流那一档（玩家手点不受节流）
            autoTick: true,
          }))
          .catch(err => console.warn('[intimate-action] 静默推进的刺激下游失败（不影响这一下）:', err?.message || err));
      }
      return res.json({
        ...baseResponse,
        mode: speedOnly ? 'speed' : 'silent',
        fallback: false,
        notice: speedOnly
          ? `自动插送的速度已调成「${paceLabelOf(snapshot.state.autoPace)}」（没有调用模型）。`
          : '自动插入：这一下只推进状态（没有调用模型）—— 她会隔一会儿才开口。',
        reaction: null,
        message: null,
        emotion: null,
        state: statePayload(snapshot),
        her: snapshot.her,
      });
    }

    // ④ 省额度模式：状态照常推进，反应留到下一轮补演
    if (!isInstantEnabled()) {      const note = buildPendingNote({ actionKey: action.key, state: before, next: persisted, target });
      // 只改这一列：整行回写会把等模型期间 ticker 推进的累积/action_seq 一起回滚（见 patchIntimateScene 注释）
      const saved = patchIntimateScene(id, { pendingNote: note });
      const snapshot = snap(saved);
      return res.json({
        ...baseResponse,
        mode: 'implicit',
        fallback: false,
        notice: '「省额度模式」已开启：这一下的反应会留到她下一轮聊天里演出来。',
        reaction: null,
        message: null,
        emotion: null,
        state: statePayload(snapshot),
        her: snapshot.her,
      });
    }

    // ⑤ 即时反应：一次 500 token 的小调用（客户端断开就中止，别空烧额度）
    let clientGone = false;
    const upstreamAbort = new AbortController();
    res.on('close', () => {
      if (res.writableEnded) return;   // 正常结束（我们自己 res.json）不算断开
      clientGone = true;
      upstreamAbort.abort();
    });

    let parsed = null;
    let promptInfo = null;
    try {
      const feed = collectFeed({ characterId: id, userName, characterName, character, conversationId: `char_${id}` });
      const prompt = buildIntimateActionPrompt({
        actionKey: action.key,
        state: before,
        next: persisted,
        target,
        persona: readPersona(character),
        characterName,
        userName,
        emotionText: feed.emotionText,
        affinityText: feed.affinityText,
        scheduleBlock: feed.scheduleBlock,
        intimateBlock: feed.intimateBlock,
        hypnosisBlock: feed.hypnosisBlock,
        recentLines: readRecentLines(scene.conversationId, { userName, characterName, group: scene.scene === 'group', limit: 6 }),
        hypnotized,
        sleeping,
        attitude: planned.effects.attitude || '',
        pendingNote: persisted.pendingNote,
        // 高潮的演出强度随她自己的敏感度浮动（1~5）—— 见 climaxStrength
        sensitivity: her.sensitivity,
        // 这一下是不是"自动插入"里的一下（他自己按节奏动）—— 演出要写成他在动，见 describeActionBeat
        autoRun: planned.effects.autoTick === true,
      });
      promptInfo = {
        blocks: prompt.meta.blocks,
        actionKey: prompt.meta.actionKey,
        chars: prompt.system.length + prompt.user.length,
        failed: feed.failed,
      };
      // 可观测（真机调参用）：一行，不影响动作
      console.log(`[intimate-action] ${action.key} position=${persisted.positionKey} pace=${persisted.pace} acc=${persisted.accumulation} penetrating=${persisted.penetrating ? 1 : 0} blocks=${promptInfo.blocks.join(',') || 'none'} failed=${feed.failed.join(',') || 'none'} chars=${promptInfo.chars}`);
      const raw = await chatSync(prompt.messages, {
        temperature: 0.9, max_tokens: 500, label: 'intimate-action', retries: 1,
        signal: upstreamAbort.signal,
      });
      parsed = parseReactionOutput(raw);
    } catch (err) {
      console.warn('[intimate-action] 即时反应调用失败，留待下一轮补演:', clientGone ? 'client_disconnected' : (err?.message || err));
    }

    if (!parsed?.ok) {
      // 失败/解析不出来：**不回滚状态**，把这一下写进 pendingNote，下一轮带出来补演
      const note = buildPendingNote({ actionKey: action.key, state: before, next: persisted, target });
      // 只改这一列：整行回写会把等模型期间 ticker 推进的累积/action_seq 一起回滚（见 patchIntimateScene 注释）
      const saved = patchIntimateScene(id, { pendingNote: note });
      const snapshot = snap(saved);
      const emotion = applySceneEmotion({
        // 心情**不分场景**：只会话是消息的目标（群聊就发在群里），情绪与记忆始终属于她本人。
        character, characterId: id, delta: null,
        reason: `性爱推进：${action.label}`, afterMsgId: null,
      });
      if (clientGone || res.writableEnded) return undefined;
      return res.json({
        ...baseResponse,
        mode: 'instant',
        fallback: true,
        reason: 'instant_failed',
        notice: '她的反应没写出来（模型调用失败）：状态已经推进，这一下会在下一轮补演。',
        reaction: null,
        message: null,
        emotion,
        prompt: promptInfo,
        state: statePayload(snapshot),
        her: snapshot.her,
      });
    }

    // ⑥ 反应真的落库 + 推给前端消息流（她的一句话立刻上屏）
    //
    // 先记一笔"这个角色刚出了一轮完整反应"（2026-10-03 复查）：面板开着时它自己也有一拍 20 秒的
    // "补一下"（IntimateActionPanel 的 AUTO_TICK_MS），而服务端 ticker 的反应跳也是 20 秒一次 ——
    // 两条节拍各走各的表 ⇒ 她每 ~10 秒就出一轮完整反应，每次都是一次 LLM 调用（额度翻倍）。
    // 现在两边共用 intimateAutoThrust 里那一个闸门（reactionDue），面板的周期严格短于闸门
    // ⇒ 面板开着时服务端每一跳都退化成状态跳（silent）。silent / speedOnly 早退与模型失败那两条
    // 分支都在这行之前返回 ⇒ 只有"真的让她说了一句"才算数。
    noteReaction(id);
    //   2026-10-02：**按场景分叉** —— 群聊里就写群会话 + 广播 `group_message`（群聊页只认这条统一流事件），
    //   私聊里保持原样（`char_<id>` + `proactive_message`）。不这样做的话，用户在群里点的动作、
    //   她的反应、配图会全部出现在私聊里（用户原话：「在哪里聊天就在哪里继续进行」）。
    let written = null;
    /** 群聊分支的广播载荷（⑥.5 补图要用同一份：`group_message_update` 必须带 id/seq/speaker…） */
    let groupPayload = null;
    try {
      if (scene.scene === 'group') {
        written = writeGroupInsertMessage(scene.groupId, character, parsed.reactionText, {
          source: 'intimate_action',
          extra: {
            intimate_action: {
              action: action.key,
              label: action.label,
              positionKey: persisted.positionKey,
              pace: persisted.pace,
              accumulation: persisted.accumulation,
              penetrating: persisted.penetrating,
            },
          },
        });
        if (written) {
          // 与触摸链同一条广播（payload 形状在 groupInsertMessage.js 里统一维护）
          groupPayload = written.payload;
          broadcast('group_message', written.payload);
          // 让下游沿用同一套字段名（配图那段用 lastMsgId / firstMsgId / rawId / segments）
          written = {
            rawId: written.rawId,
            firstMsgId: written.msgId,
            lastMsgId: written.msgId,
            msgIds: [written.msgId],
            segments: [parsed.reactionText],
          };
        }
      } else {
        written = writeProactiveMessage(character, parsed.reactionText);
      }
      if (written && scene.scene !== 'group') {
        broadcastProactiveMessage({
          character_id: id,
          display_name: characterName,
          avatar_path: character.avatar_path || null,
          content: parsed.reactionText,
          segments: written.segments || [parsed.reactionText],
          msg_ids: written.msgIds,
          msg_id: written.firstMsgId,
          raw_id: written.rawId,
          images: [],
          source: 'intimate_action',
          intimate_action: {
            action: action.key,
            label: action.label,
            positionKey: persisted.positionKey,
            pace: persisted.pace,
            accumulation: persisted.accumulation,
            penetrating: persisted.penetrating,
          },
          created_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[intimate-action] 反应消息写入失败（只影响落库，不影响返回）:', err?.message || err);
      written = null;
    }

    // ⑥.5 配图（2026-10-02）：LLM 在反应里给了画面 ⇒ 后台生成并挂到那条气泡上。
    // 文本已经在 ⑥ 上屏，所以这一步慢/失败都**不影响她说话**（与"先发文本、图后补"同一口径）。
    // 出不出图仍由生成器自己判断（总开关 / 智能档概率 / ComfyUI 是否在线），这里不重复做门控。
    //
    // ⚠️⚠️ 2026-10-03 真机反馈「在群聊里性爱…光图词 没配图 但是生图又是成功的」——**事件名发错了**：
    //   群聊页的消息流只认 `group_message` / `group_message_update`（`routes/groups.js` 的 emit →
    //   `web/src/stores/groups.js`），而这里不管什么场景都发 `proactive_message_update`。
    //   于是：图**真的生成成功了、也确实挂进了 messages.images**（刷新或看相册能看到），
    //   但群聊页那句气泡永远收不到"补图"事件 ⇒ 看起来就是"只有图词、没有图"。
    //   口径与 `routes/touch.js` 的群聊补图**逐字对齐**：`{ ...payload, group_id, images }`。
    //   （私聊继续用 `proactive_message_update` —— touch.js 里那句注释说得很清楚：那是两套 store 的契约，
    //    别互相复用。）
    if (written && parsed.imagePrompt) {
      const isGroup = scene.scene === 'group';
      const target = {
        lastMsgId: written.lastMsgId || written.firstMsgId,
        firstMsgId: written.firstMsgId,
        rawId: written.rawId,
      };
      const imagePrompt = String(parsed.imagePrompt);
      Promise.resolve()
        .then(() => generateToyImageForReaction({ character, imagePrompt }))
        .then((shot) => {
          if (!shot?.urls?.length) return;
          const attached = attachToyImagesToMessage(target.lastMsgId, shot.urls);
          if (!attached.length) return;
          // 事件名与载荷形状的唯一来源：services/reactionImageUpdate.js（群/私两套 store 各认一条）
          const update = reactionImageUpdate({
            scene: isGroup ? 'group' : 'chat',
            groupPayload,
            target,
            images: attached,
            groupId: scene.groupId,
            reactionText: parsed.reactionText,
            source: 'intimate_action',
          });
          if (update) broadcast(update.event, update.payload);
        })
        .catch((err) => {
          console.warn('[intimate-action] 配图后台生成失败（文字已上屏，不下发 update）:', err?.message || err);
        });
    }

    // 成功演出 → 清掉补演备注
    // 只清这一列（同上：别整行覆盖）
    const saved = patchIntimateScene(id, { pendingNote: '' });

    // 亲密刺激统一下游（2026-10-02）：把这一下同步进**心情 + 记忆**（累积已由上面的状态机算过，
    // 所以这里 amount:0；下游照样广播 intimate_stimulus，面板的进度条据此实时更新）。
    // 不 await：心情/记忆是旁路，绝不能拖慢或搞砸"点一下"的回执。
    // 2026-10-02 追加：高潮那一下要单独说清楚（强度 1~5，由她的敏感度决定）——
    // 否则"她到了"这件事在心情与记忆里跟一次普通推进没区别。
    const climaxStrength = planned.effects.climaxed ? (planned.effects.climaxStrength || 3) : 0;
    Promise.resolve()
      .then(() => applyIntimateStimulus({
        characterId: id,
        character,
        source: 'intimate',
        amount: 0,
        scene: scene.scene,
        groupId: scene.groupId,
        reason: climaxStrength ? `她高潮了（强度 ${climaxStrength}/5）` : `性爱推进：${action.label}`,
        note: climaxStrength
          ? `和 ${userName} 的性爱里她到了（强度 ${climaxStrength}/5）—— 身体被推过去之后还在抖`
          : `和 ${userName} 的性爱推进（${action.label}）让身体累积到 ${persisted.accumulation}`,
        // 这一下是不是把她推过了顶点（0 = 不是；1~5 = 她的高潮强度）：
        // 下游据此给心情一笔明确增量、写一条记忆，并让她的敏感度涨得更多（越敏感 → 到得越重 → 涨得越快）。
        climax: climaxStrength,
        // 自动插入的每一跳（ticker / 面板节拍推的）：敏感度走小份量 + 15 秒节流那一档。
        // 玩家自己点的那一下 autoTick=false ⇒ 照给（否则「性爱不涨敏感度」会以另一种形式回来）。
        autoTick: planned.effects.autoTick === true,
      }))
      .catch(err => console.warn('[intimate-action] 刺激下游失败（不影响这一下）:', err?.message || err));

    // ⑦ 立绘表情切帧 + 心情
    const standingExpression = driveStandingExpression(id, parsed.facialExpression);
    const emotion = applySceneEmotion({
      character,
      characterId: id,
      // 心情不分场景（见 applySceneEmotion 里的说明与守卫）。
      delta: parsed.emotionDelta,
      reason: `性爱推进：${action.label}`,
      afterMsgId: written?.lastMsgId ?? null,
    });

    const snapshot = snap(saved);
    return res.json({
      ...baseResponse,
      mode: 'instant',
      fallback: false,
      reaction: {
        text: parsed.reactionText,
        facialExpression: parsed.facialExpression,
        annoyed: parsed.annoyed,
        emotionDelta: parsed.emotionDelta,
        // 画面描述只是模型给的**即时画面**：本轮不联动出图（本任务不做出图），
        // 需要配图时由前端/后续任务复用既有生图链路，别在这里偷偷调 ComfyUI。
        imagePrompt: parsed.imagePrompt,
      },
      message: written ? { rawId: written.rawId, msgId: written.firstMsgId, msgIds: written.msgIds } : null,
      emotion,
      standingExpression,
      prompt: promptInfo,
      state: statePayload(snapshot),
      her: snapshot.her,
    });
  } catch (err) {
    console.error('[intimate-action] action error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'intimate action failed' });
  }
});

export default router;
