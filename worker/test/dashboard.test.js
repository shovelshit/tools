import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";

const NOW = Date.parse("2026-09-20T04:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function request(path, { adminToken = "test-admin-token" } = {}) {
  return new Request(`https://worker.example${path}`, {
    headers: { "X-Admin-Token": adminToken }
  });
}

async function insertSubscription(env, userId, cinemaId, nowMs = NOW) {
  await env.DB.prepare(
    "INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,next_due_at,updated_at) VALUES (?,?,1,1,?,?)"
  ).bind(userId, cinemaId, nowMs, nowMs).run();
}

async function insertNotification(env, {
  eventKey, userId, state, createdAt = NOW, kind = "lock-terminal",
  lastError = null, failureDetail = null, detectedAt = null, firstAttemptAt = null, sentAt = null
}) {
  await env.DB.prepare(
    "INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,last_error,failure_detail,next_attempt_at,created_at,updated_at,detected_at,first_attempt_at,sent_at) " +
    "VALUES (?,?,?,?,?, ?,0,?,?,?,?,?,?,?,?)"
  ).bind(
    eventKey, userId, kind, JSON.stringify({ title: eventKey, content: eventKey }), 1,
    state, lastError, failureDetail, state === "pending" ? createdAt : null, createdAt, createdAt,
    detectedAt, firstAttemptAt, sentAt
  ).run();
}

test("admin dashboard aggregates active maoyan users and excludes revoked/store rows", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  env.NOW_MS = String(NOW);
  const active = await seedAccount(env, {
    id: "maoyan-active",
    remark: "有效账号",
    expiresAt: NOW + 7 * DAY,
    businessLine: "maoyan",
    config: { enabled: true }
  });
  const revoked = await seedAccount(env, {
    id: "maoyan-revoked",
    remark: "已撤销",
    expiresAt: NOW + 7 * DAY,
    businessLine: "maoyan",
    state: "revoked",
    config: { enabled: true }
  });
  const store = await seedAccount(env, {
    id: "store-active",
    remark: "Store",
    expiresAt: NOW + 7 * DAY,
    businessLine: "store",
    config: { enabled: true }
  });

  await insertSubscription(env, active.account.id, "cinema-a");
  await insertSubscription(env, store.account.id, "cinema-store");
  await env.DB.prepare(
    "INSERT INTO monitor_status(token_id,data,updated_at) VALUES (?,?,?)"
  ).bind(active.account.id, JSON.stringify({ lastCheck: "2026-09-20T03:55:00.000Z", cinemaName: "影院 A" }), "2026-09-20T03:55:00.000Z").run();
  await env.DB.prepare(
    "INSERT INTO lock_rule(token_id,data,updated_at) VALUES (?,?,?)"
  ).bind(active.account.id, JSON.stringify({
    id: "rule-a", state: "waiting_schedule", cinemaId: "cinema-a",
    cinemaName: "影院 A", movieName: "测试电影", hall: "1号厅",
    lastError: null
  }), "2026-09-20T03:56:00.000Z").run();

  await env.DB.prepare(
    "INSERT INTO cinema_batches(cinema_id,batch_id,status,version,public_data,captured_at) VALUES " +
    "(?,'batch-a','committed',1,?,?),(?,'batch-old','committed',1,?,?)"
  ).bind(
    "cinema-a", JSON.stringify({ showData: { cinemaName: "影院 A", movies: [] } }), NOW - 5 * 60 * 1000,
    "cinema-a", JSON.stringify({ showData: { cinemaName: "影院 A", movies: [] } }), NOW - 2 * DAY
  ).run();
  await env.DB.prepare(
    "INSERT INTO cinema_events(cinema_id,batch_id,movie_id,payload,created_at) VALUES (?,?,?,?,?)"
  ).bind("cinema-a", "batch-a", "movie-a", JSON.stringify({ movieName: "测试电影", shows: [{ seqNo: "1" }] }), NOW - 10 * 60 * 1000).run();

  await insertNotification(env, {
    eventKey: "lock:rule-a:locked", userId: active.account.id, state: "sent",
    detectedAt: NOW - 5_000, firstAttemptAt: NOW - 1_000, sentAt: NOW
  });
  await insertNotification(env, {
    eventKey: "lock:rule-b:failed", userId: active.account.id, state: "failed",
    lastError: "上游返回 HTTP 403", failureDetail: '{"status":403}'
  });
  await insertNotification(env, {
    eventKey: "lock:old:failed", userId: active.account.id, state: "failed",
    createdAt: NOW - 2 * DAY, lastError: "过期失败"
  });
  await insertNotification(env, { eventKey: "lock:pending", userId: active.account.id, state: "pending" });
  await insertNotification(env, {
    eventKey: "account-expiry:pending", userId: active.account.id,
    kind: "account-expiry", state: "pending"
  });
  await env.DB.prepare(
    "INSERT INTO seat_feedback(fb_key,reported_at,day,token_id,cinema_id,movie_id,seq_no,source) VALUES (?,?,?,?,?,?,?,?)"
  ).bind("seatfb:cinema-a:1", new Date(NOW - 60 * 1000).toISOString(), "2026-09-20", active.account.id, "cinema-a", "movie-a", "1", "auto").run();
  await insertNotification(env, { eventKey: "store:sent", userId: store.account.id, state: "sent" });

  const response = await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.window, "24h");
  assert.equal(payload.summary.activeUsers, 1);
  assert.equal(payload.summary.monitoringUsers, 1);
  assert.equal(payload.summary.activeCinemas, 1);
  assert.equal(payload.summary.notificationSuccessRate, 0.5);
  assert.equal(payload.summary.lockSuccess, 1);
  assert.equal(payload.summary.lockFailed, 1);
  assert.deepEqual(payload.users.map((row) => row.userId), ["maoyan-active"]);
  assert.equal(payload.users[0].cinemaName, "影院 A");
  assert.equal(payload.users[0].monitorState, "monitoring");
  assert.equal(payload.users[0].lockState, "waiting_schedule");
  assert.deepEqual(payload.cinemas.map((row) => row.cinemaId), ["cinema-a"]);
  assert.equal(payload.cinemas[0].newShows, 1);
  assert.equal(payload.notifications.pending, 2);
  assert.equal(payload.notifications.failed, 1);
  assert.equal(payload.notifications.recent.length, 4);
  assert.equal(payload.notifications.byKind["lock-terminal"].pending, 1);
  assert.equal(payload.notifications.byKind["account-expiry"].pending, 1);
  assert.equal(payload.notifications.recent.find((row) => row.eventKey === "lock:rule-a:locked").discoveryToFirstAttemptMs, 4_000);
  assert.equal(payload.notifications.recent.find((row) => row.eventKey === "lock:rule-b:failed").discoveryToFirstAttemptMs, null);
  assert.equal(payload.health.lastMaintenanceDate, null);
  assert.equal(
    payload.notifications.recent.find((row) => row.eventKey === "lock:rule-b:failed").failureDetail,
    '{"status":403}'
  );
  assert.equal(payload.health.latestBatchAt, NOW - 5 * 60 * 1000);
  assert.equal(payload.health.oldestPendingNotificationAt, NOW);
  assert.equal(payload.seatFeedback.count, 1);
  assert.equal(payload.seatFeedback.items[0].cinemaId, "cinema-a");
  assert.equal(payload.seatFeedback.items[0].status, "unprocessed");
  const statusUpdate = await worker.fetch(new Request("https://worker.example/api/admin/seat-feedback", {
    method: "POST", headers: { "X-Admin-Token": "test-admin-token", "Content-Type": "application/json" },
    body: JSON.stringify({ key: "seatfb:cinema-a:1", status: "processed" })
  }), env);
  assert.equal(statusUpdate.status, 200);
});

