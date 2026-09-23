import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { evaluateBudget, readResourceSummary } from "../src/maoyan/resource-budget.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

test("admission closes before exhausting the configured budget", () => {
  assert.equal(evaluateBudget({ used: 70, limit: 100 }).admissionAllowed, false);
  assert.equal(evaluateBudget({ used: 69, limit: 100 }).admissionAllowed, true);
  assert.equal(evaluateBudget({ used: NaN, limit: 100 }).admissionAllowed, false);
});

test("unmeasured resources do not block admission, but an exhausted measured resource does", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  assert.equal((await readResourceSummary(env, NOW)).admissionAllowed, true);

  env.RESOURCE_USAGE_JSON = JSON.stringify({ d1RowsRead: { used: 70, limit: 100 } });
  const exhausted = await readResourceSummary(env, NOW);
  assert.equal(exhausted.admissionAllowed, false);
  assert.equal(exhausted.reason, "RESOURCE_EXHAUSTED");
});

test("admin resources returns aggregate measured and estimated fields only", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  env.NOW_MS = String(NOW);
  env.RESOURCE_USAGE_JSON = JSON.stringify({ workerRequests: { used: 1000, limit: 100000 } });
  const { account } = await seedAccount(env, { expiresAt: NOW + 86_400_000 });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "25428" }, 1, NOW);
  const response = await worker.fetch(new Request("https://worker.example/api/admin/resources", {
    headers: { "X-Admin-Token": env.ADMIN_TOKEN }
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.resources.usage.workerRequests.measured, true);
  assert.equal(payload.resources.activeCinemas, 1);
  assert.equal(JSON.stringify(payload).includes(account.id), false);
  assert.equal(JSON.stringify(payload).includes("token"), false);
});

test("notification diagnostics are admin-only, bounded and business isolated", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  const { account } = await seedAccount(env, { expiresAt: NOW + 86_400_000 });
  await env.DB.prepare(
    "INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,last_error,created_at,updated_at) VALUES (?,?,?,?,?,'failed',4,?,?,?)"
  ).bind("failure-1", account.id, "lock-terminal", "{}", 1, "full HTTP 403 response", NOW, NOW).run();
  const { account: store } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 86_400_000 });
  for (let i = 0; i < 8; i++) {
    await env.DB.prepare("INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,last_error,failure_detail,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(`recent-${i}`, i === 7 ? store.id : account.id, "lock-terminal", "{}", 1, i === 6 ? "sent" : i === 5 ? "sending" : "pending", 1, i === 6 ? null : "delivery error", i === 6 ? "lock failure" : null, NOW + 1000, NOW, NOW + i + 1).run();
  }
  const summary = await readResourceSummary(env, NOW);
  assert.equal(Object.hasOwn(summary, "notificationFailures"), false);
  assert.equal(summary.notificationPending, 6);
  const publicResponse = await worker.fetch(new Request("https://worker.example/api/enrollment/config"), env);
  assert.equal(publicResponse.status, 200);
  const publicText = await publicResponse.text();
  assert.equal(publicText.includes("notificationFailures"), false);
  assert.equal(publicText.includes("full HTTP 403 response"), false);
  assert.equal(publicText.includes("lock failure"), false);
  const request = (headers = {}) => new Request("https://worker.example/api/admin/resources", { headers });
  assert.notEqual((await worker.fetch(request(), env)).status, 200);
  const response = await worker.fetch(request({ "X-Admin-Token": env.ADMIN_TOKEN }), env);
  const { resources } = await response.json();
  assert.equal(resources.notificationFailures.length, 5);
  assert.deepEqual(resources.notificationFailures[0], {
    kind: "lock-terminal", state: "sent", attempts: 1, lastError: null,
    failureDetail: "lock failure", retryEligible: false
  });
  assert.equal(resources.notificationFailures[1].state, "sending");
  assert.equal(resources.notificationFailures[1].retryEligible, true);
  assert.equal(resources.notificationFailures[2].state, "pending");
  assert.equal(resources.notificationFailures[2].retryEligible, true);
});

test("Maoyan resource capacity excludes active Store accounts", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  await seedAccount(env, { businessLine: "maoyan", expiresAt: NOW + 86_400_000 });
  await seedAccount(env, { businessLine: "store", expiresAt: NOW + 86_400_000 });
  await seedAccount(env, { businessLine: "store", expiresAt: NOW + 86_400_000 });

  assert.deepEqual((await readResourceSummary(env, NOW)).capacity, { used: 1, maxUsers: 20 });
});

test("active cinemas only include enabled subscriptions of current Maoyan users", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const fixtures = [
    { cinemaId: "active", expiresAt: NOW + 1 },
    { cinemaId: "expired", expiresAt: NOW - 1 },
    { cinemaId: "revoked", expiresAt: NOW + 1, state: "revoked" },
    { cinemaId: "suspended", expiresAt: NOW + 1, state: "suspended" },
    { cinemaId: "archived", expiresAt: NOW + 1, archived: true },
    { cinemaId: "store", expiresAt: NOW + 1, businessLine: "store" },
    { cinemaId: "disabled", expiresAt: NOW + 1, enabled: false }
  ];
  for (const entry of fixtures) {
    const { account } = await seedAccount(env, { ...entry, state: entry.state === "revoked" ? "active" : entry.state });
    await syncSubscription(env.DB, account.id, { enabled: entry.enabled !== false, cinemaId: entry.cinemaId }, 1, NOW);
    if (entry.state === "revoked") {
      await env.DB.prepare("UPDATE users SET state='revoked' WHERE id=?").bind(account.id).run();
    }
    if (entry.archived) {
      await env.DB.prepare("UPDATE users SET archived_at=? WHERE id=?").bind(NOW, account.id).run();
    }
  }
  assert.equal((await readResourceSummary(env, NOW)).activeCinemas, 1);
});
