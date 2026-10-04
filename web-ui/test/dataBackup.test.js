import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_IMPORT_BYTES,
  countsText,
  defaultBackupFileName,
  formatBytes,
  formatExportSummary,
  formatLastExport,
  importFailureText,
  importSuccessText,
  parseBackupFileName,
  restoredText,
  validateImportFile,
} from '../src/utils/dataBackup.js'

// ═══════════════════════════════════════════════════════
// 文件名字解析
// ═══════════════════════════════════════════════════════

test('parseBackupFileName 认 Content-Disposition 的三种写法', () => {
  assert.equal(
    parseBackupFileName('attachment; filename="linshe-backup-20260928-0926.tar.gz"'),
    'linshe-backup-20260928-0926.tar.gz',
  )
  assert.equal(
    parseBackupFileName('attachment; filename=linshe-backup-20260928-0926.tar.gz'),
    'linshe-backup-20260928-0926.tar.gz',
  )
  assert.equal(
    parseBackupFileName("attachment; filename*=UTF-8''linshe-backup-%E6%B5%8B%E8%AF%95.tar.gz"),
    'linshe-backup-测试.tar.gz',
  )
})

test('parseBackupFileName 缺头 / 脏头一律回落 fallback', () => {
  const fallback = 'linshe-backup-fallback.tar.gz'
  for (const bad of [null, undefined, '', '   ', 'attachment', 'attachment; filename=""']) {
    assert.equal(parseBackupFileName(bad, fallback), fallback, `${JSON.stringify(bad)} 应回落`)
  }
  assert.equal(parseBackupFileName(null), '')
})

test('parseBackupFileName 带路径只取最后一段（不把 ..\\ 放进 download 属性）', () => {
  assert.equal(parseBackupFileName('attachment; filename="C:\\tmp\\backup.tar.gz"'), 'backup.tar.gz')
  assert.equal(parseBackupFileName('attachment; filename="../../etc/backup.tar.gz"'), 'backup.tar.gz')
  assert.equal(parseBackupFileName('attachment; filename="..\\..\\backup.tar.gz"'), 'backup.tar.gz')
})

test('parseBackupFileName 优先 filename*，编码坏了也不抛错', () => {
  assert.equal(
    parseBackupFileName("attachment; filename=\"plain.tar.gz\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95.tar.gz"),
    '测试.tar.gz',
  )
  // 非法百分号编码：退回原文而不是抛异常
  assert.equal(parseBackupFileName("attachment; filename*=UTF-8''%E6%B5%8B%ZZ.tar.gz"), '%E6%B5%8B%ZZ.tar.gz')
})

test('defaultBackupFileName 与后端同名规则一致（本地时间）', () => {
  assert.equal(defaultBackupFileName(new Date(2026, 8, 28, 9, 26)), 'linshe-backup-20260928-0926.tar.gz')
  assert.equal(defaultBackupFileName(new Date(2026, 0, 1, 0, 5)), 'linshe-backup-20260101-0005.tar.gz')
  // 非法日期退回当前时间，仍然是合法文件名
  assert.match(defaultBackupFileName(new Date('nope')), /^linshe-backup-\d{8}-\d{4}\.tar\.gz$/)
})

// ═══════════════════════════════════════════════════════
// export/info 摘要
// ═══════════════════════════════════════════════════════

test('formatBytes 分档与边界', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1 MB')
  assert.equal(formatBytes(134 * 1024 * 1024), '134 MB')
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2 GB')
  assert.equal(formatBytes(1536 * 1024 * 1024), '1.5 GB')
  for (const bad of [null, undefined, '', -1, NaN, 'abc', {}]) {
    assert.equal(formatBytes(bad), '—', `${JSON.stringify(bad)} 应回退为 —`)
  }
})

test('countsText 四类条数，缺失项显示 —（不把 null 说成 0）', () => {
  assert.equal(
    countsText({ characters: 12, messages: 3456, groups: 4, memories: 78 }),
    '角色 12 · 消息 3456 · 群聊 4 · 记忆 78',
  )
  assert.equal(
    countsText({ characters: null, messages: undefined, groups: 0, memories: '5' }),
    '角色 — · 消息 — · 群聊 0 · 记忆 5',
  )
  assert.equal(countsText(null), '角色 — · 消息 — · 群聊 — · 记忆 —')
})

test('formatExportSummary 拼出一行摘要，并明说大小是估算上界', () => {
  const now = new Date(2026, 8, 28, 12, 0)
  assert.equal(
    formatExportSummary({
      dbBytes: 134 * 1024 * 1024,
      counts: { characters: 12, messages: 3456, groups: 4, memories: 78 },
      lastExportAt: new Date(2026, 8, 28, 9, 26).toISOString(),
    }, now),
    '角色 12 · 消息 3456 · 群聊 4 · 记忆 78 · 预计大小 134 MB（估算上界） · 上次导出 09-28 09:26',
  )
  // 没有 lastExportAt 时摘要到大小为止
  assert.equal(
    formatExportSummary({ dbBytes: 1024, counts: { characters: 1, messages: 2, groups: 0, memories: 0 } }, now),
    '角色 1 · 消息 2 · 群聊 0 · 记忆 0 · 预计大小 1 KB（估算上界）',
  )
  assert.equal(formatLastExport(new Date(2026, 8, 28, 9, 26).toISOString(), now), '上次导出 09-28 09:26')
  assert.equal(formatLastExport(new Date(2025, 11, 31, 8, 3).toISOString(), now), '上次导出 2025-12-31 08:03')
  assert.equal(formatLastExport(null), '')
  assert.equal(formatLastExport('nope'), '')
})

