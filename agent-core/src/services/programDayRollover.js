/**
 * 程序日切换（世界翻篇）—— 让"调时"真的推动整个世界
 *
 * ## 为什么必须有这一层（2026-10-01，用户："角色感受到的时间很混乱 / 调时开关没什么作用"）
 *
 * `programTime.js` 自己写明了它的覆盖范围：**只影响世界钟**（日程/睡眠/时段/prompt 时间标签/
 * 日程日期键），而一堆「日常任务」还在看**真实日期**：
 *   · 日报 `getTodayNewspaper()` 用 `getLocalDateKey()`（真实日期）⇒ 时间推到明天，报纸还是今天的
 *   · 记忆整理按真实日期算"今天跑过了没有"
 *   · 前端展示的日期、报纸期号……
 * 于是用户把程序时间往前推一天：日程翻篇了、睡眠判定变了，但报纸/整理/世界状态都没动
 * ⇒ 观感就是"时间很混乱""调时没什么作用"。
 *
 * 本模块把「程序日期变了」做成一个**显式事件**，在事件里按顺序跑日常任务。
 * 触发点（三处，覆盖所有路径）：
 *   ① 手动调时（advance / set / period / reset）之后**立即**触发 —— 用户点了就该看到世界翻篇；
 *   ② `replyQueueScheduler` 每次 tick 检查 —— 覆盖"时间自然流过程序午夜"的情况；
 *   ③ 后端启动补一次 —— 覆盖"关机跨天"。
 *
 * ## 纪律
 * · **每个任务各自吞异常**：日报失败绝不能拦住记忆整理，反之亦然（旧日志里这类连带失败见过多次）。
 * · **幂等**：处理过的程序日期落库（`system_settings.program_day_last_processed`），同一天重复触发是空操作。
 * · **首次不误触发**：库是空的（第一次装/第一次升级）时只记录"今天的程序日期"，不补跑历史任务。
 * · **回拨同样算翻篇**：把时间调回过去也要触发（否则"回到昨天"看不到昨天的报纸）。
 * · 不在这里做时钟算术（那属于 programTime.js），本模块只做"事件 → 任务"的编排。
 */

import { getDb } from '../db/index.js';
import { getProgramDateKey } from './programTime.js';
import { broadcast } from './unifiedStreamBus.js';

/** system_settings 里的存储键（DB-only 运行时状态，不进 config 装载表） */
export const PROGRAM_DAY_KEY_SETTING = 'program_day_last_processed';

/** 与 getProgramState() 里"第几天"同口径，避免两处各算一遍 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readSetting(key) {
  try {
    const raw = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(key);
    return raw === undefined || raw === null ? null : String(raw);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    getDb().prepare(
      `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(key, String(value));
    return true;
  } catch {
    return false;
  }
}

/** 上一次已处理过的程序日期键；从未处理过返回 null */
export function getLastProcessedProgramDate() {
  const raw = readSetting(PROGRAM_DAY_KEY_SETTING);
  return DATE_RE.test(String(raw || '')) ? String(raw) : null;
}

/** 只给测试用 */
export function setLastProcessedProgramDate(dateKey) {
  return writeSetting(PROGRAM_DAY_KEY_SETTING, dateKey);
}

/**
 * 默认的日常任务清单（按执行顺序）。
 * 测试可以通过 `deps.jobs` 注入替身，避免真的去调 LLM / 生图。
 */
function defaultJobs() {
  return [
    {
      name: 'daily_newspaper',
      // 动态 import：newspaperService 会拉起 llm/生图依赖，放在模块顶层 import 会拖慢启动、
      // 也让"只想用 programTime"的调用方被迫加载一大堆东西（历史踩过循环依赖）。
      run: async () => {
        const mod = await import('./newspaperService.js');
        return mod.maybeGenerateDailyNewspaper();
      },
    },
    {
      name: 'memory_consolidation',
      run: async () => {
        const mod = await import('./memory/consolidationScheduler.js');
        // runConsolidationOnce 内部自带闸门（冷却/预算/空闲判定），这里只负责"把日子翻过去时敲一下门"
        return mod.runConsolidationOnce();
      },
    },
  ];
}

/**
 * 跑一次「世界翻篇」检查。
 *
 * @param {object} [opts]
 * @param {string} [opts.reason] 触发来源，仅用于日志与返回值
 * @param {boolean} [opts.force] 忽略"同一天已处理"直接跑任务（调试/手动补跑用）
 * @param {Array<{name:string, run:Function}>} [opts.jobs] 任务替身（测试用）
 * @param {string} [opts.today] 覆盖"当前程序日期"（测试用；默认取真实程序时钟）
 * @returns {Promise<{ran:boolean, reason:string, from:string|null, to:string, first:boolean, jobs:Array<{name:string, ok:boolean, error?:string}>}>}
 */
export async function runProgramDayRollover({ reason = 'tick', force = false, jobs, today } = {}) {
  const current = DATE_RE.test(String(today || '')) ? String(today) : getProgramDateKey();
  const last = getLastProcessedProgramDate();

  // 首次运行：只记录，不补跑历史任务（否则新装用户会被一堆"补作业"卡住）
  if (!last) {
    writeSetting(PROGRAM_DAY_KEY_SETTING, current);
    console.log(`[rollover] 初始化程序日期基准 = ${current}（首次不补跑历史任务）`);
    return { ran: false, reason, from: null, to: current, first: true, jobs: [] };
  }

  if (!force && last === current) {
    return { ran: false, reason, from: last, to: current, first: false, jobs: [] };
  }

  // ⚠️ 先落标记再跑任务：任务里若同步抛出/卡住，也不该让下一次 tick 把同一批任务再排一遍。
  //    （代价是"任务全失败"时当天不会自动重试——由各任务自己的重试/冷却机制兜底，见 newspaperService）
  writeSetting(PROGRAM_DAY_KEY_SETTING, current);
  console.log(`[rollover] 世界翻篇 ${last} → ${current}（来源：${reason}${force ? '，force' : ''}）`);
  // 通知前端"世界翻篇了"：日报页可以立刻去拉新一期，而不是等下一次轮询
  try { broadcast('program_day_rollover', { from: last, to: current, reason }); } catch { /* 广播失败不影响任务 */ }

  const list = Array.isArray(jobs) && jobs.length > 0 ? jobs : defaultJobs();
  const results = [];
  for (const job of list) {
    const name = String(job?.name || 'unnamed');
    try {
      const outcome = await job.run();
      // 2026-10-02 修：job 自己**不回抛**、而是返回 `{ ok: false }` 时要如实记失败。
      // 真机就是这么误导人的 —— 日志里写着 `[rollover] daily_newspaper ok`，
      // 而上一行刚报 `Daily generation failed: Connection error`，于是"调时后报纸没出来"查不出原因。
      if (outcome && typeof outcome === 'object' && outcome.ok === false) {
        const message = outcome.error || 'job 返回 ok:false';
        results.push({ name, ok: false, error: message });
        console.warn(`[rollover] ${name} 失败（已忽略，不影响其它任务）: ${message}`);
      } else {
        results.push({ name, ok: true });
        console.log(`[rollover] ${name} ok（${last} → ${current}）`);
      }
    } catch (err) {
      const message = err?.message || String(err);
      results.push({ name, ok: false, error: message });
      console.warn(`[rollover] ${name} 失败（已忽略，不影响其它任务）: ${message}`);
    }
  }
  return { ran: true, reason, from: last, to: current, first: false, jobs: results };
}