test("dashboard returns null success rate with no completed notifications and tolerates malformed JSON", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const active = await seedAccount(env, {
    id: "malformed-user",
    expiresAt: NOW + DAY,
    businessLine: "maoyan",
    config: { enabled: false }
  });
  await insertSubscription(env, active.account.id, "cinema-b");
  await env.DB.prepare(
    "INSERT INTO monitor_status(token_id,data,updated_at) VALUES (?,?,?)"
  ).bind(active.account.id, "{not-json", "not-a-time").run();
  await env.DB.prepare(
    "INSERT INTO lock_rule(token_id,data,updated_at) VALUES (?,?,?)"
  ).bind(active.account.id, "{also-not-json", "not-a-time").run();
  await insertNotification(env, { eventKey: "pending-only", userId: active.account.id, state: "pending" });

  const response = await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.summary.notificationSuccessRate, null);
  assert.equal(payload.summary.lockSuccess, 0);
  assert.equal(payload.summary.lockFailed, 0);
  assert.equal(payload.users[0].lastCheck, null);
  assert.equal(payload.users[0].lockState, null);
});

test("dashboard rejects non-admin access and unsupported query values", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const unauthorized = await worker.fetch(request("/api/admin/dashboard", { adminToken: "wrong" }), env);
  assert.equal(unauthorized.status, 401);
  const wrongBusinessLine = await worker.fetch(request("/api/admin/dashboard?businessLine=store&window=24h"), env);
  assert.equal(wrongBusinessLine.status, 400);
  const wrongWindow = await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=7d"), env);
  assert.equal(wrongWindow.status, 400);
});
