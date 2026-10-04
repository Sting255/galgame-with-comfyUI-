/**
 * 一键导出 / 一键导入（dataBackup）正式测试
 *
 * 覆盖要求（对应交付说明）：
 *   1. 导出归档结构：manifest 存在且字段正确 / 每个文件 sha256 与内容一致 / .env 开与关两种
 *   2. 自己写的 tar 读取能解回原文件（往返一致）
 *   3. 导入校验拒绝：不是 gzip / manifest 缺失 / sha256 不符 / 路径穿越 `../` / 绝对路径
 *      / 符号链接 / includeConfig 与实际内容矛盾
 *   4. 导入成功：data/ 内容被替换、导入前备份目录被创建、能回滚
 *   5. 大小上限 413（把上限调到很小来测，压缩前与解压后两条路径）
 *   6. 导入不影响 config.features 之类运行期状态
 *
 * 硬性约束：**绝不碰 agent-core/data/agent.db 本体**。
 *   本文件在 import 任何业务模块之前把 DB_PATH / LINSHE_DATA_DIR / LINSHE_ENV_PATH
 *   全部指向 mkdtemp 出来的临时目录，真实库、真实 .env 都不在测试的访问范围内。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-backup-test-'));
const DATA_DIR = path.join(TMP, 'data');
const DB_PATH = path.join(DATA_DIR, 'agent.db');
const ENV_PATH = path.join(TMP, '.env');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(ENV_PATH, 'LLM_API_KEY=test-only-key\nLLM_MODEL=test-model\n');

// 必须在 import config.js / db/index.js 之前生效
process.env.DB_PATH = DB_PATH;
process.env.LINSHE_DATA_DIR = DATA_DIR;
process.env.LINSHE_ENV_PATH = ENV_PATH;
process.env.LOG_TO_FILE = 'false';
globalThis.fetch = async url => { throw new Error(`dataBackup test forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = DB_PATH; // 兜底：即便 .env 里写了 DB_PATH，也不许漂到真实库
const { getDb, closeDb } = await import('../src/db/index.js');
const backup = await import('../src/services/dataBackup.js');
const tarGz = await import('../src/services/tarGz.js');
const dataRoutes = (await import('../src/routes/data.js')).default;

// ── 真实 HTTP 挂载（只挂 data 路由，不启动完整 app.js）──

const app = express();
app.use('/api/data', dataRoutes);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  // Windows 上偶尔会因为残留句柄删不掉，重试几次；实在删不掉也不该让测试假失败
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.warn(`[dataBackup.test] 临时目录清理失败（可手动删）: ${TMP} :: ${err.message}`);
  }
});

function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (body) finalHeaders['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers: finalHeaders }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 归档构造函数是 async 的，这里统一 await 一次，调用点就能直接写 postImport(rebuild(...))
const postImport = async (body, headers = { 'Content-Type': 'application/gzip' }) =>
  request('POST', '/api/data/import', { body: await body, headers });

// ── 夹具 ─────────────────────────────────────────────────────────────

const AVATAR_A = path.join(DATA_DIR, 'avatars', 'a.png');
const TOWN_TILE = path.join(DATA_DIR, 'town', 'assets', 'tile.png');

let seeded = false;
function ensureFixtures() {
  fs.mkdirSync(path.join(DATA_DIR, 'avatars'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'town', 'assets'), { recursive: true });
  fs.writeFileSync(AVATAR_A, Buffer.from('fake-png-avatar-a'));
  fs.writeFileSync(TOWN_TILE, Buffer.from('fake-png-town-tile'));

  if (seeded) return;
  seeded = true;
  const db = getDb();
  db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run('备份测试角色', '备份测试角色', '你是测试角色');
  db.prepare('INSERT INTO group_chats (name) VALUES (?)').run('备份测试群');
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run('char_1', 'user', '测试消息');
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run('char_1', 'user', '测试消息');
  db.prepare('INSERT INTO memory_fragments (conversation_id, fragment_type, content) VALUES (?, ?, ?)')
    .run('char_1', 'fact', '测试记忆');

  // 不该被导出的东西（front-end / 备份自身）
  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  // 用户配图：**必须跟着导出**（2026-10-01 起）—— 原来漏了它，换机导入后所有图变成死链
  fs.mkdirSync(path.join(DATA_DIR, 'images', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'images', 'chat', 'keep-me.png'), Buffer.from('image'));
  fs.mkdirSync(path.join(DATA_DIR, 'backups', 'pre-import-19700101-000000'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'backups', 'pre-import-19700101-000000', 'agent.db'), Buffer.from('old-backup'));
}

async function exportEntries({ includeConfig = false } = {}) {
  const result = await backup.createBackup({ includeConfig });
  try {
    return { entries: await tarGz.readTarGzEntries(fs.readFileSync(result.file)), bytes: result.bytes, manifest: result.manifest };
  } finally {
    await result.cleanup();
  }
}

/** 导出一次并只留下归档字节（临时目录一定清掉） */
async function exportToBuffer(options = {}) {
  const result = await backup.createBackup(options);
  try {
    return fs.readFileSync(result.file);
  } finally {
    await result.cleanup();
  }
}

