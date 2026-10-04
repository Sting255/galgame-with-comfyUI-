/**
 * 文件日志：大小轮转 + 级别过滤（2026-10-02 优化，用户：「继续优化」）
 *
 * 改之前的两件事：
 *   ① 只按天清理（keepDays），**单日文件没有上限** ⇒ 玩一天能写出 10 MB+（prompt 转储占大头），
 *      既不好 grep（我做过好几次取证，31,677 行里捞线索），也怕哪天写爆磁盘；
 *   ② 每行其实已经带 `[log]/[info]/[warn]/[error]`，但**没法只写重点** —— 想排查时只能全量筛。
 *
 * 现在：`maxSizeMb`（默认 20 MB）到了就把当天文件滚成 `.1` / `.2`（最多 3 份，最老的覆盖）；
 *      `LOG_LEVEL=warn` 时只把 warn/error 写盘（**终端照旧全打**，不丢原始输出）。
 * 默认值与以前完全一致（全写、不限制滚动点数的那一天照样写）⇒ 正常使用零感知。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initFileLogging, logFileName, dayStamp } from '../src/utils/fileLogger.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'filelog-'))

/** 关掉文件日志（避免把测试输出写进仓库 logs/），并还原 console */
const withLogger = async (opts, fn) => {
  const dir = tmpDir()
  // enabled: true 必须显式给 —— 跑测试时环境里通常有 LOG_TO_FILE=false（内存库那套），
  // 不写就会直接返回 null，测的就不是轮转而是"啥也没发生"了。
  const h = initFileLogging({ enabled: true, dir, prefix: 'test', keepDays: 14, ...opts })
  assert.ok(h, 'initFileLogging 应当返回句柄（enabled: true）')
  try {
    await fn(h, dir)
  } finally {
    await h?.close()
  }
}

test('① 大小轮转：写爆上限就在 .log/.1/.2 之间循环复用（份数恒为 maxFiles）', async () => {
  // 上限设 0.002 MB ≈ 2 KB，方便在测试里"写爆"
  await withLogger({ maxSizeMb: 0.002, maxFiles: 3 }, async (h, dir) => {
    const day = dayStamp()
    const stem = logFileName('test', day).slice(0, -'.log'.length)
    const payload = 'x'.repeat(400)
    // 写 30 行 × ~450 字节 ≈ 13.5 KB ⇒ 大约滚 6 次（远超保留的 3 份 ⇒ 一定会循环复用）
    for (let i = 0; i < 30; i++) console.log(`行${i} ${payload}`)
    await h.flush()

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('test-')).sort()
    assert.ok(files.length <= 3, `份数恒为 3，实际 ${files.length}：${files.join(', ')}`)
    assert.ok(files.length >= 2, `写爆多次至少该用到 2 份，实际 ${files.length}：${files.join(', ')}`)
    // 只用这三个名字，不产生 .3 之类的新名字（循环复用，不改名也不删除）
    for (const f of files) {
      assert.ok([`${stem}.log`, `${stem}.1.log`, `${stem}.2.log`].includes(f), `出现了预期外的文件名：${f}`)
    }
    // 最新一行一定还在（在最年轻那份里）；最早的行早已随循环复用被覆盖掉
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
    assert.match(all, /行29 /, '最新写入的行必须还在（不能被自己的轮转吃掉）')
    assert.doesNotMatch(all, /行0 /, '最早的行应当被循环复用覆盖掉（只留 3 份）')
    assert.match(all, /行2[5-9] /, '最近几行至少要能查到')
  })
})

test('② 级别过滤：LOG_LEVEL=warn 时只写 warn/error，终端仍全打', async () => {
  const seen = []
  const origLog = console.log
  await withLogger({ minLevel: 'warn' }, async (h, dir) => {
    // 借 console 的原始输出记录"终端照旧"
    console.error('错误行')
    console.warn('警告行')
    console.log('普通行')
    console.info('信息行')
    await h.flush()
    const txt = fs.readFileSync(h.file, 'utf8')
    assert.match(txt, /\[error\].*错误行/, 'error 必须写盘')
    assert.match(txt, /\[warn\].*警告行/, 'warn 必须写盘')
    assert.doesNotMatch(txt, /普通行/, 'log 级别不该写盘')
    assert.doesNotMatch(txt, /信息行/, 'info 级别不该写盘')
  })
  assert.equal(console.log, origLog, 'close 后 console.log 必须还原成同一个函数')
})

test('③ 默认不改变行为：minLevel 缺省时四个级别全写（与优化前一致）', async () => {
  await withLogger({ maxSizeMb: 20 }, async (h) => {
    console.log('普通行')
    console.info('信息行')
    console.warn('警告行')
    console.error('错误行')
    await h.flush()
    const txt = fs.readFileSync(h.file, 'utf8')
    for (const kw of ['普通行', '信息行', '警告行', '错误行']) assert.match(txt, new RegExp(kw), `${kw} 应当写盘（默认全写）`)
  })
})

test('④ 每行带级别与 ISO 时间戳（排障靠它筛）', async () => {
  await withLogger({ maxSizeMb: 20 }, async (h) => {
    console.warn('格式检查')
    await h.flush()
    const line = fs.readFileSync(h.file, 'utf8').trim().split('\n').pop()
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[warn\] 格式检查$/)
  })
})

test('⑤ LOG_TO_FILE=false 时完全不落盘', () => {
  const dir = tmpDir()
  const h = initFileLogging({ dir, prefix: 'test', enabled: false })
  assert.equal(h, null)
  assert.deepEqual(fs.readdirSync(dir), [])
})
