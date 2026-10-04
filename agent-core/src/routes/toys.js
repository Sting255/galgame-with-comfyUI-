/**
 * routes/toys.js —— 成人玩具系统 API（专题-玩具系统与真机反馈三期 §2.9-2）
 *
 * 契约（hires-ui 的 web-ui/src/api/index.js 已按 §2.9-2 写好，路径/字段以那四个函数为准）：
 *   GET  /api/characters/:id/toys                      → { unlocked, worn[], available[] }
 *   POST /api/characters/:id/toys/:toyKey/equip        body { intensity } → { ok, toy, reaction, memory }
 *   POST /api/characters/:id/toys/:toyKey/set-intensity body { intensity } → 同上
 *   POST /api/characters/:id/toys/:toyKey/remove       body {} → 同上
 *
 * 2026-10-02 玩法扩充（用户原话「玩具玩法有点太少了」）：**全部挂在本 router 下**
 * （app.js 已 `app.use('/api/characters', toysRoutes)` ⇒ 零改动即可用，不需要新挂载点）：
 *   GET  /:id/toys                 追加 catalog[] / combos / tick.transitions / selfPlay（旧字段一个没动）
 *   POST /:id/toys/:toyKey/mode    body { mode }   → 振动模式（持续/脉冲/渐变/随机）
 *   POST /:id/toys/:toyKey/curve   body { curve }  → 强度曲线（随时间自动升降；null/'off' 关掉）
 *   POST /:id/toys/tick            body {}         → **推进曲线**（返回本 tick 的档位变化）
 *   GET  /:id/toys/self-play                        → 她"自己会不会玩"的判定预览（无副作用）
 *   POST /:id/toys/self-play       body { encourage } → 让她自己判断一次；她愿意就真的戴上 + 上屏
 *
 * 口径：
 *   · 开关 features.toys（**默认关**）：关着时读接口照常返回 unlocked:false，写接口 403；
 *   · 装上走 §2.4 门控（toyService.gateToy → 复用触摸系统门槛/文案/催眠豁免/群聊口径）；
 *   · 调强度/摘下/模式/曲线**无门控**（已戴上就是默许）；
 *   · **她自己主动玩那条线不走 gateToy**：那是她对自己身上的东西动手，判定在
 *     `services/toy/selfPlay.js`（好感/淫乱度/独处/催眠/情境），与"用户命令她戴"分开两条；
 *   · 三种事件都走一次轻量反应调用（同 touch 反应管线：chatSync + parseReactionOutput），
 *     并把 emotion_delta 落 emotionEngine、把事件写一条记忆（§2.6-2/3，dedupeKey 幂等）。
 *   · 反应/记忆/心情都是**增强项**：任何一步失败都不影响穿戴状态本身（try/catch 各自兜底）。
 *
 * 场景（2026-10-03 群聊 bug，两位独立审查者的结论）：
 *   · 装 / 调强度 / 摘下 / 她自己玩都接受 `body|query` 的 `scene=group` + `groupId=<n>`；
 *     **不传 = 私聊**（与改造前逐字一致，老前端不受影响）。
 *   · 群聊 ⇒ 她的反应写进 `group_<gid>` + 广播 `group_message`（补图 `group_message_update` —— 群聊页只认
 *     这两条统一流事件）；私聊 ⇒ `char_<id>` + `proactive_message` / `proactive_message_update`。
 *   · 群聊成人内容吃 `features.touchGroupAdult`（与触摸 / 亲密**同一条**闸门，默认关）：开关关着时
 *     四条链全部 403 `toy_gate_blocked` + `code='group_adult_blocked'` + 触摸链那句人话。
 *   · `scene=group` 必须带合法 groupId 且她是该群成员，否则 400 + 人话（别把发言写进没人看的会话）。
 */

import express from 'express';
import { config } from '../config.js';
import {
  loadAffinity, loadOath, loadEmotionState, evolveEmotion, saveEmotionSnapshot,
} from '../services/emotionEngine.js';
import { getHypnosisState, isBodyControlled } from '../services/hypnosisService.js';
import { isSleeping, tempWake } from '../services/scheduleManager.js';
import { writeProactiveMessage } from '../services/proactiveChatScheduler.js';
import { isAiEditAllowed } from '../services/intimateService.js';
import { chatSync } from '../llm/llm-client.js';
import { parseReactionOutput } from '../services/touchActionService.js';
// 2026-10-02：让她知道"此刻正被插着" —— 玩具链原来只喂玩具状态，插入是另一条链的事，
// 于是"一边插着一边戴玩具"在她眼里是两件无关的事（用户明确要的是同一场戏）。
import { buildIntimateScenePromptBlock } from '../services/intimateActionService.js';
import { applyMemoryActions } from '../services/memory/memoryRepository.js';
// 批量装卸的汇总广播（2026-10-04）：单件那条链是靠反应消息体自身刷新的，
// 批量不产反应 ⇒ 必须自己广播一次，否则前端 store 的穿戴清单不会变。
import { broadcast } from '../services/unifiedStreamBus.js';
import {
  TOY_KEYS, ALL_TOY_KEYS, getToy, listWornToys, gateToy, equipToy, setToyIntensity, removeToy,
  setToyMode, setToyCurve, tickToys, wornCombo, comboEffects,
  buildToyReactionPrompt, buildToyMemoryEntry, buildToyBatchMemoryEntry, applyToyWake, publishToyReaction,
  maybeSelfPlay, selfPlayContext, decideSelfPlay, lastSelfPlay, lewdnessFor, selfPlayCountToday,
  buildSelfPlayPrompt, parseSelfPlayOutput,
  VIBRATION_MODES, INTENSITY_CURVES, SELF_PLAY_WINDOW_MS, seedOf, hash01, modeMeta, curveLabel,
} from '../services/toyService.js';
import { getDb } from '../db/index.js';
// 2026-10-03 群聊维度（两位独立审查者复现的 bug）：玩具的装/调/摘/她自己玩原来**不管场景都写私聊**
// （`publishToyReaction` 的 writeMessage ⇒ `char_<id>`），于是"在群聊里点玩具，她的反应跑到私聊"。
// 场景解析与群消息写入与 touch / 亲密共用同一份实现（`resolveSceneTarget` / `writeGroupInsertMessage`）。
import { resolveSceneTarget } from '../services/groupInsertMessage.js';