test('formatExportSummary 对空响应 / 缺字段兜底，不显示 NaN', () => {
  assert.equal(formatExportSummary(null), '暂无可用数据')
  assert.equal(formatExportSummary({}), '角色 — · 消息 — · 群聊 — · 记忆 —')
  assert.equal(
    formatExportSummary({ dbBytes: null, counts: { characters: 1 } }),
    '角色 1 · 消息 — · 群聊 — · 记忆 —',
  )
  assert.ok(!/NaN|undefined/.test(formatExportSummary({ dbBytes: 'abc', counts: {} })))
})

// ═══════════════════════════════════════════════════════
// 导入前置校验
// ═══════════════════════════════════════════════════════

test('validateImportFile 放行正常 .tar.gz / .gz / .tgz', () => {
  for (const name of ['a.tar.gz', 'A.TAR.GZ', 'backup.tgz', 'backup.gz']) {
    const result = validateImportFile({ name, size: 1024 })
    assert.equal(result.ok, true, `${name} 应通过`)
    assert.equal(result.reason, '')
  }
})

test('validateImportFile 拒绝缺文件 / 错后缀 / 空文件', () => {
  assert.deepEqual(
    validateImportFile(null),
    { ok: false, code: 'missing', reason: '请先选择要导入的备份文件' },
  )
  assert.equal(validateImportFile({ name: '   ', size: 10 }).code, 'missing')

  const suffix = validateImportFile({ name: 'backup.zip', size: 10 })
  assert.equal(suffix.ok, false)
  assert.equal(suffix.code, 'suffix')
  assert.match(suffix.reason, /\.tar\.gz/)

  const empty = validateImportFile({ name: 'backup.tar.gz', size: 0 })
  assert.equal(empty.code, 'empty')
  assert.match(empty.reason, /空的/)
  assert.equal(validateImportFile({ name: 'backup.tar.gz' }).code, 'empty')
  assert.equal(validateImportFile({ name: 'backup.tar.gz', size: -1 }).code, 'empty')
})

test('validateImportFile 超过上限直接拒绝（默认 2GB）', () => {
  assert.equal(MAX_IMPORT_BYTES, 2 * 1024 * 1024 * 1024)
  assert.equal(validateImportFile({ name: 'a.tar.gz', size: MAX_IMPORT_BYTES }).ok, true)

  const big = validateImportFile({ name: 'a.tar.gz', size: MAX_IMPORT_BYTES + 1 })
  assert.equal(big.ok, false)
  assert.equal(big.code, 'too-large')
  assert.match(big.reason, /2 GB 上限/)
  assert.match(big.reason, /2 GB/)

  // 自定义上限（便于单测与以后的配置化）
  const custom = validateImportFile({ name: 'a.tar.gz', size: 2048 }, { maxBytes: 1024 })
  assert.equal(custom.code, 'too-large')
  assert.match(custom.reason, /1 KB 上限/)
})

// ═══════════════════════════════════════════════════════
// 导入回执 → 人话
// ═══════════════════════════════════════════════════════

test('restoredText 把 restored 拼成人话', () => {
  assert.equal(
    restoredText({
      files: 12,
      bytes: 134 * 1024 * 1024,
      counts: { characters: 12, messages: 3456, groups: 4, memories: 78 },
    }),
    '已恢复 12 个文件 / 134 MB；角色 12 · 消息 3456 · 群聊 4 · 记忆 78',
  )
  assert.equal(restoredText({ files: 1, bytes: 0 }), '已恢复 1 个文件 / 0 B')
  assert.equal(restoredText({}), '已恢复数据')
  assert.equal(restoredText(null), '')
  assert.ok(!/NaN/.test(restoredText({ files: 'x', bytes: 'y', counts: {} })))
})

test('importSuccessText 在 restartRecommended 时补「建议重启应用」', () => {
  assert.equal(
    importSuccessText({ message: '导入完成', restartRecommended: false }),
    '导入完成',
  )
  assert.equal(
    importSuccessText({ message: '导入完成', restartRecommended: true }),
    '导入完成；建议重启应用',
  )
  // 后端没给 message 时也给一句人话
  assert.equal(importSuccessText({ restartRecommended: true }), '备份已导入；建议重启应用')
  assert.equal(importSuccessText(null), '备份已导入')
})

test('importFailureText 带 backupPath 时把路径显示出来', () => {
  const err = Object.assign(new Error('导入过程中出错'), { backupPath: 'D:\\linshe\\data\\backups\\20260928-092600' })
  const text = importFailureText(err)
  assert.match(text, /^导入过程中出错；导入前的数据已自动备份到 /)
  assert.ok(text.includes('20260928-092600'))

  assert.equal(importFailureText(new Error('归档格式不对')), '归档格式不对')
  assert.equal(importFailureText(new Error('归档格式不对', {})), '归档格式不对')
  assert.equal(importFailureText(null), '导入失败')

  const withDetail = Object.assign(new Error('归档超过大小上限'), { backupPath: '' })
  assert.equal(importFailureText(withDetail), '归档超过大小上限')
})
