import test from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { runScheduledChecks, runScheduledMaintenance } from "../src/maoyan/tokens.js";
import * as db from "../src/maoyan/db.js";
import { updateBusinessPolicy } from "../src/maoyan/business-policy-store.js";

// 固定窗口内时刻(北京 10:00), 使 runScheduledChecks 的监控窗口判断稳定通过
const WINDOW_NOW = Date.parse("2026-09-14T02:00:00.000Z");

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("scheduled monitoring hands data off only after snapshot and status persistence", async () => {
  const tokenId = "11111111-1111-4111-8111-111111111111";
  const cinema = { showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "200", tm: "20:00", ticketStatus: 0 }
    ] }] }]
  } };
  const baseConfig = {
    enabled: true,
    cinemaId: "25428",
    selectedMovieIds: ["7"],
    monitorDdl: "2099-01-01T00:00:00.000Z"
  };
  const env = {
    DB: await createDB({
      tokens: [{ id: tokenId, token: "access-token" }],
      configs: { [tokenId]: baseConfig }
    })
  };
  let handoffs = 0;

  await withMockFetch(async (input) => {
    if (String(input).includes("/ajax/cinemaDetail")) {
      return new Response(JSON.stringify(cinema), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }, async () => {
    await runScheduledChecks(env, async (id, monitoredCinema) => {
      handoffs++;
      assert.equal(id, tokenId);
      assert.deepEqual(monitoredCinema, cinema);
      assert.ok(Object.keys(await db.getSnapshot(env.DB, tokenId)).length > 0);
      assert.ok(await db.getStatus(env.DB, tokenId));
    }, { now: WINDOW_NOW });
  });

  assert.equal(handoffs, 1);

  await db.putConfig(env.DB, tokenId, { enabled: false, cinemaId: "25428" });
  await runScheduledChecks(env, async () => { handoffs++; }, { now: WINDOW_NOW });
  assert.equal(handoffs, 1);

  await db.putConfig(env.DB, tokenId, baseConfig);
  await db.deleteStatus(env.DB, tokenId);
  await withMockFetch(async () => { throw new Error("provider unavailable"); }, async () => {
    await runScheduledChecks(env, async () => { handoffs++; }, { now: WINDOW_NOW });
  });
  assert.equal(handoffs, 1);
});

test("scheduled Maoyan work never polls or notifies for Store accounts", async () => {
  const env = await createAccountEnv({ nowMs: WINDOW_NOW });
  const store = await seedAccount(env, {
    businessLine: "store",
    expiresAt: WINDOW_NOW + 60_000,
    config: { enabled: true, cinemaId: "25428", selectedMovieIds: ["7"] }
  });
  let providerCalls = 0;
  await withMockFetch(async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ showData: { cinemaName: "wrong", movies: [] } }));
  }, async () => {
    await runScheduledChecks(env, () => {}, { now: WINDOW_NOW });
  });
  assert.equal(providerCalls, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id=?").bind(store.account.id).first()).n, 0);
});

