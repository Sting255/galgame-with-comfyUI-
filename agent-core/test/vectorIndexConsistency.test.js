/**
 * 向量索引 ↔ 数据库一致性自检（2026-10-01 真机发现的**第二个**「导入后派生数据没跟着走」）
 *
 * ## 现场
 * 真机库：`memory_fragments` **420 行全部** `embedding_state='indexed'`、`chroma_id` 非空、profile 一致；
 * 而向量库里对应的语料几乎没有内容。
 * ⇒ 403 条 active 记忆的**向量检索等于没有**，而库里那句「已索引」让系统以为一切正常。
 * 与「578 张图丢了」是同一类成因：一键导入只换 `agent.db`，不带派生数据。
 *
 * 这里测的是**判定与出口**（真重建由 `reindexAllMemories` 负责，不在本用例范围）。
 *
 * ## 三轮踩坑都钉在用例里（都带真机证据）
 * 1. 语料名取自**库里的行**（`memory_v2_<embedding_profile>`），不是当前设置 —— 第一版用
 *    `getEmbeddingProfile()` 取，嵌入未配置时它返回 null，实测**根本没生效**。
 * 2. 判据是**条数**不是「空不空」—— 真机语料里有 16 条陈年向量，非空 ⇒ 第一版判成"一致"。
 * 3. 探针**必须带 embedding**，且「维度不符」这类**重建也救不了**的错只报警、不重建 ——
 *    否则每次启动都重建 403 条记忆，拿用户的嵌入额度在烧钱。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { ensureVectorIndexConsistency } = await import('../src/services/memory/memoryRepository.js')

/** 造 n 条 active + embedding_state='indexed' 的记忆（profile 固定 'fp' ⇒ 语料 memory_v2_fp） */
function seedIndexed(db, n) {
  const stmt = db.prepare(`INSERT INTO memory_fragments
    (conversation_id, fragment_type, content, chroma_id, embedding_profile, embedding_state, status)
    VALUES ('char_1', 'fact', ?, ?, 'fp', 'indexed', 'active')`)
  for (let i = 0; i < n; i++) stmt.run(`记忆 ${i}`, `chroma_${i}`)
}

const fakeEmbed = async () => ({ embedding: [0.1, 0.2, 0.3] })

test('库里说已索引、向量语料几乎是空的 ⇒ 判定失同步并触发重建', async () => {
  const db = getDb()
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 420)
  let reindexed = 0
  const r = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    // 真机现场：语料里只剩 16 条陈年向量。**注意**：这里非空，所以「语料是否为空」那个判据会漏判。
    searchVectors: async (text, opts) => {
      assert.equal(opts.corpus, 'memory_v2_fp', '必须按库里那批行的 embedding_profile 去探')
      assert.equal(opts.topK, 100, 'activeIndexed 超过服务端上限时就按上限 100 探')
      assert.ok(Array.isArray(opts.embedding), '探针必须带上 embedding（否则维度不符、次次误判）')
      return Array.from({ length: 16 }, (_, i) => ({ id: 'old_' + i }))
    },
    reindex: async () => { reindexed++; return { total: 420, queued: 420 } },
  })
  assert.equal(r.checked, true)
  assert.equal(r.inSync, false)
  assert.equal(r.activeIndexed, 420)
  assert.equal(r.hits, 16)
  assert.equal(r.corpus, 'memory_v2_fp')
  assert.equal(reindexed, 1, '必须真的去重建，不能只打日志')
  assert.deepEqual(r.reindexed, { total: 420, queued: 420 })
})

test('探针拿到满额（或 90% 以上）⇒ 判定一致，不重建（不误伤）', async () => {
  const db = getDb()
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 420)
  let reindexed = 0
  const r = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    searchVectors: async (text, opts) => Array.from({ length: opts.topK }, (_, i) => ({ id: 'c' + i })),
    reindex: async () => { reindexed++; },
  })
  assert.equal(r.inSync, true)
  assert.equal(r.hits, 100)
  assert.equal(reindexed, 0)

  // 小库：activeIndexed < 100 时按实际条数探
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 30)
  const r2 = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    searchVectors: async (text, opts) => {
      assert.equal(opts.topK, 30, 'activeIndexed 小于上限就按它探')
      return Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i }))
    },
    reindex: async () => { reindexed++; },
  })
  assert.equal(r2.inSync, true)
  assert.equal(reindexed, 0)
})

