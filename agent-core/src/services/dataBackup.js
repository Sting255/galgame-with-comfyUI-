/**
 * 一键导出 / 一键导入（全量数据备份恢复）
 *
 *   agent-core/data/agent.db      SQLite 主库（**不裸拷**：用 VACUUM INTO 取一致性快照）
 *   agent-core/data/avatars/      角色头像等用户资产
 *   agent-core/data/town/         小镇地图与像素素材（含 town/assets）
 *   agent-core/data/images/       聊天 / 朋友圈 / 奇遇 / 报纸等配图（**2026-10-01 补上**：
 *                                 原来漏了它，导出/导入不对称，用户的图会在换机后全部变成死链）
 *   agent-core/.env               可选（里面有 LLM_API_KEY）——默认不导出，includeConfig=1 才带
 *
 * 不导出：node_modules / logs / public（前端产物，可重建）/ data/backups（备份自身，避免套娃）。
 *
 * 归档格式（.tar.gz，ustar）：
 *   manifest.json
 *   data/agent.db
 *   data/avatars/...
 *   data/town/...
 *   data/images/...
 *   [config/.env]        ← 仅 includeConfig=1 且磁盘上确实有 .env
 *
 * 安全口径（导入）：
 *   1) **先全部校验、解到临时 staging 目录**，任何一项不过就整单拒绝，绝不碰现有数据；
 *   2) 校验：gunzip → tar → manifest 存在 / format / version → 每个文件 bytes+sha256 与 manifest 一致
 *      → 路径安全（拒绝绝对路径、`..`、反斜杠、盘符、超长、符号链接/硬链接/设备/FIFO）
 *      → 只允许 `data/**` 与（仅 includeConfig 时）`config/.env`
 *      → 总解压大小上限（默认 2GB，LINSHE_BACKUP_MAX_BYTES 覆盖）；
 *   3) 校验通过后才：备份现有 data/ → 关库 → 换 agent.db（并清 -wal/-shm）→ 合并 avatars/town/images → 重开库。
 *
 * 测试接缝（生产不需要设）：
 *   LINSHE_DATA_DIR   覆盖 data 根目录（测试用临时目录，绝不碰真实库）
 *   LINSHE_ENV_PATH   覆盖 .env 路径（测试用假 .env，避免把真实 KEY 写进测试归档）
 *   LINSHE_BACKUP_MAX_BYTES  覆盖归档/解压大小上限
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { getDb, closeDb } from '../db/index.js';
import { refresh as refreshCharSearch } from './characterSearch.js';
import {
  TYPE_DIR, TYPE_FILE,
  writeTarGz, readTarGzStream, isGzip,
} from './tarGz.js';

const AGENT_CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BACKUP_FORMAT = 'linshe-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_APP = '邻舍.EXE';

/** manifest.json 自身的大小上限（防"manifest 撑爆内存"） */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
/** 单个条目路径的字节上限（ustar 本身能到 255，这里宽一点但仍有界） */
const MAX_ENTRY_PATH_BYTES = 1024;
/** 默认归档 / 解压总大小上限：2GB */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** 期望的 counts 口径：找不到的表跳过，不报错 */
const COUNT_TABLES = {
  characters: ['characters'],
  messages: ['messages'],
  groups: ['group_chats'],
  // "记忆"在不同版本里落在不同表上，按优先级取第一个存在的
  memories: ['memory_fragments', 'chat_memories', 'memory_units', 'memory_entities'],
};

/** 导出完成后记录（进程内；重启归零，接口里如实返回 null 而不是假装有） */
let lastExportAt = null;

/** 导入串行队列（见 importBackup 注释） */
let importQueue = Promise.resolve();

/** 带 HTTP 状态码的领域错误：路由层直接照搬 status/message/detail */
export class BackupError extends Error {
  constructor(message, { status = 400, detail = '', backupPath = null } = {}) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
    this.detail = detail;
    this.backupPath = backupPath;
  }
}

const bad = (message, detail) => new BackupError(message, { status: 400, detail });
const tooLarge = (message, detail) => new BackupError(message, { status: 413, detail });

// ── 路径与配置 ───────────────────────────────────────────────────────

