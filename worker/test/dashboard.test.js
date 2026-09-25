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
    "INSERT INTO cinema_state(cinema_id,current_version,current_data,run_state,completed_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).bind(
    "cinema-a", 1, JSON.stringify({ showData: { cinemaName: "影院 A", movies: [] } }), "completed", NOW - 5 * 60 * 1000, NOW - 5 * 60 * 1000
  ).run();

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
  assert.equal(payload.cinemas[0].newShows, 0);
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

test("dashboard isolates seat feedback and counts only pending notifications", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const maoyan = await seedAccount(env, {
    id: "feedback-maoyan", expiresAt: NOW + DAY, businessLine: "maoyan", config: { enabled: true }
  });
  const store = await seedAccount(env, {
    id: "feedback-store", expiresAt: NOW + DAY, businessLine: "store", config: { enabled: true }
  });
  await env.DB.prepare(
    "INSERT INTO seat_feedback(fb_key,reported_at,day,token_id,cinema_id,movie_id,seq_no,source) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(
    "seatfb:feedback-maoyan:1", new Date(NOW - 2_000).toISOString(), "2026-09-20", maoyan.account.id,
    "cinema-maoyan", "movie-maoyan", "1", "auto"
  ).run();
  await env.DB.prepare(
    "INSERT INTO seat_feedback(fb_key,reported_at,day,token_id,cinema_id,movie_id,seq_no,source) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(
    "seatfb:feedback-store:1", new Date(NOW - 1_000).toISOString(), "2026-09-20", store.account.id,
    "cinema-store", "movie-store", "1", "auto"
  ).run();
  await insertNotification(env, { eventKey: "feedback-pending", userId: maoyan.account.id, state: "pending" });
  await insertNotification(env, { eventKey: "feedback-sending", userId: maoyan.account.id, state: "sending" });

  const payload = await (await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env)).json();
  assert.equal(payload.summary.pendingNotifications, 1);
  assert.equal(payload.seatFeedback.count, 1);
  assert.deepEqual(payload.seatFeedback.items.map((item) => item.tokenId), [maoyan.account.id]);
});

test("dashboard uses cinema_state as the current cinema source", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const active = await seedAccount(env, {
    id: "state-user", expiresAt: NOW + DAY, businessLine: "maoyan", config: { enabled: true }
  });
  await insertSubscription(env, active.account.id, "cinema-state");
  await env.DB.prepare(
    "INSERT INTO cinema_state(cinema_id,current_version,current_data,run_state,completed_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).bind("cinema-state", 2, JSON.stringify({ showData: { cinemaName: "当前影院", movies: [] } }), "completed", NOW - 1000, NOW - 1000).run();
  await insertNotification(env, {
    eventKey: "cinema:cinema-state:run-1:state-user:movie-1",
    userId: active.account.id, kind: "new-shows", state: "pending"
  });
  const payload = await (await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env)).json();
  assert.equal(payload.users[0].cinemaName, "当前影院");
  assert.equal(payload.cinemas[0].cinemaName, "当前影院");
  assert.equal(payload.cinemas[0].newShows, 1);
  assert.equal(payload.health.latestBatchAt, NOW - 1000);
});

