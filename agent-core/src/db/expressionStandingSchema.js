export function migrateExpressionStandings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_expression_standings (
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      slot_id TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      requirement TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      image_url TEXT,
      source_url TEXT,
      bounds_json TEXT,
      status TEXT NOT NULL DEFAULT 'empty',
      error TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(character_id, slot_id)
    );
    CREATE TABLE IF NOT EXISTS expression_standing_jobs (
      id TEXT PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      slots_json TEXT NOT NULL,
      status TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS standing_display_selection (
      id INTEGER PRIMARY KEY CHECK(id=1),
      character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(expression_standing_jobs)').all().some(c => c.name === 'request_json')) {
    db.exec("ALTER TABLE expression_standing_jobs ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'");
  }
  // 2026-10-01（延续主立绘的口径，见 services/worldSignature.js）：
  // 表情立绘的每个槽位也记下"这张图是在哪个世界观下生成的"（签名 = 世界观 id + 内容哈希）。
  // 没有它：世界观改了以后，聊天里显示的表情立绘还是旧世界的形象，而系统不知道。
  if (!db.prepare('PRAGMA table_info(character_expression_standings)').all().some(c => c.name === 'world_sig')) {
    db.exec('ALTER TABLE character_expression_standings ADD COLUMN world_sig TEXT');
  }
}

export function recoverExpressionStandingJobs(db) {
  db.transaction(() => {
    db.prepare(`UPDATE character_expression_standings SET status='failed',error='服务重启导致生成中断，请重试' WHERE status IN ('queued','generating')`).run();
    db.prepare(`UPDATE expression_standing_jobs SET status='failed',error='服务重启导致生成中断，请重试' WHERE status IN ('queued','prompts','generating','stopping','paused')`).run();
  })();
}