export function resolveRoots() {
  return {
    agentCoreDir: AGENT_CORE_DIR,
    dataDir: process.env.LINSHE_DATA_DIR
      ? path.resolve(process.env.LINSHE_DATA_DIR)
      : path.join(AGENT_CORE_DIR, 'data'),
    dbPath: config.dbPath,
    envPath: process.env.LINSHE_ENV_PATH
      ? path.resolve(process.env.LINSHE_ENV_PATH)
      : path.join(AGENT_CORE_DIR, '.env'),
  };
}

export function getMaxArchiveBytes() {
  const parsed = Number.parseInt(process.env.LINSHE_BACKUP_MAX_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * 图片引用自检：库里的图片引用有多少在磁盘上不存在（2026-10-01 补）。
 *
 * ## 为什么要有
 * 用户的图曾经因为**导出漏打包 `data/images`** 在导入后集体变成死链
 * （真机实测：`image_tasks` 586 条引用只剩 8 条存在、`moment_posts` 41 条 0 存在），
 * 而当时**没有任何地方会提这件事**——用户只看到聊天图显示「图片不可用」、
 * 朋友圈配图整块消失，于是报成「有时候生不出来」。有了这条账，
 * 「没触发配图 / 生成失败 / 文件丢了」三种原因至少能当场分掉第三种。
 *
 * @returns {{total:number, missing:number, samples:string[]}}
 */
export function countMissingImageRefs(db = getDb(), dataDir = resolveRoots().dataDir) {
  const refs = new Set();
  const collect = (raw) => {
    if (!raw) return;
    let list = raw;
    if (typeof raw === 'string') {
      try { list = JSON.parse(raw); } catch { return; }
    }
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const url = typeof item === 'string' ? item : item?.url || item?.path;
      if (typeof url === 'string' && url.startsWith('/images/')) refs.add(url);
    }
  };

  const safeAll = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  for (const row of safeAll('SELECT output_paths FROM image_tasks')) collect(row.output_paths);
  for (const row of safeAll('SELECT images FROM moment_posts')) collect(row.images);
  for (const row of safeAll('SELECT image_path FROM town_assets')) collect(row.image_path ? [row.image_path] : []);

  const imageRoot = path.join(dataDir, 'images');
  let missing = 0;
  const samples = [];
  for (const url of refs) {
    // `/images/a/b.png` → `<dataDir>/images/a/b.png`；顺手挡掉 `..` 之类的意外输入
    const rel = url.slice('/images/'.length).replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    if (!fs.existsSync(path.join(imageRoot, rel))) {
      missing++;
      if (samples.length < 5) samples.push(url);
    }
  }
  return { total: refs.size, missing, samples };
}

/** YYYYMMDD-HHmm（本地时间，用于归档文件名） */
function formatStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** YYYYMMDD-HHmmss（本地时间，用于备份目录名，避免同一分钟内两次导入互相覆盖） */
function formatStampSeconds(date) {
  const p = n => String(n).padStart(2, '0');
  return `${formatStamp(date)}${p(date.getSeconds())}`;
}

// ── 通用小工具 ───────────────────────────────────────────────────────

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** 流式写 + 背压 + 错误上抛（write 的回调在真正落盘后触发） */
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, err => (err ? reject(err) : resolve()));
  });
}

function streamDone(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('close', resolve);
  });
}

/** 递归收集一个目录下的目录与文件（符号链接跳过并告警，不写进归档） */
function walkTree(absDir, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // 目录不存在：跳过（例如从没建过小镇）
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const abs = path.join(absDir, entry.name);
    if (entry.isSymbolicLink()) {
      console.warn(`[backup] 跳过符号链接（不写入归档）: ${rel}`);
      continue;
    }
    if (entry.isDirectory()) {
      out.dirs.push({ rel, abs });
      walkTree(abs, rel, out);
    } else if (entry.isFile()) {
      out.files.push({ rel, abs });
    }
  }
}

/** 把 srcDir 内容递归拷进 dstDir（同名覆盖；skipRoot 里的顶层名字跳过） */
async function copyTreeInto(srcDir, dstDir, { skipRoot = new Set(), counter = null } = {}) {
  const stack = [{ src: srcDir, dst: dstDir, top: true }];
  while (stack.length > 0) {
    const { src, dst, top } = stack.pop();
    await fs.promises.mkdir(dst, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (top && skipRoot.has(entry.name)) continue;
      const from = path.join(src, entry.name);
      const to = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        stack.push({ src: from, dst: to, top: false });
      } else if (entry.isFile()) {
        await fs.promises.copyFile(from, to);
        if (counter) {
          counter.files += 1;
          counter.bytes += (await fs.promises.stat(to)).size;
        }
      }
      // 符号链接等其它类型不拷贝
    }
  }
}

