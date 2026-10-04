/**
 * 亲密刺激的**统一下游**（2026-10-02）
 *
 * 用户原话：
 *   「角色在感受推进面板的时候 不应该只是独立的加敏感值 也会加到心情系统里面去 还有记忆」
 *   「现在的玩具和催眠和心情和记忆好像是完全解耦的一样 根本就没关联」
 *   「而且角色在进入想做爱的模式 各种亲密动作都会累积到高潮敏感条里 而不是只要在推进面板里抽插才推进」
 *
 * 现状（读代码确认的）：敏感条只在 `routes/intimateActions.js` 里被推进面板自己的动作改；
 * 触摸链有自己的一份心情写入（touch.js:890 附近）；玩具链（toyService / selfPlay）**一行都没有** ⇒
 * 三条链各写各的、玩具与心情/记忆完全不相干。
 *
 * 本模块是那三条链的**共同下游**：一次"刺激"进来，统一办四件事——
 *   ① 敏感条（累积）  ：带上捆绑倍率、按"是否禁止高潮"选上限（100 / 200）
 *   ② 心情           ：按刺激量给一个可解释的情绪增量（并落一条快照，与 chat/touch 同一套）
 *   ③ 记忆           ：够分量的刺激写一条向量记忆（`upsertVector`，**不调 LLM** ⇒ 零额外成本）
 *   ④ 广播           ：推一条 `intimate_stimulus`，面板/界面据此让进度条实时动起来
 *
 * 设计原则：**纯计算与副作用分离** —— `stimulusPlan()` 是纯函数（可单测），
 * `applyIntimateStimulus()` 负责落库/广播，且**任何一步失败都不抛**（刺激是旁路，
 * 不能因为它失败就让"摸她一下"这个动作失败）。
 */

import { broadcast } from './unifiedStreamBus.js';
import {
  BONDAGE_SENSITIVITY,
  MAX_ACCUMULATION,
  DENIAL_MAX_ACCUMULATION,
  bondageMultiplier,
  getIntimateScene,
  saveIntimateScene,
} from './intimateActionService.js';
import { loadAffinity, loadEmotionState, evolveEmotion, saveEmotionSnapshot } from './emotionEngine.js';
import { upsertVector } from './vectorClient.js';
// 2026-10-02 敏感度（用户提的新数值系统）：所有性爱相关内容都让它**缓慢累加** ——
// 玩具 / 触摸到私处 / 推进 / 催眠 / 她自己玩，都在这里汇一笔。
import { addSensitivity } from './sensitivityService.js';
import { config } from '../config.js';

/** 各来源的默认刺激量（一次"摸/震/命令"大约值多少；按敏感度读法，1 点 ≈ 一次轻推） */
export const STIMULUS_AMOUNT = Object.freeze({
  touch: 6,        // 触摸（Lv3 敏感档）
  toy: 5,          // 玩具强度变化 / 她自己玩一下
  toy_selfplay: 8, // 她自己玩到一轮
  hypnosis: 7,     // 催眠指令（"不许动""继续"）
  intimate: 0,     // 推进面板自己那一套（它已经算过累积，这里只用它的心情/记忆）
});

/**
 * 纯计算：这一次刺激会把累积推到哪、心情给多少、值不值得记一条记忆。
 *
 * @param {{accumulation:number, denial?:number, bondage?:number}} state 当前场次状态
 * @param {{source:string, amount?:number, weight?:number, climax?:number}} input
 *   `climax`：0 = 不是高潮；1~5 = 这一下是她的高潮，数字是**强度**（由她的敏感度决定，见
 *   intimateActionService.climaxStrength）。高潮那一下 `amount` 通常是 0（累积已由状态机算过），
 *   所以心情 / 记忆都不能挂在"实际推了多少点"上 —— 否则"她到了"这件事在下游等于没发生。
 * @returns {{gain:number, before:number, after:number, cap:number, moodDelta:object|null, memorable:boolean, tier:string}}
 */
