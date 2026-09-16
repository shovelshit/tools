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
