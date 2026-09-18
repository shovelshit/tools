-- Run once on an existing database before deploying notification diagnostics.
-- Check PRAGMA table_info(notification_outbox) first; skip existing columns.
ALTER TABLE notification_outbox ADD COLUMN last_error TEXT;
ALTER TABLE notification_outbox ADD COLUMN failure_detail TEXT;