const router = express.Router();

const toysUnlocked = () => config.features.toys === true;
const userName = () => config.user?.nickname || '用户';

/**
 * 门控上下文：与触摸系统同一批输入（见 touchActionService.getTouchGate 的文件头）。
 * `sceneOverride` 由 `resolveSceneTarget` 解析出来的场景传入 —— 群聊时它已经校验过
 * 「群存在 + 她是成员」，别在这里再从 query/body 各读一遍（两处口径必然漂移）。
 */
function gateContext(req, characterId, sceneOverride = null) {
  const raw = sceneOverride || String((req.query && req.query.scene) || (req.body && req.body.scene) || 'chat');
  return {
    scene: raw === 'group' ? 'group' : 'chat',
    allowGroupAdult: config.features.touchGroupAdult === true,
    affinity: loadAffinity(characterId),
    isOath: loadOath(characterId) === true,
    hypnotized: isBodyControlled(characterId),
    sleeping: Boolean(isSleeping(characterId)?.sleeping),
    intimateAuthorized: isAiEditAllowed(characterId, 'stats') === true,
  };
}

/**
 * 群聊成人闸门（与触摸 / 亲密**同一条**：`config.features.touchGroupAdult`，默认关）。
 *
 * 为什么调强度 / 摘下 / 她自己玩也要过这一道：这三条链按设计**不走 gateToy**（已戴上就是默许），
 * 但它们同样会把她的反应发到群里 —— 而修完"在哪聊就在哪继续"之后，群聊成人开关关着时的
 * 玩具反应就是当众演限制级。触摸链对**每一个**动作都过 getTouchGate（群聊 + 成人档 + 开关关
 * ⇒ `group_adult_blocked` + 同一句话），玩具这块必须一致，否则它就是绕过闸门的后门。
 *
 * 口径复用：玩具全是 Lv3/Lv4（成人档）⇒ 拿这件玩具过一遍 `gateToy` 就是结论（注意 `gateToy` 里
 * 催眠豁免与 sleeping 口径也一并继承，不另造）。只有 `group_adult_blocked` 才算拦；
 * 好感 / 授权那些门槛在这三条链上依旧**不拦**（已戴上就是默许，与旧行为一致）。
 *
 * @returns {object|null} 拦截时返回 gate（调用方按 toy 的既有拒绝形状回 403），放行返回 null
 */
function groupAdultGate(characterId, toyKey, ctx) {
  if (ctx.scene !== 'group') return null;
  // 她自己玩那条链事先不知道会挑哪一件 ⇒ 用清单第一件过闸（全部玩具都是成人档，结论与件无关）
  const gate = withGate(characterId, toyKey || TOY_KEYS[0], ctx);
  return gate.code === 'group_adult_blocked' ? gate : null;
}

/** 玩具链的拒绝回执（与 equip 的既有契约同一形状：403 + error/code/message，message 是给她看的人话） */
function refuseGroupAdult(res, gate) {
  return res.status(403).json({ error: 'toy_gate_blocked', code: gate.code, message: gate.message });
}

function gatePayload(gate) {
  return { allowed: gate.allowed, code: gate.code, message: gate.message || '', exempt: gate.exempt || null };
}

function withGate(characterId, toyKey, ctx) {
  return gateToy({ toyKey, ...ctx });
}

function wornPayload(characterId, ctx, now = Date.now()) {
  return listWornToys(characterId, { now }).map(t => ({
    toyKey: t.toyKey,
    label: t.label,
    part: t.part,
    partSection: t.partSection,
    effect: t.effect || '',
    stimulus: t.stimulus,
    stimulusLabel: t.stimulusLabel,
    desc: t.desc,
    intensity: t.intensity,               // 基准档（旧字段，语义不变）
    liveIntensity: t.liveIntensity,       // 此刻生效档（曲线 × 模式）
    maxIntensity: t.maxIntensity,
    mode: t.mode,
    modeLabel: t.modeLabel,
    modePhase: t.modePhase,
    modePhaseText: t.modePhaseText,
    curve: t.curve,
    curveLabel: t.curveLabel,
    curveProgress: t.curveProgress,
    remainingSec: t.remainingSec,
    curveFinished: t.curveFinished,
    equippedAt: t.equippedAt,
    minutesWorn: t.minutesWorn,
    gate: gatePayload(withGate(characterId, t.toyKey, ctx)),
  }));
}

function availablePayload(characterId, ctx) {
  return TOY_KEYS.map(key => {
    const toy = getToy(key);
    const gate = withGate(characterId, key, ctx);
    return {
      toyKey: key,
      label: toy.label,
      part: toy.part,
      maxIntensity: toy.maxIntensity,
      allowed: gate.allowed,
      gate: gatePayload(gate),
    };
  });
}

/**
 * 全部玩具清单（含第二批 6 件）。**与 `available` 分开返回**：
 * `available` 是首期 5 件的旧契约（既有测试与 force_toy 枚举都吃它，一个字符都不能动），
 * 面板要从这里拿完整清单 + 服务端门控结论。
 */
