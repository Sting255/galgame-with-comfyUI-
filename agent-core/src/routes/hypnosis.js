/**
 * 催眠手机 HTTP 接口
 *
 * 挂载点：
 *   - `/api/characters`（`/:id/hypnosis*`）——刻意早于 intimate 家族与 charactersRoutes 挂载，
 *     理由同 emoji/intimate：避免 characters 的 `/:id` 通配先吃掉带子路径的请求
 *   - `/api/hypnosis`（`/phone/grant`）——背包装手机与角色无关，单独挂一条
 *
 * 错误映射（与 task-28 契约一致）：
 *   400 非法 id / 非法参数
 *   403 门控未达标 `{ error: 'hypnosis gate not met', reason }`
 *   404 角色不存在 / 遗忘窗口不存在
 *   409 未处于催眠中 / 总开关关闭 / 没有可遗忘的催眠会话
 */

import { Router } from 'express';
// 2026-10-02 发情模式（用户：催眠手机里加一个选项，角色敏感度直接拉满）
import { getSensitivity, getHeatUntil, setHeatMode } from '../services/sensitivityService.js';
import { config } from '../config.js';
import {
  getHypnosisState,
  hypnotize,
  wake,
  issueCommand,
  forgetWindow,
  listForgottenWindows,
  restoreForgottenWindow,
  grantHypnosisPhone,
  sleepNow,
  wakeFromSleep,
  wakeForForcedTrigger,
} from '../services/hypnosisService.js';
import { forceProactiveNow } from '../services/proactiveChatScheduler.js';

const router = Router();
/** 与角色无关的接口（背包装手机） */
export const phoneRouter = Router();