test("maintenance creates one-day reminder on the prior Beijing calendar date", async () => {
  const nowMs = Date.parse("2026-09-13T17:00:00Z"); // Beijing Sep 14 01:00
  const env = await createAccountEnv({ nowMs });
  const expiresAt = Date.parse("2026-09-15T15:59:00Z"); // Beijing Sep 15 23:59, over 24h ahead
  const { account } = await seedAccount(env, { expiresAt });
  await runScheduledMaintenance(env, nowMs);
  const row = await env.DB.prepare("SELECT payload FROM notification_outbox WHERE user_id=? AND kind='account-expiry'").bind(account.id).first();
  assert.equal(JSON.parse(row.payload).meta.stage, "one-day");
  assert.equal((await runScheduledMaintenance(env, nowMs)).queued, 0);
  const newcomer = await seedAccount(env, { expiresAt, id: "newcomer" });
  assert.equal((await runScheduledMaintenance(env, nowMs + 180_000)).queued, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id=?").bind(newcomer.account.id).first()).n, 1);
});

test("maintenance stays silent outside policy window and never queries all users", async () => {
  const nowMs = Date.parse("2026-09-14T02:00:00Z");
  const env = await createAccountEnv({ nowMs });
  env.DB.queries = [];
  assert.deepEqual(await runScheduledMaintenance(env, nowMs), { queued: 0 });
  assert.equal(env.DB.queries.some(({ sql }) => sql.includes("FROM users u LEFT JOIN user_config")), false);
});

test("configured monitoring window gates the legacy scheduled checker", async () => {
  const env = await createAccountEnv({ nowMs: WINDOW_NOW });
  await updateBusinessPolicy(env.DB, {
    expectedVersion: 1, monitorStartMinute: 1320, monitorEndMinute: 120,
    maintenanceStartMinute: 180, maintenanceEndMinute: 240, nowMs: WINDOW_NOW
  });
  env.DB.queries = [];
  await runScheduledChecks(env, () => { throw new Error("closed window"); }, { now: WINDOW_NOW });
  assert.equal(env.DB.queries.some(({ sql }) => sql.startsWith("SELECT id FROM users WHERE role='user'")), false);
});

test("maintenance resumes after a bounded page without duplicating prior reminders", async () => {
  const nowMs = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs });
  const expiresAt = Date.parse("2026-09-15T15:00:00Z");
  for (let id = 1; id <= 51; id++) {
    await env.DB.prepare(
      "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,'user','active',?,?,'test',1)"
    ).bind(`page-user-${String(id).padStart(2, "0")}`, nowMs, expiresAt).run();
  }
  assert.equal((await runScheduledMaintenance(env, nowMs)).queued, 50);
  assert.equal((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first()).completed_at, null);
  assert.equal((await runScheduledMaintenance(env, nowMs + 180_000)).queued, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 51);
  assert.equal((await runScheduledMaintenance(env, nowMs + 360_000)).queued, 0);
});

test("exactly one full reminder page completes before the maintenance window closes", async () => {
  const nowMs = Date.parse("2026-09-13T17:57:00Z"); // Beijing 01:57
  const env = await createAccountEnv({ nowMs });
  const expiresAt = Date.parse("2026-09-15T15:00:00Z");
  for (let id = 1; id <= 50; id++) {
    await env.DB.prepare(
      "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,'user','active',?,?,'test',1)"
    ).bind(`exact-user-${String(id).padStart(2, "0")}`, nowMs, expiresAt).run();
  }
  assert.equal((await runScheduledMaintenance(env, nowMs)).queued, 50);
  const close = Date.parse("2026-09-13T18:00:00Z");
  assert.deepEqual(await runScheduledMaintenance(env, close), { queued: 0 });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 50);
  assert.ok((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder' AND local_date='2026-09-14'").first()).completed_at);
  const verified = await env.DB.prepare("SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' AND request_id='reminder:2026-09-14'").first();
  assert.equal(JSON.parse(verified.data).complete, true);
});

test("next-day maintenance retries remaining archive candidates without a prior-day cursor", async () => {
  const firstDay = Date.parse("2026-09-13T17:00:00Z"); // Beijing Sep 14 01:00
  const nextDay = firstDay + 86_400_000;
  const env = await createAccountEnv({ nowMs: firstDay });
  for (let id = 1; id <= 51; id++) {
    await env.DB.prepare(
      "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,'user','active',?,?,'test',1)"
    ).bind(`old-user-${String(id).padStart(2, "0")}`, firstDay - 60 * 86_400_000, firstDay - 31 * 86_400_000).run();
  }
  await env.DB.prepare(
    "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES ('z-future','user','active',?,?,'test',1)"
  ).bind(firstDay, Date.parse("2026-09-16T15:00:00Z")).run();
  await runScheduledMaintenance(env, firstDay);
  const unfinished = await env.DB.prepare(
    "SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='archive' AND local_date='2026-09-14'"
  ).first();
  assert.equal(unfinished.completed_at, null);

  assert.equal((await runScheduledMaintenance(env, nextDay)).queued, 1);
  const resumed = await env.DB.prepare(
    "SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='archive' AND local_date='2026-09-15'"
  ).first();
  assert.equal(resumed.completed_at, nextDay);
  assert.equal((await env.DB.prepare("SELECT archived_at FROM users WHERE id='old-user-51'").first()).archived_at, nextDay);
  assert.equal((await runScheduledMaintenance(env, nextDay + 180_000)).queued, 0);
  const row = await env.DB.prepare("SELECT payload FROM notification_outbox WHERE user_id='z-future'").first();
  assert.equal(JSON.parse(row.payload).meta.stage, "one-day");
});

test("expired accounts past retention are archived without generating a doomed reminder", async () => {
  const nowMs = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs });
  const account = await seedAccount(env, { expiresAt: nowMs - 31 * 86_400_000 });
  assert.deepEqual(await runScheduledMaintenance(env, nowMs), { queued: 0 });
  assert.equal((await env.DB.prepare("SELECT archived_at FROM users WHERE id=?").bind(account.account.id).first()).archived_at, nowMs);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id=?").bind(account.account.id).first()).n, 0);
});

