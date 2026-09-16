DROP TRIGGER IF EXISTS users_capacity_insert;
DROP TRIGGER IF EXISTS users_capacity_update;
DROP TRIGGER IF EXISTS reservations_capacity_insert;
DROP TRIGGER IF EXISTS reservations_capacity_update;
DROP TRIGGER IF EXISTS settings_capacity_update;
DROP VIEW IF EXISTS capacity_usage;

ALTER TABLE users ADD COLUMN business_line TEXT NOT NULL DEFAULT 'maoyan'
  CHECK (business_line IN ('maoyan', 'store'));
CREATE INDEX IF NOT EXISTS idx_users_business_state_expiry
  ON users(business_line, state, expires_at);

CREATE TABLE store_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  business_line TEXT NOT NULL CHECK (business_line IN ('store')),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  admin_token_hash TEXT CHECK (admin_token_hash IS NULL OR length(admin_token_hash) = 64),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_store_sessions_expiry ON store_sessions(expires_at);

ALTER TABLE service_settings RENAME TO service_settings_legacy;
CREATE TABLE service_settings (
  id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
  business_line TEXT NOT NULL UNIQUE CHECK (business_line IN ('maoyan', 'store')),
  max_users INTEGER NOT NULL DEFAULT 20 CHECK (max_users >= 0),
  default_valid_days INTEGER NOT NULL DEFAULT 15 CHECK (default_valid_days > 0),
  public_signup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_signup_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO service_settings
  (id, business_line, max_users, default_valid_days, public_signup_enabled, version, updated_at)
SELECT 1, 'maoyan', max_users, default_valid_days, public_signup_enabled, version, updated_at
FROM service_settings_legacy WHERE id = 1;
INSERT INTO service_settings
  (id, business_line, max_users, default_valid_days, public_signup_enabled, version, updated_at)
VALUES (2, 'store', 20, 15, 0, 1, 0);
DROP TABLE service_settings_legacy;

CREATE VIEW capacity_usage AS
SELECT business_line, 'user' AS kind, id AS resource_id
FROM users
WHERE role = 'user' AND state != 'revoked'
  AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
UNION ALL
SELECT 'maoyan' AS business_line, 'reservation' AS kind, reservation_id AS resource_id
FROM enrollment_reservations
WHERE expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER);

CREATE TRIGGER users_capacity_insert AFTER INSERT ON users
WHEN NEW.role = 'user' AND NEW.state != 'revoked'
  AND NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = NEW.business_line) >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = NEW.business_line), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER users_capacity_update AFTER UPDATE OF role, state, expires_at, business_line ON users
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = NEW.business_line) >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = NEW.business_line), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER reservations_capacity_insert AFTER INSERT ON enrollment_reservations
WHEN NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = 'maoyan') >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = 'maoyan'), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER reservations_capacity_update AFTER UPDATE OF expires_at ON enrollment_reservations
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM capacity_usage WHERE business_line = 'maoyan') >
    COALESCE((SELECT max_users FROM service_settings WHERE business_line = 'maoyan'), -1)
    THEN RAISE(ABORT, 'CAPACITY_FULL') END;
END;

CREATE TRIGGER settings_capacity_update BEFORE UPDATE OF max_users ON service_settings
BEGIN
  SELECT CASE WHEN NEW.max_users < (SELECT COUNT(*) FROM capacity_usage WHERE business_line = NEW.business_line)
    THEN RAISE(ABORT, 'CAPACITY_BELOW_USAGE') END;
END;
