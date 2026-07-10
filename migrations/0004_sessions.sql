-- 0004_sessions: Anonymous session table for no-auth click tracking
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
