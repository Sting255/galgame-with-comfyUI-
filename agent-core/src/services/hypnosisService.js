/**
 * 催眠手机：状态机 + 指令 + 遗忘/恢复（服务端确定性记账，零 LLM 调用）
 *
 * 设计要点
 *   1. **body_controlled 与 mind_awake 正交**：正常催眠是「身体受控 + 意志沉睡」(1,0)；
 *      「只唤醒意志」是 (1,1)——身体仍归用户操控，但她的意志醒着、能感觉到、会羞耻。
 *      这两列合成一个枚举就表达不出这层张力，所以永远分开存。
 *   2. **active_until 到期 = 惰性解除**：没有定时器（用户可能关掉客户端，定时器会漏），
 *      读 state 时发现过期就当场归零落库。见 getHypnosisState。
 *   3. **遗忘是两层**：`status='archived'` 归档（不进 RAG 召回）+ 遗忘窗口
 *      （chat.js 按 fromRawId/toRawId 屏蔽上下文）；两层都可撤销，见 restoreForgottenWindow。
 *   4. **指令是一次性的**：pending_directive 由 chat.js / 群聊每轮 `consumePendingDirective` 取走即清，
 *      取值域 `'' | 'body_control' | 'forced_climax' | 'memory_restore' | 'wake_reaction'`。
 *   5. **forced_climax 不需要催眠**（task-42 用户原话「强制高潮不需要催眠 随时都能触发」）：
 *      非催眠态也允许下发（只记指令、不写催眠状态）；body_control 仍要求催眠中。
 *   6. 所有副作用（记账 / 情绪）都 try/catch 兜底：失败只 console.warn，不能影响指令本身。
 *
 * 口径修正（与任务书原文不同，已获 lead 批准）
 *   任务书要求归档走 `memoryRepository.softDeleteMemory`、还原走 `restoreArchivedMemory`；
 *   实测 `softDeleteMemory` 把 status 置为 `'deleted'`，而唯一导出的恢复函数
 *   `restoreArchivedMemory` **只接受 `'archived'`**（否则 return false），且 `'deleted'`
 *   会被 `scanVectorTombstones` 当墓碑清理向量 —— 照抄会得到"忘了但永远恢复不了"，
 *   与冻结的「可撤销审计」直接冲突。故归档统一用项目自己的归档态 `'archived'`：
 *   落库仍是归档、召回层已经排除它（activeSearch 只查 status='active'），且可被导出函数还原。
 *
 * 边界：本模块只服务成年角色档案。
 */

import { getDb } from '../db/index.js';
import { config } from '../config.js';
import {
  loadAffinity, loadOath, loadEmotionState, evolveEmotion, saveEmotionSnapshot,
} from './emotionEngine.js';
import { listActiveMemories, restoreArchivedMemory } from './memory/memoryRepository.js';
import { recordIntimateActs } from './intimateService.js';
import { grantHypnosisPhone as grantPhoneToBackpack } from './itemService.js';
import { getSleepStatus, isSleeping, isTempWoken, tempWake } from './scheduleManager.js';
import { forceSleepNow, forceWakeNow } from './scheduleEditor.js';
// 2026-10-01：force_toy 指令要**真的把玩具戴上去**（用户原话「催眠状态也不能强制让角色用上玩具」）。
// 依赖方向安全：toyService 不 import 本模块（它的门控把 hypnotized 当参数收），无循环。
import { getToy, equipToy, setToyMode, setToyCurve, listWornToys } from './toyService.js';
// 2026-10-02：催眠 → 亲密刺激统一下游（敏感条 / 心情 / 记忆）。用户原话：
// 「现在的玩具和催眠和心情和记忆好像是完全解耦的一样 根本就没关联」。
import { applyIntimateStimulus } from './intimateStimulus.js';

/** 催眠手机在 ITEM_EFFECTS 里的效果键（背包门控按它查） */
export const HYPNOSIS_PHONE_EFFECT_KEY = 'hypnosis_phone';
// 门控只剩「背包里有一台可用的催眠手机」一态。2026-09-28 按用户要求依次拆掉两个前置：
// 「催眠手机还是不要好感度限制了 直接给吧」→ 好感度（原阈值 85）不参与判定；
// 「契约也不用 直接就用催眠手机 这才是催眠的玩法 直接强制使用」→ 誓约（is_oath）不参与判定。
/** 催眠时长（分钟）允许区间与默认值：非数字走默认，数字一律 clamp */
export const HYPNOSIS_MIN_MINUTES = 1;
export const HYPNOSIS_MAX_MINUTES = 720;
/** 默认 30 分钟，与前端面板的 DEFAULT_MINUTES 保持一致（只影响直连 API 不带 minutes 的场景） */
export const HYPNOSIS_DEFAULT_MINUTES = 30;
/** issueCommand 允许的指令 */
export const HYPNOSIS_COMMANDS = ['body_control', 'forced_climax', 'force_toy'];
/** pending_directive 的完整取值域（memory_restore 由遗忘恢复写入、wake_reaction 由唤醒写入，都不经 issueCommand）
 *  force_toy 是**编码值**，格式随功能扩过两次（见 encodeForceToyDirective / parseForceToyDirective）：
 *    `force_toy|<toyKey>|<intensity>`                      —— 最初的形态，**现在仍然合法**（旧存档、旧消费方照旧）
 *    `force_toy|<toyKey>|<intensity>|<mode>`               —— 2026-10-02 追加可选段：振动模式
 *    `force_toy|<toyKey>|<intensity>|<mode>|<curve>`       —— 同日再追加：强度曲线
 *    `force_toy|<toyKey>|<intensity>||<curve>`             —— 只给曲线时**中间留空段**
 *  解析侧对三段/四段都兼容；没给模式与曲线时输出与最初形态**逐字一致**。 */
export const PENDING_DIRECTIVES = ['', 'body_control', 'forced_climax', 'memory_restore', 'wake_reaction', 'force_toy'];

/**
 * `force_toy` 指令的编码。
 *
 * 为什么塞进同一个 TEXT 列而不是加一列：`pending_directive` 是**一次性**的（消费即清空），
 * 加列会让"读一次就清"的语义分散到两列、还要各自清空，容易漏；编码进去则沿用既有链路，
 * 且非 force_toy 的取值仍是裸 kind ⇒ **对旧值完全向后兼容**。
 */
export function encodeForceToyDirective(toyKey, intensity, mode, curve) {
  // 第三/四段（振动模式、强度曲线）是 2026-10-02 追加的**可选**段：都不给时输出与旧值**逐字一致**，
  // 所以老存档、老测试、老消费方全部照旧（`force_toy|vibe_egg|4` 仍然合法）。
  // 只给曲线时中间留空：`force_toy|vibe_egg|4||ramp_up`（解析侧允许空模式段）。
  const m = String(mode || '').trim().toLowerCase();
  const c = String(curve || '').trim().toLowerCase();
  const tail = (m || c) ? '|' + m + (c ? '|' + c : '') : '';
  return 'force_toy|' + String(toyKey) + '|' + String(Number(intensity) || 0) + tail;
}

