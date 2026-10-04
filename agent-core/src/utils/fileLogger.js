/**
 * 后端文件日志（把 console 输出同时落盘，按天切分）
 *
 * 为什么需要它：启动器（`邻舍.EXE.exe`，PySide6）只是把后端子进程的 stdout
 * `readyReadStandardOutput → _on_stdout` 灌进界面上的「日志」控件，**不落盘**
 * （全包内没有任何 *.log 文件，启动器代码里也没有写日志文件的逻辑）。
 * 于是"把日志发给别人看"只能靠界面里右键「复制全部」或截图——排查一次就要一次人工搬运。
 *
 * 口径（刻意保持简单，不做日志框架）：
 *   - 只**镜像** `console.log / info / warn / error`：原输出照旧打给启动器（界面日志页不变），
 *     同一份内容再写一份到 `<仓库根>/logs/<prefix>-YYYY-MM-DD.log`；不接管、不重定向、不丢原始输出。
 *   - 按**本地日期**切分文件，写入当天那个；跨天时自动换文件。
 *   - 启动时按 `keepDays`（默认 14 天）清理旧的 `<prefix>-*.log`。
 *   - 任何失败都只 warn 一次，绝不影响主流程（与项目里"旁路功能不拖垮主链路"的一贯口径一致）。
 *
 * 环境变量：
 *   - `LOG_TO_FILE=false`（或 `0`/`off`）→ 完全不落盘（测试/CI 用）
 *   - `LOG_DIR=<绝对路径>` → 换目录（测试用临时目录）
 *   - `LOG_KEEP_DAYS=<n>` → 保留天数
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 默认日志目录：仓库根的 logs/（agent-core/src/utils → 上三级） */
const DEFAULT_DIR = path.resolve(HERE, '..', '..', '..', 'logs');
const DEFAULT_PREFIX = 'backend';
const DEFAULT_KEEP_DAYS = 14;
const LEVELS = ['log', 'info', 'warn', 'error'];
/** 级别高低（越大越重要）：`LOG_LEVEL=warn` ⇒ 只把 warn/error 写盘，终端照旧全打 */
const LEVEL_ORDER = { log: 0, info: 1, warn: 2, error: 3 };
/** 单文件上限与单日份数（2026-10-02 优化）：一天写爆就滚成 .1/.2，最多留 3 份 */
const DEFAULT_MAX_SIZE_MB = 20;
const DEFAULT_MAX_FILES = 3;

/** 进程内单例：重复 init 返回同一个句柄（避免把 console 套两层） */
let handle = null;

/** `YYYY-MM-DD`（本地日期；日志是给人看的，跟用户看到的时间一致更重要） */
export function dayStamp(ms = Date.now()) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 该日期对应的日志文件名 */
export function logFileName(prefix, day) {
  return `${prefix}-${day}.log`;
}

const truthy = value => !['0', 'false', 'off', 'no', ''].includes(String(value ?? '').trim().toLowerCase());

/**
 * 清理超过 keepDays 的 `<prefix>-*.log`。
 * @returns {string[]} 被删掉的文件名
 */
export function pruneOldLogs(dir, prefix, keepDays, now = Date.now()) {
  const removed = [];
  if (!Number.isFinite(keepDays) || keepDays <= 0) return removed;
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(`${prefix}-`) || !name.endsWith('.log')) continue;
    const day = name.slice(prefix.length + 1, -4);
    const ms = Date.parse(`${day}T00:00:00`);
    if (!Number.isFinite(ms) || ms >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch { /* 删不掉就留着，不影响主流程 */ }
  }
  return removed;
}

/**
 * 开始镜像 console 到文件。
 *
 * @param {object} [options]
 * @param {string} [options.dir] 日志目录（默认仓库根 logs/）
 * @param {string} [options.prefix] 文件名前缀（默认 backend）
 * @param {number} [options.keepDays] 保留天数（默认 14）
 * @param {number} [options.maxSizeMb] 单个日志文件上限（默认 20 MB，0/负数=不限制）
 * @param {number} [options.maxFiles] 单日最多保留几份（默认 3：`.log` + `.1` + `.2`，超出的滚掉）
 * @param {string} [options.minLevel] 写盘的最低级别（默认 log=全写；急用时 `LOG_LEVEL=warn` 只看重点）
 * @param {boolean} [options.enabled] false 时只返回 null（也读 `LOG_TO_FILE`）
 * @param {() => number} [options.now] 供测试注入时钟
 * @returns {{dir:string,file:string,flush:()=>Promise<void>,close:()=>Promise<void>}|null}
 */
