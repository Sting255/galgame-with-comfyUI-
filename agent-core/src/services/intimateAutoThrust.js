/**
 * 「自动插入」的服务端 ticker（2026-10-02）
 *
 * 用户原话：「而且自动抽插并没有自动 只是点一下 后面就没有角色的反应和图了」
 *
 * 根因（当时）：服务端**没有定时器** —— `planIntimateAction` 只在"下一条动作进来时"按 `lastActionAt`
 * 补算几个 tick（`AUTO_MAX_CATCHUP_TICKS = 2`，见 intimateActionService.js 里 `planIntimateAction` 的 autoTicks 段），
 * 前端也只在**面板开着**时自己 tick 一次 thrust。于是用户点完「自动抽插」不动别的东西时，
 * 她**完全静止**、也不会有新的反应与配图。
 *
 * 本模块把它变成真的自动：每 `AUTO_THRUST_TICK_MS`（3 秒）扫一遍"正在自动抽插"的场次，
 * 到点的就用**同一条 HTTP 推进链**推一下 —— 这样状态推进 / 她的反应 / 配图 / 心情 / 广播
 * 全部照旧走那条链（不复制逻辑，避免两套口径）。
 *
 * 为什么用内部 HTTP 而不是直接调函数：推进链目前是 `routes/intimateActions.js` 里的
 * 一大段内联流程（门控 → 状态机 → 落库 → 调模型 → 写消息 → 配图）。抽成服务是一次大重构，
 * 而本轮的诉求是"让它动起来"。内部 HTTP 走的是**同一条已测试过的路径**，且天然带场景参数。
 * 后续若把那段流程抽成服务，这里换成一个函数调用即可（ticker 的其余部分不用动）。
 *
 * 场景（私聊 / 群聊）：路由每次处理动作时会调 `noteScene()` 登记一次，ticker 按登记发请求 ——
 * 群里开的自动抽插，她的反应就写回群里（不会跑私聊）。
 *
 * ⚠️ 2026-10-03 复查（代码审查发现，仍在）：登记原来**永不过期**，于是
 *   「在群里开自动插入，然后人回到私聊」之后 ticker 会**一直**往群里写 ——
 *   她的反应正文 + 配图出现在**错的会话**里（审查原文：the ticker keeps posting to the stale scene,
 *   so her reaction text + image appear in the wrong conversation）。
 *   现在两层兜底：① 玩家侧的任何一次动作**立刻覆盖**登记（私聊动作覆盖群登记，反之亦然）；
 *   ② 登记带 TTL（`SCENE_MEMO_TTL_MS`）且**只认玩家侧**的登记（ticker 自己的回声不算，否则它每一跳都给自己续命、
 *   TTL 永远不生效）；过期 ⇒ 这一跳只推状态、不再猜会话（见 `sceneFor` / `fireOne`）。
 */

import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { AUTO_THRUST_TICK_MS, intervalForAutoPace } from './intimateActionService.js';

/** characterId → { scene, groupId, at }（路由**玩家侧**登记；内存即可，重启/过期后不再乱猜会话） */
const sceneMemo = new Map();
/** 正在处理的角色（避免模型慢时同一角色堆积多个 tick） */
const inFlight = new Set();
/**
 * characterId → 上一次"真的让她说了一句"的时刻（毫秒）。
 *
 * ⚠️ 2026-10-03 复查发现的额度洞：ticker 以前**每一跳都走完整链路**（含一次 LLM 调用）——
 * 冲刺档 1.5 秒一跳 ⇒ **每分钟 40 次模型调用**，正常档也有 20 次/分钟。用户开一小时自动，
 * 就是上千次调用（前端面板自己那套节拍刻意设成 20 秒一次，注释里写得明明白白"别白烧额度"，
 * 服务端 ticker 却把这个口径漏了）。现在拆成两种跳：
 *   · **状态跳**（每一跳，`silent: true`）：只推进累积 / 广播状态，**不调模型**；
 *   · **反应跳**（每 `AUTO_REACTION_INTERVAL_MS` 至多一次）：走完整链路，她才说话、才配图。
 * 内存里记即可（重启后最多多让她说一句，无所谓）。
 *
 * ⚠️ 2026-10-03 复查（同一天的第二个洞）：这个时间戳**不能只有 ticker 自己写**。
 * 面板（`IntimateActionPanel.vue`）开着时也有一拍（原来也是 20 秒）的"补一下"，那一拍走的是同一条 HTTP 路由，
 * 但它以前完全不进这个闸门 ⇒ **两条各走各的节拍叠在一起**，她每 ~10 秒就出一轮完整反应
 * （每次都是一次 LLM 调用，额度直接翻倍）。现在路由在她的完整反应真的出来之后调 `noteReaction()`，
 * 两边**共用同一个闸门**；面板的周期（15 秒，见那里的注释）严格短于本闸门 ⇒ 面板开着时
 * 服务端每一跳都退化成状态跳（silent），她说话的节拍只剩一条。
 */