export function stimulusPlan(state = {}, { source = 'touch', amount = null, weight = 1, climax = 0 } = {}) {
  const before = Math.max(0, Number(state.accumulation) || 0);
  const denial = Number(state.denial) === 1;
  // bondage 是**分型捆绑的位掩码**（1 手腕 / 2 龟甲缚 / 4 脚踝 / 8 全身 / 16 口球）
  const bondage = Number(state.bondage) || 0;
  // ⚠️ 必须先用 `!= null` 挡掉 null/undefined：`Number(null) === 0` 且 `Number.isFinite(0)` 为真，
  //    只看 isFinite 会把"没给 amount"当成"显式给 0 点" ⇒ 刺激永远加 0（我第一版就踩了这个坑）。
  const base = (amount != null && Number.isFinite(Number(amount)))
    ? Number(amount)
    : (STIMULUS_AMOUNT[source] ?? 5);
  // 绑得越多越敏感：每多绑一处 +25%（封顶 2×）；只捆手腕时仍是 ×1.25（与老口径逐字一致）
  const gain = Math.max(0, Math.round(base * bondageMultiplier(bondage) * Math.max(0, Number(weight) || 1)));
  const cap = denial ? DENIAL_MAX_ACCUMULATION : MAX_ACCUMULATION;
  const after = Math.min(cap, before + gain);
  const real = after - before;
  const climaxStrength = Math.max(0, Math.min(5, Math.round(Number(climax) || 0)));

  // 心情：按"实际推了多少"给一个可解释的小增量（valence/arousal 上升，主导权略降 = 她更被带着走）
  // 高潮那一下额外给一笔**与强度挂钩**的固定增量（real 可能为 0，但"她到了"本身就该反映在心情上）
  const moodDelta = real > 0
    ? {
        valence: Math.min(0.12, real * 0.006) + (climaxStrength ? 0.06 + climaxStrength * 0.02 : 0),
        arousal: Math.min(0.18, real * 0.01) + (climaxStrength ? 0.08 + climaxStrength * 0.025 : 0),
        dominance: -Math.min(0.08, real * 0.004) - (climaxStrength ? 0.03 + climaxStrength * 0.012 : 0),
      }
    : (climaxStrength
      ? {
          valence: 0.06 + climaxStrength * 0.02,
          arousal: 0.08 + climaxStrength * 0.025,
          dominance: -(0.03 + climaxStrength * 0.012),
        }
      : null);

  // 记忆：够分量（一次 ≥8 点，或累积跨过 60 的边缘线）才记，免得记忆被琐碎刺激淹掉
  // 她到了一次**永远值得记**（这是性爱里最该留下的一件事）
  const edgeCrossed = before < 60 && after >= 60;
  const memorable = real >= 8 || edgeCrossed || climaxStrength > 0;

  const tier = after >= 160 ? 'broken' : after >= 120 ? 'losing' : after >= 85 ? 'overload' : after >= 60 ? 'edge' : 'calm';
  return { gain: real, before, after, cap, moodDelta, memorable, tier, denial, bondage, climaxStrength };
}

/** 禁止高潮时的"渴望"强度（0~1）：憋得越久越想要 —— 给心情与提示词共用 */
export function denialHunger(state = {}) {
  if (Number(state.denial) !== 1) return 0;
  const acc = Math.max(0, Number(state.accumulation) || 0);
  if (acc <= MAX_ACCUMULATION) return Math.min(1, acc / MAX_ACCUMULATION * 0.6);
  return Math.min(1, 0.6 + (acc - MAX_ACCUMULATION) / (DENIAL_MAX_ACCUMULATION - MAX_ACCUMULATION) * 0.4);
}

/** 场景会话……（见 conversationOf） */