// ── 统计 ─────────────────────────────────────────────────────────────

/** 从库里现查四个计数；表不存在就跳过（不报错），查不到给 null */
export function collectCounts(db) {
  const counts = {};
  for (const [key, candidates] of Object.entries(COUNT_TABLES)) {
    counts[key] = null;
    for (const table of candidates) {
      try {
        counts[key] = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
        break;
      } catch {
        // 表不存在 / 句柄已关：继续试下一个候选
      }
    }
  }
  return counts;
}

// ── 导出 ─────────────────────────────────────────────────────────────

/**
 * 把 agent.db 的一致性快照写到 file。
 * 默认 VACUUM INTO（better-sqlite3 同步执行，WAL 下也拿到一致快照）；
 * 极端情况下（例如目标已存在、权限异常）回退到在线备份 API。
 */
async function snapshotDbTo(file) {
  const db = getDb();
  try {
    db.prepare('VACUUM INTO ?').run(file);
    return 'vacuum-into';
  } catch (err) {
    console.warn('[backup] VACUUM INTO 失败，回退到在线备份:', err.message);
  }
  await fs.promises.rm(file, { force: true });
  await db.backup(file);
  return 'online-backup';
}

/**
 * 生成一份 .tar.gz 备份（流式写文件，不整包进内存）。
 * @param {{includeConfig?:boolean, roots?:object, outDir?:string}} options
 * @returns {Promise<{file:string, workDir:string, fileName:string, bytes:number, manifest:object, cleanup:Function}>}
 */
export async function createBackup({ includeConfig = false, roots = resolveRoots(), outDir = null } = {}) {
  const started = new Date();
  // 每次都用新的临时子目录：snapshot 目标必须不存在（VACUUM INTO 会拒绝覆盖已有文件）
  const workDir = await fs.promises.mkdtemp(path.join(outDir || os.tmpdir(), 'linshe-export-'));
  const cleanup = async () => { await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {}); };

  try {
    return await buildBackupInto(workDir, { includeConfig, roots, started, cleanup });
  } catch (err) {
    // 生成中途失败：临时目录不留尸体（成功的归档由调用方 cleanup）
    await cleanup();
    throw err;
  }
}

async function buildBackupInto(workDir, { includeConfig, roots, started, cleanup }) {
  const snapshotFile = path.join(workDir, 'agent.db');
  await snapshotDbTo(snapshotFile);
  const dbBytes = (await fs.promises.stat(snapshotFile)).size;

  // 用户资产：avatars / town（含 town/assets）/ **images**，目录条目一并带上（空目录也能还原）
  //
  // 2026-10-01 修（真机数据丢失）：原来只打包 avatars + town，**漏了 data/images**，
  // 而导入侧是允许 `data/**` 的 ⇒ 导出/导入**不对称**：换台机器导入之后，
  // agent.db 里所有 `/images/chat/…`、`/images/events/…`、朋友圈配图引用全部指向不存在的文件
  // （实测该用户 586 条引用只剩 8 条存在、moment_posts 41 条 0 存在），
  // 现象就是「聊天图显示图片不可用」「朋友圈配图整块消失」，用户会报成「有时候生不出来」。
  // 图片是**不可再生**的用户内容（重生成也回不到同一张），必须跟着归档走。
  const tree = { dirs: [], files: [] };
  walkTree(path.join(roots.dataDir, 'avatars'), 'data/avatars', tree);
  walkTree(path.join(roots.dataDir, 'town'), 'data/town', tree);
  walkTree(path.join(roots.dataDir, 'images'), 'data/images', tree);

  const manifestFiles = [{ path: 'data/agent.db', bytes: dbBytes, sha256: await sha256File(snapshotFile) }];
  for (const file of tree.files) {
    const stat = await fs.promises.stat(file.abs);
    manifestFiles.push({ path: file.rel, bytes: stat.size, sha256: await sha256File(file.abs) });
  }

  // 可选 .env：只有显式要求、且磁盘上确实存在才带
  let envInfo = null;
  if (includeConfig) {
    if (fs.existsSync(roots.envPath)) {
      const stat = await fs.promises.stat(roots.envPath);
      envInfo = { rel: 'config/.env', abs: roots.envPath, bytes: stat.size, sha256: await sha256File(roots.envPath) };
      manifestFiles.push({ path: envInfo.rel, bytes: envInfo.bytes, sha256: envInfo.sha256 });
    } else {
      console.warn(`[backup] includeConfig=1 但 .env 不存在，本次不导出配置: ${roots.envPath}`);
    }
  }

  const counts = collectCounts(getDb());
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: BACKUP_APP,
    exportedAt: started.toISOString(),
    includeConfig: Boolean(envInfo),
    dbBytes,
    files: manifestFiles,
    counts,
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const mtime = Math.floor(started.getTime() / 1000);

  const entries = [
    { path: 'manifest.json', type: TYPE_FILE, data: manifestBuffer, size: manifestBuffer.length, mtime, mode: 0o644 },
    { path: 'data/agent.db', type: TYPE_FILE, source: snapshotFile, size: dbBytes, mtime, mode: 0o644 },
    ...tree.dirs.map(dir => ({ path: dir.rel, type: TYPE_DIR, mode: 0o755, mtime })),
    ...tree.files.map(file => ({ path: file.rel, type: TYPE_FILE, source: file.abs, mode: 0o644 })),
  ];
  if (envInfo) {
    entries.push({ path: envInfo.rel, type: TYPE_FILE, source: envInfo.abs, size: envInfo.bytes, mode: 0o600 });
  }

  const fileName = `linshe-backup-${formatStamp(started)}.tar.gz`;
  const outFile = path.join(workDir, fileName);
  await writeTarGz(outFile, entries);

  lastExportAt = started.toISOString();
  return {
    file: outFile,
    workDir,
    fileName,
    bytes: (await fs.promises.stat(outFile)).size,
    manifest,
    cleanup,
  };
}