test('维度不符这类「重建也救不了」的错 ⇒ 只报警、绝不重建（防每次启动烧一遍嵌入额度）', async () => {
  const db = getDb()
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 420)
  let reindexed = 0
  const r = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    searchVectors: async () => { throw new Error('Search error: Collection expecting embedding with dimension of 1024, got 768') },
    reindex: async () => { reindexed++; },
  })
  assert.equal(r.checked, true)
  assert.equal(r.inSync, false)
  assert.equal(r.unavailable, true)
  assert.match(r.error, /dimension of 1024/)
  assert.equal(reindexed, 0, '维度问题重建也救不了 ⇒ 必须不重建')
})

test('记忆太少（新装 / 新建库）不判 —— 避免误报与无谓重建', async () => {
  const db = getDb()
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 5)
  let reindexed = 0
  let probed = 0
  const r = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    searchVectors: async () => { probed++; return [] },
    reindex: async () => { reindexed++; },
  })
  assert.equal(r.checked, false)
  assert.equal(r.activeIndexed, 5)
  assert.equal(probed, 0, '门槛以下连探都不探')
  assert.equal(reindexed, 0)
})

test('只有「已索引 + active + 有 profile」的才算数（stale / deleted / 空 profile 都不该触发判断）', async () => {
  const db = getDb()
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 30)
  db.prepare(`UPDATE memory_fragments SET embedding_state='stale' WHERE id IN (SELECT id FROM memory_fragments LIMIT 20)`).run()
  db.prepare(`UPDATE memory_fragments SET status='deleted' WHERE id IN (SELECT id FROM memory_fragments LIMIT 9)`).run()
  let reindexed = 0
  const r = await ensureVectorIndexConsistency({
    db, embed: fakeEmbed, searchVectors: async () => [], reindex: async () => { reindexed++; },
  })
  assert.equal(r.checked, false, `实际 activeIndexed=${r.activeIndexed}`)
  assert.equal(reindexed, 0)

  // 有量但没有 profile ⇒ 推不出语料名，也不判
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 50)
  db.prepare(`UPDATE memory_fragments SET embedding_profile = ''`).run()
  const r2 = await ensureVectorIndexConsistency({
    db, embed: fakeEmbed, searchVectors: async () => [], reindex: async () => { reindexed++; },
  })
  assert.equal(r2.checked, false, '没有 profile 就判不了，不能瞎重建')
  assert.equal(reindexed, 0)
})

test('向量服务没起来 ⇒ 跳过（暂时性），不影响启动、绝不乱重建', async () => {
  const db = getDb()
  db.prepare('DELETE FROM memory_fragments').run()
  seedIndexed(db, 420)
  let reindexed = 0
  const r = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    searchVectors: async () => { throw new Error('fetch failed') },
    reindex: async () => { reindexed++; },
  })
  assert.equal(r.checked, false)
  assert.equal(r.unreachable, true)
  assert.equal(reindexed, 0)
  // 重建自己抛错也不能冒出去
  const r2 = await ensureVectorIndexConsistency({
    db,
    embed: fakeEmbed,
    searchVectors: async () => [],
    reindex: async () => { throw new Error('reindex boom') },
  })
  assert.equal(r2.checked, false)
  assert.match(r2.error, /reindex boom/)
})

test('源码级：启动时真的挂上了自检，且用了现成的重建入口', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  assert.match(app, /ensureVectorIndexConsistency\(\)/, 'app.js 启动要调它')
  assert.match(app, /import \{[^}]*ensureVectorIndexConsistency[^}]*\} from '\.\/src\/services\/memory\/memoryRepository\.js'/)
  const repo = readFileSync(new URL('../src/services/memory/memoryRepository.js', import.meta.url), 'utf8')
  assert.match(repo, /const reindexed = await reindex\(\);/, '失同步时必须调重建')
  assert.match(repo, /MIN_ACTIVE_INDEXED_FOR_CHECK/, '要有门槛常量')
  assert.match(repo, /GROUP BY embedding_profile/, '语料名必须从库里的 embedding_profile 推')
  assert.match(repo, /embedding = embedded\?\.embedding/, '探针必须带上 embedding')
  assert.match(repo, /dimension\|expecting embedding/, '维度类错误要单独分流（不重建）')
})