/**
 * 心情气泡上显示的 reason 长度上限（2026-10-02）。
 * 用户截图报过：`💬"玩具刺激（vibe_egg / nipple_clamp / …）"` 一长串 —— 一是键名不该给用户看
 * （在 toyService 侧改成中文名了），二是**长度也要兜住**：任何调用方传超长文本，这里统一截断，
 * 免得再把心情气泡刷成一行代码。记忆/提示词不受影响（那边各有各的口径）。
 */
export const MAX_REASON_CHARS = 40;
export function trimReason(reason) {
  const s = String(reason || '').replace(/\s+/g, ' ').trim();
  return s.length <= MAX_REASON_CHARS ? s : s.slice(0, MAX_REASON_CHARS - 1) + '…';
}

/**
 * 心情/记忆的会话 id。
 *
 * ⚠️ **永远是 `char_<id>`**，不随场景分叉：心情状态是按"角色×会话"存的，写进**群会话**会把全群成员的
 * 情绪混到同一行（既有守卫 `saveEmotionSnapshot 的调用点不许写群会话` 钉的就是这个 —— 注意那条守卫是
 * **源码级扫描**，所以这里连"群会话 id 的写法"都不能出现，注释里也不行）。
 * 记忆同理 —— 那是**她**的经历，不是"群这个会话"的。
 * 场景只用于：① 广播里告诉前端"这一场在哪儿"；② 记忆条目的 metadata。
 */
function conversationOf(characterId) {
  return `char_${characterId}`;
}