function catalogPayload(characterId, ctx) {
  return ALL_TOY_KEYS.map(key => {
    const toy = getToy(key);
    const gate = withGate(characterId, key, ctx);
    return {
      toyKey: key,
      label: toy.label,
      part: toy.part,
      partSection: toy.partSection,
      desc: toy.desc,
      effect: toy.effect || '',
      stimulus: toy.stimulus || toy.intensityKind,
      maxIntensity: toy.maxIntensity,
      legacy: TOY_KEYS.includes(key),
      allowed: gate.allowed,
      gate: gatePayload(gate),
    };
  });
}

function modeOptions() {
  return Object.values(VIBRATION_MODES).map(m => ({ value: m.key, label: m.label }));
}

function curveOptions() {
  return Object.values(INTENSITY_CURVES).map(c => ({ value: c.key, label: c.label }));
}

function characterIdOf(req) {
  return Number.parseInt(req.params.id, 10);
}

/**
 * 上屏/出图要用的角色行（display_name / avatar_path）。
 *
 * ⚠️ 2026-10-02 修真 bug（用户："玩具触发的图和角色完全无关"）：
 *   原来只 SELECT `id, display_name, avatar_path`，**没查 `base_prompt`** ——
 *   而这个对象会一路传到 `generateToyImageForReaction`，那里靠
 *   `buildCharacterAppearanceSection(character)` 从 `base_prompt` 里提"## 你的外观"段。
 *   于是外观段**永远为空**，最终 prompt 只剩 LLM 写的场景描述
 *   （真机日志铁证：所有玩具图的 Final prompt 都是 `english: a young woman…`，
 *    零角色名零外观；同一日志里聊天/性爱面板的图全都带完整角色外观）。
 *   玩具出图从上线起就没带过人 —— 不是这次改版坏的。
 * `short_prompt` 一并查出来，供外观段兜底用（角色卡没写外观段时）。
 */
function characterRow(characterId) {
  return getDb().prepare(
    'SELECT id, display_name, avatar_path, base_prompt, short_prompt FROM characters WHERE id = ?'
  ).get(characterId) || null;
}

/**
 * 反应的两段式上屏（§2.7/§8.2 口径）：文字先广播 → 出图不 await → 图好补一条 update。
 * 反应是增强项：没有文字就不上屏；出图/写库失败只 warn。
 *
 * 2026-10-02：顺手把**当下的模式/曲线/叠加**带进反应 prompt —— 装备之后档位会自己随时间变
 * （模式+曲线），所以"调强度"的反应也要按当时的节奏阶段演（调用方签名不变）。
 * 2026-10-03：`scene` 由调用方传（`resolveSceneTarget` 的结论）—— **在哪聊就在哪上屏**：
 * 群聊 ⇒ 写 `group_<gid>` + `group_message`（+ 补图 `group_message_update`）；私聊一字未改。
 * @returns {Promise<object>} 返回解析出的 reaction（调用方拿 reactionText/imagePrompt/emotionDelta）
 */
async function reactAndPublish(characterId, { event, toyKey, intensity, minutesWorn, extraContext = '', scene = null, batchToys = null }) {
  const now = Date.now();
  const worn = listWornToys(characterId, { now });
  // 批量（≥2 件，2026-10-04）走**另一套事实口径**：模式/曲线/叠加都是"单件"的概念，
  // 在整批语境里只会糊成一个假象（挑其中一件的曲线讲，等于替整批编了个不存在的一致节奏），
  // 所以批量时这三项一律不带，把全部信息交给 `batchToys`（事实句直接列全清单）。
  const isBatch = Array.isArray(batchToys) && batchToys.length >= 2;
  const current = isBatch ? null : (worn.find(t => t.toyKey === toyKey) || null);
  const reaction = await runToyReaction(characterId, {
    event, toyKey, intensity, minutesWorn, extraContext,
    batchToys: isBatch ? batchToys : null,
    mode: current ? current.mode : undefined,
    modePhaseText: current ? current.modePhaseText : '',
    curve: current ? current.curve : null,
    combo: isBatch ? null : comboEffects(worn, {}),
  });
  if (reaction?.ok && reaction.reactionText) {
    const character = characterRow(characterId);
    if (character) {
      const isGroup = scene?.scene === 'group' && Number(scene.groupId) > 0;
      publishToyReaction({
        character,
        reactionText: reaction.reactionText,
        imagePrompt: reaction.imagePrompt,
        source: 'toy',
        scene: isGroup ? 'group' : 'chat',
        groupId: isGroup ? Number(scene.groupId) : null,
        deps: isGroup
          ? { groupExtra: { toy: { event, toyKey } } }   // 群 payload 的附加字段（前端忽略未知字段）
          : { writeMessage: writeProactiveMessage },
      });
    }
  }
  return reaction;
}

/** 一次轻量反应调用（同 touch 反应管线：同一 prompt 结构 + 同一解析器）。 */
async function runToyReaction(characterId, { event, toyKey, intensity, minutesWorn, extraContext = '', mode, modePhaseText = '', curve = null, combo = null, batchToys = null }) {
  // 她此刻正被插着吗（2026-10-02）：并进 extraContext 一起喂给玩具反应 prompt；
  // 取不到就当没有这场戏（失败绝不影响玩具链路）。
  try {
    const sceneNow = buildIntimateScenePromptBlock(characterId, { chatUserName: userName() });
    if (sceneNow) extraContext = [extraContext, sceneNow].filter(Boolean).join('\n\n');
  } catch { /* 场景块取不到就按原样喂 */ }
  const prompt = buildToyReactionPrompt({
    event, toyKey, intensity, minutesWorn, userName: userName(), extraContext, mode, modePhaseText, curve, combo, batchToys,
  });
  try {
    const raw = await chatSync(prompt.messages, {
      temperature: prompt.temperature, max_tokens: prompt.max_tokens, label: '玩具·' + event,
    });
    const parsed = parseReactionOutput(raw || '');
    if (parsed.ok && parsed.emotionDelta) applyToyEmotion(characterId, parsed.emotionDelta);
    return parsed;
  } catch (err) {
    console.warn('[toys] reaction failed:', err.message);
    return { ok: false, error: err.message, reactionText: '', imagePrompt: '', emotionDelta: null, facialExpression: '', annoyed: false };
  }
}

