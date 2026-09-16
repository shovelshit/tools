import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { authenticate, requireActiveAccount } from "../src/maoyan/auth.js";
import { runScheduledChecks } from "../src/maoyan/tokens.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

function request(path, { method = "GET", token, adminToken, body } = {}) {
  const headers = {};
  if (token) headers["X-Token"] = token;
  if (adminToken) headers["X-Admin-Token"] = adminToken;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("capabilities is public and advertises account lifecycle", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const response = await worker.fetch(request("/api/capabilities"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    accountLifecycle: true,
    adminMonitorSession: true
  });
});

test("access key authenticates a principal without binding the current IP", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account, key } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const principal = await authenticate(request("/api/account", { token: key }), env, NOW);
  assert.equal(principal.userId, account.id);
  assert.equal(principal.credentialType, "access_key");
  assert.equal(principal.accountStatus, "active");
  assert.equal((await requireActiveAccount(env, account.id, NOW)).id, account.id);
});

test("expired and suspended accounts can read account/status but cannot mutate config", async () => {
  for (const fixture of [
    { state: "active", expiresAt: NOW - 1, code: "ACCOUNT_EXPIRED" },
    { state: "suspended", expiresAt: NOW + 60_000, code: "ACCOUNT_SUSPENDED" }
  ]) {
    const env = await createAccountEnv({ nowMs: NOW });
    env.NOW_MS = String(NOW);
    const { account, key } = await seedAccount(env, fixture);
    const own = await worker.fetch(request("/api/account", { token: key }), env);
    assert.equal(own.status, 200);
    assert.equal((await own.json()).account.accountStatus, fixture.code === "ACCOUNT_EXPIRED" ? "expired" : "suspended");
    assert.equal((await worker.fetch(request("/api/status", { token: key }), env)).status, 200);
    const write = await worker.fetch(request("/api/config", {
      method: "POST",
      token: key,
      body: { cinemaId: "25428" }
    }), env);
    assert.equal(write.status, 403);
    assert.equal((await write.json()).code, fixture.code);
    const stop = await worker.fetch(request("/api/config", {
      method: "POST",
      token: key,
      body: { enabled: false }
    }), env);
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).config.enabled, false);
    await assert.rejects(() => requireActiveAccount(env, account.id, NOW), { code: fixture.code });
  }
});

test("revoked credentials are rejected instead of exposing restricted status", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, { state: "revoked", expiresAt: NOW + 60_000 });
  const response = await worker.fetch(request("/api/account", { token: key }), env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNAUTHORIZED");
});

test("an expired user can renew with the original credential", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account, key } = await seedAccount(env, { expiresAt: NOW - 1 });
  const response = await worker.fetch(request("/api/account/renew", {
    method: "POST",
    token: key,
    body: { requestId: crypto.randomUUID(), expectedVersion: account.version }
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.account.accountStatus, "active");
  assert.equal(payload.account.userId, account.id);
  assert.equal((await authenticate(request("/api/account", { token: key }), env, NOW)).accountStatus, "active");
});

test("scheduled monitoring filters expired accounts before provider access", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  await seedAccount(env, {
    expiresAt: NOW - 1,
    config: { enabled: true, cinemaId: "25428", selectedMovieIds: ["7"] }
  });
  let providerCalls = 0;
  let lockCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("must not fetch"); };
  try {
    await runScheduledChecks(env, async () => { lockCalls += 1; }, { now: new Date(NOW) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerCalls, 0);
  assert.equal(lockCalls, 0);
});

test("ADMIN_TOKEN exchanges for a short monitor session with a stable admin UUID", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const exchange = async () => {
    const response = await worker.fetch(request("/api/auth/session", {
      method: "POST",
      token: env.ADMIN_TOKEN
    }), env);
    assert.equal(response.status, 200);
    return await response.json();
  };
  const first = await exchange();
  const second = await exchange();
  assert.equal(first.account.role, "admin");
  assert.equal(second.account.userId, first.account.userId);
  assert.match(first.monitorSession, /^[0-9a-f]{64}$/);
  assert.notEqual(second.monitorSession, first.monitorSession);

  const own = await worker.fetch(request("/api/account", { token: first.monitorSession }), env);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).account.role, "admin");
  const forbidden = await worker.fetch(request("/api/admin/tokens", { token: first.monitorSession }), env);
  assert.equal(forbidden.status, 401);
  assert.equal(
    await authenticate(request("/api/account", { token: first.monitorSession }), env, NOW + 24 * 60 * 60 * 1000),
    null
  );
});

test("rotating ADMIN_TOKEN invalidates monitor sessions without changing admin UUID", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const firstResponse = await worker.fetch(request("/api/auth/session", {
    method: "POST",
    token: env.ADMIN_TOKEN
  }), env);
  const first = await firstResponse.json();

  env.ADMIN_TOKEN = "rotated-admin-token";
  assert.equal((await worker.fetch(request("/api/account", { token: first.monitorSession }), env)).status, 401);
  const nextResponse = await worker.fetch(request("/api/auth/session", {
    method: "POST",
    token: env.ADMIN_TOKEN
  }), env);
  const next = await nextResponse.json();
  assert.equal(next.account.userId, first.account.userId);
});
