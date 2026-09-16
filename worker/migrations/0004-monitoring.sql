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
  public_data TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
  ON notification_outbox(state, next_attempt_at, lease_until, id);

INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,baseline_version,next_due_at,updated_at)
SELECT u.id,COALESCE(json_extract(c.data,'$.cinemaId'),''),
  CASE WHEN json_extract(c.data,'$.enabled')=1 AND COALESCE(json_extract(c.data,'$.cinemaId'),'')!='' THEN 1 ELSE 0 END,
  c.version,NULL,CAST(unixepoch('subsec') * 1000 AS INTEGER),CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM users u JOIN user_config c ON c.token_id=u.id
ON CONFLICT(user_id) DO NOTHING;

ALTER TABLE monitor_status ADD COLUMN changes_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER IF NOT EXISTS change_log_version_insert AFTER INSERT ON change_log
BEGIN
  INSERT INTO monitor_status(token_id,data,updated_at,changes_version)
  VALUES (NEW.token_id,'{}',NEW.time,NEW.id)
  ON CONFLICT(token_id) DO UPDATE SET changes_version=MAX(monitor_status.changes_version,NEW.id);
END;
INSERT INTO monitor_status(token_id,data,updated_at,changes_version)
SELECT token_id,'{}',COALESCE(MAX(time),''),MAX(id) FROM change_log GROUP BY token_id
ON CONFLICT(token_id) DO UPDATE SET changes_version=MAX(monitor_status.changes_version,excluded.changes_version);