/**
 * emotion_delta → 心情（§2.6-2）；失败只 warn（增强项）。
 *
 * 2026-10-01 修（用户真机日志里 31 次 `[toys] emotion write failed: FOREIGN KEY constraint failed`）：
 * 原来第二个参数传的是字面量 `0`（after_msg_id=0）。那一列外键指向 `raw_messages(id)`，
 * id=0 不存在 ⇒ **每一次玩具的情绪影响都被外键挡回去**，玩具对心情/后续对话毫无影响
 * （用户感受就是"玩具的效果不能和对话发生交互"）。
 * 对照既有的两处正确写法：`touch.js` 传真实 anchor 消息 id；`itemService.js` 传 `null`（没有对应消息时）。
 * 玩具穿戴事件本身不一定有对应消息，所以这里用 `null`，并把 dominantEmotion / 好感一并带上，
 * 让这次心情变化在情绪快照里是完整的（原来只传两个参数，后三项全是默认值）。
 */
function applyToyEmotion(characterId, delta) {
  try {
    const conversationId = 'char_' + characterId;
    const state = loadEmotionState(conversationId);
    const next = evolveEmotion(state, delta);
    const dominantEmotion = next?.dominant || next?.instant?.dominantEmotion || null;
    saveEmotionSnapshot(
      conversationId,
      null,                       // after_msg_id：没有对应消息就明确给 null，绝不给 0
      next,
      dominantEmotion,
      loadAffinity(characterId),
      null,
      '玩具穿戴'
    );
  } catch (err) {
    console.warn('[toys] emotion write failed:', err.message);
  }
}

/** 穿戴事件写记忆（§2.6-3）；dedupeKey 幂等；失败只 warn。 */
function writeToyMemory(characterId, { toyKey, event, intensity, at, secret = false }) {
  if (config.features.memory === false) return null;
  try {
    const entry = buildToyMemoryEntry({ characterId, toyKey, event, intensity, at, userName: userName(), secret });
    applyMemoryActions({
      conversationId: 'char_' + characterId,
      dedupeKey: entry.dedupe_key,
      sourceRawStartId: null, sourceRawEndId: null, sourceMessageId: null,
      actions: [{
        action: 'create',
        memory: {
          memoryType: 'event',
          subject: 'relationship',
          judgment: entry.content,
          reasoning: event === 'self_play'
            ? '她自己主动用玩具（专题-玩具系统 §二 玩法扩充，2026-10-02）'
            : '玩具穿戴事件（专题-玩具系统 §2.6-3）',
          tags: event === 'self_play' ? ['玩具', toyKey, '自己玩'] : ['玩具', toyKey],
        },
      }],
    });
    return entry;
  } catch (err) {
    console.warn('[toys] memory write failed:', err.message);
    return null;
  }
}

/**
 * 批量装卸写记忆（2026-10-04 补）：**一次批量 = 一条记忆**（不是逐件 N 条）。
 *
 * 原来批量那条链**一件记忆都不写** —— 单件有、批量没有，于是"他一次给我戴了三件"
 * 在后来的对话里查无此事。这里补上；1 件时回落单件口径（同一件事不要两种措辞）。
 * 失败只 warn（与单件链同口径：记忆是增强项）。
 */
function writeToyBatchMemory(characterId, { toyKeys, event, intensityOf }) {
  if (config.features.memory === false) return null;
  const keys = (Array.isArray(toyKeys) ? toyKeys : []).map(k => String(k || '')).filter(Boolean);
  if (keys.length === 0) return null;
  if (keys.length === 1) {
    const one = typeof intensityOf === 'function' ? intensityOf(keys[0]) : 0;
    return writeToyMemory(characterId, { toyKey: keys[0], event, intensity: one });
  }
  try {
    const entry = buildToyBatchMemoryEntry({ characterId, toyKeys: keys, event, userName: userName() });
    if (!entry) return null;
    applyMemoryActions({
      conversationId: 'char_' + characterId,
      dedupeKey: entry.dedupe_key,
      sourceRawStartId: null, sourceRawEndId: null, sourceMessageId: null,
      actions: [{
        action: 'create',
        memory: {
          memoryType: 'event',
          subject: 'relationship',
          judgment: entry.content,
          reasoning: '玩具批量装卸事件（一次一批，2026-10-04）',
          tags: ['玩具', '批量', event, ...entry.toyKeys],
        },
      }],
    });
    return entry;
  } catch (err) {
    console.warn('[toys] batch memory write failed:', err.message);
    return null;
  }
}

// ── 她自己主动玩：判定输入采集（催眠/睡着在这里采，toyService 刻意不 import 这两个模块）──

/** 场景：query/body 里 scene=group 才算群聊（与 gateContext 同一读法） */
function sceneOf(req) {
  const raw = String((req.query && req.query.scene) || (req.body && req.body.scene) || 'chat');
  return raw === 'group' ? 'group' : 'chat';
}

/** `{ hypnosisActive, bodyControlled, sleeping }`：采集失败一律按"没有这个状态"处理 */
function selfPlaySignals(characterId) {
  let hypnosisActive = false;
  let bodyControlled = false;
  try {
    const st = getHypnosisState(characterId);
    hypnosisActive = st?.active === true;
    bodyControlled = st?.bodyControlled === true;
  } catch (err) { /* 采集失败按没在催眠处理 */ }
  let sleeping = false;
  try { sleeping = Boolean(isSleeping(characterId)?.sleeping) } catch (err) { /* 同上 */ }
  return { hypnosisActive, bodyControlled, sleeping };
}