test("a missed prior-day reminder is recorded once without late one-day delivery", async () => {
  const nowMs = Date.parse("2026-09-14T17:00:00Z"); // Beijing Sep 15 01:00
  const env = await createAccountEnv({ nowMs });
  await env.DB.prepare(
    "INSERT INTO maoyan_maintenance_runs(job_id,local_date,lease_until,completed_at,updated_at) VALUES ('reminder','2026-09-13',0,?,?)"
  ).bind(nowMs - 2 * 86_400_000, nowMs - 2 * 86_400_000).run();
  const expiresAt = Date.parse("2026-09-15T15:59:00Z"); // Beijing Sep 15 23:59
  await seedAccount(env, { expiresAt });
  assert.equal((await runScheduledMaintenance(env, nowMs)).queued, 0);
  assert.equal((await runScheduledMaintenance(env, nowMs + 180_000)).queued, 0);
  const events = await env.DB.prepare(
    "SELECT request_id,data FROM audit_events WHERE event_type='maoyan_maintenance_reminder_missed'"
  ).all();
  assert.equal(events.results.length, 1);
  assert.equal(events.results[0].request_id, "reminder-missed:2026-09-14");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 0);
});

test("first maintenance run establishes baseline without a false missed-day alert", async () => {
  const nowMs = Date.parse("2026-09-14T17:00:00Z");
  const env = await createAccountEnv({ nowMs });
  await runScheduledMaintenance(env, nowMs);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='maoyan_maintenance_reminder_missed'").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='maoyan_maintenance_observation_started'").first()).n, 1);
});

test("after-window verification marks an observed empty day complete without enqueuing", async () => {
  const first = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs: first });
  await runScheduledMaintenance(env, first);
  const close = Date.parse("2026-09-13T18:02:00Z");
  assert.deepEqual(await runScheduledMaintenance(env, close), { queued: 0 });
  const rows = await env.DB.prepare("SELECT job_id,completed_at,updated_at FROM maoyan_maintenance_runs WHERE local_date='2026-09-14'").all();
  assert.equal(rows.results.length, 3);
  assert.ok(rows.results.every((row) => row.completed_at && row.updated_at === close));
  const audits = await env.DB.prepare("SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified'").all();
  assert.equal(audits.results.length, 3);
  assert.ok(audits.results.every((row) => JSON.parse(row.data).complete));
});