test("dashboard exposes selected movie details and cinema runtime state", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const active = await seedAccount(env, {
    id: "detail-user",
    expiresAt: NOW + DAY,
    businessLine: "maoyan",
    config: { enabled: true, cinemaId: "cinema-detail", selectedMovieIds: ["101", "202"] }
  });
  await insertSubscription(env, active.account.id, "cinema-detail");
  const movie101Shows = Array.from({ length: 6 }, (_, index) => ({
    seqNo: String(1010 + index), tm: `1${String(index).padStart(2, "0")}`, th: `${index + 1} 号厅`, ticketStatus: 0
  }));
  await env.DB.prepare(
    "INSERT INTO cinema_state(cinema_id,current_version,current_data,active_run_id,run_state,attempt_count,completed_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(
    "cinema-detail", 4, JSON.stringify({ showData: { cinemaName: "详情影院", movies: [
      { id: "101", nm: "监控电影 A", shows: [{ showDate: "2026-09-25", plist: movie101Shows }] },
      { id: "202", nm: "监控电影 B", shows: [{ showDate: "2026-09-25", plist: [{ seqNo: "2020", tm: "20:20", th: "8 号厅", ticketStatus: 1 }] }] },
      { id: "303", nm: "未选电影", shows: [{ showDate: "2026-09-25", plist: [{ seqNo: "3030", tm: "21:30", th: "9 号厅", ticketStatus: 1 }] }] }
    ] } }),
    "run-detail", "retryable", 2, NOW - 10 * 60 * 1000, NOW - 1_000
  ).run();

  const payload = await (await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env)).json();
  const user = payload.users[0];
  const cinema = payload.cinemas[0];
  assert.equal(payload.summary.monitoredMovies, 2);
  assert.equal(payload.summary.currentShows, 7);
  assert.equal(payload.summary.attentionCinemas, 1);
  assert.equal(payload.summary.pendingNotifications, 0);
  assert.equal(user.cinemaRunState, "retryable");
  assert.equal(user.activeRunId, "run-detail");
  assert.equal(user.attemptCount, 2);
  assert.equal(user.monitorContent.selectedCount, 2);
  assert.equal(user.monitorContent.availableShows, 7);
  assert.deepEqual(user.monitorContent.movies.map((movie) => [movie.movieId, movie.movieName, movie.showCount, movie.hasMoreShows]), [
    ["101", "监控电影 A", 6, true],
    ["202", "监控电影 B", 1, false]
  ]);
  assert.equal(user.monitorContent.movies[0].nextShows.length, 5);
  assert.equal(user.monitorContent.movies[0].nextShows[0].hall, "1 号厅");
  assert.equal(cinema.movieCount, 3);
  assert.equal(cinema.showCount, 8);
  assert.equal(cinema.runState, "retryable");
  assert.equal(cinema.activeRunId, "run-detail");
  assert.equal(cinema.attemptCount, 2);
  assert.equal(cinema.stale, true);
});

test("admin notification detail returns full content and isolates business lines", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const maoyan = await seedAccount(env, {
    id: "notification-detail-maoyan", expiresAt: NOW + DAY, businessLine: "maoyan", config: { enabled: true }
  });
  const store = await seedAccount(env, {
    id: "notification-detail-store", expiresAt: NOW + DAY, businessLine: "store", config: { enabled: true }
  });
  const payload = JSON.stringify({
    title: "新场次通知",
    content: "这是完整通知正文\n包含影片、日期和影厅",
    meta: {
      movieId: "101", cinemaId: "cinema-detail", accessToken: "must-not-return",
      providerResponse: { httpStatus: 403, responseBody: "猫眼原始响应".repeat(200) },
      lockRule: { targetDate: "2026-09-30", seats: [{ label: "11排23座", seatNo: "1-11-23" }] }
    }
  });
  const maoyanResult = await env.DB.prepare(
    "INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,last_error,failure_detail,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    "notification-detail-maoyan", maoyan.account.id, "new-shows", payload, 1, "failed", 3,
    "发送失败", "HTTP 403", NOW + 60_000, NOW - 2_000, NOW - 1_000
  ).run();
  const storeResult = await env.DB.prepare(
    "INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(
    "notification-detail-store", store.account.id, "test", payload, 1, "sent", 1, NOW, NOW
  ).run();
  const maoyanId = Number((await env.DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind("notification-detail-maoyan").first()).id);
  const storeId = Number((await env.DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind("notification-detail-store").first()).id);

  const response = await worker.fetch(request(`/api/admin/notifications/${maoyanId}?businessLine=maoyan`), env);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.notification.title, "新场次通知");
  assert.equal(detail.notification.content, "这是完整通知正文\n包含影片、日期和影厅");
  assert.equal(detail.notification.remark, "");
  assert.equal(detail.notification.attempts, 3);
  assert.equal(detail.notification.lastError, "发送失败");
  assert.equal(detail.notification.failureDetail, "HTTP 403");
  assert.equal(detail.notification.meta.movieId, "101");
  assert.equal(Object.hasOwn(detail.notification.meta, "accessToken"), false);
  assert.equal(detail.notification.meta.providerResponse.responseBody, "猫眼原始响应".repeat(200));
  assert.equal(detail.notification.meta.lockRule.targetDate, "2026-09-30");
  assert.deepEqual(detail.notification.meta.lockRule.seats, [{ label: "11排23座", seatNo: "1-11-23" }]);

  const longContent = "完整通知正文".repeat(1_000);
  await env.DB.prepare(
    "INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(
    "notification-detail-long", maoyan.account.id, "new-shows", JSON.stringify({ title: "长通知", content: longContent }),
    1, "sent", 1, NOW, NOW
  ).run();
  const longId = Number((await env.DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind("notification-detail-long").first()).id);
  const longResponse = await worker.fetch(request(`/api/admin/notifications/${longId}?businessLine=maoyan`), env);
  assert.equal((await longResponse.json()).notification.content, longContent);

  const crossBusiness = await worker.fetch(request(`/api/admin/notifications/${storeId}?businessLine=maoyan`), env);
  assert.equal(crossBusiness.status, 404);
  assert.equal((await crossBusiness.json()).code, "NOT_FOUND");

  const invalid = await worker.fetch(request("/api/admin/notifications/not-a-number?businessLine=maoyan"), env);
  assert.equal(invalid.status, 400);
});

