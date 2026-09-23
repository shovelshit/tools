import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PRODUCTION_SCHEMA_SQL } from "./helpers.js";

const migrationSql = readFileSync(new URL("../sql/maoyan-monitor-state-v2.sql", import.meta.url), "utf8");

function legacyDatabase() {
  const DB = new DatabaseSync(":memory:");
  const legacySchema = PRODUCTION_SCHEMA_SQL
    .replace("  last_run_id TEXT,\n", "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_run[\s\S]*?;\n\n/, "")
    .replace(/CREATE TABLE IF NOT EXISTS cinema_state \([\s\S]*?CREATE INDEX IF NOT EXISTS idx_cinema_state_active\n  ON cinema_state\(run_state, lease_until, cinema_id\);\n\n/, "");
  DB.exec(legacySchema);
  return DB;
}

test("v2 migration preserves active monitor rows and seeds the subscription baseline", () => {
  const DB = legacyDatabase();
  const now = 1_726_000_000_000;
  DB.exec(`CREATE TABLE cinema_state (
    cinema_id TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL DEFAULT 0,
    current_hash TEXT,
    current_data TEXT,
    active_run_id TEXT,
    active_base_version INTEGER,
    active_base_hash TEXT,
    active_data TEXT,
    active_version INTEGER,
    run_state TEXT NOT NULL DEFAULT 'idle',
    subscriber_cursor TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO cinema_state(cinema_id,current_version,current_hash,current_data,run_state,updated_at)
    VALUES ('cinema-1',7,'hash','{}','idle',${now});`);
  DB.prepare("INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES ('monitor-user','user','active',?,?, 'test',1)").run(now, now + 86_400_000);
  DB.prepare("INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,next_due_at,updated_at) VALUES ('monitor-user','cinema-1',1,3,?,?)").run(now + 60_000, now);
  DB.prepare("INSERT INTO lock_rule(token_id,data,updated_at) VALUES ('monitor-user','{\"state\":\"waiting_schedule\"}',?)").run(String(now));
  DB.prepare("INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,created_at,updated_at) VALUES ('event-1','monitor-user','lock-terminal','{}',1,'pending',?,?)").run(now, now);
  DB.exec(migrationSql);

  assert.deepEqual({ ...DB.prepare("SELECT cinema_id,enabled,config_version,baseline_version,last_run_id FROM monitor_subscriptions WHERE user_id='monitor-user'").get() }, {
    cinema_id: "cinema-1", enabled: 1, config_version: 3, baseline_version: 7, last_run_id: null
  });
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM lock_rule WHERE token_id='monitor-user'").get().n, 1);
  assert.equal(DB.prepare("SELECT state FROM notification_outbox WHERE event_key='event-1'").get().state, "pending");
  assert.doesNotMatch(migrationSql, /cinema_(?:batches|snapshots|events)/);
  assert.equal(DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cinema_batches'").get().name, "cinema_batches");
  assert.equal(DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cinema_state'").get().name, "cinema_state");
  assert.ok(DB.prepare("SELECT 1 FROM pragma_index_list('monitor_subscriptions') WHERE name='idx_monitor_subscriptions_run'").get());
});
