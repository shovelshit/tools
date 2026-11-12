-- Apply once while Worker writes/cron are paused, after backing up D1.
-- The existing config rows belong to Movie; preserve every blob and version.
CREATE TABLE user_config_v2 (
  token_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  business_line TEXT NOT NULL DEFAULT 'maoyan' CHECK (business_line IN ('maoyan', 'store')),
  PRIMARY KEY (token_id, business_line)
);

INSERT INTO user_config_v2(token_id,data,updated_at,version,business_line)
SELECT token_id,data,updated_at,version,'maoyan' FROM user_config;

DROP TABLE user_config;
ALTER TABLE user_config_v2 RENAME TO user_config;

CREATE INDEX idx_user_config_business_line ON user_config(business_line,token_id);
CREATE TRIGGER runtime_guard_user_config_insert BEFORE INSERT ON user_config
WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked')
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
CREATE TRIGGER runtime_guard_user_config_update BEFORE UPDATE ON user_config
WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked')
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;