function parseCharacterId(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function handle(res, err) {
  const code = err?.code;
  const message = err?.message || 'unknown error';
  if (code === 'INVALID' || message === 'invalid character id' || message === 'invalid argument') {
    return res.status(400).json({ error: message });
  }
  // force_toy 指令专用：玩具总开关关着时整条指令不可用（与玩具路由的 403 口径一致）
  if (code === 'TOYS_DISABLED') {
    return res.status(403).json({ error: 'toys feature disabled', features: { toys: config.features.toys } });
  }
  if (code === 'NOT_FOUND' || message === 'character not found') {
    return res.status(404).json({ error: message });
  }
  if (code === 'GATE') {
    return res.status(403).json({ error: 'hypnosis gate not met', code: err.gateCode || '', reason: err.reason || '' });
  }
  if (code === 'NOT_HYPNOTIZED') {
    return res.status(409).json({ error: 'not hypnotized' });
  }
  if (code === 'NO_SESSION') {
    return res.status(409).json({ error: 'no hypnosis session' });
  }
  if (code === 'DISABLED') {
    return res.status(409).json({ error: 'hypnosis feature disabled', features: { hypnosis: config.features.hypnosis } });
  }
  if (code === 'CANNOT_SLEEP') {
    return res.status(409).json({ error: 'cannot sleep', reason: err.reason || '' });
  }
  if (code === 'CANNOT_WAKE') {
    return res.status(409).json({ error: 'cannot wake', reason: err.reason || '' });
  }
  console.error('[hypnosis] route error:', message);
  return res.status(500).json({ error: message });
}

// GET /api/characters/:id/hypnosis — 面板状态（读不拦总开关）
router.get('/:id/hypnosis', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(getHypnosisState(id));
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/hypnosis/hypnotize — 自定义时长（分钟，clamp 1~720）
// ── 发情模式（2026-10-02 用户：「然后再在催眠手机里加一个选项 叫发情模式 角色的敏感度就会直接拉满」）──
// 挂在催眠手机下（它是"控制她身体"的总入口）。开 ⇒ 敏感度直接 100；关 ⇒ 回落到常态上沿（≤55）。
// ⚠️ GET 与 POST 必须返回**同一个形状**：面板拿同一段代码渲染（曾经 GET 给 `tier` 字符串、
//    POST 给 `tier` 对象 ⇒ 前端读 `.label` 读到 undefined，是"假绿"高发区）。
function heatPayload(id) {
  const st = getSensitivity(id);
  return {
    characterId: id,
    heat: st.heat === true,
    value: Number(st.value) || 0,
    tier: st.tier.key,
    tierLabel: st.tier.label,
    multiplier: st.multiplier,
  };
}

router.get('/:id/heat', (req, res) => {
  try {
    const id = Number(req.params.id);
    res.json({ ...heatPayload(id), until: getHeatUntil(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/heat', (req, res) => {
  try {
    const id = Number(req.params.id);
    // ⚠️ 2026-10-03 复查：这两行原来都太宽松 ——
    //   · `on` 只在"明确给了 false/0/'false'"时才是关 ⇒ 传 `'0'`、`''`、`null` 都会被当成**开**
    //     （把她的敏感度直接拉满）；现在只认明确的真值（true / 1 / '1' / 'true' / 'on'）。
    //   · `minutes` 原样透传 ⇒ 前端/脚本传 9999999 就是**发情 19 年**（到点回落形同虚设）；
    //     现在与催眠那边的口径一致，夹到 1~720 分钟（最长 12 小时）。
    const rawOn = req.body?.on;
    const on = rawOn === true || rawOn === 1 || rawOn === '1' || rawOn === 'true' || rawOn === 'on';
    const wanted = Number(req.body?.minutes);
    const minutes = Number.isFinite(wanted) && wanted > 0 ? Math.min(720, Math.max(1, Math.round(wanted))) : undefined;
    const out = setHeatMode(id, on, minutes ? { minutes } : {});
    if (!out) return res.status(404).json({ error: '没有这个角色' });
    console.log(`[heat] ${id} 发情模式 ⇒ ${on ? `开（敏感度拉满${minutes ? `，${minutes} 分钟` : ''}）` : '关（回落到 ' + out.value + '）'}`);
    res.json({ ...heatPayload(id), until: out.until || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/hypnosis/hypnotize', (req, res) => {  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(hypnotize(id, { minutes: req.body?.minutes }));
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/hypnosis/wake — **一个路径两种语义**（按 body 里有没有 mode 分流）：
//   · 带 `mode: 'full' | 'mind'` → 既有「催眠唤醒」（解除控制 / 只唤醒意志），返回催眠状态
//   · 不带 mode（前端睡眠控制区就是这么调的）→ **睡眠唤醒**「把她从睡眠里叫醒」，
//     返回冻结的睡眠形状 `{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }`
// 两种语义共用路径是交付契约（前端 `sleepCharacter` / `wakeFromSleepCharacter` 不带 mode）；
// 之所以不新开路径：`/wake` 早就是催眠唤醒的既有路径，改名会破坏已发布的接口。
router.post('/:id/hypnosis/wake', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  const rawMode = req.body?.mode;
  const sleepControl = rawMode === undefined || rawMode === null || rawMode === '';
  try {
    if (sleepControl) return res.json(wakeFromSleep(id));
    return res.json(wake(id, { mode: rawMode }));
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/hypnosis/sleep — 睡眠控制：立刻入睡
// body `{ until?: 'HH:mm' | 'YYYY-MM-DD HH:mm[:ss]' | ISO }`，不传 = 按日程默认（当日主睡眠时长）
// 返回统一形状 `{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }`
router.post('/:id/hypnosis/sleep', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(sleepNow(id, { until: req.body?.until }));
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/hypnosis/command — 一次性指令（body_control / forced_climax / force_toy）
//   body `{ kind, toyKey?, intensity? }`；toyKey/intensity 仅 force_toy 使用。
//   force_toy（2026-10-01 新增，用户原话「催眠状态也不能强制让角色用上玩具」）：
//   服务端**当场真的把玩具戴上**（issueCommand 内部走 equipToy，不是只写一句台词），
//   再写一次性指令让当轮演出"被强制"的状态；并且像 forced_climax 一样点完立刻替她触发一轮，
//   让用户马上看到她戴着它的反应与配图（否则要等他再发一条消息，那条消息还会把指令盖过去）。
router.post('/:id/hypnosis/command', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const kind = req.body?.kind;
    const result = issueCommand(id, kind, { toyKey: req.body?.toyKey, intensity: req.body?.intensity, mode: req.body?.mode, curve: req.body?.curve });
    if (kind === 'force_toy') {
      forceProactiveNow(id, { bypassGuards: true })
        .then(r => {
          if (r && r.ok === false) console.warn('[hypnosis] force_toy 触发一轮未成功:', r.reason || r.error || '');
        })
        .catch(err => console.warn('[hypnosis] force_toy 触发一轮失败:', err?.message || err));
      return res.json({ ...result, triggered: true });
    }
    if (kind === 'forced_climax') {
      // 强制高潮是一次性指令，挂在"下一轮"的 prompt 上。真机反馈：用户点完按钮什么都不发生，
      // 直到他自己再发一条消息 —— 而那条消息（如「想你了」）会把指令盖过去，看着就像"没用"。
      // 所以这里立刻替她触发一轮（复用主动聊天那套链路），点完马上能看到反应与配图。
      //
      // 触发前先临时唤醒她（用户：「睡觉怎么就不能直接触发了 催眠手机是全覆盖的」）：
      // bypassGuards 只绕过 `is_sleeping` 闸门，绕不过 prompt 里那句「你正在睡觉。不要回复任何消息」
      // —— 那会和"这一轮必须演完高潮"硬碰硬。临时唤醒走日程链路（库 + 定时器 + 广播一起动），
      // 到期后 revertTempWake 会按日程把她放回睡眠。
      const wakeInfo = wakeForForcedTrigger(id);
      if (wakeInfo.woken) console.log(`[hypnosis] forced_climax: 先临时唤醒 ${id}（${wakeInfo.minutes} 分钟）再触发`);
      // forcedClimax: 这一轮要走「催眠高潮轮」——注入状态块 + 一次性指令块（含睡梦唤醒文案）
      // 并强制配图；否则点完只会得到一句普通主动闲聊（真机反复反馈过）。
      forceProactiveNow(id, { bypassGuards: true, forcedClimax: true })
        .then(r => {
          if (r && r.ok === false) console.warn('[hypnosis] forced_climax 触发一轮未成功:', r.reason || r.error || '');
        })
        .catch(err => console.warn('[hypnosis] forced_climax 触发一轮失败:', err?.message || err));
      return res.json({ ...result, triggered: true, preWake: wakeInfo });
    }
    return res.json(result);
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/hypnosis/forget — 遗忘 [started_at, now] 并结束控制
router.post('/:id/hypnosis/forget', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(forgetWindow(id, { toRawId: req.body?.toRawId }));
  } catch (err) {
    handle(res, err);
  }
});

// GET /api/characters/:id/hypnosis/forgotten — 遗忘窗口（默认只看 active）
router.get('/:id/hypnosis/forgotten', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const status = req.query?.status === undefined ? 'active' : String(req.query.status);
    res.json({ windows: listForgottenWindows(id, { status }) });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/hypnosis/forgotten/:wid/restore — 撤销遗忘（按 memory_ids 精确还原）
router.post('/:id/hypnosis/forgotten/:wid/restore', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const windowId = Number.parseInt(req.params.wid, 10);
    if (!Number.isSafeInteger(windowId) || windowId <= 0) {
      return res.status(400).json({ error: 'invalid window id' });
    }
    // 归属校验在服务层内部、任何副作用之前完成：不属于该角色的窗口直接 NOT_FOUND，
    // 不存在"先恢复再回 404"的越权写入。
    res.json(restoreForgottenWindow(windowId, { characterId: id }));
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/hypnosis/phone/grant — 背包直接领取催眠手机（幂等）
phoneRouter.post('/phone/grant', (req, res) => {
  try {
    res.json(grantHypnosisPhone());
  } catch (err) {
    handle(res, err);
  }
});

export default router;