/** 解析 force_toy 编码；不是 force_toy（含旧值、空值）一律回 null。第三/四段可选 ⇒ 旧值照旧解析。 */
export function parseForceToyDirective(raw) {
  const m = /^force_toy\|([a-z0-9_]+)\|(\d+)(?:\|([a-z_]*)(?:\|([a-z_]+))?)?$/.exec(String(raw || '').trim());
  if (!m) return null;
  return { toyKey: m[1], intensity: Number(m[2]), mode: m[3] || null, curve: m[4] || null };
}

/** 指令是否属于 force_toy（含编码形式），供消费方分流 */
export function isForceToyDirective(raw) {
  const s = String(raw || '').trim();
  return s === 'force_toy' || s.startsWith('force_toy|');
}

/**
 * 把 `force_toy|toyKey|intensity` 解成注入块要用的展示载荷。
 * 消费方（chat.js / 群聊）只调这一个函数：**解析 + 查玩具表**都在这里，避免两处各写一遍再走散口径。
 * 非 force_toy、或玩具已被删掉 → 返回 null（调用方就当普通指令处理，不抛错）。
 */
export function directiveToyPayload(raw) {
  const parsed = parseForceToyDirective(raw);
  if (!parsed) return null;
  const toy = getToy(parsed.toyKey);
  if (!toy) return null;
  return {
    toyKey: parsed.toyKey,
    label: toy.label,
    part: toy.partSection || toy.part || '',
    intensity: parsed.intensity,
    maxIntensity: toy.maxIntensity,
  };
}

