import { Router } from 'express';
import {
  getTodayNewspaperForFrontend,
  maybeGenerateDailyNewspaper,
  setWorldStateDismissed,
  listNewspaperEditions,
  getNewspaperByDate,
} from '../services/newspaperService.js';

const router = Router();

// GET /api/newspaper/today — 今天的《邻舍日报》（没有则 { newspaper: null }）
router.get('/today', (req, res) => {
  res.json({ newspaper: getTodayNewspaperForFrontend() });
});

// GET /api/newspaper/editions — 历史期简目（最新在前，供期号导航）
router.get('/editions', (req, res) => {
  res.json({ editions: listNewspaperEditions() });
});

// GET /api/newspaper/by-date/:date — 按日期回看某一期（YYYY-MM-DD）
router.get('/by-date/:date', (req, res) => {
  res.json({ newspaper: getNewspaperByDate(req.params.date) });
});

// POST /api/newspaper/generate — 手动补发/补图今天的报纸（已存在则返回现有内容 + 顺带补图）
router.post('/generate', async (req, res) => {
  const existing = getTodayNewspaperForFrontend();
  if (existing) {
    // 2026-10-04 用户实测：「日报的图加载不出来」，点「手动补发」也没反应。
    // 原因就是这里**直接 return** —— 报纸已在、只是配图缺失（出图当时 ComfyUI 没开）时，
    // 手动入口等于不存在，用户没有任何补救手段。
    // 现在照样把补图那一趟踢起来：`maybeGenerateDailyNewspaper` 对"今天已有报纸"走的分支
    // 正是 `maybeRefillTodayImages`（服务里那行注释也写着"当天报纸已出：只剩补图一条路"）。
    const task = maybeGenerateDailyNewspaper();
    res.json({ newspaper: existing, started: false, refill: Boolean(task) });
    return;
  }
  const task = maybeGenerateDailyNewspaper();
  if (!task) {
    res.status(409).json({ error: '当前不满足生成条件（清晨时段外 / 刚失败冷却中 / 已在生成）' });
    return;
  }
  res.json({ started: true });
});

// POST /api/newspaper/dismiss-world — 消除/恢复今天的世界影响
// body 可选 { dismissed: boolean }：true=消除（当天不再注入），false=恢复；省略则按当前状态切换
router.post('/dismiss-world', (req, res) => {
  const paper = getTodayNewspaperForFrontend();
  if (!paper?.world_state) {
    res.json({ ok: false, error: '今天的报纸没有世界影响', newspaper: paper });
    return;
  }
  const target = typeof req.body?.dismissed === 'boolean'
    ? req.body.dismissed
    : !paper.world_dismissed;
  setWorldStateDismissed(target);
  res.json({ ok: true, dismissed: target, newspaper: getTodayNewspaperForFrontend() });
});

export default router;