/** 给前端"将导出多少数据"用的轻量信息（不生成归档） */
export function getExportInfo() {
  const roots = resolveRoots();
  let dbBytes = 0;
  try {
    dbBytes += fs.statSync(roots.dbPath).size;
    // WAL 里的已提交内容会在快照里落进 agent.db，估算时算上更接近真实导出量
    dbBytes += fs.statSync(`${roots.dbPath}-wal`).size;
  } catch {
    // 文件不存在（`:memory:` 或还没建库）：保持 0
  }
  let counts = null;
  try {
    counts = collectCounts(getDb());
  } catch {
    // 句柄不可用时不假装有数据
  }
  return { ok: true, dbBytes, counts, lastExportAt };
}

// ── 导入：路径与条目校验 ─────────────────────────────────────────────

/**
 * 校验归档内的一条路径，返回它属于哪一类。
 * 拒绝一切可能逃出目标目录或不该出现的形态。
 */
function classifyEntryPath(rawPath, type) {
  const name = String(rawPath ?? '');
  if (name === '') throw bad('归档内存在空路径条目', 'tar 条目名为空');
  if (name.includes('\0')) throw bad('归档路径含非法字符', `NUL 出现在路径中: ${name}`);
  if (name.includes('\\')) throw bad('归档路径含非法字符', `不允许反斜杠（Windows 分隔符）: ${name}`);
  if (name.startsWith('/')) throw bad('归档包含绝对路径', name);
  if (/^[A-Za-z]:/.test(name)) throw bad('归档包含盘符路径', name);
  if (name.startsWith('//') || name.startsWith('\\\\')) throw bad('归档包含 UNC 路径', name);
  if (Buffer.byteLength(name, 'utf8') > MAX_ENTRY_PATH_BYTES) {
    throw bad('归档路径过长', `${Buffer.byteLength(name, 'utf8')} 字节 > ${MAX_ENTRY_PATH_BYTES}: ${name}`);
  }

  const isDir = type === TYPE_DIR;
  if (!isDir && name.endsWith('/')) throw bad('归档条目类型与路径不符', `文件条目却以 / 结尾: ${name}`);

  const segments = name.split('/');
  const cleaned = [];
  for (const segment of segments) {
    if (segment === '') continue; // 目录条目的尾斜杠之类
    if (segment === '.' || segment === '..') throw bad('归档包含路径穿越', name);
    cleaned.push(segment);
  }
  if (cleaned.length === 0) throw bad('归档包含空路径条目', name);
  const rel = cleaned.join('/');

  if (rel === 'manifest.json') {
    if (isDir) throw bad('manifest.json 不是文件', name);
    return { kind: 'manifest', rel };
  }
  if (rel === 'config/.env') {
    if (isDir) throw bad('config/.env 不是文件', name);
    return { kind: 'env', rel };
  }
  if (rel === 'data' || rel.startsWith('data/')) {
    if (rel === 'data/backups' || rel.startsWith('data/backups/')) {
      throw bad('归档不允许包含 data/backups（备份自身）', name);
    }
    if (rel === 'data/agent.db-wal' || rel === 'data/agent.db-shm') {
      throw bad('归档不允许包含 SQLite WAL 文件', `${name} —— 导出用的是 VACUUM INTO 快照，正常归档不会有它`);
    }
    return { kind: 'data', rel };
  }
  throw bad('归档路径不在允许范围内', `${name} —— 只允许 data/** 与（includeConfig=1 时）config/.env`);
}