/** `{ affinity, isOath, arousal }`：与 gateContext 同一批读，别另造口径 */
function selfPlayEmotion(characterId) {
  let affinity = 0;
  let isOath = false;
  let arousal = 0;
  try { affinity = Number(loadAffinity(characterId)) || 0 } catch (err) { /* 读不到按 0 */ }
  try { isOath = loadOath(characterId) === true } catch (err) { /* 同上 */ }
  try { arousal = Number(loadEmotionState('char_' + characterId)?.instant?.arousal) || 0 } catch (err) { /* 同上 */ }
  return { affinity, isOath, arousal };
}

/** 判定用的确定性骰子：同一角色、同一个 10 分钟窗口 ⇒ 同一个结果（可复算、可测、不会抖） */
function selfPlayRoll(characterId, now) {
  return () => hash01(seedOf(characterId, 'self_play'), Math.floor(now / SELF_PLAY_WINDOW_MS) + 1);
}

function selfPlayPreview(characterId, { now, scene }) {
  const signals = selfPlaySignals(characterId);
  const emotion = selfPlayEmotion(characterId);
  const ctx = selfPlayContext(characterId, { now, scene, signals, emotion });
  const decision = decideSelfPlay({ ...ctx, random: selfPlayRoll(characterId, now), seed: seedOf(characterId, 'self_play') });
  const last = lastSelfPlay(characterId, { now });
  return {
    decision,
    lewdness: { score: ctx.lewdness, ...lewdnessFor(characterId) },
    context: {
      affinity: ctx.affinity, isOath: ctx.isOath, arousal: ctx.arousal,
      alone: ctx.alone, userPresent: ctx.userPresent, idleMinutes: ctx.idleMinutes === Infinity ? null : ctx.idleMinutes,
      hypnosisActive: ctx.hypnosisActive, sleeping: ctx.sleeping,
      wornCount: ctx.wornKeys.length, minutesSinceLast: ctx.minutesSinceLast === Infinity ? null : ctx.minutesSinceLast,
      playsToday: ctx.playsToday,
    },
    last: last ? {
      toyKey: last.toy_key, label: getToy(last.toy_key)?.label || last.toy_key,
      intensity: Number(last.intensity) || 0, mode: last.mode, action: last.action,
      secret: last.secret, bold: last.bold, minutesAgo: last.minutesAgo,
    } : null,
  };
}

/**
 * 她自己动手的反应：**走独立 prompt + 独立解析**（`buildSelfPlayPrompt` / `parseSelfPlayOutput`），
 * 与"用户命令她戴"那条（`buildToyReactionPrompt`）分开；上屏仍是同一套两段式（文字先到、图后补）。
 * 2026-10-03：同样按场景上屏（群里发现她自己玩，那句反应就该发在群里）。
 */
async function reactSelfPlayAndPublish(characterId, result, scene = null) {
  const toy = getToy(result.toyKey) || {};
  const prompt = buildSelfPlayPrompt({
    toyLabel: toy.label, part: toy.partSection || toy.part, effect: toy.effect || '',
    intensity: result.intensity, maxIntensity: toy.maxIntensity || 0,
    mode: result.mode, modeRhythm: modeMeta(result.mode).rhythm, modePhaseText: '',
    curve: result.curve, curveText: curveLabel(result.curve),
    action: result.action, secret: result.secret, bold: result.bold, alone: result.alone,
    hypnosisActive: result.hypnosisActive === true, lewdness: result.lewdness,
    userName: userName(), extraContext: result.reason || '',
  });
  let parsed = {
    ok: false, error: '', reactionText: '', imagePrompt: '', emotionDelta: null,
    facialExpression: '', annoyed: false, innerThought: '', hidden: false,
  };
  try {
    const raw = await chatSync(prompt.messages, {
      temperature: prompt.temperature, max_tokens: prompt.max_tokens, label: '玩具·她自己玩',
    });
    parsed = parseSelfPlayOutput(raw || '', parseReactionOutput);
    if (parsed.ok && parsed.emotionDelta) applyToyEmotion(characterId, parsed.emotionDelta);
  } catch (err) {
    console.warn('[toys] self-play reaction failed:', err.message);
    parsed = { ...parsed, error: err.message };
  }
  if (parsed.ok && parsed.reactionText) {
    const character = characterRow(characterId);
    if (character) {
      const isGroup = scene?.scene === 'group' && Number(scene.groupId) > 0;
      publishToyReaction({
        character,
        reactionText: parsed.reactionText,
        imagePrompt: parsed.imagePrompt,
        source: 'toy_self_play',
        scene: isGroup ? 'group' : 'chat',
        groupId: isGroup ? Number(scene.groupId) : null,
        deps: isGroup
          ? { groupExtra: { toy: { event: 'self_play', toyKey: result.toyKey } } }
          : { writeMessage: writeProactiveMessage },
      });
    }
  }
  return parsed;
}

// ── GET /:id/toys ─────────────────────────────────────────────────────────
router.get('/:id/toys', (req, res) => {
  const characterId = characterIdOf(req);
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return res.status(400).json({ error: 'invalid character id' });
  const unlocked = toysUnlocked();
  // 开关关着时**逐字节保持旧响应**（`{unlocked:false,worn:[],available:[]}`，既有测试 deepEqual 它）
  if (!unlocked) return res.json({ unlocked: false, worn: [], available: [] });
  const ctx = gateContext(req, characterId);
  const now = Date.now();
  // tick：曲线随时间自动升降 —— 读接口顺手把它结算一次（不然"曲线"只在装备那一刻算过一次）
  const tick = tickToys(characterId, { now });
  res.json({
    unlocked: true,
    worn: wornPayload(characterId, ctx, now),
    available: availablePayload(characterId, ctx),
    catalog: catalogPayload(characterId, ctx),
    combos: wornCombo(characterId, { now }),
    transitions: tick.transitions,
    options: { modes: modeOptions(), curves: curveOptions() },
    selfPlay: selfPlayPreview(characterId, { now, scene: sceneOf(req) }),
  });
});

