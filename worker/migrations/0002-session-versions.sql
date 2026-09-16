CREATE TABLE IF NOT EXISTS session_versions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  active_version INTEGER NOT NULL CHECK (active_version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);
