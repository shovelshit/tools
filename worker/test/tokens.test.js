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
  assert.equal((await runScheduledMaintenance(env, nowMs + 180_000)).queued, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 51);
  assert.equal((await runScheduledMaintenance(env, nowMs + 360_000)).queued, 0);
});

test("next-day maintenance resumes prior archive while prioritizing today's reminder", async () => {
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
    "SELECT cursor,completed_at FROM maoyan_maintenance_runs WHERE job_id='archive' AND local_date='2026-09-14'"
  ).first();
  assert.equal(unfinished.cursor, "old-user-50");
  assert.equal(unfinished.completed_at, null);

  assert.equal((await runScheduledMaintenance(env, nextDay)).queued, 1);
  const resumed = await env.DB.prepare(
    "SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='archive' AND local_date='2026-09-14'"
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
});