/** 用一组（可能被篡改过的）条目重新打一个 tar.gz */
function rebuild(entries) {
  return tarGz.createTarGzBuffer(entries.map(entry => {
    if (entry.type === tarGz.TYPE_DIR) return { path: entry.path, type: tarGz.TYPE_DIR };
    const data = entry.data || Buffer.alloc(0);
    return { path: entry.path, type: entry.type || tarGz.TYPE_FILE, data, size: data.length, linkname: entry.linkname || '' };
  }));
}

function withManifest(entries, mutate) {
  const next = entries.map(entry => (entry.path === 'manifest.json'
    ? { ...entry, data: Buffer.from(JSON.stringify(mutate(JSON.parse(entry.data.toString('utf8'))))) }
    : entry));
  return rebuild(next);
}

let baseEntriesPromise = null;
function baseEntries() {
  if (!baseEntriesPromise) {
    ensureFixtures();
    baseEntriesPromise = exportEntries({ includeConfig: false });
  }
  return baseEntriesPromise;
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// ── 1. 导出归档结构 ──────────────────────────────────────────────────

test('导出：manifest 结构、sha256 与内容一致，带 images、不带 .env / backups', async () => {
  ensureFixtures();
  const { entries, bytes, manifest } = await exportEntries({ includeConfig: false });

  assert.ok(bytes > 0, '归档字节数应大于 0');
  assert.equal(entries[0].path, 'manifest.json', 'manifest.json 必须是第一个条目');

  const paths = entries.map(entry => entry.path);
  assert.ok(paths.includes('data/agent.db'), '必须包含 data/agent.db');
  assert.ok(paths.includes('data/avatars/a.png'), '必须包含 avatars 下的资产');
  assert.ok(paths.includes('data/town/assets/tile.png'), '必须包含 town/assets 下的素材');
  // 2026-10-01 修：导出必须包含 data/images（原来漏了 ⇒ 导出/导入不对称，用户的图换机后全变死链）
  assert.ok(paths.includes('data/images/chat/keep-me.png'), '配图必须跟着导出（含子目录）');
  assert.ok(!paths.includes('config/.env'), 'includeConfig=0 时不得带 .env');
  assert.ok(!paths.some(p => p.startsWith('data/backups/')), 'data/backups 必须排除（避免套娃）');
  assert.ok(!paths.some(p => p.startsWith('node_modules') || p.startsWith('logs/') || p.startsWith('public/')));

  assert.equal(manifest.format, 'linshe-backup');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.app, '邻舍.EXE');
  assert.equal(manifest.includeConfig, false);
  assert.ok(!Number.isNaN(Date.parse(manifest.exportedAt)), 'exportedAt 必须是可解析的时间');
  assert.equal(manifest.dbBytes, entries.find(e => e.path === 'data/agent.db').data.length);
  for (const key of ['characters', 'messages', 'groups', 'memories']) {
    assert.ok(typeof manifest.counts[key] === 'number' && manifest.counts[key] >= 1, `counts.${key} 应 >= 1`);
  }

  // 每个文件：大小 + sha256 都能对上归档里的真实字节
  for (const item of manifest.files) {
    const entry = entries.find(e => e.path === item.path);
    assert.ok(entry, `归档缺少 manifest 登记的文件 ${item.path}`);
    assert.equal(entry.data.length, item.bytes, `${item.path} 大小不符`);
    assert.equal(sha256(entry.data), item.sha256, `${item.path} sha256 不符`);
  }
});

