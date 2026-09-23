import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildMigrationPlan, executeRemoteMigration, parseWranglerJson, readRemoteSnapshot } from "../scripts/migrate-maoyan-monitor-state-remote.mjs";

function snapshot(overrides = {}) {
  return {
    nowMs: 1000,
    subscriptions: [
      { user_id: "u'1", cinema_id: "cinema\n1", enabled: 1, baseline_version: null, last_run_id: null },
      { user_id: "u2", cinema_id: "cinema\n1", enabled: 1, baseline_version: null, last_run_id: null }
    ],
    states: [],
    latest: [{ cinema_id: "cinema\n1", version: 8, public_data: JSON.stringify({ showData: { cinemaName: "A", movies: [] } }), captured_at: 900 }],
    activeRuns: [], outbox: [{ state: "pending", count: 2 }], lockRules: [{ count: 2 }], ...overrides
  };
}

test("Wrangler progress output is ignored when parsing JSON", () => {
  const payload = parseWranglerJson("\u001b[2K\u001b[1GExecuting...\n[{\"results\":[{\"ok\":1}]}]\nDone");
  assert.deepEqual(payload, [{ results: [{ ok: 1 }] }]);
});

test("remote plan uses safe hex literals and initializes one shared cinema for both subscribers", () => {
  const plan = buildMigrationPlan(snapshot(), { paused: true, nowMs: 1000 });
  assert.equal(plan.summary.insertedStates, 1);
  assert.equal(plan.summary.baselineUpdates, 2);
  assert.equal(plan.statements.filter((sql) => sql.startsWith("INSERT INTO cinema_state")).length, 1);
  assert.equal(plan.statements.filter((sql) => sql.startsWith("UPDATE monitor_subscriptions")).length, 2);
  assert.match(plan.sql, /'[0-9a-zA-Z]/);
  assert.doesNotMatch(plan.sql, /X'[0-9a-f]+'/i);
  assert.doesNotMatch(plan.sql, /u'1/);
  assert.doesNotMatch(plan.sql, /cinema\\n1/);
});

test("generated SQL keeps cinema data and hash as readable TEXT", () => {
  const plan = buildMigrationPlan(snapshot(), { paused: true, nowMs: 1000 });
  const DB = new DatabaseSync(":memory:");
  DB.exec("CREATE TABLE cinema_state (cinema_id TEXT PRIMARY KEY,current_version INTEGER,current_hash TEXT,current_data TEXT,run_state TEXT,completed_at INTEGER,updated_at INTEGER); CREATE TABLE monitor_subscriptions (user_id TEXT,cinema_id TEXT,enabled INTEGER,baseline_version INTEGER,last_run_id TEXT,updated_at INTEGER);");
  DB.exec(plan.sql);
  const state = DB.prepare("SELECT typeof(current_hash) AS hash_type,typeof(current_data) AS data_type,current_hash,current_data FROM cinema_state").get();
  assert.equal(state.hash_type, "text");
  assert.equal(state.data_type, "text");
  assert.doesNotThrow(() => JSON.parse(state.current_data));
});

test("remote plan is idempotent and preserves active state/subscriber progress", () => {
  const plan = buildMigrationPlan(snapshot({
    states: [{ cinema_id: "cinema\n1", current_version: 7, current_data: "{}", active_run_id: "run-1", run_state: "processing" }],
    subscriptions: [{ user_id: "u'1", cinema_id: "cinema\n1", enabled: 1, baseline_version: 7, last_run_id: "run-1" }]
  }), { paused: true, nowMs: 1000 });
  assert.equal(plan.statements.length, 0);
  assert.equal(plan.summary.insertedStates, 0);
  assert.equal(plan.summary.baselineUpdates, 0);
});

test("plan refuses missing pause confirmation or active runs", () => {
  assert.throws(() => buildMigrationPlan(snapshot()), /pause confirmation/);
  assert.throws(() => buildMigrationPlan(snapshot({ activeRuns: [{ cinema_id: "c", run_state: "processing" }] }), { paused: true }), /active cinema runs/);
});

test("remote dry-run performs no apply command and does not expose public data", async () => {
  const calls = [];
  const run = async (sql) => {
    calls.push(sql);
    if (sql.startsWith("SELECT name")) return [{ results: [{ name: "monitor_subscriptions" }, { name: "cinema_batches" }, { name: "cinema_state" }, { name: "notification_outbox" }, { name: "lock_rule" }] }];
    if (sql.startsWith("PRAGMA table_info(cinema_state)")) return [{ results: [{ name: "cinema_id" }, { name: "current_version" }, { name: "current_data" }, { name: "active_run_id" }, { name: "run_state" }] }];
    if (sql.startsWith("PRAGMA table_info(monitor_subscriptions)")) return [{ results: [{ name: "last_run_id" }] }];
    if (sql.startsWith("SELECT s.user_id")) return [{ results: snapshot().subscriptions }];
    if (sql.startsWith("SELECT cinema_id,current_version")) return [{ results: [] }];
    if (sql.startsWith("SELECT b.cinema_id")) return [{ results: snapshot().latest }];
    if (sql.startsWith("SELECT state,COUNT")) return [{ results: snapshot().outbox }];
    if (sql.startsWith("SELECT COUNT(*) AS count FROM lock_rule")) return [{ results: snapshot().lockRules }];
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const result = await executeRemoteMigration({ database: "ignored", paused: true, run });
  assert.equal(result.mode, "dry-run");
  assert.equal(calls.some((sql) => sql.startsWith("INSERT") || sql.startsWith("UPDATE")), false);
  assert.equal(result.summary.preservedOutbox, 2);
  assert.match(calls.find((sql) => sql.startsWith("SELECT s.user_id")), /u\.role IN \('user','admin'\)/);
});

test("remote snapshot rejects an old schema before generating SQL", async () => {
  await assert.rejects(() => readRemoteSnapshot(async (sql) => {
    if (sql.startsWith("SELECT name")) return [{ name: "monitor_subscriptions" }];
    return [];
  }), /required tables missing/);
});
