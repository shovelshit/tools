import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

function storeRequest(path, { method = "GET", cookie, body, headers = {} } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("a Store key creates a path-scoped browser session without storing its secret", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account, key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });

  const response = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }, headers: { Origin: "https://worker.example" }
  }), env);

  assert.equal(response.status, 200);
  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /^store_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/store\/; Max-Age=86400; Secure$/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).account.userId, account.id);
  const session = await env.DB.prepare("SELECT token_hash,business_line,user_id,expires_at FROM store_sessions").first();
  assert.equal(session.business_line, "store");
  assert.equal(session.user_id, account.id);
  assert.notEqual(cookie.match(/^store_session=([^;]+)/)[1], session.token_hash);
});

test("a Store login racing revocation cannot recreate a browser session", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account, key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });
  const batch = env.DB.batch.bind(env.DB);
  let revoked = false;
  env.DB.batch = async (statements) => {
    if (!revoked) {
      revoked = true;
      await env.DB.prepare("UPDATE users SET state='revoked' WHERE id=?").bind(account.id).run();
    }
    return await batch(statements);
  };

  const response = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }, headers: { Origin: "https://worker.example" }
  }), env);

  assert.equal(response.status, 403);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM store_sessions WHERE user_id=?").bind(account.id).first(), null);
});

test("Store session grants only its owner account inspection and logout", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account, key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });
  const login = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  const own = await worker.fetch(storeRequest("/store/auth/session", { cookie }), env);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).account.userId, account.id);

  const logout = await worker.fetch(storeRequest("/store/auth/logout", {
    method: "POST", cookie, headers: { Origin: "https://worker.example" }
  }), env);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("Set-Cookie"), /^store_session=; HttpOnly; SameSite=Lax; Path=\/store\/; Max-Age=0; Secure$/);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM store_sessions").first(), null);
  assert.equal((await worker.fetch(storeRequest("/store/auth/session", { cookie }), env)).status, 401);
});

test("Store logout clears an invalid browser cookie idempotently", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const response = await worker.fetch(storeRequest("/store/auth/logout", {
    method: "POST",
    cookie: "store_session=stale-session",
    headers: { Origin: "https://worker.example" }
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie"), /^store_session=; HttpOnly; SameSite=Lax; Path=\/store\/; Max-Age=0; Secure$/);
  assert.deepEqual(await response.json(), { ok: true });
});

test("Store session mutation rejects a foreign origin and non-JSON login", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });

  const foreign = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }, headers: { Origin: "https://attacker.example" }
  }), env);
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, "FORBIDDEN");
  assert.equal(foreign.headers.get("Cache-Control"), "no-store");

  const nonJson = await worker.fetch(new Request("https://worker.example/store/auth/session", {
    method: "POST", headers: { Origin: "https://worker.example" }, body: JSON.stringify({ key })
  }), env);
  assert.equal(nonJson.status, 400);
  assert.equal((await nonJson.json()).code, "INVALID_REQUEST");
});

test("an expired Store session can inspect and renew only its Store account", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { account, key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW - 1 });
  const login = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  const inspect = await worker.fetch(storeRequest("/store/auth/session", { cookie }), env);
  assert.equal(inspect.status, 200);
  assert.equal((await inspect.json()).account.accountStatus, "expired");

  const renewal = await worker.fetch(storeRequest("/store/auth/renew", {
    method: "POST", cookie, headers: { Origin: "https://worker.example" },
    body: { requestId: crypto.randomUUID(), expectedVersion: account.version }
  }), env);
  assert.equal(renewal.status, 200);
  const body = await renewal.json();
  assert.equal(body.account.accountStatus, "active");
  assert.equal(body.account.userId, account.id);
  assert.equal(Object.hasOwn(body, "resume"), false);
});

test("Store sessions recheck suspended accounts before download access", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, {
    businessLine: "store", state: "suspended", expiresAt: NOW + 60_000
  });
  const login = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  const response = await worker.fetch(storeRequest("/store/file?url=http://appstore.cnmlynk.org/download", { cookie }), env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ACCOUNT_SUSPENDED");
});

test("Store API mutation rejects cross-site requests and does not emit wildcard CORS", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });
  const login = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key }
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", {
    headers: { "Content-Type": "application/json" }
  });
  try {
    const foreign = await worker.fetch(storeRequest("/store/api/fs/list", {
      method: "POST", cookie, body: {}, headers: { Origin: "https://attacker.example" }
    }), env);
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).code, "FORBIDDEN");
    assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);

    const crossSite = await worker.fetch(storeRequest("/store/api/fs/list", {
      method: "POST", cookie, body: {}, headers: {
        Origin: "https://worker.example", "Sec-Fetch-Site": "cross-site"
      }
    }), env);
    assert.equal(crossSite.status, 403);

    const sameOrigin = await worker.fetch(storeRequest("/store/api/fs/list", {
      method: "POST", cookie, body: {}, headers: { Origin: "https://worker.example" }
    }), env);
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get("Access-Control-Allow-Origin"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rotating the administrator credential invalidates Store browser sessions", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const login = await worker.fetch(storeRequest("/store/auth/session", {
    method: "POST", body: { key: env.ADMIN_TOKEN }
  }), env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  env.ADMIN_TOKEN = "rotated-admin-token";
  const session = await worker.fetch(storeRequest("/store/auth/session", { cookie }), env);
  assert.equal(session.status, 401);
  assert.equal((await session.json()).code, "UNAUTHORIZED");
});
