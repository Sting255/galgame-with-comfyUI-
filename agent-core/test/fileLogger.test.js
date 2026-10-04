/**
 * 文件日志（fileLogger）单测
 *
 * 背景：启动器只用 QProcess 把后端 stdout 灌进界面日志控件，**不落盘**，
 * 于是"把日志发给别人看"只能人工截图/复制。本模块把 console 输出镜像一份到
 * `<仓库根>/logs/backend-YYYY-MM-DD.log`（第 3 条：旁路功能，绝不影响主流程）。
 *
 * 本文件锁：
 *   1. 镜像与**保留原始输出**同时成立（不能把 console 抢走）；
 *   2. 行格式（ISO 时间 + [level] + 原文）与按天分文件；
 *   3. `LOG_TO_FILE=false` / `enabled:false` 时完全不落盘、也不改 console；
 *   4. 重复 init 幂等（只包一层，不重复写）；
 *   5. 过期清理（keepDays）与边界（只删 `<prefix>-YYYY-MM-DD.log`）；
 *   6. close 之后 console 复原、后续输出不再进文件。
 *
 * 用临时目录，绝不碰仓库里的 logs/。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  dayStamp,
  logFileName,
  pruneOldLogs,
  initFileLogging,
  getFileLogging,
} = await import('../src/utils/fileLogger.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-'));
const readLog = p => fs.readFileSync(p, 'utf8');

/** 每个用例结束都彻底关掉（模块内是单例，残留会串味） */
async function withLogging(options, fn) {
  // 显式 enabled:true —— 测试跑批时可能带着 LOG_TO_FILE=false（避免污染仓库 logs/），
  // 本文件都写临时目录，所以这里必须自己指定开关，才能测到镜像逻辑本身。
  const h = initFileLogging({ enabled: true, ...options });
  try {
    return await fn(h);
  } finally {
    if (h) await h.close();
  }
}

// ──────────────── 1. 纯函数 ────────────────

test('dayStamp / logFileName：本地日期与文件名口径', () => {
  const ms = new Date(2026, 8, 28, 13, 35, 16).getTime(); // 本地 2026-09-28
  assert.equal(dayStamp(ms), '2026-09-28');
  assert.equal(dayStamp(new Date(2026, 0, 5).getTime()), '2026-01-05', '单位数月日要补零');
  assert.equal(logFileName('backend', '2026-09-28'), 'backend-2026-09-28.log');
  assert.equal(logFileName('x', '2026-09-28'), 'x-2026-09-28.log');
});

test('pruneOldLogs：只删超期的 <prefix>-日期.log，别的文件不动', () => {
  const dir = tmpDir();
  const now = new Date(2026, 8, 28, 12, 0, 0).getTime();
  const day = n => new Date(now - n * 24 * 60 * 60 * 1000);
  const name = d => `backend-${dayStamp(d.getTime())}.log`;
  for (const d of [day(0), day(3), day(20), day(40)]) fs.writeFileSync(path.join(dir, name(d)), 'x');
  fs.writeFileSync(path.join(dir, 'other-2020-01-01.log'), 'x');
  fs.writeFileSync(path.join(dir, 'backend-不是日期.log'), 'x');

  const removed = pruneOldLogs(dir, 'backend', 14, now);
  assert.deepEqual(removed.sort(), [name(day(20)), name(day(40))].sort());
  assert.ok(fs.existsSync(path.join(dir, name(day(0)))));
  assert.ok(fs.existsSync(path.join(dir, name(day(3)))));
  assert.ok(fs.existsSync(path.join(dir, 'other-2020-01-01.log')), '别的前缀不能删');
  assert.ok(fs.existsSync(path.join(dir, 'backend-不是日期.log')), '解析不出日期的不删');

  assert.deepEqual(pruneOldLogs(dir, 'backend', 0, now), [], 'keepDays<=0 不清理');
  assert.deepEqual(pruneOldLogs(path.join(dir, '不存在'), 'backend', 14, now), [], '目录不存在时安全返回');
});

// ──────────────── 2. 镜像 ────────────────