// ── POST /:id/toys/tick ───────────────────────────────────────────────────
router.post('/:id/toys/tick', (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const now = Date.now();
  const tick = tickToys(characterId, { now });
  const ctx = gateContext(req, characterId);
  res.json({
    ok: true, unlocked: true, now,
    worn: wornPayload(characterId, ctx, now),
    combos: wornCombo(characterId, { now }),
    transitions: tick.transitions,
    selfPlay: selfPlayPreview(characterId, { now, scene: sceneOf(req) }),
  });
});

// ── POST /:id/toys/:toyKey/mode ───────────────────────────────────────────
router.post('/:id/toys/:toyKey/mode', (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const toyKey = String(req.params.toyKey || '');
  if (!getToy(toyKey)) return res.status(404).json({ error: 'unknown_toy' });
  const result = setToyMode(characterId, toyKey, req.body?.mode);
  if (!result.ok) {
    const status = result.code === 'toy_not_worn' ? 404 : 400;
    return res.status(status).json({ error: result.code });
  }
  res.json({ ok: true, unlocked: true, toy: result.toy });
});

// ── POST /:id/toys/:toyKey/curve ──────────────────────────────────────────
router.post('/:id/toys/:toyKey/curve', (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const toyKey = String(req.params.toyKey || '');
  if (!getToy(toyKey)) return res.status(404).json({ error: 'unknown_toy' });
  // body 允许两种写法：`{ curve: {...} }`（首选）或直接把曲线对象放在 body 上（面板手滑也能用）
  const curve = req.body && Object.prototype.hasOwnProperty.call(req.body, 'curve') ? req.body.curve : req.body;
  const result = setToyCurve(characterId, toyKey, curve);
  if (!result.ok) {
    const status = result.code === 'toy_not_worn' ? 404 : 400;
    return res.status(status).json({ error: result.code });
  }
  res.json({ ok: true, unlocked: true, toy: result.toy });
});

// ── GET /:id/toys/self-play ───────────────────────────────────────────────
router.get('/:id/toys/self-play', (req, res) => {
  const characterId = characterIdOf(req);
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return res.status(400).json({ error: 'invalid character id' });
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  res.json({ ok: true, unlocked: true, ...selfPlayPreview(characterId, { now: Date.now(), scene: sceneOf(req) }) });
});

// ── POST /:id/toys/self-play ──────────────────────────────────────────────
router.post('/:id/toys/self-play', async (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const now = Date.now();
  // 2026-10-03 群聊维度：场景先解析（群聊要校验「群存在 + 她是成员」）—— 不通过就 400 人话，
  // 绝不把她这段反应写进一个没人看的会话；随后过群聊成人闸门（开关关着 = 当众不许演）。
  const scene = resolveSceneTarget(req, characterId);
  if (!scene.ok) return res.status(400).json({ error: scene.message, code: scene.code });
  const ctx = gateContext(req, characterId, scene.scene);
  const blockedHere = groupAdultGate(characterId, null, ctx);
  if (blockedHere) return refuseGroupAdult(res, blockedHere);
  // `encourage` = 用户逗她一下：**只加分**（+0.12），硬门槛（好感/淫乱度/冷却/当日上限）一条都不越过；
  // 她照样可以收住（`held_back`）⇒ 面板如实把她的理由显示出来。
  const encouraged = req.body?.encourage === true;
  const result = maybeSelfPlay(characterId, {
    now, scene: scene.scene,
    signals: selfPlaySignals(characterId),
    emotion: selfPlayEmotion(characterId),
    encouraged,
  });
  if (!result.play) {
    return res.json({
      ok: true, unlocked: true, play: false,
      code: result.code, reason: result.reason, score: result.score ?? 0,
      encouraged,
    });
  }
  const reaction = await reactSelfPlayAndPublish(characterId, result, scene);
  const memory = writeToyMemory(characterId, {
    toyKey: result.toyKey, event: 'self_play', intensity: result.intensity, at: result.at, secret: result.secret,
  });
  res.json({
    ok: true, unlocked: true, play: true,
    code: result.code, reason: result.reason, score: result.score, encouraged,
    action: result.action, toyKey: result.toyKey, label: result.label, intensity: result.intensity,
    mode: result.mode, curve: result.curve, secret: result.secret, bold: result.bold, alone: result.alone,
    toy: (wornPayload(characterId, ctx, now).find(t => t.toyKey === result.toyKey)) || null,
    reaction, memory,
  });
});

// ── POST /:id/toys/:toyKey/equip ──────────────────────────────────────────
router.post('/:id/toys/:toyKey/equip', async (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const toyKey = String(req.params.toyKey || '');
  if (!getToy(toyKey)) return res.status(404).json({ error: 'unknown_toy' });
  // 场景先解析（群聊校验群存在 + 她是成员；不传 = 私聊，老前端不受影响）
  const scene = resolveSceneTarget(req, characterId);
  if (!scene.ok) return res.status(400).json({ error: scene.message, code: scene.code });
  // 门控用**解析后的场景**：群聊里成人档 + `touchGroupAdult` 关着 ⇒ 与触摸链同一句 group_adult_blocked
  const ctx = gateContext(req, characterId, scene.scene);
  const gate = withGate(characterId, toyKey, ctx);
  if (!gate.allowed) return res.status(403).json({ error: 'toy_gate_blocked', code: gate.code, message: gate.message });
  const intensity = req.body?.intensity;
  const equipped = equipToy(characterId, toyKey, intensity === undefined ? {} : { intensity });
  const reaction = await reactAndPublish(characterId, { event: 'equip', toyKey, intensity: equipped.intensity, minutesWorn: 0, scene });
  const memory = writeToyMemory(characterId, { toyKey, event: 'equip', intensity: equipped.intensity, at: equipped.equippedAt });
  res.json({ ok: true, unlocked: true, toy: equipped, reaction, memory, gate: gatePayload(gate) });
});

