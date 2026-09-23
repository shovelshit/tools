import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { saveLockSession } from "../src/maoyan/lock-session.js";
import { userKey } from "../src/maoyan/user.js";
import { validSession } from "./helpers.js";
import * as db from "../src/maoyan/db.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

function request(path, { method = "GET", body, adminToken = "test-admin-token" } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      "X-Admin-Token": adminToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function seedRuntime(env, account, nowMs) {
  await db.putStatus(env.DB, account.id, { enabled: true });
  await db.saveSnapshot(env.DB, account.id, { movie: ["seat"] });
  await db.appendChange(env.DB, account.id, { time: new Date(nowMs).toISOString(), type: "ok", text: "change" });
  await db.putLockRuleRow(env.DB, account.id, { state: "waiting_schedule" });
  await env.DB.prepare(
    "INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,next_due_at,updated_at) VALUES (?,?,1,1,?,?)"
  ).bind(account.id, "cinema", nowMs, nowMs).run();
  await env.DB.prepare(
    "INSERT INTO notification_outbox(event_key,user_id,kind,payload,credential_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(`runtime:${account.id}`, account.id, "test", "{}", 1, nowMs, nowMs).run();
  await saveLockSession(env, account.id, validSession());
}

async function assertRuntimeCleared(env, account) {
  assert.equal(await db.getConfig(env.DB, account.id), null);
  assert.equal(await db.getStatus(env.DB, account.id), null);
  assert.deepEqual(await db.getSnapshot(env.DB, account.id), {});
  assert.deepEqual(await db.listChanges(env.DB, account.id), []);
  assert.equal(await db.getLockRuleRow(env.DB, account.id), null);
  assert.equal(await db.getSessionVersion(env.DB, account.id), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM monitor_subscriptions WHERE user_id=?").bind(account.id).first(), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM notification_outbox WHERE user_id=?").bind(account.id).first(), null);
  assert.equal(await env.MAOYAN_KV.get(userKey(account.id, "maoyan-session")), null);
  assert.equal((await env.MAOYAN_KV.list({ prefix: userKey(account.id, "maoyan-session:v") })).keys.length, 0);
}

test("admin account list is paged, filterable and credential-safe", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  env.NOW_MS = String(NOW);
  await seedAccount(env, { key: "never-return-this-key", remark: "Alice", expiresAt: NOW + 10_000 });
  await seedAccount(env, { key: "another-secret-key", remark: "Bob", state: "suspended", expiresAt: NOW + 10_000 });
  const response = await worker.fetch(request("/api/admin/accounts?status=active&q=Alice&limit=1"), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accounts.length, 1);
  assert.equal(payload.accounts[0].remark, "Alice");
  assert.equal(payload.accounts[0].accountStatus, "active");
  assert.equal(payload.capacity.maxUsers, 20);
  assert.equal(JSON.stringify(payload).includes("never-return-this-key"), false);
  assert.equal(Object.hasOwn(payload.accounts[0], "token"), false);
});

test("managed account key is returned once and creation obeys request idempotency", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 1 });
  env.NOW_MS = String(NOW);
  const requestId = crypto.randomUUID();
  const first = await worker.fetch(request("/api/admin/accounts/create", {
    method: "POST", body: { remark: "Managed", requestId }
  }), env);
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.match(created.key, /^[0-9a-f]{64}$/);
  const replay = await worker.fetch(request("/api/admin/accounts/create", {
    method: "POST", body: { remark: "Managed", requestId }
  }), env);
  assert.equal(replay.status, 200);
  assert.equal(Object.hasOwn(await replay.json(), "key"), false);
});

test("admin updates use optimistic account versions and reject arbitrary fields", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account } = await seedAccount(env, { expiresAt: NOW + 10_000 });
  const invalid = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { role: "admin" } }
  }), env);
  assert.equal(invalid.status, 400);
  const invalidExpiry = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { expiresAt: "not-a-time" } }
  }), env);
  assert.equal(invalidExpiry.status, 400);
  const updated = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { state: "suspended" } }
  }), env);
  assert.equal(updated.status, 200);
  const updatedPayload = await updated.json();
  assert.equal(updatedPayload.adminAccount.userId, account.id);
  assert.equal(updatedPayload.adminAccount.accountVersion, account.version + 1);
  assert.equal(updatedPayload.adminAccount.accountStatus, "suspended");
  assert.equal(updatedPayload.adminAccount.monitorState, "stopped");
  assert.equal(typeof updatedPayload.capacity.used, "number");
  const stale = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { remark: "stale" } }
  }), env);
  assert.equal(stale.status, 409);
});

test("admin remark edits reject overlong values and allow an empty remark", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account } = await seedAccount(env, { remark: "Named", expiresAt: NOW + 10_000 });
  const invalid = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { remark: "x".repeat(51) } }
  }), env);
  assert.equal(invalid.status, 400);
  const clear = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { remark: "   " } }
  }), env);
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).adminAccount.remark, "");
});

test("account revocation clears Maoyan runtime only after the state transition", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await seedRuntime(env, account, NOW);

  const staleRevoke = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version + 1, patch: { state: "revoked" } }
  }), env);
  assert.equal(staleRevoke.status, 409);
  assert.notEqual(await db.getConfig(env.DB, account.id), null);

  const suspended = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { state: "suspended" } }
  }), env);
  assert.equal(suspended.status, 200);
  assert.notEqual(await db.getConfig(env.DB, account.id), null);

  const revoke = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version + 1, patch: { state: "revoked" } }
  }), env);
  assert.equal(revoke.status, 200);
  await assertRuntimeCleared(env, account);
  assert.equal((await env.DB.prepare("SELECT state FROM users WHERE id=?").bind(account.id).first()).state, "revoked");
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM access_keys WHERE user_id=?").bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM audit_events WHERE subject_user_id=? AND event_type='account_updated'").bind(account.id).first(), null);
});

