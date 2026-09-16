import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";

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
  const stale = await worker.fetch(request("/api/admin/accounts/update", {
    method: "POST", body: { id: account.id, expectedVersion: account.version, patch: { remark: "stale" } }
  }), env);
  assert.equal(stale.status, 409);
});

test("capacity settings use CAS and cannot drop below current occupancy", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 2 });
  env.NOW_MS = String(NOW);
  await seedAccount(env, { expiresAt: NOW + 10_000 });
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