// ── POST /:id/toys/:toyKey/set-intensity ──────────────────────────────────
router.post('/:id/toys/:toyKey/set-intensity', async (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const toyKey = String(req.params.toyKey || '');
  if (!getToy(toyKey)) return res.status(404).json({ error: 'unknown_toy' });
  const scene = resolveSceneTarget(req, characterId);
  if (!scene.ok) return res.status(400).json({ error: scene.message, code: scene.code });
  // 调强度**不走 gateToy**（已戴上就是默许），但群聊成人开关关着时同样要拦 ——
  // 她这一下的反应是要发在群里的（见 routes/toys.js 文件头的 groupAdultGate 说明）。
  const ctx = gateContext(req, characterId, scene.scene);
  const blocked = groupAdultGate(characterId, toyKey, ctx);
  if (blocked) return refuseGroupAdult(res, blocked);
  const before = listWornToys(characterId).find(t => t.toyKey === toyKey);
  // 睡着时调**高**强度会把她弄醒（§2.4 表末行；gateToy 的 wakesOnIntensity 在这里被消费）。
  // 复用触摸链的现成机制 scheduleManager.tempWake（不新造唤醒管线）。
  const sleeping = Boolean(isSleeping(characterId)?.sleeping);
  const updated = setToyIntensity(characterId, toyKey, req.body?.intensity);
  if (!updated) return res.status(404).json({ error: 'toy_not_worn' });
  // 睡着时调**高**强度 ⇒ 复用触摸链的 tempWake 把她弄醒，并把「刚被惊醒」写进反应 prompt。
  const wake = applyToyWake({ characterId, sleeping, intensity: updated.intensity, tempWake });
  const reaction = await reactAndPublish(characterId, {
    event: 'set_intensity', toyKey, intensity: updated.intensity,
    minutesWorn: before ? before.minutesWorn : 0,
    extraContext: wake.extraContext,
    scene,
  });
  res.json({ ok: true, unlocked: true, toy: updated, reaction, wake });
});

// ── POST /:id/toys/:toyKey/remove ─────────────────────────────────────────
router.post('/:id/toys/:toyKey/remove', async (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  const toyKey = String(req.params.toyKey || '');
  if (!getToy(toyKey)) return res.status(404).json({ error: 'unknown_toy' });
  const scene = resolveSceneTarget(req, characterId);
  if (!scene.ok) return res.status(400).json({ error: scene.message, code: scene.code });
  // 摘下同样不走 gateToy（已戴上就是默许），但她的反应会发到群里 ⇒ 群聊成人开关关着时一并拦
  const ctx = gateContext(req, characterId, scene.scene);
  const blocked = groupAdultGate(characterId, toyKey, ctx);
  if (blocked) return refuseGroupAdult(res, blocked);
  const before = listWornToys(characterId).find(t => t.toyKey === toyKey);
  const removed = removeToy(characterId, toyKey);
  if (!removed) return res.status(404).json({ error: 'toy_not_worn' });
  const reaction = await reactAndPublish(characterId, {
    event: 'remove', toyKey, intensity: before ? before.intensity : removed.intensity, minutesWorn: before ? before.minutesWorn : 0, scene,
  });
  const memory = writeToyMemory(characterId, { toyKey, event: 'remove', intensity: before ? before.intensity : removed.intensity, at: removed.updatedAt });
  res.json({ ok: true, unlocked: true, toy: removed, reaction, memory });
});

// ── POST /:id/toys/batch —— 批量装卸 ─────────────────────────────────────────
/**
 * 2026-10-04 用户：「玩具不能批量装卸 还得一个个点 比较麻烦 这个也加上」。
 *
 * **设计裁决（已按用户实测反馈定稿）：一次批量 = 一次感受 = 一条反应。**
 *   · 不是"逐件各反应一次"（N 次调用会刷爆面板、白烧额度）；
 *   · 也不是"静默不反应"（第一版这么定的，用户实测直接说"角色没有反馈，右上角的思考也没变化"——
 *     逐件调确实要避免，但**完全不调**不是省额度，是机制缺失）；
 *   · 所以整批汇聚成**一条**：事实句直接列全清单 + 点明"同一瞬间一起到位/一起消失"，
 *     让她把这一批当成**一次**感受说出来（措辞与写作要求见 toyService.normalizeBatchToys /
 *     buildBatchFactLine / buildToyReactionPrompt 的 batchToys 分支）。
 *   · 记忆同口径：**一条汇总记忆**（`writeToyBatchMemory`），不是逐件 N 条。
 *   · 1 件时全体回落单件口径（反应、记忆都是）——一件不算"一批"。
 *
 * 请求体：
 *   `{ action: 'equip' | 'remove',   // 缺省 equip`
 *     toyKeys?: string[],            // 不给 ⇒ 装上＝全部可用；摘下＝当前已戴的全部
 *     intensity?: number }           // 仅 equip 用；缺省按各玩具的默认（equipToy 自己 clamp）
 *
 * 响应：`{ ok, unlocked, action, applied: string[], skipped: [{toyKey,reason}], worn: [...], reaction, memory }`
 *   · `skipped` 会给出原因码（`unknown_toy` / `not_wearable` / `not_worn` / `already_worn`），
 *     调用方据此提示，**不静默吞掉**。
 *   · `reaction` / `memory` 是**增强项**：失败只 warn，穿戴状态本身照改（与单件那两条同口径）。
 */