test('导出：includeConfig=1 时才带 config/.env', async () => {
  ensureFixtures();
  const { entries, manifest } = await exportEntries({ includeConfig: true });
  const paths = entries.map(entry => entry.path);
  assert.ok(paths.includes('config/.env'), 'includeConfig=1 应带上 .env');
  assert.equal(manifest.includeConfig, true);

  const envEntry = entries.find(e => e.path === 'config/.env');
  assert.equal(envEntry.data.toString('utf8'), fs.readFileSync(ENV_PATH, 'utf8'), '.env 内容应逐字节一致');
  const item = manifest.files.find(f => f.path === 'config/.env');
  assert.equal(item.sha256, sha256(envEntry.data));
});

// ── 2. 自己写的 tar 读取往返一致 ─────────────────────────────────────

test('tar 往返：流式解压出的每个文件与磁盘原文件逐字节一致', async () => {
  ensureFixtures();
  const raw = await exportToBuffer({ includeConfig: true });
  const inMemory = await tarGz.readTarGzEntries(raw);
  const manifest = JSON.parse(inMemory[0].data.toString('utf8'));

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-tar-roundtrip-'));
  try {
    // 走导入真正使用的那条流式路径，还原成文件
    const written = [];
    await tarGz.readTarGzStream(raw, {
      async onEntry(entry) {
        const target = path.join(staging, entry.path);
        if (entry.type === tarGz.TYPE_DIR) {
          fs.mkdirSync(target, { recursive: true });
          written.push({ entry, fd: null });
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        written.push({ entry, fd: fs.openSync(target, 'w') });
      },
      async onData(entry, chunk) {
        fs.writeSync(written[written.length - 1].fd, chunk);
      },
      async onEnd(entry) {
        const last = written[written.length - 1];
        if (last.fd !== null) fs.closeSync(last.fd);
      },
    });

    // 磁盘上的原文件（agent.db 例外：库在 WAL 模式下主文件不等于快照，改用 manifest 的 sha256 校验）
    const sourceOf = rel => (rel === 'config/.env' ? ENV_PATH : path.join(DATA_DIR, rel.slice('data/'.length)));
    let compared = 0;
    for (const { entry } of written) {
      if (entry.type === tarGz.TYPE_DIR) continue;
      const restored = fs.readFileSync(path.join(staging, entry.path));
      if (entry.path === 'manifest.json') {
        assert.equal(restored.toString('utf8'), inMemory[0].data.toString('utf8'), 'manifest.json 往返后应一致');
        continue;
      }
      if (entry.path === 'data/agent.db') {
        assert.equal(restored.length, manifest.dbBytes, 'agent.db 快照大小应与 manifest.dbBytes 一致');
        assert.equal(sha256(restored), manifest.files.find(f => f.path === 'data/agent.db').sha256);
      } else {
        assert.deepEqual(restored, fs.readFileSync(sourceOf(entry.path)), `${entry.path} 往返后内容不一致`);
      }
      compared += 1;
    }
    assert.ok(compared >= 3, `应至少比对 3 个文件，实际 ${compared}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

// ── 3. 导入校验拒绝 ──────────────────────────────────────────────────

test('导入拒绝：不是 gzip', async () => {
  ensureFixtures();
  const res = await postImport(Buffer.from('这不是 gzip，只是一段普通文本'));
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body.toString('utf8'));
  assert.equal(json.error, '不是 gzip 归档');
  assert.ok(json.detail.length > 0);
});

test('导入拒绝：空 body', async () => {
  const res = await postImport(Buffer.alloc(0));
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body.toString('utf8')).error, '请求体为空');
});

test('导入拒绝：manifest 缺失', async () => {
  const { entries } = await baseEntries();
  const withoutManifest = entries.filter(entry => entry.path !== 'manifest.json');
  const res = await postImport(rebuild(withoutManifest));
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body.toString('utf8')).error, /manifest\.json/);
});

test('导入拒绝：sha256 不符', async () => {
  const { entries } = await baseEntries();
  const tampered = withManifest(entries, manifest => {
    const target = manifest.files.find(f => f.path === 'data/avatars/a.png');
    target.sha256 = 'f'.repeat(64);
    return manifest;
  });
  const res = await postImport(tampered);
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body.toString('utf8'));
  assert.equal(json.error, '文件 sha256 与 manifest 不符');
  assert.match(json.detail, /data\/avatars\/a\.png/);
});

test('导入拒绝：路径穿越 ../ 与绝对路径', async () => {
  ensureFixtures();
  const { entries } = await baseEntries();

  const traversal = rebuild([
    ...entries,
    { path: '../evil.txt', type: tarGz.TYPE_FILE, data: Buffer.from('pwned'), size: 7 },
  ]);
  const traversalRes = await postImport(traversal);
  assert.equal(traversalRes.status, 400);
  assert.equal(JSON.parse(traversalRes.body.toString('utf8')).error, '归档包含路径穿越');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'evil.txt')), false, '穿越文件绝不能落到临时目录之外');
  assert.equal(fs.existsSync(path.join(TMP, 'evil.txt')), false);

  const absolute = rebuild([
    ...entries,
    { path: '/etc/passwd', type: tarGz.TYPE_FILE, data: Buffer.from('pwned'), size: 5 },
  ]);
  const absoluteRes = await postImport(absolute);
  assert.equal(absoluteRes.status, 400);
  assert.equal(JSON.parse(absoluteRes.body.toString('utf8')).error, '归档包含绝对路径');

  const nested = rebuild([
    ...entries,
    { path: 'data/avatars/../../escape.png', type: tarGz.TYPE_FILE, data: Buffer.from('pwned'), size: 5 },
  ]);
  const nestedRes = await postImport(nested);
  assert.equal(nestedRes.status, 400);
  assert.equal(JSON.parse(nestedRes.body.toString('utf8')).error, '归档包含路径穿越');
});

test('导入拒绝：符号链接 / 硬链接条目', async () => {
  const { entries } = await baseEntries();

  const symlink = rebuild([
    ...entries,
    { path: 'data/avatars/link.png', type: tarGz.TYPE_SYMLINK, linkname: '/etc/passwd', data: Buffer.alloc(0), size: 0 },
  ]);
  const symlinkRes = await postImport(symlink);
  assert.equal(symlinkRes.status, 400);
  assert.equal(JSON.parse(symlinkRes.body.toString('utf8')).error, '归档包含不允许的条目类型');

  const hardlink = rebuild([
    ...entries,
    { path: 'data/avatars/hard.png', type: tarGz.TYPE_HARDLINK, linkname: 'data/agent.db', data: Buffer.alloc(0), size: 0 },
  ]);
  const hardlinkRes = await postImport(hardlink);
  assert.equal(hardlinkRes.status, 400);
  assert.match(JSON.parse(hardlinkRes.body.toString('utf8')).detail, /硬链接/);
});

test('导入拒绝：manifest 之外的路径（config 只允许 .env）与未登记文件', async () => {
  const { entries } = await baseEntries();

  const outside = rebuild([
    ...entries,
    { path: 'agent-core/data/agent.db', type: tarGz.TYPE_FILE, data: Buffer.from('x'), size: 1 },
  ]);
  const outsideRes = await postImport(outside);
  assert.equal(outsideRes.status, 400);
  assert.equal(JSON.parse(outsideRes.body.toString('utf8')).error, '归档路径不在允许范围内');

  const extra = rebuild([
    ...entries,
    { path: 'data/avatars/not-in-manifest.png', type: tarGz.TYPE_FILE, data: Buffer.from('x'), size: 1 },
  ]);
  const extraRes = await postImport(extra);
  assert.equal(extraRes.status, 400);
  assert.equal(JSON.parse(extraRes.body.toString('utf8')).error, '归档包含未在 manifest 中登记的文件');
});

test('导入拒绝：includeConfig 与实际内容矛盾', async () => {
  const withEnv = await exportEntries({ includeConfig: true });
  // manifest 说不带 .env，归档里却有 config/.env
  const lie = withManifest(withEnv.entries, manifest => { manifest.includeConfig = false; return manifest; });
  const lieRes = await postImport(lie);
  assert.equal(lieRes.status, 400);
  assert.equal(JSON.parse(lieRes.body.toString('utf8')).error, '归档含 config/.env，但 manifest.includeConfig 不是 true');

  // manifest 说带 .env，归档里却没有
  const { entries } = await baseEntries();
  const missing = withManifest(entries, manifest => { manifest.includeConfig = true; return manifest; });
  const missingRes = await postImport(missing);
  assert.equal(missingRes.status, 400);
  assert.equal(JSON.parse(missingRes.body.toString('utf8')).error, 'manifest.includeConfig=true 但归档里没有 config/.env');
});

test('导入拒绝：format/version 不对、agent.db 不是 SQLite', async () => {
  const { entries } = await baseEntries();

  const badFormat = withManifest(entries, manifest => { manifest.format = 'someone-else'; return manifest; });
  const badFormatRes = await postImport(badFormat);
  assert.equal(badFormatRes.status, 400);
  assert.equal(JSON.parse(badFormatRes.body.toString('utf8')).error, '归档格式不匹配');

  const badVersion = withManifest(entries, manifest => { manifest.version = 99; return manifest; });
  const badVersionRes = await postImport(badVersion);
  assert.equal(badVersionRes.status, 400);
  assert.equal(JSON.parse(badVersionRes.body.toString('utf8')).error, '归档版本不支持');

  // 把 agent.db 换成非 SQLite 字节，并同步 manifest 里的 sha/size（绕过 sha 校验，专测文件头校验）
  const fakeDb = Buffer.from('this is definitely not a sqlite database file');
  const swapped = withManifest(entries.map(entry => (entry.path === 'data/agent.db' ? { ...entry, data: fakeDb } : entry)), manifest => {
    const item = manifest.files.find(f => f.path === 'data/agent.db');
    item.bytes = fakeDb.length;
    item.sha256 = sha256(fakeDb);
    manifest.dbBytes = fakeDb.length;
    return manifest;
  });
  const swappedRes = await postImport(swapped);
  assert.equal(swappedRes.status, 400);
  assert.equal(JSON.parse(swappedRes.body.toString('utf8')).error, 'data/agent.db 不是 SQLite 数据库');
});

test('导入校验失败时绝不创建备份目录、绝不改现有数据', async () => {
  ensureFixtures();
  const backupsDir = path.join(DATA_DIR, 'backups');
  const before = fs.readdirSync(backupsDir).sort();
  const dbBytesBefore = fs.readFileSync(DB_PATH);

  const { entries } = await baseEntries();
  const res = await postImport(rebuild([
    ...entries,
    { path: '../evil.txt', type: tarGz.TYPE_FILE, data: Buffer.from('pwned'), size: 5 },
  ]));
  assert.equal(res.status, 400);
  assert.deepEqual(fs.readdirSync(backupsDir).sort(), before, '校验失败不得创建 pre-import 备份目录');
  assert.deepEqual(fs.readFileSync(DB_PATH), dbBytesBefore, '校验失败不得动 agent.db');
});

// ── 4. 大小上限 ──────────────────────────────────────────────────────

test('导入：请求体超过上限 → 413（压缩前）', async () => {
  const previous = process.env.LINSHE_BACKUP_MAX_BYTES;
  process.env.LINSHE_BACKUP_MAX_BYTES = '1024';
  try {
    const body = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(4096)]);
    const res = await postImport(body);
    assert.equal(res.status, 413);
    const json = JSON.parse(res.body.toString('utf8'));
    assert.equal(json.error, '归档超过大小上限');
    assert.match(json.detail, /1024/);
  } finally {
    process.env.LINSHE_BACKUP_MAX_BYTES = previous;
  }
});

test('导入：解压后总大小超过上限 → 413（压缩后很小也不行）', async () => {
  ensureFixtures();
  // 100KB 的全零文件，gzip 之后只有几十字节 —— 只有解压口径的上限才拦得住它
  const heavy = path.join(DATA_DIR, 'avatars', 'heavy-zeros.bin');
  fs.writeFileSync(heavy, Buffer.alloc(100 * 1024));
  try {
    const result = await backup.createBackup({ includeConfig: false });
    const archive = fs.readFileSync(result.file);
    const uncompressed = result.manifest.files.reduce((sum, f) => sum + f.bytes, 0);
    await result.cleanup();
    assert.ok(archive.length < uncompressed / 4, `gzip 压缩率应显著，压缩后 ${archive.length} / 原始 ${uncompressed}`);

    // 上限压到"刚好等于压缩后大小"：压缩前检查会放行，解压口径必须拦住
    const previous = process.env.LINSHE_BACKUP_MAX_BYTES;
    process.env.LINSHE_BACKUP_MAX_BYTES = String(archive.length);
    try {
      const res = await postImport(archive);
      assert.equal(res.status, 413, res.body.toString('utf8').slice(0, 200));
      assert.equal(JSON.parse(res.body.toString('utf8')).error, '归档解压后超过大小上限');
    } finally {
      process.env.LINSHE_BACKUP_MAX_BYTES = previous;
    }
  } finally {
    fs.rmSync(heavy, { force: true });
  }
});

// ── 5. 导出/信息接口的真实 HTTP 形状 ─────────────────────────────────

test('GET /api/data/export：200 + application/gzip + 正确的 Content-Disposition', async () => {
  ensureFixtures();
  const res = await request('GET', '/api/data/export?includeConfig=0');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/gzip');
  assert.match(res.headers['content-disposition'], /^attachment; filename="linshe-backup-\d{8}-\d{4}\.tar\.gz"$/);
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.ok(tarGz.isGzip(res.body));

  const entries = await tarGz.readTarGzEntries(res.body);
  const manifest = JSON.parse(entries[0].data.toString('utf8'));
  assert.equal(manifest.format, 'linshe-backup');
  assert.ok(!entries.some(e => e.path === 'config/.env'));
  console.log(`[evidence] GET /api/data/export 归档 ${res.body.length} 字节，条目 ${entries.length} 个: ${entries.map(e => e.path).join(', ')}`);
});

test('GET /api/data/export/info：返回 ok/dbBytes/counts/lastExportAt', async () => {
  ensureFixtures();
  const res = await request('GET', '/api/data/export/info');
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body.toString('utf8'));
  assert.equal(json.ok, true);
  assert.ok(json.dbBytes > 0);
  assert.ok(json.counts.characters >= 1);
  assert.ok(json.counts.groups >= 1);
  assert.ok(json.counts.messages >= 1);
  assert.equal(typeof json.lastExportAt, 'string'); // 前面的导出已经跑过
});

// ── 6. 导入成功：替换 + 备份 + 不影响运行期状态 ──────────────────────

test('导入成功：data/ 被替换、备份目录被创建、运行期 config.features 不受影响', async () => {
  ensureFixtures();
  const featuresBefore = JSON.stringify(config.features);

  // 1) 以"导出那一刻"为基准
  const archive = await exportToBuffer({ includeConfig: false });
  const avatarBefore = fs.readFileSync(AVATAR_A);

  // 2) 把现状改坏：删掉导出时存在的角色/头像，加一个"导入后应该消失"的角色和头像
  const db = getDb();
  db.prepare('DELETE FROM characters WHERE name = ?').run('备份测试角色');
  db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run('导入后应消失', '导入后应消失', 'x');
  fs.rmSync(AVATAR_A, { force: true });
  fs.writeFileSync(path.join(DATA_DIR, 'avatars', 'b.png'), Buffer.from('avatar-b'));

  // 3) 导入
  const res = await postImport(archive, { 'Content-Type': 'application/gzip' });
  assert.equal(res.status, 200, res.body.toString('utf8'));
  const json = JSON.parse(res.body.toString('utf8'));
  assert.equal(json.ok, true);
  assert.equal(typeof json.restored.files, 'number');
  assert.ok(json.restored.bytes > 0);
  assert.ok(json.restored.counts.characters >= 1);
  assert.ok(typeof json.backupPath === 'string' && json.backupPath.length > 0);
  assert.equal(typeof json.restartRecommended, 'boolean');
  assert.ok(json.message.length > 0);

  // 4) agent.db 已被替换（旧角色回来、新角色消失）
  const names = getDb().prepare('SELECT name FROM characters').all().map(row => row.name);
  assert.ok(names.includes('备份测试角色'), '导入后应恢复导出时的角色');
  assert.ok(!names.includes('导入后应消失'), '导入后不应残留导入前的角色');

  // 5) avatars 覆盖合并：a.png 恢复、b.png（归档里没有）保留
  assert.deepEqual(fs.readFileSync(AVATAR_A), avatarBefore);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'avatars', 'b.png')), true, '合并语义：归档里没有的文件不删');

  // 6) 导入前备份目录被创建，且装的是"导入前"的状态
  assert.ok(json.backupPath.startsWith(path.join(DATA_DIR, 'backups')), json.backupPath);
  assert.match(path.basename(json.backupPath), /^pre-import-\d{8}-\d{6}(-\d+)?$/);
  assert.equal(fs.existsSync(path.join(json.backupPath, 'agent.db')), true, '备份必须含 agent.db');
  assert.equal(fs.existsSync(path.join(json.backupPath, 'avatars', 'b.png')), true, '备份应是导入前状态');
  assert.equal(fs.existsSync(path.join(json.backupPath, 'avatars', 'a.png')), false, '备份应是导入前状态（a.png 当时已删）');

  // 7) 回滚路径可用：把备份里的 agent.db 拷回去，旧角色应能读出来
  closeDb();
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.copyFileSync(path.join(json.backupPath, 'agent.db'), DB_PATH);
  const rolledBack = getDb().prepare('SELECT name FROM characters').all().map(row => row.name);
  assert.ok(rolledBack.includes('导入后应消失'), '用备份路径回滚后应看到导入前的角色');
  assert.ok(!rolledBack.includes('备份测试角色'));

  // 8) 运行期状态没被导入搅动
  assert.equal(JSON.stringify(config.features), featuresBefore, '导入不得改动 config.features');
});

test('导入成功：includeConfig=1 时 .env 被写回，并要求重启加载配置', async () => {
  ensureFixtures();
  // 用一份写着自己内容的归档来验证"写回"这件事（不碰真实 .env）
  const original = fs.readFileSync(ENV_PATH, 'utf8');
  const archive = await exportToBuffer({ includeConfig: true });

  fs.writeFileSync(ENV_PATH, 'LLM_API_KEY=changed\n');
  const res = await postImport(archive, { 'Content-Type': 'application/gzip' });
  assert.equal(res.status, 200, res.body.toString('utf8'));
  const json = JSON.parse(res.body.toString('utf8'));
  assert.equal(fs.readFileSync(ENV_PATH, 'utf8'), original, '.env 应被归档内容覆盖');
  assert.equal(json.restartRecommended, true, '.env 需要重启才会被 dotenv 读进 config');
  assert.match(json.message, /重启/);
});

test('导入：两个并发导入被串行化，两次都成功且各留下一份完整备份', async () => {
  ensureFixtures();
  const archive = await exportToBuffer({ includeConfig: false });
  const backupsDir = path.join(DATA_DIR, 'backups');
  const before = fs.readdirSync(backupsDir).length;

  const [first, second] = await Promise.all([
    postImport(archive, { 'Content-Type': 'application/gzip' }),
    postImport(archive, { 'Content-Type': 'application/gzip' }),
  ]);
  assert.equal(first.status, 200, first.body.toString('utf8'));
  assert.equal(second.status, 200, second.body.toString('utf8'));

  const paths = [JSON.parse(first.body.toString('utf8')).backupPath, JSON.parse(second.body.toString('utf8')).backupPath];
  assert.notEqual(paths[0], paths[1], '两次导入应各留一份备份（时间戳不同）');
  for (const p of paths) {
    assert.equal(fs.existsSync(path.join(p, 'agent.db')), true, `备份 ${p} 必须含 agent.db`);
    assert.equal(fs.statSync(path.join(p, 'agent.db')).size > 0, true);
  }
  assert.equal(fs.readdirSync(backupsDir).length, before + 2);
  // 串行化的意义：两次都读到了完整、可用的库
  assert.ok(getDb().prepare('SELECT COUNT(*) AS c FROM characters').get().c >= 1);
});

test('导入：使用 seed 的临时库，全程真实 HTTP（restored 形状固定为 files/bytes/counts）', async () => {
  ensureFixtures();
  const { manifest } = await baseEntries();
  const archive = await exportToBuffer({ includeConfig: false });

  const res = await postImport(archive, { 'Content-Type': 'application/gzip' });
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body.toString('utf8'));
  assert.deepEqual(Object.keys(json).sort(), ['backupPath', 'message', 'ok', 'restartRecommended', 'restored'].sort());
  assert.deepEqual(Object.keys(json.restored).sort(), ['bytes', 'counts', 'files'].sort());
  assert.equal(manifest.format, 'linshe-backup');
});