test("a late candidate keeps the day incomplete on close and is never queued outside the window", async () => {
  const first = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs: first });
  await runScheduledMaintenance(env, first);
  const newcomer = await seedAccount(env, { expiresAt: Date.parse("2026-09-15T15:00:00Z"), id: "late-user" });
  const close = Date.parse("2026-09-13T18:02:00Z");
  assert.deepEqual(await runScheduledMaintenance(env, close), { queued: 0 });
  assert.equal((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder' AND local_date='2026-09-14'").first()).completed_at, first);
  const audit = await env.DB.prepare("SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' AND request_id='reminder:2026-09-14'").first();
  assert.equal(JSON.parse(audit.data).complete, false);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id=?").bind(newcomer.account.id).first()).n, 0);
});

test("reopening the window invalidates the old close verification even in the same millisecond", async () => {
  const nowMs = Date.parse("2026-09-13T18:02:00Z"); // Beijing 02:02
  const env = await createAccountEnv({ nowMs });
  await updateBusinessPolicy(env.DB, {
    expectedVersion: 1, monitorStartMinute: 420, monitorEndMinute: 1380,
    maintenanceStartMinute: 60, maintenanceEndMinute: 121, nowMs
  });
  await runScheduledMaintenance(env, nowMs - 180_000);
  await runScheduledMaintenance(env, nowMs);
  const prior = await env.DB.prepare("SELECT updated_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first();
  await updateBusinessPolicy(env.DB, {
    expectedVersion: 2, monitorStartMinute: 420, monitorEndMinute: 1380,
    maintenanceStartMinute: 60, maintenanceEndMinute: 180, nowMs
  });
  await runScheduledMaintenance(env, nowMs);
  const current = await env.DB.prepare("SELECT updated_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first();
  assert.ok(current.updated_at > prior.updated_at);
  const audit = await env.DB.prepare("SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' AND request_id='reminder:2026-09-14'").first();
  assert.notEqual(JSON.parse(audit.data).runUpdatedAt, current.updated_at);
});

test("first observed cron after the maintenance window records a baseline without inventing a daily run", async () => {
  const nowMs = Date.parse("2026-09-14T03:00:00Z");
  const env = await createAccountEnv({ nowMs });
  await runScheduledMaintenance(env, nowMs);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM maoyan_maintenance_runs").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT created_at FROM audit_events WHERE event_type='maoyan_maintenance_observation_started'").first()).created_at, nowMs);
});