/** 目标绝对路径必须落在 staging 根之内（路径穿越的最后一道保险） */
function stagedPath(stagingRoot, rel) {
  const target = path.resolve(stagingRoot, rel);
  const root = path.resolve(stagingRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw bad('归档路径穿越 staging 目录', rel);
  }
  return target;
}

/**
 * 全量校验：把归档解到 staging（临时目录），逐条核对 manifest 与 sha256。
 * 任何问题都抛错，且**不产生任何对现有数据的影响**。
 */
async function extractAndValidate(gzipBuffer, stagingRoot, maxBytes) {
  const files = new Map();       // rel -> { bytes, sha256 }
  const dirs = new Set();
  const state = {
    manifestChunks: null,
    current: null,
    totalBytes: 0,
  };

  const onEntry = async (entry) => {
    const type = entry.type;
    if (type === TYPE_DIR && entry.size !== 0) {
      throw bad('目录条目带数据', `${entry.path} size=${entry.size}`);
    }
    if (type !== TYPE_FILE && type !== TYPE_DIR) {
      const label = type === '2' ? '符号链接' : type === '1' ? '硬链接' : `类型 ${JSON.stringify(type)}`;
      throw bad('归档包含不允许的条目类型', `${label}: ${entry.path}${entry.linkname ? ` → ${entry.linkname}` : ''}`);
    }

    const info = classifyEntryPath(entry.rawName ?? entry.path, type);
    state.totalBytes += entry.size;
    if (state.totalBytes > maxBytes) {
      throw tooLarge('归档解压后超过大小上限', `已解压 ${state.totalBytes} 字节 > 上限 ${maxBytes} 字节`);
    }

    if (info.kind === 'manifest') {
      if (state.manifestChunks !== null) throw bad('归档包含重复的 manifest.json', '');
      if (entry.size > MANIFEST_MAX_BYTES) {
        throw bad('manifest.json 过大', `${entry.size} 字节 > ${MANIFEST_MAX_BYTES}`);
      }
      state.manifestChunks = [];
      state.current = { kind: 'manifest' };
      return;
    }

    const target = stagedPath(stagingRoot, info.rel);
    if (type === TYPE_DIR) {
      await fs.promises.mkdir(target, { recursive: true });
      dirs.add(info.rel);
      state.current = { kind: 'dir', rel: info.rel };
      return;
    }
    if (files.has(info.rel)) throw bad('归档包含重复文件条目', info.rel);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const stream = fs.createWriteStream(target, { flags: 'w' });
    const done = streamDone(stream);
    done.catch(() => {}); // 归档中途失败时这个 promise 可能没人 await，先挂个空 catch 防 unhandledRejection
    state.current = {
      kind: 'file',
      rel: info.rel,
      hash: crypto.createHash('sha256'),
      bytes: 0,
      stream,
      done,
    };
  };

  const onData = async (entry, chunk) => {
    const current = state.current;
    if (!current) throw bad('归档数据结构异常', '数据片段出现在任何条目之外');
    if (current.kind === 'manifest') {
      state.manifestChunks.push(chunk);
      return;
    }
    if (current.kind !== 'file') throw bad('归档数据结构异常', `${current.rel} 是目录却带数据`);
    current.hash.update(chunk);
    current.bytes += chunk.length;
    await writeChunk(current.stream, chunk);
  };

  const onEnd = async (entry) => {
    const current = state.current;
    state.current = null;
    if (!current || current.kind === 'dir') return;
    if (current.kind === 'manifest') return;
    current.stream.end();
    await current.done;
    current.stream.destroy();
    files.set(current.rel, { bytes: current.bytes, sha256: current.hash.digest('hex'), entrySize: entry.size });
  };

  try {
    await readTarGzStream(gzipBuffer, { onEntry, onData, onEnd });
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw bad('归档不是合法的 .tar.gz', err.message);
  }

  // ── manifest 本身 ──
  if (!state.manifestChunks) throw bad('归档缺少 manifest.json', '根目录下必须有一份 manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(Buffer.concat(state.manifestChunks).toString('utf8'));
  } catch (err) {
    throw bad('manifest.json 不是合法 JSON', err.message);
  }
  if (!manifest || typeof manifest !== 'object') throw bad('manifest.json 结构非法', '顶层必须是对象');
  if (manifest.format !== BACKUP_FORMAT) {
    throw bad('归档格式不匹配', `manifest.format=${JSON.stringify(manifest.format)}，期望 "${BACKUP_FORMAT}"`);
  }
  if (manifest.version !== BACKUP_VERSION) {
    throw bad('归档版本不支持', `manifest.version=${JSON.stringify(manifest.version)}，期望 ${BACKUP_VERSION}`);
  }
  if (!Array.isArray(manifest.files)) throw bad('manifest.files 缺失或不是数组', '');

  const includeConfig = manifest.includeConfig === true;

  // ── 逐文件核对 ──
  const declared = new Map();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string') throw bad('manifest.files 条目缺少 path', JSON.stringify(item));
    if (declared.has(item.path)) throw bad('manifest.files 出现重复路径', item.path);
    declared.set(item.path, item);
    const actual = files.get(item.path);
    if (!actual) throw bad('归档缺少 manifest 中登记的文件', item.path);
    if (actual.entrySize !== item.bytes || actual.bytes !== item.bytes) {
      throw bad('文件大小与 manifest 不符', `${item.path}: 归档 ${actual.bytes} 字节，manifest ${item.bytes} 字节`);
    }
    if (typeof item.sha256 !== 'string' || actual.sha256 !== item.sha256.toLowerCase()) {
      throw bad('文件 sha256 与 manifest 不符', `${item.path}: 实际 ${actual.sha256}，manifest ${item.sha256}`);
    }
  }
  for (const rel of files.keys()) {
    if (!declared.has(rel)) throw bad('归档包含未在 manifest 中登记的文件', rel);
  }

  if (!files.has('data/agent.db')) throw bad('归档缺少 data/agent.db', '全量备份必须包含数据库');

  if (includeConfig && !files.has('config/.env')) {
    throw bad('manifest.includeConfig=true 但归档里没有 config/.env', '');
  }
  if (!includeConfig && files.has('config/.env')) {
    throw bad('归档含 config/.env，但 manifest.includeConfig 不是 true', '拒绝写入 .env');
  }

  // 数据库文件头校验：比"换完文件再让 better-sqlite3 炸"更早、更明确
  const dbStaged = path.join(stagingRoot, 'data', 'agent.db');
  const head = Buffer.alloc(16);
  const fd = await fs.promises.open(dbStaged, 'r');
  try {
    await fd.read(head, 0, 16, 0);
  } finally {
    await fd.close();
  }
  if (head.toString('latin1') !== 'SQLite format 3\0') {
    throw bad('data/agent.db 不是 SQLite 数据库', `文件头: ${JSON.stringify(head.subarray(0, 16).toString('latin1'))}`);
  }

  return { manifest, files, dirs, includeConfig, totalBytes: state.totalBytes };
}

