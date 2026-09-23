-- Maoyan monitor state v2. Apply after pausing the monitor dispatcher.
-- Preflight required before this file: PRAGMA table_info(monitor_subscriptions);
-- The Node entry point conditionally adds last_run_id for pre-v2 databases,
-- then executes this idempotent SQL. Existing user, config, lock and
-- notification rows are intentionally untouched.
CREATE TABLE IF NOT EXISTS cinema_state (
  cinema_id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  current_hash TEXT,
  current_data TEXT,
  active_run_id TEXT,
  active_base_version INTEGER,
  active_base_hash TEXT,
  active_data TEXT,
  active_version INTEGER,
  run_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (run_state IN ('idle', 'processing', 'retryable', 'completed')),
  subscriber_cursor TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_until INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_state_active
  ON cinema_state(run_state, lease_until, cinema_id);

CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_run
  ON monitor_subscriptions(cinema_id, last_run_id, next_due_at, user_id);

-- A state row already populated by an earlier cutover is the source of truth
-- for a subscription baseline. New rows remain NULL until their first scan.
UPDATE monitor_subscriptions
SET baseline_version = (
  SELECT current_version FROM cinema_state
  WHERE cinema_state.cinema_id = monitor_subscriptions.cinema_id
)
WHERE baseline_version IS NULL
  AND EXISTS (
    SELECT 1 FROM cinema_state
    WHERE cinema_state.cinema_id = monitor_subscriptions.cinema_id
  );