const lastReactionAt = new Map();

/** 自动插入时，"她真的出一次反应"的最小间隔（毫秒）—— 与前端面板的节拍同量级（面板必须**短于**它） */
export const AUTO_REACTION_INTERVAL_MS = 20000;

/**
 * 场景登记的有效期（10 分钟）：只由**玩家侧**的动作续期（面板那一拍也算 —— 面板就开在那个会话里）。
 * 过期 ⇒ 不再拿它当"她在哪儿"的依据（见 sceneFor）：宁可这一跳她不出声，也不把反应写进猜出来的会话。
 * 注意副作用（有意为之）：面板关掉、玩家又十分钟没动作时，ticker 会安静下来（只推进状态）——
 * 等玩家下一次动作重新登记即可；这比"把她的反应和配图写进错的聊天"划算得多。
 */
export const SCENE_MEMO_TTL_MS = 10 * 60 * 1000;

let timer = null;
let running = false;

/**
 * 路由在每次动作请求里登记一次场景（私聊也登记 ⇒ **立刻覆盖**上一次的群登记，反之亦然）。
 *
 * @param {number|string} characterId
 * @param {{scene?:'chat'|'group', groupId?:number|string|null, internal?:boolean, now?:number}} [opts]
 *   `internal`：这一条请求是 **ticker 自己发出去的推进**（回声）⇒ 不登记、不续期。
 *   少这一条判断的话，ticker 的每一跳都会把自己的场景登记刷新一遍（因为它走的就是这条路由），
 *   `SCENE_MEMO_TTL_MS` 永远不生效 —— 玩家切回私聊后她的反应会一直留在群里。
 *   `now`：测试用显式时钟（别让用例依赖真实时间，也别让假时间戳和真实 now 混着比）。
 */
export function noteScene(characterId, { scene = 'chat', groupId = null, internal = false, now = Date.now() } = {}) {
  const id = Number(characterId);
  if (!Number.isFinite(id) || id <= 0) return;
  if (internal) return;   // 回声不登记（见上面 internal 的说明）
  sceneMemo.set(id, { scene: scene === 'group' ? 'group' : 'chat', groupId: groupId ?? null, at: now });
}

/**
 * 这一跳该写到哪个会话 —— **只有还活着的登记**才算数。
 * @returns {{scene:'chat'|'group', groupId:number|null}|null} null ＝ 不知道她在哪儿（从没登记 / 重启 / 过期）
 */
export function sceneFor(characterId, { now = Date.now() } = {}) {
  const id = Number(characterId);
  const memo = sceneMemo.get(id);
  if (!memo) return null;
  if (now - Number(memo.at) > SCENE_MEMO_TTL_MS) { sceneMemo.delete(id); return null; }
  return { scene: memo.scene, groupId: memo.groupId };
}

/**
 * 记一次"这个角色刚出了一轮**完整反应**"（含一次 LLM 调用）—— 面板那一拍 / 玩家点的那一下都算。
 * 调用点：`routes/intimateActions.js` 的成功分支（模型真的写出了反应之后）。
 */
export function noteReaction(characterId, { at = Date.now() } = {}) {
  const id = Number(characterId);
  if (!Number.isFinite(id) || id <= 0) return;
  lastReactionAt.set(id, Number(at) || Date.now());
}