// ── 导入：备份 + 落地 ────────────────────────────────────────────────

/**
 * 关库前的 WAL checkpoint + 关库。
 * 必须在**备份现有数据之前**做：WAL 模式下 agent.db 主文件不含最新提交，
 * 只拷主文件会得到一个"少了最近写入"的假备份。checkpoint(TRUNCATE) 把 WAL 全并回主文件。
 */
function checkpointAndCloseDb() {
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('[backup] 关库前 WAL checkpoint 失败（继续，closeDb 内部仍会 checkpoint）:', err.message);
  }
  closeDb();
}

/** 把现有 data/ 整份复制到 data/backups/pre-import-<YYYYMMDD-HHmmss>/（跳过 backups 自身）。
 *  同一秒内的第二次导入自动退到 `-2` / `-3` 后缀，绝不把两次备份写进同一个目录。 */
async function backupExistingData(roots) {
  const backupsRoot = path.join(roots.dataDir, 'backups');
  await fs.promises.mkdir(backupsRoot, { recursive: true });
  const base = path.join(backupsRoot, `pre-import-${formatStampSeconds(new Date())}`);
  let dir = base;
  for (let suffix = 2; ; suffix++) {
    try {
      await fs.promises.mkdir(dir); // 非 recursive：目录已存在会 EEXIST，等于原子占位
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (suffix > 999) throw new Error(`导入前备份目录名冲突过多: ${base}`);
      dir = `${base}-${suffix}`;
    }
  }
  const counter = { files: 0, bytes: 0 };
  await copyTreeInto(roots.dataDir, dir, { skipRoot: new Set(['backups']), counter });
  console.log(`[backup] 导入前备份: ${dir}（${counter.files} 个文件 / ${counter.bytes} 字节）`);
  return dir;
}