test("revocation cleanup left by a failed day is retried from its durable marker the next day", async () => {
  const first = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs: first });
  const { account } = await seedAccount(env, { id: "revoked-user", state: "revoked" });
  await env.DB.prepare("INSERT INTO revocation_cleanup(user_id,created_at) VALUES (?,?)").bind(account.id, first).run();
  const originalList = env.MAOYAN_KV.list;
  env.MAOYAN_KV.list = async () => { throw new Error("temporary KV failure"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    await runScheduledMaintenance(env, first);
  } finally {
    console.error = originalError;
    env.MAOYAN_KV.list = originalList;
  }
  assert.equal((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='revocation' AND local_date='2026-09-14'").first()).completed_at, null);
  await runScheduledMaintenance(env, first + 86_400_000);
  assert.equal(await env.DB.prepare("SELECT 1 AS present FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
  assert.ok((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='revocation' AND local_date='2026-09-15'").first()).completed_at);
});

test("one failed cleanup does not block later revocations in the same page", async () => {
  const nowMs = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs });
  for (const id of ["a-failed", "b-ready"]) {
    await seedAccount(env, { id, state: "revoked" });
    await env.DB.prepare("INSERT INTO revocation_cleanup(user_id,created_at) VALUES (?,?)").bind(id, nowMs).run();
  }
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  let first = true;
  env.MAOYAN_KV.list = async (options) => {
    if (first) { first = false; throw new Error("temporary KV failure"); }
    return list(options);
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await runScheduledMaintenance(env, nowMs);
  } finally {
    console.error = originalError;
  }
  assert.ok(await env.DB.prepare("SELECT 1 AS present FROM revocation_cleanup WHERE user_id='a-failed'").first());
  assert.equal(await env.DB.prepare("SELECT 1 AS present FROM revocation_cleanup WHERE user_id='b-ready'").first(), null);
  assert.equal((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='revocation'").first()).completed_at, null);
});

test("a failed later scan preserves the last full success but closes as incomplete", async () => {
  const first = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs: first });
  await runScheduledMaintenance(env, first);
  await seedAccount(env, { id: "late-expiry", expiresAt: Date.parse("2026-09-15T15:00:00Z") });
  const enqueue = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.startsWith("INSERT OR IGNORE INTO notification_outbox")) {
      return { bind: () => ({ run: async () => { throw new Error("temporary D1 failure"); } }) };
    }
    return enqueue(sql);
  };
  const retry = first + 180_000;
  await runScheduledMaintenance(env, retry);
  env.DB.prepare = enqueue;
  await env.DB.prepare("UPDATE users SET expires_at=? WHERE id='late-expiry'").bind(first + 10 * 86_400_000).run();
  const beforeClose = await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first();
  assert.equal(beforeClose.completed_at, first);
  const close = Date.parse("2026-09-13T18:00:00Z");
  await runScheduledMaintenance(env, close);
  const row = await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first();
  assert.equal(row.completed_at, first);
  const audit = await env.DB.prepare("SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' AND request_id='reminder:2026-09-14'").first();
  assert.equal(JSON.parse(audit.data).complete, false);
});

test("a full page of unchanged failed candidates reports backlog independently of candidate failures", async () => {
  const nowMs = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs });
  for (let i = 0; i < 50; i++) {
    const id = `failed-revocation-${String(i).padStart(2, "0")}`;
    await seedAccount(env, { id, state: "revoked" });
    await env.DB.prepare("INSERT INTO revocation_cleanup(user_id,created_at) VALUES (?,?)").bind(id, nowMs).run();
  }
  env.MAOYAN_KV.list = async () => { throw new Error("KV unavailable"); };
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    await runScheduledMaintenance(env, nowMs);
  } finally {
    console.error = originalError;
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM revocation_cleanup").first()).n, 50);
  assert.ok(errors.some((args) => args.some((arg) => arg?.reason === "backlog_no_progress")));
});

test("next day reports an incomplete close despite an older successful scan timestamp", async () => {
  const first = Date.parse("2026-09-13T17:00:00Z");
  const env = await createAccountEnv({ nowMs: first });
  await runScheduledMaintenance(env, first);
  await seedAccount(env, { id: "late-for-close", expiresAt: Date.parse("2026-09-15T15:00:00Z") });
  await runScheduledMaintenance(env, Date.parse("2026-09-13T18:00:00Z"));
  const run = await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder' AND local_date='2026-09-14'").first();
  assert.equal(run.completed_at, first);
  await runScheduledMaintenance(env, first + 86_400_000);
  assert.ok(await env.DB.prepare("SELECT 1 AS present FROM audit_events WHERE event_type='maoyan_maintenance_reminder_missed' AND request_id='reminder-missed:2026-09-14'").first());
});

test("close verification reads the completion state after claiming its lease", async () => {
  const first = Date.parse("2026-09-13T17:00:00Z");
  const close = Date.parse("2026-09-13T18:02:00Z");
  const env = await createAccountEnv({ nowMs: first });
  await runScheduledMaintenance(env, first);
  const prepare = env.DB.prepare.bind(env.DB);
  let changed = false;
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (changed || !sql.startsWith("UPDATE maoyan_maintenance_runs SET lease_until=?")) return statement;
    return {
      bind: (...params) => {
        const bound = statement.bind(...params);
        return {
          run: async () => {
            changed = true;
            await prepare("UPDATE maoyan_maintenance_runs SET completed_at=NULL,updated_at=updated_at+1 WHERE job_id='reminder'").run();
            return bound.run();
          }
        };
      }
    };
  };
  await runScheduledMaintenance(env, close);
  assert.equal(changed, true);
  assert.equal((await env.DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first()).completed_at, null);
  const audit = await env.DB.prepare("SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' AND request_id='reminder:2026-09-14'").first();
  assert.equal(JSON.parse(audit.data).complete, false);
});