/** 反应闸门：距她上一次完整反应是否已满 `intervalMs`（纯读；ticker 与测试共用同一个口径） */
export function reactionDue(characterId, { now = Date.now(), intervalMs = AUTO_REACTION_INTERVAL_MS } = {}) {
  const last = Number(lastReactionAt.get(Number(characterId))) || 0;
  return now - last >= intervalMs;
}

/** 测试与关停用：清空登记与在飞标记 */
export function resetAutoThrustState() {
  sceneMemo.clear();
  inFlight.clear();
  lastReactionAt.clear();
}

/** 本机后端端口（内部 HTTP 用；与 app.js 监听同一个） */
function localPort() {
  return Number(process.env.PORT || config.port || 3099);
}

/**
 * 查一次"正在自动抽插且插入中"的场次（纯 SQL，方便测试）。
 * @returns {Array<{characterId:number, pace:number, autoPace:number, lastActionAt:string|null}>}
 */
export function listAutoThrustScenes(db = getDb()) {
  try {
    const rows = db.prepare(
      `SELECT character_id AS characterId, pace, auto_pace AS autoPace, last_action_at AS lastActionAt
         FROM character_intimate_scene
        WHERE auto_thrust = 1 AND active = 1 AND penetrating = 1`
    ).all() || [];
    return rows.map(r => ({
      characterId: Number(r.characterId),
      pace: Number(r.pace) || 2,
      // 老行没有 auto_pace 列时 `r.autoPace` 是 undefined ⇒ 回落手动节奏档（= 迁移前的旧行为）
      autoPace: Number(r.autoPace) || Number(r.pace) || 2,
      lastActionAt: r.lastActionAt ?? null,
    }));
  } catch (err) {
    // 表还没建（全新库 / 迁移未跑）时不要每 3 秒刷一条错误日志
    if (!/no such table/.test(String(err?.message || ''))) {
      console.warn('[intimateAutoThrust] 查询失败（本轮跳过）:', err?.message || err);
    }
    return [];
  }
}

/**
 * 自动插入的频率跟着**自动速度**走（2026-10-03 用户：「自动的速度新增一个单独的」）。
 *
 * ⚠️ 语义（用户 2026-10-03 澄清）：「**自动的意思是自动插入 不是自己动**」—— 这一档是**他**在动。
 * ⚠️ 2026-10-02 ~ 10-03 期间这里用的是**手动节奏档** `pace` —— 于是"想把自动插送调快一点"
 * 只能连手动节奏一起改（两个旋钮互相污染）。现在拆开：
 *   · 手动节奏档 `pace`：他手点时顶得多快、那一下涨多少；
 *   · 自动速度 `autoPace`：**他自动插送的频率与每下涨多少**（面板上单独一排页签）。
 * 表格只有一份，在 `intimateActionService.AUTO_PACE_INTERVALS`（1 缓 5.0s · 2 正常 3.0s ·
 * 3 快 2.0s · 4 冲刺 1.5s）。`intervalForPace` 这个旧名字保留导出（既有测试与调用点还在用它）。
 */
export function intervalForPace(pace) {
  return intervalForAutoPace(pace);
}

/**
 * 这条场次现在该不该推一下（与 planIntimateAction 的补算口径一致：按 lastActionAt 距今算 tick，
 * tick 长度由节奏档决定 —— 见 intervalForPace）。
 */