/**
 * 关键区：清 -wal/-shm → 换 agent.db → 重开库。
 * 全程同步，Node 单线程下不会被别的请求插进来看到"半换"状态。
 * 调用前数据库必须已关闭（checkpointAndCloseDb）。
 */
function swapDatabase(stagingDbFile, roots) {
  if (roots.dbPath === ':memory:') {
    return { applied: false, reason: ':memory: 数据库没有磁盘文件，无法替换' };
  }
  fs.mkdirSync(path.dirname(roots.dbPath), { recursive: true });
  closeDb(); // 幂等：保证调用点顺序变了也不会带着打开状态去覆盖文件
  let failure = null;
  try {
    fs.rmSync(`${roots.dbPath}-wal`, { force: true });
    fs.rmSync(`${roots.dbPath}-shm`, { force: true });
    fs.copyFileSync(stagingDbFile, roots.dbPath);
  } catch (err) {
    failure = err;
  }
  try {
    getDb(); // 无论成败都重开，别把进程留在"没有库"的状态
  } catch (err) {
    failure = failure || err;
  }
  if (failure) {
    throw new BackupError('替换数据库后重新打开失败', { status: 500, detail: failure.message });
  }
  return { applied: true, reason: '' };
}

/** 把 staging/data/** 合并回真实 data/（agent.db 已在关键区单独处理） */
async function applyDataTree(stagingRoot, roots) {
  const counter = { files: 0, bytes: 0 };
  await copyTreeInto(path.join(stagingRoot, 'data'), roots.dataDir, {
    skipRoot: new Set(['agent.db']),
    counter,
  });
  return counter;
}

/**
 * 一键导入：先全部校验 → 备份 → 落地。同一进程内**串行**执行。
 *
 * 为什么要串行：导入要"关库 → 换 agent.db → 重开库"，两个导入并发时后一个的
 * 「导入前备份」可能拍到前一个已经换过一半的 data/，回滚点时就不再是真实前态。
 * 串行后第二个请求会等第一个彻底落地（含重开库）再开始，备份点始终是完整状态。
 * 换库本身是同步的（closeDb/rm/copyFile/getDb 之间没有 await），
 * 所以关键区对事件循环是原子的，导出侧不会拍到半个文件。
 *
 * @param {Buffer} gzipBuffer 请求体（.tar.gz 原始字节）
 * @returns {Promise<{restored:object, backupPath:string, restartRecommended:boolean, message:string}>}
 */
export function importBackup(gzipBuffer, options = {}) {
  const run = importQueue.then(
    () => runImport(gzipBuffer, options),
    () => runImport(gzipBuffer, options),
  );
  // 队列本身不因失败而断链（失败已经由 run 交给调用方）
  importQueue = run.then(() => {}, () => {});
  return run;
}

