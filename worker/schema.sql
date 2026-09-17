-- ============ tools-api D1 schema(用户状态全链路存储) ============
-- 适用: Cloudflare D1(SQLite)。KV 仅保留 maoyan-session 加密会话与 cache:cinemas:* 影院缓存。
-- 建库: wrangler d1 create tools-db
-- 建表: wrangler d1 execute tools-db --remote --file schema.sql
-- 说明: config/status/lock-rule 按令牌一行(JSON blob), snapshot 按 (token_id, movie_id) 一行,
--       change_log 追加式全量历史(读取时 LIMIT 100 与旧 KV 上限语义一致), seatfb 用原 KV key 作主键。

-- ============ account lifecycle v1 ============
-- Runtime authentication uses hashed access_keys; the retired plaintext
-- tokens migration source is intentionally absent from fresh databases.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  remark TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  archived_at INTEGER,
  archive_reason TEXT,
  revoked_at INTEGER,
  source TEXT NOT NULL DEFAULT 'public',
  business_line TEXT NOT NULL DEFAULT 'maoyan' CHECK (business_line IN ('maoyan', 'store')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((role = 'admin' AND expires_at IS NULL) OR role = 'user')
);

CREATE INDEX IF NOT EXISTS idx_users_business_state_expiry
  ON users(business_line, state, expires_at);

CREATE TABLE IF NOT EXISTS access_keys (
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  key_prefix TEXT NOT NULL DEFAULT '',
  key_suffix TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_monitor_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  admin_token_hash TEXT NOT NULL CHECK (length(admin_token_hash) = 64),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_monitor_sessions_expiry
  ON admin_monitor_sessions(expires_at);

CREATE TABLE IF NOT EXISTS store_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  business_line TEXT NOT NULL CHECK (business_line IN ('store')),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  admin_token_hash TEXT CHECK (admin_token_hash IS NULL OR length(admin_token_hash) = 64),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_sessions_expiry ON store_sessions(expires_at);

CREATE TABLE IF NOT EXISTS session_versions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  active_version INTEGER NOT NULL CHECK (active_version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollment_claims (
  user_id TEXT NOT NULL REFERENCES users(id),
  fingerprint_digest TEXT,
  fingerprint_version TEXT,
  initial_ip_digest TEXT,
  request_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollment_reservations (
  reservation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  fingerprint_digest TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL,
  initial_ip_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprint_bindings (
  fingerprint_digest TEXT PRIMARY KEY,
  fingerprint_version TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  reservation_id TEXT REFERENCES enrollment_reservations(reservation_id),
  bound_until INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((user_id IS NULL) != (reservation_id IS NULL))
);

CREATE TABLE IF NOT EXISTS service_settings (
  id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
  business_line TEXT NOT NULL UNIQUE CHECK (business_line IN ('maoyan', 'store')),
  max_users INTEGER NOT NULL DEFAULT 20 CHECK (max_users >= 0),
  default_valid_days INTEGER NOT NULL DEFAULT 15 CHECK (default_valid_days > 0),
  public_signup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_signup_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO service_settings
  (id, business_line, max_users, default_valid_days, public_signup_enabled, version, updated_at)
VALUES (1, 'maoyan', 20, 15, 0, 1, 0);

INSERT OR IGNORE INTO service_settings
  (id, business_line, max_users, default_valid_days, public_signup_enabled, version, updated_at)
VALUES (2, 'store', 20, 15, 0, 1, 0);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  subject_user_id TEXT,
  request_id TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_subject ON audit_events(subject_user_id, id DESC);

CREATE TABLE IF NOT EXISTS revocation_cleanup (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  created_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS mutation_guards (
  request_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE IF NOT EXISTS account_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_version INTEGER NOT NULL,
  result_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id, kind)
);

CREATE VIEW IF NOT EXISTS capacity_usage AS
SELECT business_line, 'user' AS kind, id AS resource_id
FROM users
WHERE role = 'user' AND state != 'revoked'
  AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
UNION ALL
SELECT 'maoyan' AS business_line, 'reservation' AS kind, reservation_id AS resource_id
FROM enrollment_reservations
WHERE expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER);

CREATE TRIGGER IF NOT EXISTS users_capacity_insert AFTER INSERT ON users
WHEN NEW.role = 'user' AND NEW.state != 'revoked'
  AND NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = NEW.business_line) >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = NEW.business_line), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS users_capacity_update AFTER UPDATE OF role, state, expires_at, business_line ON users
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = NEW.business_line) >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = NEW.business_line), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS reservations_capacity_insert AFTER INSERT ON enrollment_reservations
WHEN NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = 'maoyan') >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = 'maoyan'), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS reservations_capacity_update AFTER UPDATE OF expires_at ON enrollment_reservations
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = 'maoyan') >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = 'maoyan'), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS settings_capacity_update BEFORE UPDATE OF max_users ON service_settings
BEGIN
  SELECT CASE WHEN NEW.max_users < (SELECT COUNT(*) FROM capacity_usage WHERE business_line = NEW.business_line)
    THEN RAISE(ABORT, 'CAPACITY_BELOW_USAGE') END;
