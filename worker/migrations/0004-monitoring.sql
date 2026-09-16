CREATE TABLE IF NOT EXISTS monitor_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cinema_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  baseline_version INTEGER,
  next_due_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_due
  ON monitor_subscriptions(enabled, next_due_at, cinema_id, user_id);

CREATE TABLE IF NOT EXISTS cinema_snapshots (
  cinema_id TEXT NOT NULL,
  movie_id TEXT NOT NULL,
  movie_name TEXT NOT NULL DEFAULT '',
  seq_nos TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cinema_id, movie_id)
);

CREATE TABLE IF NOT EXISTS cinema_batches (
  cinema_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed')),
  version INTEGER NOT NULL CHECK (version > 0),
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (cinema_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_cinema_batches_latest
  ON cinema_batches(cinema_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS cinema_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cinema_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  movie_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (cinema_id, batch_id, movie_id)
);
CREATE INDEX IF NOT EXISTS idx_cinema_events_batch
  ON cinema_events(cinema_id, batch_id, id);