test("account revocation clears Store browser sessions while preserving the Store account", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });
  await env.DB.prepare(
    "INSERT INTO store_sessions(token_hash,business_line,user_id,expires_at,created_at) VALUES (?,?,?,?,?)"
  ).bind("a".repeat(64), "store", account.id, NOW + 60_000, NOW).run();

  const response = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { state: "revoked" } }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM store_sessions WHERE user_id=?").bind(account.id).first(), null);
  assert.equal((await env.DB.prepare("SELECT state FROM users WHERE id=?").bind(account.id).first()).state, "revoked");
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM access_keys WHERE user_id=?").bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM audit_events WHERE subject_user_id=? AND event_type='account_updated'").bind(account.id).first(), null);
});

test("capacity settings use CAS and cannot drop below current occupancy", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 2 });
  env.NOW_MS = String(NOW);
  env.TURNSTILE_SITE_KEY = "site";
  env.TURNSTILE_SECRET_KEY = "secret";
  env.ENROLLMENT_ORIGIN = "https://worker.example";
  env.ENROLLMENT_HOSTNAME = "worker.example";
  await seedAccount(env, { expiresAt: NOW + 365 * 86_400_000 });
  const read = await worker.fetch(request("/api/admin/settings"), env);
  assert.equal(read.status, 200);
  const settings = (await read.json()).settings;
  const tooLow = await worker.fetch(request("/api/admin/settings", {
    method: "POST",
    body: { expectedVersion: settings.version, maxUsers: 0, defaultValidDays: 15, publicSignupEnabled: false }
  }), env);
  assert.equal(tooLow.status, 409);
  const saved = await worker.fetch(request("/api/admin/settings", {
    method: "POST",
    body: { expectedVersion: settings.version, maxUsers: 3, defaultValidDays: 15, publicSignupEnabled: true }
  }), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.maxUsers, 3);
});

test("admin settings cannot enable public enrollment with incomplete security configuration", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const current = (await (await worker.fetch(request("/api/admin/settings"), env)).json()).settings;
  const response = await worker.fetch(request("/api/admin/settings", {
    method: "POST",
    body: { expectedVersion: current.version, maxUsers: 20, defaultValidDays: 15, publicSignupEnabled: true }
  }), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /TURNSTILE_SITE_KEY/);
});

test("admin can change Maoyan business windows with version protection and audit", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const path = "/api/admin/business-policy";
  const initial = await worker.fetch(request(path), env);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).policy.monitorStartMinute, 420);
  const denied = await worker.fetch(request(path, { adminToken: "wrong" }), env);
  assert.equal(denied.status, 401);
  const saved = await worker.fetch(request(path, { method: "POST", body: {
    expectedVersion: 1, monitorStartMinute: 1320, monitorEndMinute: 120,
    maintenanceStartMinute: 180, maintenanceEndMinute: 240
  } }), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).policy.version, 2);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='maoyan_business_policy_updated'").first()).n, 1);
  const stale = await worker.fetch(request(path, { method: "POST", body: {
    expectedVersion: 1, monitorStartMinute: 1320, monitorEndMinute: 120,
    maintenanceStartMinute: 180, maintenanceEndMinute: 240
  } }), env);
  assert.equal(stale.status, 409);
  const invalid = await worker.fetch(request(path, { method: "POST", body: {
    expectedVersion: 2, monitorStartMinute: 1320, monitorEndMinute: 120,
    maintenanceStartMinute: 60, maintenanceEndMinute: 120
  } }), env);
  assert.equal(invalid.status, 400);
});

test("admin accounts, creation, and settings are independently scoped by business line", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 2 });
  env.NOW_MS = String(NOW);
  await seedAccount(env, { remark: "Cinema", businessLine: "maoyan", expiresAt: NOW + 60_000 });
  await seedAccount(env, { remark: "Apps", businessLine: "store", expiresAt: NOW + 60_000 });

  const storeList = await worker.fetch(request("/api/admin/accounts?businessLine=store"), env);
  const listed = await storeList.json();
  assert.deepEqual(listed.accounts.map((account) => account.remark), ["Apps"]);
  assert.equal(listed.accounts[0].businessLine, "store");
  assert.equal(listed.accounts[0].monitorState, null);
  assert.equal(listed.accounts[0].lastActivityAt, null);
  assert.equal(listed.capacity.used, 1);

  const settingsResponse = await worker.fetch(request("/api/admin/settings?businessLine=store"), env);
  const storeSettings = (await settingsResponse.json()).settings;
  assert.equal(storeSettings.maxUsers, 20);
  const created = await worker.fetch(request("/api/admin/accounts/create", {
    method: "POST",
    body: { remark: "Second app", businessLine: "store", requestId: crypto.randomUUID() }
  }), env);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).account.businessLine, "store");

  const maoyanList = await worker.fetch(request("/api/admin/accounts"), env);
  assert.deepEqual((await maoyanList.json()).accounts.map((account) => account.remark), ["Cinema"]);
});

test("business assignment cannot be edited on an existing account", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });
  const response = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST",
    body: { id: account.id, expectedVersion: account.version, patch: { businessLine: "maoyan" } }
  }), env);
  assert.equal(response.status, 400);
});