END;

CREATE TABLE IF NOT EXISTS user_config (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS monitor_status (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  changes_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitor_snapshot (
  token_id TEXT NOT NULL,
  movie_id TEXT NOT NULL,
  seq_nos TEXT NOT NULL,            -- JSON 数组: ["seqNo", ...]
  updated_at TEXT NOT NULL,
  PRIMARY KEY (token_id, movie_id)
);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  time TEXT NOT NULL,
  type TEXT,
  text TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_log_token ON change_log (token_id, id DESC);

CREATE TRIGGER IF NOT EXISTS change_log_version_insert AFTER INSERT ON change_log
BEGIN
  INSERT INTO monitor_status(token_id,data,updated_at,changes_version)
  VALUES (NEW.token_id,'{}',NEW.time,NEW.id)
  ON CONFLICT(token_id) DO UPDATE SET changes_version=MAX(monitor_status.changes_version,NEW.id);
END;

-- ============ shared cinema monitoring ============
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

CREATE TABLE IF NOT EXISTS seat_feedback (
  fb_key TEXT PRIMARY KEY,          -- 原 KV key: seatfb:{cinemaId}:{seqNo||"na"}
  reported_at TEXT NOT NULL,
  day TEXT,
  token_id TEXT,
  cinema_id TEXT,
  movie_id TEXT,
  seq_no TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS lock_rule (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,               -- JSON: 规则状态机全文
  updated_at TEXT NOT NULL
);

-- Revocation deletes operational rows. These guards also close the check/write
-- race for requests authenticated just before the account became revoked.
CREATE TRIGGER IF NOT EXISTS runtime_guard_user_config_insert BEFORE INSERT ON user_config WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_user_config_update BEFORE UPDATE ON user_config WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_monitor_status_insert BEFORE INSERT ON monitor_status WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_monitor_status_update BEFORE UPDATE ON monitor_status WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_monitor_snapshot_insert BEFORE INSERT ON monitor_snapshot WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_monitor_snapshot_update BEFORE UPDATE ON monitor_snapshot WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_change_log_insert BEFORE INSERT ON change_log WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_lock_rule_insert BEFORE INSERT ON lock_rule WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_lock_rule_update BEFORE UPDATE ON lock_rule WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_monitor_subscription_insert BEFORE INSERT ON monitor_subscriptions WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_monitor_subscription_update BEFORE UPDATE ON monitor_subscriptions WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_notification_outbox_insert BEFORE INSERT ON notification_outbox WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_notification_outbox_update BEFORE UPDATE ON notification_outbox WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_session_version_insert BEFORE INSERT ON session_versions WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_session_version_update BEFORE UPDATE ON session_versions WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_store_session_insert BEFORE INSERT ON store_sessions WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS runtime_guard_store_session_update BEFORE UPDATE ON store_sessions WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND state='revoked') BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
