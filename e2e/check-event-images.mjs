/**
 * 事件/朋友圈配图的"引用 vs 文件"缺口体检（2026-10-02，只读）
 *
 * 背景：交付包页面出现两条 404（`/images/events/event_*_ComfyUI_temp_*.png`）。
 * 本脚本把库（只读副本）里所有指向 `/images/**` 的引用抠出来，逐个核对交付包 data 目录里有没有对应文件，
 * 给出**缺口数量与清单**，用于判断"是不是我们的资源真的缺失、要不要修"。
 *
 * 跑法：..\runtime\nodejs\node.exe check-event-images.mjs
 * 只读；不改任何文件。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

// 路径必须**相对本脚本**定位（脚本在 <repo>/e2e/ ⇒ 仓库根是它的上一层）。
// 为什么：这里原本硬编码旧机器的交付目录 `C:/3.6.2-r/...`，换机器后那个目录不存在
// ⇒ createRequire 从死路径解 better-sqlite3、new Database(真库) 也直接 ENOENT，
//   脚本根本走不到体检逻辑。改成基于仓库根之后，仓库放哪个盘都成立。
const REPO = path.resolve(import.meta.dirname, '..')
const AGENT_CORE = path.join(REPO, 'agent-core')
const req = createRequire(path.join(AGENT_CORE, 'package.json'))
const Database = req('better-sqlite3')

const DB_COPY = path.join(process.env.TEMP || '/tmp', 'assets-probe.db')
const DATA_DIR = path.join(AGENT_CORE, 'data')

// 只读地做一份副本（真库 <仓库根>\agent-core\data\agent.db 不被改动）
fs.rmSync(DB_COPY, { force: true })
const src = new Database(path.join(DATA_DIR, 'agent.db'), { readonly: true, fileMustExist: true })
src.prepare('VACUUM INTO ?').run(DB_COPY)
src.close()
const db = new Database(DB_COPY, { readonly: true })

/** 收集所有 TEXT 列里形如 /images/... 的值 */
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name)
const refs = new Map()   // path -> Set(来源 "表.列")
for (const t of tables) {
  let cols = []
  try { cols = db.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /TEXT|CHAR|CLOB/i.test(c.type || '') || !c.type).map((c) => c.name) } catch { continue }
  for (const col of cols) {
    let rows = []
    try { rows = db.prepare(`SELECT ${col} AS v FROM ${t} WHERE ${col} LIKE '%/images/%' LIMIT 500`).all() } catch { continue }
    for (const r of rows) {
      const s = String(r.v || '')
      for (const m of s.matchAll(/\/images\/[A-Za-z0-9_./\-]+\.(?:png|jpg|jpeg|webp|gif)/gi)) {
        const p = m[0]
        if (!refs.has(p)) refs.set(p, new Set())
        refs.get(p).add(`${t}.${col}`)
      }
    }
  }
}

console.log(`库里指向 /images/** 的**去重引用**：${refs.size} 条`)
const missing = []
const present = []
for (const [p, from] of refs) {
  const disk = path.join(DATA_DIR, p.replace(/^\//, ''))
  ;(fs.existsSync(disk) ? present : missing).push({ p, from: [...from].join(', ') })
}
console.log(`  交付包里存在：${present.length} 条`)
console.log(`  ✗ 缺失（会 404）：${missing.length} 条`)

const byDir = {}
for (const m of missing) {
  const d = m.p.replace(/\/[^/]+$/, '')
  byDir[d] = (byDir[d] || 0) + 1
}
console.log('\n  缺失按目录：')
for (const [d, c] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) console.log(`    ${String(c).padStart(4)}  ${d}`)

console.log('\n  缺失清单（前 15 条，含引用来源）：')
for (const m of missing.slice(0, 15)) console.log(`    ${m.p}\n         ← ${m.from}`)

console.log('\n  data/images 下实际有哪些文件（按目录）：')
const walk = (dir, base = '') => {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base + '/' + e.name))
    else out.push(base + '/' + e.name)
  }
  return out
}
const files = walk(path.join(DATA_DIR, 'images'))
const fdir = {}
for (const f of files) { const d = f.replace(/\/[^/]+$/, ''); fdir[d] = (fdir[d] || 0) + 1 }
for (const [d, c] of Object.entries(fdir)) console.log(`    ${String(c).padStart(4)}  ${d}`)

console.log('\n  事件图引用 vs 文件（只看 /images/events/）：')
const evRefs = [...refs.keys()].filter((p) => p.includes('/images/events/'))
const evMissing = evRefs.filter((p) => !fs.existsSync(path.join(DATA_DIR, p.replace(/^\//, ''))))
console.log(`    引用 ${evRefs.length} 条 / 缺失 ${evMissing.length} 条 / 文件 ${files.filter((f) => f.includes('/events/')).length} 个`)

db.close()
console.log('\n（本脚本只读：真库未被改动，副本在 %TEMP%\\assets-probe.db）')
