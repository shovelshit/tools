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
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((role = 'admin' AND expires_at IS NULL) OR role = 'user')
);

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
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_users INTEGER NOT NULL DEFAULT 20 CHECK (max_users >= 0),
  default_valid_days INTEGER NOT NULL DEFAULT 15 CHECK (default_valid_days > 0),
  public_signup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_signup_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO service_settings
  (id, max_users, default_valid_days, public_signup_enabled, version, updated_at)
VALUES (1, 20, 15, 0, 1, 0);

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

CREATE TABLE IF NOT EXISTS account_migrations (
  name TEXT PRIMARY KEY,
  activated_at INTEGER NOT NULL
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
SELECT 'user' AS kind, id AS resource_id
FROM users
WHERE role = 'user' AND state != 'revoked'
  AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
UNION ALL
SELECT 'reservation' AS kind, reservation_id AS resource_id
FROM enrollment_reservations
WHERE expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER);

CREATE TRIGGER IF NOT EXISTS users_capacity_insert AFTER INSERT ON users
WHEN NEW.role = 'user' AND NEW.state != 'revoked'
  AND NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage) >
    COALESCE((SELECT max_users FROM service_settings WHERE id = 1), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS users_capacity_update AFTER UPDATE OF role, state, expires_at ON users
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage) >
    COALESCE((SELECT max_users FROM service_settings WHERE id = 1), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS reservations_capacity_insert AFTER INSERT ON enrollment_reservations
WHEN NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage) >
    COALESCE((SELECT max_users FROM service_settings WHERE id = 1), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS reservations_capacity_update AFTER UPDATE OF expires_at ON enrollment_reservations
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage) >
    COALESCE((SELECT max_users FROM service_settings WHERE id = 1), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER IF NOT EXISTS settings_capacity_update BEFORE UPDATE OF max_users ON service_settings
BEGIN
  SELECT CASE WHEN NEW.max_users < (SELECT COUNT(*) FROM capacity_usage)
    THEN RAISE(ABORT, 'CAPACITY_BELOW_USAGE') END;
END;