test('镜像：console.log/info/warn/error 都进文件，且原始输出不被抢走', async () => {
  const dir = tmpDir();
  await withLogging({ dir, prefix: 'backend', keepDays: 14 }, async h => {
    assert.ok(h, '应返回句柄');
    assert.equal(path.dirname(h.file), path.resolve(dir));
    assert.equal(path.basename(h.file), `backend-${dayStamp()}.log`);

    // 捕获原始 stdout/stderr，确认"照旧打给人看"（error 走 stderr）
    const chunks = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = c => { chunks.push(String(c)); return true; };
    process.stderr.write = c => { chunks.push(String(c)); return true; };
    try {
      console.log('普通一行');
      console.info('信息一行');
      console.warn('警告一行');
      console.error('错误一行');
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    assert.ok(chunks.join('').includes('普通一行'), 'console.log 必须照旧输出到 stdout');
    assert.ok(chunks.join('').includes('错误一行'));

    await h.flush();
    const text = readLog(h.file);
    for (const [level, msg] of [['log', '普通一行'], ['info', '信息一行'], ['warn', '警告一行'], ['error', '错误一行']]) {
      assert.match(text, new RegExp(`^\\S+ \\[${level}\\] ${msg}$`, 'm'), `${level} 未按格式落盘`);
    }
    // 对象参数按 util.format 展开，不出现 [object Object]
    console.warn('带对象', { a: 1 });
    await h.flush();
    const text2 = readLog(h.file);
    assert.match(text2, /带对象 \{ a: 1 \}/);
    assert.ok(!text2.includes('[object Object]'));
  });
});

test('写入失败/目录不可用时只 warn，不抛给调用方', async () => {
  // 用一个"父路径是文件"的目录名，mkdirSync 必失败
  const file = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const h = initFileLogging({ dir: path.join(file, 'sub'), enabled: true });
  assert.equal(h, null, '目录建不出来时应返回 null 而不是抛错');
  assert.equal(getFileLogging(), null);
});

// ──────────────── 3. 开关与幂等 ────────────────

test('关闭时不落盘、也不改 console（enabled:false 与环境变量都算）', async () => {
  const dir = tmpDir();
  const before = console.log;
  const h = initFileLogging({ dir, enabled: false });
  assert.equal(h, null);
  assert.equal(console.log, before, '关闭时不得替换 console');
  assert.deepEqual(fs.readdirSync(dir), [], '关闭时不得创建文件');

  const h2 = initFileLogging({ dir, enabled: false });
  assert.equal(h2, null);
  assert.deepEqual(fs.readdirSync(dir), []);

  // 环境变量口径：LOG_TO_FILE=false 时不传 enabled 也应完全关闭
  const prevEnv = process.env.LOG_TO_FILE;
  process.env.LOG_TO_FILE = 'false';
  try {
    assert.equal(initFileLogging({ dir }), null, 'LOG_TO_FILE=false 应关闭落盘');
    assert.equal(console.log, before, '关闭时不得替换 console');
  } finally {
    if (prevEnv === undefined) delete process.env.LOG_TO_FILE;
    else process.env.LOG_TO_FILE = prevEnv;
  }
});

test('重复 init 幂等：同一个句柄、同一行只写一次', async () => {
  const dir = tmpDir();
  await withLogging({ dir }, async h => {
    const again = initFileLogging({ dir, enabled: true });
    assert.equal(again, h, '重复 init 应返回同一个句柄');
    console.log('只应出现一次');
    await h.flush();
    const text = readLog(h.file);
    const hits = text.split('\n').filter(l => l.endsWith('[log] 只应出现一次'));
    assert.equal(hits.length, 1, `重复写入：${hits.length} 次`);
  });
});

test('跨天：日期变化后写入新文件（旧文件保留）', async () => {
  const dir = tmpDir();
  let clock = new Date(2026, 8, 28, 23, 59, 0).getTime();
  await withLogging({ dir, now: () => clock }, async h => {
    console.log('第一天');
    await h.flush();
    const first = h.file;
    assert.ok(first.endsWith('backend-2026-09-28.log'));

    clock += 2 * 60 * 1000; // 跨到次日
    console.log('第二天');
    await h.flush();
    const second = getFileLogging().file;
    assert.ok(second.endsWith('backend-2026-09-29.log'), `未按天切分：${second}`);
    assert.ok(readLog(first).includes('第一天'));
    assert.ok(!readLog(first).includes('第二天'), '新的一天不该写进旧文件');
    assert.ok(readLog(second).includes('第二天'));
  });
});

test('close：console 复原、句柄清空、后续输出不再进文件', async () => {
  const dir = tmpDir();
  const before = console.log;
  const h = initFileLogging({ dir, enabled: true });
  assert.notEqual(console.log, before, 'init 后 console 应被镜像包裹');
  const filePath = h.file; // close 之后句柄的 .file 会清空，先记住路径
  console.log('关掉之前');
  await h.close();
  assert.equal(console.log, before, 'close 后必须复原 console');
  assert.equal(getFileLogging(), null);

  const text = readLog(filePath);
  assert.ok(text.includes('关掉之前'));
  console.log('关掉之后');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!readLog(filePath).includes('关掉之后'), 'close 之后不得再写入');

  // 关掉之后还能重新开（幂等句柄已清空）
  const h2 = initFileLogging({ dir, enabled: true });
  assert.ok(h2);
  console.log('重新开启');
  await h2.flush();
  assert.ok(readLog(h2.file).includes('重新开启'));
  await h2.close();
});

test('清理过期文件：init 时按 keepDays 删旧日志', async () => {
  const dir = tmpDir();
  const now = new Date(2026, 8, 28, 12, 0, 0).getTime();
  const oldName = `backend-${dayStamp(now - 30 * 24 * 60 * 60 * 1000)}.log`;
  fs.writeFileSync(path.join(dir, oldName), '旧日志');
  await withLogging({ dir, keepDays: 14, now: () => now }, async h => {
    assert.ok(h);
    assert.ok(!fs.existsSync(path.join(dir, oldName)), '30 天前的日志应被清掉');
  });
});