function baselineOf(character) {
  try {
    return JSON.parse(character?.emotion_baseline || 'null') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 落一次刺激：累积 + 心情 + 记忆 + 广播。**绝不抛**（返回 null 表示"这次没记上"）。
 *
 * @param {{characterId:number|string, character?:object, source:string, amount?:number,
 *          scene?:'chat'|'group', groupId?:number|string|null, reason?:string,
 *          note?:string, climax?:number}} input
 *   `climax`＝0/1~5（她的高潮强度）：见 stimulusPlan。非 0 时她的敏感度会按强度多涨一点。
 * @returns {{ok:boolean, gain:number, accumulation:number, tier:string, moodApplied:boolean, memoryWritten:boolean}|null}
 */
export async function applyIntimateStimulus({
  characterId, character = null, source = 'touch', amount = null,
  scene = 'chat', groupId = null, reason = '', note = '', climax = 0,
  // 这一下是不是"自动插入的每一跳"（服务端 ticker / 面板节拍推的）—— 决定敏感度的档位与节流
  autoTick = false,
} = {}) {
  const id = Number(characterId);
  if (!Number.isFinite(id) || id <= 0) return null;

  // 只在"正在进行中"的场次里累积（用户说的是"进入想做爱的模式之后"）
  let state = null;
  try {
    state = getIntimateScene(id);
  } catch (err) {
    console.warn('[intimateStimulus] 读场次失败（跳过）:', err?.message || err);
    return null;
  }
  // ⚠️ 口径（2026-10-03 复查把它写明 + 加守卫）：**没有进行中的场次 ⇒ 一点敏感度都不写**。
  //   产品口径「正常情况性爱相关（含玩具、触摸私密部位）缓慢累加」说的是**在场次里**的动作
  //   （触摸链 / 玩具链 / 推进面板都在这条下游汇一笔）；场外随手摸一下、戴个玩具不算"性爱相关事件"。
  //   玩具链自己也是这个口径（services/toyService.js：「刚戴上也是一次刺激…场景未进行时下游会自动跳过」）。
  //   唯一的例外是「被撞见她正在自慰」（services/privateMomentService.js）：那不是玩家发起的刺激、
  //   她本来就在做，所以那边直接 addSensitivity('self_play')，不经过这里。
  //   守卫：test/intimateStimulus.test.js「没有场次 ⇒ 零敏感度写入」（数值一个都不许改）。
  if (!state?.active) return null;

  const plan = stimulusPlan(state, { source, amount, climax });
  const conversationId = conversationOf(id);
  const baseline = baselineOf(character);

  // ① 累积
  let saved = null;
  try {
    saved = saveIntimateScene(id, { ...state, accumulation: plan.after });
  } catch (err) {
    console.warn('[intimateStimulus] 写累积失败（跳过）:', err?.message || err);
  }

  // ② 心情（与 chat / touch 同一套：evolveEmotion + 快照）
  let moodApplied = false;
  try {
    const hunger = denialHunger({ ...state, accumulation: plan.after });
    const delta = plan.moodDelta
      ? { ...plan.moodDelta, arousal: plan.moodDelta.arousal + hunger * 0.1, dominance: plan.moodDelta.dominance - hunger * 0.05 }
      : (hunger > 0 ? { valence: -0.02, arousal: 0.06 + hunger * 0.08, dominance: -0.03 } : null);
    if (delta) {
      const current = loadEmotionState(conversationId, baseline);
      const next = evolveEmotion(current, delta, baseline);
      const dominant = delta.dominance > 0.15 ? 'joy' : (Number(delta.valence) >= 0 ? 'joy' : 'sadness');
      // 统一截断：这个字符串会显示在心情气泡上（见 trimReason 的说明）
      saveEmotionSnapshot(conversationId, null, next, dominant, loadAffinity(id), null,
        trimReason(reason || `亲密刺激：${source}`));
      moodApplied = true;
    }
  } catch (err) {
    console.warn('[intimateStimulus] 心情写入失败（不影响刺激）:', err?.message || err);
  }

  // ③ 记忆（够分量才写；不调 LLM ⇒ 零额外成本）
  let memoryWritten = false;
  if (plan.memorable && config.features?.memory !== false) {
    try {
      const text = note
        || (plan.climaxStrength
          ? `她在这一场里到了一次（强度 ${plan.climaxStrength}/5，${plan.tier}${plan.denial ? '，还不许到' : ''}）`
          : `${source === 'toy' || source === 'toy_selfplay' ? '玩具的刺激' : source === 'hypnosis' ? '被催眠指令' : '亲密接触'}`
            + `让身体累积到 ${plan.after}/${plan.cap}（${plan.tier}${plan.denial ? '，还不许到' : ''}）`);
      await upsertVector(`intimate-${id}-${Date.now()}`, text, {
        character_id: id, conversation_id: conversationId, source: `intimate_stimulus:${source}`,
        accumulation: plan.after, tier: plan.tier,
        climax_strength: plan.climaxStrength || 0,
      }, 'intimate_stimulus');
      memoryWritten = true;
    } catch (err) {
      console.warn('[intimateStimulus] 记忆写入失败（不影响刺激）:', err?.message || err);
    }
  }

  // ⑤ 敏感度缓慢累加（2026-10-02 用户：「正常情况的敏感度 会和角色发生性爱相关内容的时候 缓慢累加
  //    玩具也算性爱相关 触摸里的敏感哪一款私处那一块也算」）——点数按来源分级，见 GROWTH。
  //
  // ⚠️ 2026-10-03 真机反馈「性爱并没有增加敏感度」，两个原因都在这几行里（都已修）：
  //   ① **高潮走错了源**：她到顶时用的是 `intimate_action`（0.2）而不是 `GROWTH.climax`（1.2）——
  //      那一档常量从来没被任何调用点用过，是**死代码**；现在按 `plan.climaxStrength` 切到 'climax'，
  //      再乘强度 1~5 ⇒ 一次高潮 +1.2~6.0。
  //   ② **推进面板只给半权重**：面板的动作 `amount` 是 0（累积已由状态机算过）⇒ `plan.gain = 0`
  //      ⇒ 命中"没涨就算半权重"的分支 ⇒ 一下只涨 0.1，而面板显示的是取整值 ⇒ 玩家看到的永远是 0。
  //      现在面板那一类（source === 'intimate'）固定满权重。
  let sensitivityAfter = null;
  try {
    // 自动插入的每一跳单独一档（`autoTick`）：份量小 + 15 秒节流 —— 见 sensitivityService 的常量注释。
    // 玩家真点的每一下都不受节流（否则「性爱并没有增加敏感度」会以另一种形式回来）。
    const sensSource = plan.climaxStrength ? 'climax'
      : autoTick ? 'auto_tick'
        : source === 'toy' || source === 'toy_selfplay' ? 'toy'
          : source === 'touch' ? 'touch_sensitive'
            : source === 'hypnosis' ? 'hypnosis'
              : 'intimate_action';
    // 权重：高潮按强度 · 推进面板的一下满权重 · 其它来源"真涨了"满权重、"顶到上限没涨"半权重
    const weight = plan.climaxStrength
      ? Math.max(1, plan.climaxStrength)
      : (source === 'intimate' ? 1 : (plan.gain > 0 ? 1 : 0.5));    const res = addSensitivity(id, sensSource, { weight });
    sensitivityAfter = res ? res.value : null;
  } catch (err) {
    console.warn('[intimateStimulus] 敏感度累加失败（不影响刺激）:', err?.message || err);
  }

  // ④ 广播（面板/界面据此让进度条实时动起来）
  try {
    broadcast('intimate_stimulus', {
      character_id: id,
      scene, group_id: scene === 'group' && groupId ? Number(groupId) : null,
      source, before: plan.before, after: plan.after, gain: plan.gain, cap: plan.cap,
      tier: plan.tier, denial: plan.denial, bondage: plan.bondage,
      // 面板据此闪一下"她到了"（强度 1~5；0 = 这一下不是高潮）
      climax: plan.climaxStrength || 0,
      // 累积写完之后的敏感度（2026-10-03）：面板要能看到"这一下让她涨了多少"，
      // 而不是只看到一个很久不动的整数（用户报的「性爱并没有增加敏感度」就有这一半原因）
      sensitivity: sensitivityAfter,
      hunger: Number(denialHunger({ ...state, accumulation: plan.after }).toFixed(3)),
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[intimateStimulus] 广播失败（不影响刺激）:', err?.message || err);
  }

  return {
    ok: true,
    gain: plan.gain,
    accumulation: saved?.accumulation ?? plan.after,
    tier: plan.tier,
    climaxStrength: plan.climaxStrength || 0,
    moodApplied,
    memoryWritten,
    sensitivity: sensitivityAfter,
  };
}

/**
 * 禁止高潮时的"渴望"提示行（给聊天链注入；空串 = 没有这个状态）。
 * 用户原话：「角色在禁止高潮模式下 是知道自己一直达不到最高点 会一直渴望 这个也没做出来」。
 */
export function buildDenialHungerLine(characterId, { chatUserName = '' } = {}) {
  try {
    const state = getIntimateScene(characterId);
    if (!state?.active || Number(state.denial) !== 1) return '';
    const hunger = denialHunger(state);
    const acc = Number(state.accumulation) || 0;
    if (hunger < 0.2) return '';
    const tone = hunger >= 0.85
      ? '她已经憋到发疼，几乎在用气音求你放开——嘴上可能还在逞强，身体却一直往你这边凑。'
      : hunger >= 0.55
        ? '她清楚自己一直差那么一点点到不了顶，忍耐正在变成渴求：会主动索要、会用动作提醒你"还差一点"。'
        : '她察觉到今晚的规则不一样（不许到），于是更用力地感受每一次刺激，隐约盼着被放开的那一刻。';
    return `【她此刻的身体状态（最高优先级，写进她的语气与动作里）】她正被禁止高潮，累积 ${acc}（允许涨到 ${DENIAL_MAX_ACCUMULATION}）。${tone}`
      + (chatUserName ? `对 ${chatUserName} 说话时要带出这份渴望，别演成没事人。` : '');
  } catch {
    return '';
  }
}