router.post('/:id/toys/batch', async (req, res) => {
  const characterId = characterIdOf(req);
  if (!toysUnlocked()) return res.status(403).json({ error: 'toys_disabled' });
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return res.status(400).json({ error: 'invalid character id' });
  const scene = resolveSceneTarget(req, characterId);
  if (!scene.ok) return res.status(400).json({ error: scene.message, code: scene.code });

  const action = req.body?.action === 'remove' ? 'remove' : 'equip';
  const now = Date.now();
  const ctx = gateContext(req, characterId, scene.scene);

  // 目标集合：显式给 toyKeys 就按它（保留未知 key 到 skipped 里，别静默丢）；否则按状态推导。
  const explicit = Array.isArray(req.body?.toyKeys) ? req.body.toyKeys.map(String) : null;
  let targets;
  if (explicit) {
    targets = explicit;
  } else if (action === 'equip') {
    // 全部**可装**的：availablePayload 已按服务端 gate 过滤过（现在玩具全放行，这里就是全目录）
    targets = availablePayload(characterId, ctx).map(t => t.toyKey);
  } else {
    targets = listWornToys(characterId).filter(t => t.status === 'worn').map(t => t.toyKey);
  }

  const wornBefore = listWornToys(characterId).filter(t => t.status === 'worn');
  const beforeByKey = new Map(wornBefore.map(t => [t.toyKey, t]));
  const wornNow = new Set(wornBefore.map(t => t.toyKey));
  const applied = [];
  const skipped = [];
  // 每件此刻的档位 —— 批量事实句要**逐件**写清（整批糊成一个档位就是给模型编假数据）
  const intensityOf = new Map();
  for (const key of targets) {
    if (!getToy(key)) { skipped.push({ toyKey: key, reason: 'unknown_toy' }); continue }
    if (action === 'equip') {
      if (wornNow.has(key)) { skipped.push({ toyKey: key, reason: 'already_worn' }); continue }
      const intensity = req.body?.intensity;
      const equipped = equipToy(characterId, key, intensity === undefined ? {} : { intensity });
      if (!equipped) { skipped.push({ toyKey: key, reason: 'not_wearable' }); continue }
      applied.push(key);
      intensityOf.set(key, Number(equipped.intensity) || 0);
      wornNow.add(key);
    } else {
      if (!wornNow.has(key)) { skipped.push({ toyKey: key, reason: 'not_worn' }); continue }
      const before = beforeByKey.get(key);
      const removed = removeToy(characterId, key);
      if (!removed) { skipped.push({ toyKey: key, reason: 'not_worn' }); continue }
      applied.push(key);
      intensityOf.set(key, Number(before ? before.intensity : removed.intensity) || 0);
      wornNow.delete(key);
    }
  }

  // 汇总广播一次（不是逐件）—— 前端 store 靠它刷新穿戴清单。
  try {
    broadcast('toys_batch_changed', { characterId, action, applied, skipped, scene: scene.scene, groupId: scene.groupId || null });
  } catch (err) {
    console.warn('[toys] batch broadcast failed:', err?.message || err);
  }

  // ── 她要有反应：**一次批量 = 一次感受 = 一条反应**（不是 N 条，也不是 0 条）──────
  //
  // 2026-10-04 用户反馈（两轮，各自独立）：
  //   ①「角色没有反馈 …… 右上角的思考也没变化」—— 第一版把批量定成"静默操作"，那是机制缺失；
  //   ②「一次性拿掉的话不要一个一个的去反馈 直接让角色一次性感受到然后再去反馈」——
  //      第二版虽然只调了一次模型，但**事实句只提了 `applied[0]` 一件**（真机日志实证：摘了 2 件，
  //      事实句只写「项圈」），整批清单被塞进 `extraContext` 兜底 ⇒ 模型眼里那还是"一次一件"。
  //
  // 定稿：≥2 件时把**整批**当一等公民传下去（`batchToys`），事实句直接列全清单 + 点明"同一瞬间"，
  // 写作要求同步禁止"一件接一件"的时间顺序（见 toyService.buildToyReactionPrompt 的 batchToys 分支）。
  // 1 件回落单件口径。无论几件都只调**一次**模型 ⇒ 额度与刷屏仍在控制内。
  const isBatch = applied.length >= 2;
  let reaction = null;
  let memory = null;
  if (applied.length > 0) {
    try {
      reaction = await reactAndPublish(characterId, {
        event: action === 'remove' ? 'remove' : 'equip',
        toyKey: applied[0],
        intensity: intensityOf.get(applied[0]) || 0,
        minutesWorn: 0,
        batchToys: isBatch ? applied.map(k => ({ toyKey: k, intensity: intensityOf.get(k) || 0 })) : null,
        scene,
      });
    } catch (err) {
      // 反应是**增强项**：失败不影响穿戴状态（与单件那条链同口径），下一页轮次会自然带出来
      console.warn('[toys] batch reaction failed (状态已改，不影响穿戴):', err?.message || err);
    }
    // 记忆同口径：一次批量一条（原来**一件都不写** —— 那是漏的，单件有、批量没有）
    memory = writeToyBatchMemory(characterId, {
      toyKeys: applied,
      event: action === 'remove' ? 'remove' : 'equip',
      intensityOf: k => intensityOf.get(k) || 0,
    });
  }

  res.json({
    ok: true, unlocked: true, action, applied, skipped,
    worn: wornPayload(characterId, ctx, now),
    reaction, memory,
  });
});

export default router;
