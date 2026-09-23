-- Apply once to the existing D1 database, after checking PRAGMA table_info(notification_outbox).
-- Existing pending and leased sending rows remain intact for the new lanes to claim.
ALTER TABLE notification_outbox ADD COLUMN detected_at INTEGER;
ALTER TABLE notification_outbox ADD COLUMN first_attempt_at INTEGER;
ALTER TABLE notification_outbox ADD COLUMN sent_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_lane
  ON notification_outbox(user_id, kind, state, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_lane_lease
  ON notification_outbox(user_id, kind, state, lease_until, id);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_routine
  ON notification_outbox(kind, state, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_routine_lease
  ON notification_outbox(kind, state, lease_until, id);