export function isTickDue(lastActionAt, { now = Date.now(), tickMs = AUTO_THRUST_TICK_MS } = {}) {
  if (!lastActionAt) return true;
  const ms = Date.parse(String(lastActionAt).replace(' ', 'T') + (String(lastActionAt).includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(ms)) return true;
  return now - ms >= tickMs;
}

/**
 * 推一下某个角色的自动抽插（内部 HTTP；场景由**还活着的登记**决定 —— 没有就只推状态，见 sceneFor）。
 * 失败只 warn：她这一下没动，下个 tick 会再来（绝不影响别的场次）。
 */
async function fireOne(scene, { now = Date.now() } = {}) {
  const id = scene.characterId;
  if (inFlight.has(id)) return false;
  // 频率由**自动速度**决定（面板上那一排「自动速度」页签；手动节奏档不参与）
  if (!isTickDue(scene.lastActionAt, { now, tickMs: intervalForAutoPace(scene.autoPace) })) return false;
  inFlight.add(id);
  try {
    // 场景登记：过期 / 从没登记 / 重启后的第一跳 ⇒ null（不知道她在哪儿）
    const memo = sceneFor(id, { now });
    // 这一跳要不要"真的让她反应"（含 LLM 调用）：每 AUTO_REACTION_INTERVAL_MS 至多一次，
    // 其余的只是状态跳（silent）—— 见 lastReactionAt 的注释（额度洞）。
    // ⚠️ 闸门是**两边共用**的：面板那一拍 / 玩家点的那一下也会写（路由里的 noteReaction）
    //   ⇒ 面板开着时（它的周期严格短于本闸门）这里恒为 false，她说话的节拍只剩面板那一条，不再翻倍。
    // ⚠️ 没有活的场景登记 ⇒ 只能状态跳：**宁可这一跳她不出声**，也不把反应正文和配图写进猜出来的会话
    //   （用户报过的"她的反应跑到错的聊天里"就是这么来的，见 SCENE_MEMO_TTL_MS）。
    const wantReaction = memo != null && reactionDue(id, { now });
    // `auto: true` 让状态机知道"这一下是他自动插送的" ⇒ 增益走 autoTickGain(autoPace)，
    // 演出文案也换成"他在自动插送"（见 planIntimateAction / describeActionBeat）
    const body = {
      auto: true,
      ...(wantReaction ? {} : { silent: true }),
      ...(memo?.scene === 'group' && memo.groupId ? { scene: 'group', groupId: memo.groupId } : {}),
      // 告诉路由"这一条是 ticker 自己发的推进"（回声）⇒ 路由不拿它续期场景登记（见 noteScene 的 internal）
      internal: true,
    };
    const res = await fetch(`http://127.0.0.1:${localPort()}/api/intimate-actions/${id}/thrust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      // ⚠️ 2026-10-03 复查：额度**只在这一跳真的成功之后**才记（原来在 fetch 之前就记了时间戳 ⇒
      //   一次网络抖动/500 会白白封掉她 20 秒的话）。
      if (wantReaction) noteReaction(id, { at: now });
      return true;
    }
    console.warn(`[intimateAutoThrust] 角色 ${id} 自动推进返回 ${res.status}（下个 tick 再试）`);
    return false;
  } catch (err) {
    console.warn(`[intimateAutoThrust] 角色 ${id} 自动推进失败（下个 tick 再试）:`, err?.message || err);
    return false;
  } finally {
    inFlight.delete(id);
  }
}

/** 一个 tick（导出以便测试直接调一次，不用等定时器） */
export async function runAutoThrustTick({ db = getDb(), now = Date.now() } = {}) {
  const scenes = listAutoThrustScenes(db);
  if (scenes.length === 0) return { checked: 0, fired: 0 };
  let fired = 0;
  for (const scene of scenes) {
    // eslint-disable-next-line no-await-in-loop —— 有意串行：她的动作要按顺序发生，别并发撞状态
    if (await fireOne(scene, { now })) fired += 1;
  }
  return { checked: scenes.length, fired };
}

/** 起定时器（app.js 调；重复调用是幂等的） */
export function startIntimateAutoThrust({ intervalMs = 1000 } = {}) {
  if (running) return false;
  running = true;
  timer = setInterval(() => {
    runAutoThrustTick().catch(err => console.warn('[intimateAutoThrust] tick 异常（继续）:', err?.message || err));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();   // 别拖住进程退出
  console.log(`[intimateAutoThrust] started (interval ${intervalMs}ms；每场次按**自动速度** ${[0, 5000, 3000, 2000, 1500].slice(1).join('/')}ms 判定)`);
  return true;
}

/** 停定时器（测试 / 关停用） */
export function stopIntimateAutoThrust() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

/** 是否在跑（测试断言用） */
export function isIntimateAutoThrustRunning() {
  return running;
}