export function initFileLogging({
  dir = process.env.LOG_DIR || DEFAULT_DIR,
  prefix = DEFAULT_PREFIX,
  keepDays = Number.parseInt(process.env.LOG_KEEP_DAYS ?? '', 10) || DEFAULT_KEEP_DAYS,
  // 2026-10-02 优化（用户：「继续优化」）：原来只按天清理，**单日文件没有上限** ——
  // 玩一天能写出 10 MB+（prompt 转储占大头），既不好 grep 也怕哪天写爆磁盘。
  maxSizeMb = Number.parseFloat(process.env.LOG_MAX_MB ?? '') || DEFAULT_MAX_SIZE_MB,
  maxFiles = Number.parseInt(process.env.LOG_MAX_FILES ?? '', 10) || DEFAULT_MAX_FILES,
  minLevel = String(process.env.LOG_LEVEL ?? '').trim().toLowerCase() || 'log',
  enabled = process.env.LOG_TO_FILE === undefined ? true : truthy(process.env.LOG_TO_FILE),
  now = () => Date.now(),
} = {}) {
  if (!enabled) return null;
  if (handle) return handle;

  const targetDir = path.resolve(dir);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    console.warn(`[log] 日志目录不可用（${targetDir}）：${err.message}`);
    return null;
  }

  const maxSizeBytes = maxSizeMb > 0 ? Math.round(maxSizeMb * 1024 * 1024) : 0;
  const keepFiles = Math.max(1, Math.trunc(maxFiles));
  const levelFloor = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.log;

  let stream = null;
  let currentDay = '';
  let currentFile = '';
  let failed = false;
  let writtenBytes = 0;
  let currentIndex = 0;

  /** 第 idx 份的文件名：idx=0 是 `backend-<day>.log`，往上是 `…​.1.log` / `…​.2.log` */
  const fileNameFor = (day, idx) => {
    const base = logFileName(prefix, day);
    return idx === 0 ? base : `${base.slice(0, -'.log'.length)}.${idx}.log`;
  };

  const openFor = (day, idx = 0, { reuse = false } = {}) => {
    // 跨天 ⇒ 份数重新从 0 开始
    if (day !== currentDay) { currentIndex = 0; idx = 0; }
    const file = path.join(targetDir, fileNameFor(day, idx));
    if (stream && currentFile === file) return;
    if (stream) stream.end();
    // reuse：这个名字以前可能用过（循环复用到最老那份）⇒ 必须截断，否则会把旧内容续在后面
    stream = fs.createWriteStream(file, { flags: reuse ? 'w' : 'a' });
    stream.on('error', err => {
      if (failed) return;
      failed = true;
      console.warn(`[log] 写日志文件失败，已停止落盘：${err.message}`);
    });
    currentDay = day;
    currentFile = file;
    currentIndex = idx;
    writtenBytes = 0;   // 新文件重新计数（跨天、或轮转后的新文件都走这里）
  };

  /**
   * 超过上限就换一份继续写：`.log` → `.1.log` → `.2.log` → 回到 `.log`（**循环复用**，份数恒为 keepFiles）。
   *
   * ⚠️ 这里刻意**既不改名也不删除** —— 旧文件刚写完，句柄可能还没真正关掉，Windows 上 rename/unlink
   * 都会 EBUSY/EPERM：改名版的表现是"看着滚了、其实一直写同一个文件"，删除版的表现是"份数越滚越多"。
   * 两个坑都被这条单测抓到过。循环复用则完全不动别人的文件，最老那份被截断重写 = 等价于删掉它。
   */
  const rollIfNeeded = () => {
    if (!maxSizeBytes || writtenBytes < maxSizeBytes || !currentDay) return false;
    const wrapped = currentIndex + 1 >= keepFiles;
    const next = wrapped ? 0 : currentIndex + 1;
    try {
      openFor(currentDay, next, { reuse: true });
      return true;
    } catch (err) {
      console.warn(`[log] 日志轮转失败（继续写当前文件）：${err.message}`);
      return false;
    }
  };

  const write = (level, args) => {
    if (failed) return;
    if ((LEVEL_ORDER[level] ?? LEVEL_ORDER.log) < levelFloor) return;   // 级别过滤：终端照旧，只是不落盘
    try {
      const day = dayStamp(now());
      if (day !== currentDay) openFor(day);
      rollIfNeeded();
      const line = `${new Date(now()).toISOString()} [${level}] ${format(...args)}\n`;
      stream.write(line);
      writtenBytes += Buffer.byteLength(line);
    } catch { /* 旁路，绝不抛给调用方 */ }
  };

  const originals = {};
  for (const level of LEVELS) {
    // 存**原函数本身**而不是 bind 后的副本：close 时必须把 console 还原成
    // 逐字节同一个函数（否则每 init 一次就多套一层 bound，测试里表现为
    // "close 后 console.log !== before"，实际是身份变了）。
    originals[level] = console[level];
    console[level] = (...args) => {
      originals[level].apply(console, args); // 先照原样打给启动器/终端
      write(level, args);
    };
  }

  try {
    openFor(dayStamp(now()));
  } catch (err) {
    console.warn(`[log] 打开日志文件失败：${err.message}`);
    for (const level of LEVELS) console[level] = originals[level];
    return null;
  }

  const removed = pruneOldLogs(targetDir, prefix, keepDays, now());
  if (removed.length > 0) originals.log(`[log] 已清理 ${removed.length} 个过期日志（保留 ${keepDays} 天）`);
  const flush = () => new Promise(resolve => {
    if (!stream) return resolve();
    stream.write('', () => resolve());
  });
  const close = async () => {
    for (const level of LEVELS) console[level] = originals[level];
    await flush();
    await new Promise(resolve => {
      if (!stream) return resolve();
      stream.end(() => resolve());
    });
    stream = null;
    currentDay = '';
    currentFile = '';
    handle = null;
  };

  handle = {
    dir: targetDir,
    // 活取值：跨天切换文件后 `.file` 必须指向**当前**文件（启动时只打印一次，
    // 但测试与排障都靠它，快照会指向昨天那个）
    get file() { return currentFile; },
    flush,
    close,
    prefix,
    keepDays,
  };
  return handle;
}

/** 当前句柄（没初始化过 / 已关闭时为 null） */
export function getFileLogging() {
  return handle;
}