async function runImport(gzipBuffer, { maxBytes = getMaxArchiveBytes(), roots = resolveRoots() } = {}) {
  if (!Buffer.isBuffer(gzipBuffer) || gzipBuffer.length === 0) {
    throw bad('请求体为空', 'POST /api/data/import 的 body 必须是 .tar.gz 的原始字节');
  }
  if (gzipBuffer.length > maxBytes) {
    throw tooLarge('归档超过大小上限', `${gzipBuffer.length} 字节 > 上限 ${maxBytes} 字节`);
  }
  if (!isGzip(gzipBuffer)) {
    throw bad('不是 gzip 归档', '文件头不是 1f 8b，本接口只接受 .tar.gz');
  }

  const stagingRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'linshe-import-'));
  let backupPath = null;
  try {
    // 1) 校验（解到 staging，绝不碰现有数据）
    const checked = await extractAndValidate(gzipBuffer, stagingRoot, maxBytes);

    // 2) 关库（把 WAL 全并回主文件）→ 备份现状。备份必须是"干净完整"的一份，
    //    所以 checkpoint 一定在复制之前；失败时无论如何都把库重新打开。
    await fs.promises.mkdir(roots.dataDir, { recursive: true });
    checkpointAndCloseDb();
    let swap;
    try {
      backupPath = await backupExistingData(roots);

      // 3) 落地
      try {
        swap = swapDatabase(path.join(stagingRoot, 'data', 'agent.db'), roots);
      } catch (err) {
        if (err instanceof BackupError) err.backupPath = backupPath;
        throw err;
      }
    } catch (err) {
      // 备份或换库阶段失败：保证进程里一定有一个可用的库句柄
      try { getDb(); } catch { /* 重开也失败时交给上层 500，并给出 backupPath */ }
      if (err instanceof BackupError) {
        if (!err.backupPath) err.backupPath = backupPath;
        throw err;
      }
      throw new BackupError('导入过程中出错', { status: 500, detail: err.message, backupPath });
    }

    const copied = await applyDataTree(stagingRoot, roots);

    let envApplied = false;
    if (checked.includeConfig) {
      await fs.promises.copyFile(path.join(stagingRoot, 'config', '.env'), roots.envPath);
      envApplied = true;
    }

    // 角色名注册表是启动时灌进内存的，导入后必须重建，否则交叉引用检索还按旧名单走
    try {
      refreshCharSearch();
    } catch (err) {
      console.warn('[backup] 导入后重建角色名注册表失败:', err.message);
    }

    let counts = null;
    try {
      counts = collectCounts(getDb());
    } catch (err) {
      console.warn('[backup] 导入后统计失败:', err.message);
    }

    // 图片引用自检（2026-10-01 补）：库里的图有多少在磁盘上真的存在
    let imageCheck = null;
    try {
      imageCheck = countMissingImageRefs(getDb(), roots.dataDir);
      if (imageCheck.total > 0 && imageCheck.missing > 0) {
        const pct = Math.round((imageCheck.missing / imageCheck.total) * 100);
        console.warn(`[backup] 图片引用自检：${imageCheck.missing}/${imageCheck.total} 条（${pct}%）在磁盘上不存在`);
      }
    } catch (err) {
      console.warn('[backup] 图片引用自检失败:', err.message);
    }

    const restartRecommended = Boolean(envApplied) || !swap.applied;
    const parts = [
      `已恢复 ${checked.files.size} 个文件 / ${checked.totalBytes} 字节`,
      `导入前数据已备份到 ${backupPath}`,
    ];
    if (copied.files > 0) parts.push(`data/ 内合并了 ${copied.files} 个资产文件`);
    if (imageCheck && imageCheck.missing > 0) {
      const pct = Math.round((imageCheck.missing / imageCheck.total) * 100);
      parts.push(pct >= 20
        ? `⚠️ 有 ${imageCheck.missing}/${imageCheck.total} 条图片引用找不到文件（聊天图会显示「图片不可用」、朋友圈配图会整块消失）。旧版本的导出不带 data/images，若这份归档来自旧版本，请用新版本重新导出一次`
        : `有 ${imageCheck.missing}/${imageCheck.total} 条图片引用找不到文件（多为历史上被清理过的旧图）`);
    }
    if (!swap.applied) {
      parts.push(`当前使用 ${roots.dbPath}，数据库未换文件，需要重启才能生效`);
    } else {
      parts.push('数据库已在当前进程内重新打开，可以立即继续使用');
    }
    if (envApplied) parts.push('config/.env 已写入，其中的配置（如 LLM_API_KEY）需重启进程才会加载');

    return {
      restored: {
        files: checked.files.size,
        bytes: checked.totalBytes,
        counts,
      },
      backupPath,
      restartRecommended,
      message: parts.join('；'),
    };
  } catch (err) {
    if (err instanceof BackupError) {
      if (!err.backupPath) err.backupPath = backupPath;
      throw err;
    }
    const wrapped = new BackupError('导入过程中出错', { status: 500, detail: err.message, backupPath });
    throw wrapped;
  } finally {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}
