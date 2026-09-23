import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PRODUCTION_SCHEMA_SQL, createMonitorStateFixture } from "./helpers.js";
import { applyMaoyanMonitorStateV2 } from "../scripts/apply-maoyan-monitor-state-v2.mjs";

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

test("v2 migration upgrades a truly old schema and creates the v2 table", () => {
  const DB = legacyDatabase();
  const now = 1_726_000_000_000;
  DB.prepare("INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES ('monitor-user','user','active',?,?, 'test',1)").run(now, now + 86_400_000);
  DB.prepare("INSERT INTO user_config(token_id,data,updated_at,version) VALUES ('monitor-user','{}',?,1)").run(String(now));
  DB.prepare("INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,next_due_at,updated_at) VALUES ('monitor-user','cinema-1',1,3,?,?)").run(now + 60_000, now);
  DB.prepare("INSERT INTO lock_rule(token_id,data,updated_at) VALUES ('monitor-user','{\"state\":\"waiting_schedule\"}',?)").run(String(now));
  DB.prepare("INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,created_at,updated_at) VALUES ('event-1','monitor-user','lock-terminal','{}',1,'pending',?,?)").run(now, now);
  applyMaoyanMonitorStateV2(DB);

  assert.deepEqual({ ...DB.prepare("SELECT cinema_id,enabled,config_version,baseline_version,last_run_id FROM monitor_subscriptions WHERE user_id='monitor-user'").get() }, {
    cinema_id: "cinema-1", enabled: 1, config_version: 3, baseline_version: null, last_run_id: null
  });
  assert.equal(DB.prepare("SELECT data FROM user_config WHERE token_id='monitor-user'").get().data, "{}");
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM lock_rule WHERE token_id='monitor-user'").get().n, 1);
  assert.equal(DB.prepare("SELECT state FROM notification_outbox WHERE event_key='event-1'").get().state, "pending");
  assert.doesNotMatch(migrationSql, /cinema_(?:batches|snapshots|events)/);
  assert.equal(DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cinema_batches'").get().name, "cinema_batches");
  assert.equal(DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cinema_state'").get().name, "cinema_state");
  assert.ok(DB.prepare("SELECT 1 FROM pragma_index_list('monitor_subscriptions') WHERE name='idx_monitor_subscriptions_run'").get());
});

test("v2 migration is safe on the current schema and initializes baseline from current state", async () => {
  const { DB, userId, cinemaId, currentVersion } = await createMonitorStateFixture({ nowMs: 1_726_000_000_000 });
  applyMaoyanMonitorStateV2(DB.sqlite);
  applyMaoyanMonitorStateV2(DB.sqlite);
  const subscription = await DB.prepare("SELECT baseline_version,last_run_id FROM monitor_subscriptions WHERE user_id=?").bind(userId).first();
  assert.equal(Number(subscription.baseline_version), currentVersion);
  assert.equal(subscription.last_run_id, null);
  assert.equal((await DB.prepare("SELECT data FROM user_config WHERE token_id=?").bind(userId).first()).data, JSON.stringify({ cinemaId }));
});