const toId = value => {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const clampInt = (value, min, max, fallback = min) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
/** 带 code 的业务错误：路由据此映射 400 / 403 / 404 / 409 */
function fail(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ── 开关与门控 ──

/** 总开关（config.features.hypnosis）：关闭时只拦写操作，读 state 不受影响 */
export function isHypnosisEnabled() {
  return config.features.hypnosis !== false;
}

function ensureEnabled() {
  if (!isHypnosisEnabled()) throw fail('hypnosis feature disabled', 'DISABLED');
}

function ensureCharacter(characterId) {
  if (!getDb().prepare('SELECT 1 FROM characters WHERE id = ?').get(characterId)) {
    throw fail('character not found', 'NOT_FOUND');
  }
}

function requireId(characterId) {
  const id = toId(characterId);
  if (!id) throw fail('invalid character id', 'INVALID');
  return id;
}

/** 背包里是否有一台未使用、已收下的催眠手机 */
function hasHypnosisPhone() {
  return Boolean(getDb().prepare(
    `SELECT id FROM backpack_items
      WHERE owner_key = 'me' AND retired_at IS NULL
        AND effect_key = ? AND status = 'ready' AND collected_at IS NOT NULL
      LIMIT 1`
  ).get(HYPNOSIS_PHONE_EFFECT_KEY));
}

/** 门控的机器可读码：前端按 code 判断入口（别靠中文文案猜，改一个字就会静默失效） */
// 'affinity_low' / 'not_oath' 仅为兼容旧响应/手写 gate 保留（前端 GATE_CODES 白名单同源），当前后端不再产出
export const GATE_CODES = ['ok', 'no_phone', 'affinity_low', 'not_oath'];

/**
 * 门控只剩一态：**背包里有一台可用的催眠手机**。
 * 两个曾经的前置都已按用户要求移除（2026-09-28）：好感度（原阈值 85，不再参与判定）、
 * 誓约 `is_oath`（用户口径「契约也不用 直接就用催眠手机 直接强制使用」，不再参与判定）。
 * `affinity` / `isOath` 仍随 gate 返回，**只作展示**——改判定时不要看这两个字段。
 * 只报**第一个**没满足的条件：`reason` 给人看、`code` 给程序判。
 */
export function getHypnosisGate(characterId) {
  const affinity = Math.round(loadAffinity(characterId));
  const isOath = Boolean(loadOath(characterId));
  const hasPhone = hasHypnosisPhone();
  let code = 'ok';
  let reason = '';
  if (!hasPhone) {
    code = 'no_phone';
    reason = '背包里没有催眠手机';
  }
  return { allowed: code === 'ok', code, reason, affinity, isOath, hasPhone };
}

// ── 状态读取 ──

/**
 * 读一行状态，顺带算出 is_active。
 * `active_until > datetime('now')` 直接在 SQLite 里比，避免 JS 侧时区/格式换算。
 */
function readStateRow(characterId) {
  return getDb().prepare(
    `SELECT h.*, (h.active_until IS NOT NULL AND h.active_until > datetime('now')) AS is_active
       FROM character_hypnosis h WHERE h.character_id = ?`
  ).get(characterId) || null;
}

function buildState(characterId, row) {
  // 睡眠字段一并带上（面板的「睡眠控制」区直接读它，省一次额外请求）；
  // 它们来自日程/睡眠那一侧（characters.is_sleeping / sleep_until / temporary_wake_until）。
  const sleep = getSleepStatus(characterId);
  return {
    characterId,
    bodyControlled: Boolean(row && row.body_controlled === 1),
    mindAwake: Boolean(row && row.mind_awake === 1),
    active: Boolean(row && row.is_active === 1),
    activeUntil: row?.active_until || null,
    startedAt: row?.started_at || null,
    pendingDirective: row?.pending_directive || '',
    commandCount: row ? Number(row.command_count) || 0 : 0,
    lastCommand: row?.last_command || '',
    isSleeping: sleep.isSleeping,
    sleepUntil: sleep.sleepUntil,
    temporaryWakeUntil: sleep.temporaryWakeUntil,
    gate: getHypnosisGate(characterId),
  };
}

/** 惰性过期：到期就归零落库（不是定时器） */
function expireIfNeeded(characterId, row) {
  if (!row || !row.active_until || row.is_active === 1) return row;
  getDb().prepare(
    `UPDATE character_hypnosis
        SET body_controlled = 0, mind_awake = 0, active_until = NULL,
            pending_directive = '', pending_at = NULL, last_command = 'expired',
            updated_at = datetime('now')
      WHERE character_id = ?`
  ).run(characterId);
  return readStateRow(characterId);
}

/**
 * 面板状态。`active` 为 false 时一律视为未催眠（过期即自动解除）。
 * @returns {{characterId:number, bodyControlled:boolean, mindAwake:boolean, active:boolean,
 *            activeUntil:string|null, startedAt:string|null, pendingDirective:string,
 *            commandCount:number, lastCommand:string, gate:object}}
 */
export function getHypnosisState(characterId) {
  const id = requireId(characterId);
  ensureCharacter(id);
  const row = expireIfNeeded(id, readStateRow(id));
  return buildState(id, row);
}

/** 是否处于催眠中（受控且未过期） */
export function isHypnotized(characterId) {
  const id = toId(characterId);
  if (!id) return false;
  const row = expireIfNeeded(id, readStateRow(id));
  return Boolean(row && row.is_active === 1 && row.body_controlled === 1);
}

/** 身体是否受控 */
export function isBodyControlled(characterId) {
  const id = toId(characterId);
  if (!id) return false;
  const row = expireIfNeeded(id, readStateRow(id));
  return Boolean(row && row.is_active === 1 && row.body_controlled === 1);
}

/** 意志是否清醒（「只唤醒意志」后为 true，此时身体仍可能受控） */
export function isMindAwake(characterId) {
  const id = toId(characterId);
  if (!id) return false;
  const row = expireIfNeeded(id, readStateRow(id));
  return Boolean(row && row.is_active === 1 && row.mind_awake === 1);
}

/**
 * 只读当前的一次性指令（不清空；清空走 consumePendingDirective）。
 * 与读状态同口径：过期会话视为已解除，不会吐出陈旧指令。
 */
export function getPendingDirective(characterId) {
  const id = toId(characterId);
  if (!id) return '';
  const row = expireIfNeeded(id, readStateRow(id));
  return row?.pending_directive || '';
}

/**
 * 取走一次性指令并立即清空：chat.js 每轮组装上下文时调一次。
 * 自己先做过期判定，不再依赖调用方"先 getHypnosisState 再 consume"的顺序：
 * 过期会话的 pending 在这一步就被 expireIfNeeded 清掉，因此返回空串。
 */
export function consumePendingDirective(characterId) {
  const id = toId(characterId);
  if (!id) return '';
  const row = expireIfNeeded(id, readStateRow(id));
  const directive = row?.pending_directive || '';
  if (directive) {
    getDb().prepare(
      `UPDATE character_hypnosis SET pending_directive = '', pending_at = NULL, updated_at = datetime('now')
        WHERE character_id = ?`
    ).run(id);
  }
  return directive;
}

// ── 催眠 / 唤醒 / 指令 ──

/**
 * 开始一次催眠（自定义时长）。**每次调用都是重新开始一次**：started_at 刷新、
 * mind_awake 归零、身体回到受控；遗忘窗口的左端跟着这个 started_at 走。
 * @param {{minutes?:number}} [options]
 */
export function hypnotize(characterId, { minutes } = {}) {
  const id = requireId(characterId);
  ensureCharacter(id);
  ensureEnabled();
  const gate = getHypnosisGate(id);
  if (!gate.allowed) throw fail('hypnosis gate not met', 'GATE', { reason: gate.reason, gateCode: gate.code });

  const mins = clampInt(minutes, HYPNOSIS_MIN_MINUTES, HYPNOSIS_MAX_MINUTES, HYPNOSIS_DEFAULT_MINUTES);
  const modifier = `+${mins} minutes`;
  // 会话起点的 raw id：遗忘窗口左端 = 它 + 1。
  // 刻意用 raw id 而不是时间当左端 —— datetime('now') 只到秒，且"同秒重复催眠"会把 started_at
  // 推到未来 1 秒，用时间会漏掉催眠后那一秒内发出的消息（e2e 实测抓到过）。
  // 注意：会话 id 必须**按字符串绑定**（`'char_' || ?` 传数字会被绑成 REAL，拼出 'char_1.0' 查不到）。
  const sessionStartRawId = Number(getDb().prepare(
    `SELECT COALESCE(MAX(id), 0) AS id FROM raw_messages WHERE conversation_id = ?`
  ).get(`char_${id}`)?.id) || 0;
  // started_at 同时是「本次催眠会话」的身份：forced_climax 用它做幂等锚点（SQLite 只到秒，
  // 同一秒内连点两次「催眠」会拿到同一个锚点，所以让重复催眠至少前进 1 秒）。
  // 注意：这个 +1 秒**不再参与遗忘窗口计算**，只影响 started_at 的展示值与会话身份。
  getDb().prepare(
    `INSERT INTO character_hypnosis
       (character_id, body_controlled, mind_awake, active_until, started_at, session_start_raw_id,
        pending_directive, pending_at, command_count, last_command, updated_at)
     VALUES (?, 1, 0, datetime('now', ?), datetime('now'), ?, '', NULL, 1, 'hypnotize', datetime('now'))
     ON CONFLICT(character_id) DO UPDATE SET
       body_controlled = 1,
       mind_awake = 0,
       active_until = datetime('now', ?),
       started_at = CASE
         WHEN character_hypnosis.started_at = datetime('now') THEN datetime('now', '+1 second')
         ELSE datetime('now')
       END,
       session_start_raw_id = ?,
       pending_directive = '', pending_at = NULL,
       command_count = character_hypnosis.command_count + 1,
       last_command = 'hypnotize',
       updated_at = datetime('now')`
  ).run(id, modifier, sessionStartRawId, modifier, sessionStartRawId);

  return getHypnosisState(id);
}

/**
 * 挂上「刚被唤醒」的一次性反应（task-42）。
 *
 * 用户原话：「唤醒的时候没有惊讶诧异的反应」。唤醒成功后，紧随的那一轮要让模型演出
 * 惊醒 / 错愕 / 恍惚 / 意识与身体对不上 / 下意识找你在哪（文案见 hypnosisPrompt 的 WAKE_REACTION_LINES）。
 *
 * 三条口径：
 *   1. **只在真的从"受控或睡着"变成"醒着"的那一次挂**（调用方负责判转变），幂等调用不重复挂；
 *   2. 只写 pending_directive / pending_at 两列，**不碰任何催眠状态列**（body_controlled /
 *      mind_awake / active_until 原样）——睡眠唤醒走的就是这条路：那是睡眠系统的事，
 *      不该顺手把催眠状态改动或"记一笔催眠"；
 *   3. 角色可能**一行状态都没有**（从没被催眠过、或纯靠睡眠唤醒）→ upsert 建行，否则指令丢失。
 *
 * 与遗忘恢复的 memory_restore 同性质：都是"下一个 chat 轮的一句叙事提示"，消费即清空。
 * 时间新鲜度口径与其它一次性指令一致（pending_at 只留痕，不参与判定）——已知边界。
 *
 * @returns {boolean} 是否真的写进去了（异常只 warn，不影响唤醒本身）
 *
 * 2026-09-30 加 export（task-17）：SLG 动作系统「睡着时被重动作摸醒」也要演这一下
 * （routes/touch.js 在 tempWake 之后挂同一个 wake_reaction），复用同一份挂载逻辑，别各写一份。
 */
export function attachWakeReaction(characterId) {
  try {
    getDb().prepare(
      `INSERT INTO character_hypnosis (character_id, pending_directive, pending_at, updated_at)
       VALUES (?, 'wake_reaction', datetime('now'), datetime('now'))
       ON CONFLICT(character_id) DO UPDATE SET
         pending_directive = 'wake_reaction',
         pending_at = datetime('now'),
         updated_at = datetime('now')`
    ).run(characterId);
    return true;
  } catch (err) {
    // 与其它副作用同口径：挂不上也不能让唤醒失败
    console.warn('[hypnosis] 挂唤醒反应指令失败:', err.message);
    return false;
  }
}

/**
 * 唤醒。
 *   - mode='full'：身体与意志一起放开（active_until 清空，**保留 started_at**，遗忘窗口还要用）
 *   - mode='mind'：只唤醒意志（mind_awake=1，body_controlled 保持 1，active_until 不变）
 *
 * task-42 起两种 mode 都会在**真的发生转变**的那一次挂上 `wake_reaction`（"刚被唤醒"的一次性叙事）：
 *   - full：本次调用前 active && bodyControlled（真的从受控变成醒着）才挂；幂等空唤醒不挂；
 *   - mind：本次调用前 mindAwake === false（真的从"意志被压制"变成清醒）才挂。
 * ⚠️ full 分支的 UPDATE 会先清空 pending_directive，再挂 wake_reaction —— 这是既有语义
 * （全醒 = 丢掉没来得及执行的一次性指令）之上的一步，顺序不能反。
 */
export function wake(characterId, { mode = 'full' } = {}) {
  const id = requireId(characterId);
  ensureCharacter(id);
  ensureEnabled();
  const wanted = mode === 'mind' ? 'mind' : 'full';
  const state = getHypnosisState(id);

  if (wanted === 'mind') {
    if (!state.active || !state.bodyControlled) throw fail('not hypnotized', 'NOT_HYPNOTIZED');
    const transitioned = !state.mindAwake;
    getDb().prepare(
      `UPDATE character_hypnosis SET mind_awake = 1, last_command = 'wake:mind', updated_at = datetime('now')
        WHERE character_id = ?`
    ).run(id);
    if (transitioned) attachWakeReaction(id);
  } else {
    // 未在催眠中也允许调用（幂等）：只是把状态归零
    // 只有"真的从受控变成醒着"才算一次唤醒（过期后 / 本来就醒着都不算）
    const transitioned = Boolean(state.active && state.bodyControlled);
    getDb().prepare(
      `UPDATE character_hypnosis
          SET body_controlled = 0, mind_awake = 0, active_until = NULL,
              pending_directive = '', pending_at = NULL, last_command = 'wake:full',
              updated_at = datetime('now')
        WHERE character_id = ?`
    ).run(id);
    if (transitioned) attachWakeReaction(id);
  }
  return getHypnosisState(id);
}

/**
 * 强制高潮的服务端记账。幂等锚点分两种（task-42）：
 *   - **催眠中**：用**本次催眠会话**（started_at）。同一场里重复点只落 1 笔；
 *     不能用 command_count —— 后者每点一次就变，会让重复点击重复计数。
 *   - **非催眠态**（用户口径「强制高潮不需要催眠 随时都能触发」）：没有"会话"这个概念，
 *     用**下发时刻**当锚点 ⇒ 每点一次记一笔。若沿用会话锚点，startedAt 为空（从没被催眠过）
 *     或残留旧值（会话已过期）都会让所有非催眠触发共用一个 anchor → 看板一辈子只记 1 笔。
 *
 * 一笔点击 = 一笔账：本函数在整个后端只有 `issueCommand` 一个调用点（表演轮不会重复记账），
 * 回归见 hypnosisService.test.js「强制高潮记账：一次点击只落一笔」。
 */
/** 非催眠态强制高潮的进程内自增序号（见 recordForcedClimax 的锚点说明） */
let awakeClimaxSeq = 0;

function recordForcedClimax(characterId, state, inHypnosis) {
  // 非催眠态的锚点 = 下发时刻 + 进程内自增序号：同一毫秒内连点两次也要各记一笔
  // （只用 Date.now() 的话，两次点击落在同一毫秒会被当成同一次，第二次静默跳过）。
  const anchor = inHypnosis && state.startedAt
    ? `hypnosis:${state.startedAt}:forced_climax`
    : `hypnosis:awake:${Date.now()}:${++awakeClimaxSeq}:forced_climax`;
  try {
    const result = recordIntimateActs(characterId, {
      scene: 'hypnosis',
      partnerKind: 'user',
      partnerId: 0,
      source: 'manual',
      rawId: 0,
      // climaxCount 必须显式给：面板「高潮次数」读的是 SUM(climax_count)（intimateService.js:1154），
      // 只给 count 的话 totalClimax 永远是 0 —— 点多少次都不涨（真机诊断：totalClimax 恒为 0）。
      acts: [{ actKey: 'climax', count: 1, climaxCount: 1, sourceUid: anchor }],
    });
    return { inserted: result.inserted, skipped: result.skipped, blocked: result.blocked, sourceUid: anchor };
  } catch (err) {
    console.warn('[hypnosis] forced_climax 记账失败:', err.message);
    return null;
  }
}

/**
 * 强制高潮的情绪快照锚点：优先当前会话最后一条 `messages.id`（`emotion_snapshots.after_msg_id`
 * 的 FK 指向 `messages(id)`）；查不到行、或表结构异常，就返回 `null`。
 *
 * 绝不能拿 `raw_messages.id` 顶替（两者是不同表的主键，id 撞不上就 `FOREIGN KEY constraint failed`，
 * 真机日志踩到过）；`after_msg_id` 本身可空，宁可空锚点也**要把这次情绪写进去**。
 */
function resolveClimaxAnchorMsgId(db, conversationId) {
  try {
    const row = db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversationId);
    return row?.id ?? null;
  } catch (err) {
    console.warn('[hypnosis] 解析强制高潮情绪锚点失败，改用空锚点:', err.message);
    return null;
  }
}

/**
 * 情绪侧：arousal 拉高、dominance 压低。
 */
function nudgeEmotionForClimax(characterId) {
  try {
    const db = getDb();
    const conversationId = `char_${characterId}`;
    const afterMsgId = resolveClimaxAnchorMsgId(db, conversationId);

    const character = db.prepare('SELECT emotion_baseline FROM characters WHERE id = ?').get(characterId);
    const baseline = JSON.parse(character?.emotion_baseline || '{"valence":0.5,"arousal":0.5,"dominance":0.5}');
    const current = loadEmotionState(conversationId, baseline);
    const next = evolveEmotion(current, { valence: 0.1, arousal: 0.3, dominance: -0.3 }, baseline);
    saveEmotionSnapshot(conversationId, afterMsgId, next, 'joy', loadAffinity(characterId), null, '催眠指令：强制高潮');
    // 2026-10-02：催眠也走亲密刺激统一下游（用户原话：「现在的玩具和催眠和心情和记忆好像是完全解耦的
    // 一样 根本就没关联」）—— 强制高潮是一记重刺激：敏感条 + 心情 + 记忆一起走，别只有这一份情绪增量。
    // 不 await：心情/记忆是旁路，指令回执不该等它。
    Promise.resolve()
      .then(() => applyIntimateStimulus({
        characterId, source: 'hypnosis', amount: 25, reason: '催眠指令：强制高潮',
        note: '被催眠指令强制高潮',
      }))
      .catch(err => console.warn('[hypnosis] 刺激下游失败（不影响指令）:', err?.message || err));
    return { applied: true, afterMsgId: afterMsgId == null ? null : Number(afterMsgId) };
  } catch (err) {
    console.warn('[hypnosis] 强制高潮情绪写入失败:', err.message);
    return null;
  }
}

/**
 * 下达一次性指令（kind ∈ body_control | forced_climax）。
 *
 * 前置按 kind 分流（task-42 口径修订）：
 *   - `body_control`：**必须**处于催眠中且身体受控，否则抛 code='NOT_HYPNOTIZED'（保持原样）；
 *   - `forced_climax`：**不再要求催眠**——用户原话「再加一个 强制高潮不需要催眠 随时都能触发」。
 *     非催眠态下也允许下发，只把指令记进 pending_directive，**不写任何催眠状态**
 *     （body_controlled / mind_awake / active_until 原样不动），不抛错。
 *
 * forced_climax 会同时做两件事（都 try/catch 兜底，失败不影响指令本身）：
 *   ① 往看板记一笔 climax（scene='hypnosis'）② 抬高 arousal / 压低 dominance
 * 记账的幂等锚点见 recordForcedClimax：催眠中按会话锚点（重复点只 1 笔），非催眠态按下发时刻。
 */
/**
 * 下发一条催眠指令。2026-10-01 新增 `force_toy`（用户原话「催眠状态也不能强制让角色用上玩具」）。
 *
 * ## force_toy 的玩法语义（本条是与用户确认后定下的口径）
 * · **归催眠域**：与 body_control 同档，**只在完全控制（active && body_controlled）下可下**；
 *   未催眠时下发抛 NOT_HYPHNOTIZED（forced_climax 是唯一例外，见上）。
 * · **它就是"命令她戴上并用上某个玩具"**：服务端**当场真的戴上**（写 character_worn_toys），
 *   不是只写一句让她"照做"的台词 —— 用户要的是"强制用上"，那就得真的用上。
 * · **门控归属**：她的**意愿**被强制（hypnosis 已经在玩具门控里豁免），但**系统约束不越过**：
 *   玩具必须存在（否则 INVALID）、强度按该玩具上限 clamp、玩具总开关关着时整条指令不可用（TOYS_DISABLED）。
 * · 一次性：写进 pending_directive，由 chat.js / 群聊当轮消费即清（与其它指令同一条链路）。
 *
 * @param {number|string} characterId
 * @param {'body_control'|'forced_climax'|'force_toy'} kind
 * @param {{toyKey?:string, intensity?:number}} [options] 仅 force_toy 使用
 */
export function issueCommand(characterId, kind, options = {}) {
  const id = requireId(characterId);
  ensureCharacter(id);
  ensureEnabled();
  if (!HYPNOSIS_COMMANDS.includes(kind)) throw fail('invalid argument', 'INVALID');

  const state = getHypnosisState(id);
  const inHypnosis = Boolean(state.active && state.bodyControlled);
  // 参数校验（INVALID）已经过了；未催眠时只有 forced_climax 放行
  if (!inHypnosis && kind !== 'forced_climax') {
    // 2026-10-01（用户：「不能强制角色自己玩玩具 / 催眠玩具不能点击」）：
    // force_toy 原来和 body_control 一个门（要求 bodyControlled＝完全控制），
    // 结果是「在催眠中但不是完全控制」时下不了玩具指令 —— 用户要的是**催眠中就可用**。
    // 独立放行：只要是 active（真的在催眠里）就允许命令她用玩具；
    // 命令能否"生效"仍由角色状态与叙事决定（这里只负责下发）。
    if (kind === 'force_toy' && state.active) { /* 放行 */ }
    else throw fail('not hypnotized', 'NOT_HYPNOTIZED');
  }

  // force_toy：先校验 + 真的戴上，再写指令。顺序很重要 —— 校验失败时不能留下一条"她已被命令"的记录。
  let directiveValue = kind;
  let toyResult = null;
  if (kind === 'force_toy') {
    if (config.features?.toys !== true) throw fail('toys disabled', 'TOYS_DISABLED');
    const toyKey = String(options.toyKey || '').trim();
    const toy = getToy(toyKey);
    if (!toy) throw fail('unknown toy', 'INVALID');
    // clampIntensity 由 equipToy 内部走（这里先算出最终强度，好写进指令里给模型看）
    const intensity = Math.min(
      toy.maxIntensity,
      Math.max(0, Math.trunc(Number(options.intensity ?? Math.min(4, toy.maxIntensity))))
    );
    const equipped = equipToy(id, toyKey, { intensity });
    if (!equipped) throw fail('equip failed', 'EQUIP_FAILED');
    // ⚠️ setToyMode / setToyCurve 返回的是**对象** `{ ok, code, toy }`，不是布尔 ——
    // 第一版写成 `if (setToyMode(...))` ⇒ 无效模式也会被当成成功（会写出一条假指令），
    // 被新加的"给错了就当没给"单测当场抓到。
    let mode = null;
    let curve = null;
    try {
      const wanted = String(options.mode || '').trim().toLowerCase();
      if (wanted) {
        const applied = setToyMode(id, toyKey, wanted);
        if (applied?.ok) mode = wanted;
        else console.warn(`[hypnosis] force_toy 的振动模式被拒（${applied?.code || 'unknown'}），按"没给模式"处理`);
      }
    } catch (err) {
      console.warn('[hypnosis] force_toy 设置振动模式失败（不影响戴上玩具）:', err?.message || err);
    }
    // 强度曲线（2026-10-02 第二步扩展）：同样只在**真的设上**时才写进指令
    try {
      const wanted = String(options.curve || '').trim().toLowerCase();
      if (wanted && wanted !== 'off') {
        const applied = setToyCurve(id, toyKey, wanted);
        if (applied?.ok) curve = wanted;
        else console.warn(`[hypnosis] force_toy 的强度曲线被拒（${applied?.code || 'unknown'}），按"没给曲线"处理`);
      }
    } catch (err) {
      console.warn('[hypnosis] force_toy 设置强度曲线失败（不影响戴上玩具）:', err?.message || err);
    }
    directiveValue = encodeForceToyDirective(toyKey, intensity, mode, curve);
    toyResult = {
      toyKey,
      label: toy.label,
      part: toy.part,
      intensity,
      maxIntensity: toy.maxIntensity,
      mode,
      curve,
      worn: listWornToys(id).map(t => ({ toyKey: t.toyKey, label: t.label, intensity: t.intensity })),
    };
  }

  if (inHypnosis) {
    getDb().prepare(
      `UPDATE character_hypnosis
          SET pending_directive = ?, pending_at = datetime('now'),
              command_count = command_count + 1, last_command = ?, updated_at = datetime('now')
        WHERE character_id = ?`
    ).run(directiveValue, kind, id);
  } else {
    // 非催眠态的 forced_climax：角色**可能一行状态都没有**（从没被催眠过），裸 UPDATE 会静默丢指令。
    // 用 upsert 只写"指令"两列 + 计数，其余列吃 INSERT 的默认值
    // （body_controlled=0 / mind_awake=0 / active_until=NULL）——「记录指令即可，不写催眠状态」。
    getDb().prepare(
      `INSERT INTO character_hypnosis (character_id, pending_directive, pending_at, command_count, last_command, updated_at)
       VALUES (?, ?, datetime('now'), 1, ?, datetime('now'))
       ON CONFLICT(character_id) DO UPDATE SET
         pending_directive = excluded.pending_directive,
         pending_at = datetime('now'),
         command_count = character_hypnosis.command_count + 1,
         last_command = excluded.last_command,
         updated_at = datetime('now')`
    ).run(id, directiveValue, kind);
  }

  const result = getHypnosisState(id);
  if (kind === 'forced_climax') {
    result.intimate = recordForcedClimax(id, state, inHypnosis);
    result.emotion = nudgeEmotionForClimax(id);
  }
  if (toyResult) result.toy = toyResult;
  return result;
}

// ── 遗忘 / 恢复 ──

function parseMemoryIds(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.map(v => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function serializeWindow(row) {
  return {
    id: Number(row.id),
    characterId: Number(row.character_id),
    fromRawId: Number(row.from_raw_id) || 0,
    toRawId: Number(row.to_raw_id) || 0,
    fromAt: row.from_at || null,
    toAt: row.to_at || null,
    memoriesArchived: Number(row.memories_archived) || 0,
    memoryIds: parseMemoryIds(row.memory_ids),
    status: row.status,
    createdAt: row.created_at || null,
  };
}

/**
 * 挑出与 [fromRawId, toRawId] 有交集的活跃记忆 id。
 * 先**只读**收集（分页期间不改数据，避免边归档边翻页跳行），再由调用方统一归档。
 */
function collectMemoriesInRange(conversationId, fromRawId, toRawId) {
  if (!(toRawId >= fromRawId)) return { rows: [], ids: [] };
  const rows = [];
  const ids = [];
  const limit = 200;
  for (let offset = 0; offset <= 5000; offset += limit) {
    const batch = listActiveMemories({ conversationId, limit, offset });
    if (batch.length === 0) break;
    for (const memory of batch) {
      const startId = Number(memory.source_raw_start_id) || 0;
      const endId = Number(memory.source_raw_end_id) || 0;
      if (!startId && !endId) continue; // 无 raw 锚点的记忆（如 AI 整理写入）不属于这段对话
      if (endId < fromRawId || startId > toRawId) continue;
      rows.push(memory);
      ids.push(String(memory.memory_id));
    }
    if (batch.length < limit) break;
  }
  return { rows, ids };
}

/**
 * 群聊侧的遗忘口径（2026-09-29 task-1 冻结，lead 预冻结口径原文：「群聊 transcript 的屏蔽以
 * 遗忘窗口自身的 from_at/to_at 时间区间为准」）：
 *
 *   群会话（「group_<gid>」）与私聊会话（「char_<cid>」）是**两条独立的 raw_messages 自增序列**，
 *   窗口行里的 from_raw_id/to_raw_id 只对私聊会话有意义，拿去比群 raw 的 id 必然串台
 *   （可能误屏群里的无关消息，也可能漏掉该屏的）。所以群聊侧一律按 **时间区间** 判定，
 *   时间戳同为 SQLite 无时区的 UTC 串（「YYYY-MM-DD HH:MM:SS」），字典序比较等价于时间序。
 *
 * 一轮群聊是**一次调用演全部角色**（输出协议按 「[名字]: 台词」 分行），无法按成员分片裁 transcript
 * —— 一条 raw 里混着所有成员的发言。故屏蔽口径为：**任一成员遗忘该区间即对全体屏蔽**
 * （对没被催眠的成员是"多屏了一段"，但不会泄漏被遗忘者该忘掉的内容；反之按成员拆分需要把一条
 * raw 按行拆开，代价与出错面都大得多）。此口径需与前端/文档同步维护。
 */

/**
 * 一次查库取回指定成员集合的所有 **active** 遗忘窗口（群聊 transcript 屏蔽用）。
 *
 * 为什么要批量版：群聊每轮都要算，逐个成员 listForgottenWindows 会变成 N 次查库；
 * 这里一条 IN (...) 拿全，再在内存里判断（与 isRawForgotten 的既有口径一致：不逐条查库）。
 * 总开关关闭 / 无有效成员 / 无窗口时返回 []。
 *
 * @param {Array<number|string>} characterIds 群成员 id 列表
 * @returns {Array<{characterId:number, windowId:number, fromAt:string|null, toAt:string|null}>}
 */
export function collectForgottenWindowsForMembers(characterIds = []) {
  if (config.features.hypnosis === false) return [];
  const ids = [...new Set((Array.isArray(characterIds) ? characterIds : [])
    .map(toId)
    .filter(id => id > 0))];
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT id, character_id, from_at, to_at FROM hypnosis_forgotten_windows
       WHERE status = 'active' AND character_id IN (${ph})
       ORDER BY id ASC`
  ).all(...ids);
  return rows.map(row => ({
    characterId: Number(row.character_id),
    windowId: Number(row.id),
    fromAt: row.from_at || null,
    toAt: row.to_at || null,
  }));
}

/**
 * 挑出**群聊会话**里落在 [fromAt, toAt] 时间区间内的活跃长期记忆（闭区间）。
 *
 * 与 collectMemoriesInRange（私聊、按 raw id）同职责、同"先只读收集再统一归档"的写法，
 * 只是判定基准换成时间：源 raw 的 raw_messages.created_at 落在区间内即命中。
 * 只看该角色所在的群会话；无锚点（无 source_raw_start_id）的记忆不参与（与私聊同口径）。
 * 用 EXISTS 子查询按 id 取 raw，避开"一个窗口几千条 id 拼 IN 占位符"的规模问题。
 *
 * @param {number} characterId
 * @param {string} fromAt 区间左端（闭，UTC 无时区串）
 * @param {string} toAt 区间右端（闭）
 */
function collectGroupMemoriesInRange(characterId, fromAt, toAt) {
  const empty = { rows: [], ids: [] };
  const from = String(fromAt || '').trim();
  const to = String(toAt || '').trim();
  if (!from || !to || to < from) return empty;
  const rows = [];
  const ids = [];
  const limit = 200;
  for (let offset = 0; offset <= 5000; offset += limit) {
    const batch = getDb().prepare(
      `SELECT mf.* FROM memory_fragments mf
         WHERE mf.status = 'active'
           AND mf.conversation_id LIKE 'group_%'
           AND mf.source_raw_start_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM group_members gm
              JOIN raw_messages rm ON rm.id = mf.source_raw_start_id
             WHERE gm.group_id = CAST(SUBSTR(mf.conversation_id, 7) AS INTEGER)
               AND gm.character_id = ?
               AND rm.created_at IS NOT NULL
               AND rm.created_at >= ? AND rm.created_at <= ?
           )
         ORDER BY mf.id ASC LIMIT ? OFFSET ?`
    ).all(toId(characterId), from, to, limit, offset);
    if (batch.length === 0) break;
    for (const memory of batch) {
      rows.push(memory);
      ids.push(String(memory.memory_id));
    }
    if (batch.length < limit) break;
  }
  return { rows, ids };
}

/**
 * 遗忘这一轮催眠覆盖的范围：归档窗口内的长期记忆 + 写一条可撤销的遗忘窗口，
 * 并把当前催眠状态清零（遗忘即结束控制）。
 *
 * 窗口左端 = `session_start_raw_id + 1`（**raw id**，不是时间）：
 *   时间当左端会漏掉"催眠后同一秒内"发出的消息（started_at 在同秒重复催眠时会被推到未来 1 秒），
 *   而按 id 判定与时间分辨率、时钟回拨、created_at 为 NULL 都无关。
 *   存量库该列为 0（首版没有这一列）时回退到原来的时间查询，行为可解释、不报错。
 *
 * 归档用 status='archived'（可被 restoreArchivedMemory 还原），
 * 精确 memory_id 列表存进窗口行的 memory_ids。
 *
 * **两侧都归档**（task-1，2026-09-29）：私聊长期记忆按 raw id 区间、群聊长期记忆按
 * 窗口的 from_at/to_at 时间区间（见文件上方的群聊侧口径说明）。撤销仍走 memory_ids 精确还原，
 * 所以"让她恢复这段记忆"对群聊侧同样生效，且不会误还原同一区间里被别的任务归档的无关记忆。
 *
 * @param {{toRawId?:number}} [options]
 * @returns {{windowId:number, fromRawId:number, toRawId:number, archived:number}}
 */
export function forgetWindow(characterId, { toRawId } = {}) {
  const id = requireId(characterId);
  ensureCharacter(id);
  ensureEnabled();
  const db = getDb();
  const row = readStateRow(id);
  const startedAt = row?.started_at || null;
  if (!startedAt) throw fail('no hypnosis session', 'NO_SESSION');

  const conversationId = `char_${id}`;
  const convMaxId = db.prepare(
    `SELECT MAX(id) AS maxId FROM raw_messages WHERE conversation_id = ? AND role IN ('user', 'assistant')`
  ).get(conversationId)?.maxId ?? 0;

  const sessionStartRawId = Number(row?.session_start_raw_id) || 0;
  let fromRawId;
  if (sessionStartRawId > 0) {
    // 主路径：会话起点之后的第一条 raw（与时间无关）
    fromRawId = sessionStartRawId + 1;
  } else {
    // 回退路径：老库/老会话该列为 0（首版没有这一列），只能按时间找。
    // `created_at IS NULL` 也计入窗口（NULL 参与比较恒为假，不兜住会把这类 raw 永久漏掉）。
    const byTime = db.prepare(
      `SELECT MIN(id) AS minId FROM raw_messages
        WHERE conversation_id = ? AND role IN ('user', 'assistant')
          AND (created_at IS NULL OR created_at >= ?)`
    ).get(conversationId, startedAt)?.minId;
    // 没有匹配 raw 时给空区间（from = max + 1），仍落一条窗口行供审计
    fromRawId = Number(byTime) || (convMaxId + 1);
  }
  const toRawIdFinal = clampInt(toRawId, 0, Number.MAX_SAFE_INTEGER, 0) || convMaxId;

  const collected = collectMemoriesInRange(conversationId, fromRawId, toRawIdFinal);
  const archiveStmt = db.prepare(
    `UPDATE memory_fragments SET status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'`
  );
  let archived = 0;
  const archivedIds = [];
  // 先落窗口行拿到 to_at，再用**同一对时间戳**归档两侧的长期记忆：
  //   ① 私聊（按 raw id 区间，见 collectMemoriesInRange）；② 群聊（按时间区间，见 collectGroupMemoriesInRange）。
  // 群聊那半必须用窗口行的 from_at/to_at 而不是 raw id —— 群会话与私聊会话是两条独立的 id 序列。
  const toAt = db.prepare("SELECT datetime('now') AS t").get().t;
  const groupCollected = collectGroupMemoriesInRange(id, startedAt, toAt);
  const archive = db.transaction(() => {
    for (const memory of collected.rows) {
      const changed = archiveStmt.run(memory.id).changes;
      if (changed > 0) {
        archived += 1;
        archivedIds.push(String(memory.memory_id));
      }
    }
    for (const memory of groupCollected.rows) {
      const changed = archiveStmt.run(memory.id).changes;
      if (changed > 0) {
        archived += 1;
        archivedIds.push(String(memory.memory_id));
      }
    }
  });
  archive();

  const inserted = db.prepare(
    `INSERT INTO hypnosis_forgotten_windows
       (character_id, from_raw_id, to_raw_id, from_at, to_at, memories_archived, memory_ids, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
  ).run(id, fromRawId, toRawIdFinal, startedAt, toAt, archived, JSON.stringify(archivedIds));

  // 遗忘即结束控制（保留 started_at：窗口审计要用，且下一次催眠会重新刷新它）
  db.prepare(
    `UPDATE character_hypnosis
        SET body_controlled = 0, mind_awake = 0, active_until = NULL,
            pending_directive = '', pending_at = NULL, updated_at = datetime('now')
      WHERE character_id = ?`
  ).run(id);

  return { windowId: Number(inserted.lastInsertRowid), fromRawId, toRawId: toRawIdFinal, archived };
}

/** 遗忘窗口列表（默认只看 active；展示字段用 fromRawId/toRawId，chat.js 直接拿去屏蔽上下文） */
export function listForgottenWindows(characterId, { status = 'active' } = {}) {
  const id = toId(characterId);
  if (!id) return [];
  const rows = status
    ? getDb().prepare('SELECT * FROM hypnosis_forgotten_windows WHERE character_id = ? AND status = ? ORDER BY id DESC').all(id, status)
    : getDb().prepare('SELECT * FROM hypnosis_forgotten_windows WHERE character_id = ? ORDER BY id DESC').all(id);
  return rows.map(serializeWindow);
}

/**
 * 撤销一次遗忘：按 memory_ids **精确**还原（不会误还原同一 raw 区间里被 T3 衰减自动归档的无关记忆），
 * 窗口置 status='restored'，并给该角色下一次聊天留一条一次性叙事指令 `memory_restore`
 * （不走 issueCommand——它要求处于催眠中）。
 *
 * 传 `characterId` 时先做**归属校验**：不匹配直接抛 NOT_FOUND 且**不产生任何副作用**
 * （曾出现过"路由先执行再校验 404"的越权写入：别人窗口已被恢复，却回了 404）。
 * @param {number} windowId
 * @param {{characterId?: number}} [options]
 * @returns {{windowId:number, restored:number, pendingDirective:string, window:object}}
 */
export function restoreForgottenWindow(windowId, { characterId } = {}) {
  const wid = toId(windowId);
  if (!wid) throw fail('invalid argument', 'INVALID');
  const db = getDb();
  const row = db.prepare('SELECT * FROM hypnosis_forgotten_windows WHERE id = ?').get(wid);
  if (!row) throw fail('window not found', 'NOT_FOUND');

  // 归属校验必须在任何副作用之前（越权请求不能改到别人的窗口/记忆）
  const ownerId = toId(characterId);
  if (ownerId && Number(row.character_id) !== ownerId) throw fail('window not found', 'NOT_FOUND');

  // 恢复是一次写操作（改窗口状态 + 还原记忆 + 置指令），与其它写操作一样受总开关拦截
  ensureEnabled();

  const memoryIds = parseMemoryIds(row.memory_ids);
  let restored = 0;
  for (const memoryId of memoryIds) {
    try {
      if (restoreArchivedMemory(memoryId)) restored += 1;
    } catch (err) {
      console.warn('[hypnosis] 还原记忆失败:', memoryId, err.message);
    }
  }

  const characterIdToUse = Number(row.character_id);
  const write = db.transaction(() => {
    db.prepare(`UPDATE hypnosis_forgotten_windows SET status = 'restored' WHERE id = ?`).run(wid);
    // 角色可能还没有状态行（例如刚建号就恢复历史窗口）→ upsert 一行再置指令
    db.prepare(
      `INSERT INTO character_hypnosis (character_id, pending_directive, pending_at, last_command, updated_at)
       VALUES (?, 'memory_restore', datetime('now'), 'memory_restore', datetime('now'))
       ON CONFLICT(character_id) DO UPDATE SET
         pending_directive = 'memory_restore', pending_at = datetime('now'),
         last_command = 'memory_restore', updated_at = datetime('now')`
    ).run(characterIdToUse);
  });
  write();

  const fresh = db.prepare('SELECT * FROM hypnosis_forgotten_windows WHERE id = ?').get(wid);
  return { windowId: wid, restored, pendingDirective: 'memory_restore', window: serializeWindow(fresh) };
}

/** 当前生效（active）的遗忘区间，供下面的内存判断复用 */
function activeWindowRanges(characterId) {
  return getDb().prepare(
    `SELECT from_raw_id AS fromRawId, to_raw_id AS toRawId FROM hypnosis_forgotten_windows
      WHERE character_id = ? AND status = 'active'`
  ).all(characterId);
}

/** 某条 raw 是否落在被遗忘的窗口里 */
export function isRawForgotten(characterId, rawId) {
  const id = toId(characterId);
  const raw = clampInt(rawId, 0, Number.MAX_SAFE_INTEGER, 0);
  if (!id || !raw) return false;
  return activeWindowRanges(id).some(w => raw >= w.fromRawId && raw <= w.toRawId);
}

/**
 * 过滤掉被遗忘的 raw id：**返回仍然可见的 id 列表**（语义：filter out forgotten）。
 * 一次查窗口集合、再内存判断——不对每条消息查库。
 */
export function filterForgottenRawIds(characterId, rawIds = []) {
  const id = toId(characterId);
  const list = Array.isArray(rawIds) ? rawIds : [];
  if (!id || list.length === 0) return list.slice();
  const windows = activeWindowRanges(id);
  if (windows.length === 0) return list.slice();
  return list.filter(raw => {
    const value = Number(raw) || 0;
    return !windows.some(w => value >= w.fromRawId && value <= w.toRawId);
  });
}

/** 背包直接领取催眠手机（幂等：已有一台未使用就不重复塞；与其余写操作一致受总开关约束） */
export function grantHypnosisPhone() {
  ensureEnabled();
  return { item: grantPhoneToBackpack() };
}

// ── 睡眠控制（催眠手机的独立一区：「立刻入睡」/「立刻唤醒」）────────────────────
//
// 用户口径：
//   「睡觉怎么就不能直接触发了 催眠手机是全覆盖的」→ 睡着也要能用手机（触发前先临时唤醒，见 wakeForForcedTrigger）
//   「再加单独一个选项 可以控制角色睡眠」        → 面板上独立一区，与催眠指令互不影响
//
// **写操作一定走日程/睡眠那一侧的链路**（`scheduleEditor.forceSleepNow/forceWakeNow` →
// `scheduleManager.syncSleepingState`），绝不只改 `characters.is_sleeping`：
// 只改库的话，下一次日程同步会按日程把结论翻回去（内存说醒着、库里说睡着）。

/** 触发一轮前给她的临时唤醒窗口（分钟）：够跑完一轮 LLM 回复即可 */
export const FORCED_TRIGGER_TEMP_WAKE_MINUTES = 5;

/**
 * **立刻入睡**。
 * @param {number} characterId
 * @param {{until?: string}} [options] 不传 = 按日程默认（当日主睡眠块的时长，兜底 8 小时）
 * @returns {{characterId:number, isSleeping:boolean, sleepUntil:string|null, temporaryWakeUntil:string|null}}
 */
export function sleepNow(characterId, { until } = {}) {
  const id = requireId(characterId);
  ensureCharacter(id);
  ensureEnabled();
  const result = forceSleepNow(id, { until });
  if (!result.ok) {
    if (result.reason === 'not_found') throw fail('character not found', 'NOT_FOUND');
    if (result.reason === 'invalid until') throw fail('invalid argument', 'INVALID');
    // 'no_schedule'：她没有日程（被清空过 / 关闭了日程），没有"睡眠时段"这个概念可写
    throw fail('cannot sleep', 'CANNOT_SLEEP', { reason: result.reason });
  }
  return getSleepStatus(id);
}

/**
 * **立刻唤醒**（从睡眠里叫醒，不是解除催眠 —— 解除催眠走 `wake(id, { mode })`）。
 * 幂等：本来醒着也返回成功（只是不会有任何日程改动）。
 *
 * task-42：真的从"睡着"变成"醒着"的那一次，挂上 `wake_reaction`（"刚被唤醒"的一次性叙事）。
 * 判定用**调用前后**两个睡眠结论（前 = `isSleeping()`，含小憩；后 = `getSleepStatus().isSleeping`），
 * 只有 true → false 才挂 —— 幂等调用（本来就醒着）不挂，临时唤醒窗口内（本来就不算睡着）也不挂。
 * ⚠️ 这是「睡眠 ≠ 催眠」的唯一交叉点：只写 character_hypnosis 的 pending_directive，
 * **不碰睡眠列，也不碰 body_controlled / mind_awake / active_until**（不假装她被催眠过）。
 *
 * @returns {{characterId:number, isSleeping:boolean, sleepUntil:string|null, temporaryWakeUntil:string|null}}
 */
export function wakeFromSleep(characterId) {
  const id = requireId(characterId);
  ensureCharacter(id);
  ensureEnabled();
  // 唤醒前的睡眠结论：含小憩；临时唤醒窗口内 isSleeping() 直接给 false（那种情况本来就在醒着）
  const wasSleeping = Boolean(isSleeping(id).sleeping);
  const result = forceWakeNow(id);
  if (!result.ok) {
    if (result.reason === 'not_found') throw fail('character not found', 'NOT_FOUND');
    throw fail('cannot wake', 'CANNOT_WAKE', { reason: result.reason });
  }
  const status = getSleepStatus(id);
  if (wasSleeping && !status.isSleeping) attachWakeReaction(id);
  return status;
}

/**
 * 催眠指令触发一轮**之前**先临时唤醒她。
 *
 * 为什么要做：`forceProactiveNow(id, { bypassGuards: true })` 虽然绕过了 `is_sleeping` 闸门，
 * 但日程上下文仍然是「你正在睡觉。不要回复任何消息，直到自然醒来。」—— 与"这一轮必须演完高潮"
 * 的硬指令直接打架（真机表现：她回一句"别吵我"就完了）。临时唤醒后日程上下文换成
 * 「被催眠指令从睡眠里拉出来——身体醒了、意识由对方压着」（见 scheduleManager 的 wakeMsgs.hypnosis）。
 *
 * 只在**她真的在睡**时才唤醒；本来就醒着就不动她（否则白占一个 5~15 分钟窗口，
 * 还会把后续消息的日程上下文一直换成"刚被叫醒"）。
 * @returns {{woken:boolean, minutes:number, reason?:string}}
 */
export function wakeForForcedTrigger(characterId) {
  const id = toId(characterId);
  if (!id) return { woken: false, minutes: 0, reason: 'invalid_id' };
  try {
    if (isTempWoken(id)) return { woken: false, minutes: 0, reason: 'already_temp_woken' };
    if (!isSleeping(id).sleeping) return { woken: false, minutes: 0, reason: 'awake' };
    const result = tempWake(id, { mode: 'hypnosis', minutes: FORCED_TRIGGER_TEMP_WAKE_MINUTES, force: true });
    return { woken: Boolean(result.ok), minutes: result.minutes, reason: result.reason };
  } catch (err) {
    // 唤醒失败不能挡住指令本身（与其它副作用同口径：只 warn）
    console.warn('[hypnosis] 触发前临时唤醒失败:', err.message);
    return { woken: false, minutes: 0, reason: 'error' };
  }
}
