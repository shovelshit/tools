CREATE TABLE IF NOT EXISTS revocation_cleanup (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  created_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at INTEGER,
  last_error TEXT
);

DROP TABLE IF EXISTS account_migrations;

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