test("dashboard distinguishes verified maintenance scans from incomplete and unrun jobs", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const localDate = "2026-09-20";
  const observedAt = Date.parse("2026-09-19T17:00:00Z");
  await env.DB.prepare(
    "INSERT INTO audit_events(event_type,request_id,data,created_at) VALUES (?,?,?,?)"
  ).bind("maoyan_maintenance_observation_started", "maintenance-observation", JSON.stringify({ localDate }), observedAt).run();
  await env.DB.prepare(
    "INSERT INTO maoyan_maintenance_runs(job_id,local_date,completed_at,updated_at,lease_until) VALUES (?,?,?,?,0),(?,?,?,?,0)"
  ).bind("reminder", localDate, NOW - 600_000, NOW - 600_000, "archive", localDate, null, NOW - 500_000).run();
  await env.DB.prepare(
    "INSERT INTO audit_events(event_type,request_id,data,created_at) VALUES (?,?,?,?),(?,?,?,?)"
  ).bind(
    "maoyan_maintenance_close_verified", `reminder:${localDate}`,
    JSON.stringify({ jobId: "reminder", localDate, complete: true, runUpdatedAt: NOW - 600_000 }), NOW - 400_000,
    "maoyan_maintenance_close_verified", `archive:${localDate}`,
    JSON.stringify({ jobId: "archive", localDate, complete: false, runUpdatedAt: NOW - 500_000 }), NOW - 300_000
  ).run();
  const response = await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env);
  const payload = await response.json();
  assert.equal(payload.health.maintenance.localDate, localDate);
  assert.equal(payload.health.maintenance.observedAt, observedAt);
  assert.deepEqual(payload.health.maintenance.jobs.map(({ jobId, status }) => [jobId, status]), [
    ["reminder", "completed"], ["archive", "incomplete"], ["revocation", "unrun"]
  ]);
  assert.equal(payload.health.maintenance.jobs[0].completedAt, NOW - 600_000);
  await env.DB.prepare(
    "UPDATE maoyan_maintenance_runs SET updated_at=? WHERE job_id='reminder' AND local_date=?"
  ).bind(NOW - 100_000, localDate).run();
  const reopened = await (await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env)).json();
  assert.equal(reopened.health.maintenance.jobs[0].status, "incomplete");
});

test("dashboard does not mark the first day unrun when observation starts after the maintenance window", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  await env.DB.prepare(
    "INSERT INTO audit_events(event_type,request_id,data,created_at) VALUES (?,?,?,?)"
  ).bind("maoyan_maintenance_observation_started", "maintenance-observation", "{\"localDate\":\"2026-09-20\"}", NOW - 1000).run();
  const payload = await (await worker.fetch(request("/api/admin/dashboard?businessLine=maoyan&window=24h"), env)).json();
  assert.deepEqual(payload.health.maintenance.jobs.map((job) => job.status), ["unobserved", "unobserved", "unobserved"]);
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
