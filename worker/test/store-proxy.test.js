import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

async function storeSession(env) {
  const { key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW + 60_000 });
  const response = await worker.fetch(new Request("https://worker.example/store/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://worker.example" },
    body: JSON.stringify({ key })
  }), env);
  return response.headers.get("Set-Cookie").split(";")[0];
}

test("Store file access is denied before any provider request", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; return new Response("unexpected"); };
  try {
    const response = await worker.fetch(new Request(
      "https://worker.example/store/file?url=http%3A%2F%2Fappstore.cnmlynk.org%2Fsample.apk"
    ), env);
    assert.equal(response.status, 401);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing, detail, preview, and download return 401 before provider dispatch", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; return new Response("unexpected"); };
  try {
    const requests = [
      new Request("https://worker.example/store/api/fs/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      new Request("https://worker.example/store/api/fs/get", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      new Request("https://worker.example/store/file?url=http%3A%2F%2Fappstore.cnmlynk.org%2Fpreview.txt"),
      new Request("https://worker.example/store/file?url=http%3A%2F%2Fappstore.cnmlynk.org%2Fdownload.apk")
    ];
    for (const request of requests) assert.equal((await worker.fetch(request, env)).status, 401);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired Store sessions return 403 for listing, detail, preview, and download", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, { businessLine: "store", expiresAt: NOW - 1 });
  const login = await worker.fetch(new Request("https://worker.example/store/auth/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key })
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const init = { headers: { Cookie: cookie } };
  const requests = [
    new Request("https://worker.example/store/api/fs/list", { method: "POST", headers: { ...init.headers, "Content-Type": "application/json" }, body: "{}" }),
    new Request("https://worker.example/store/api/fs/get", { method: "POST", headers: { ...init.headers, "Content-Type": "application/json" }, body: "{}" }),
    new Request("https://worker.example/store/file?url=http%3A%2F%2Fappstore.cnmlynk.org%2Fpreview.txt", init),
    new Request("https://worker.example/store/file?url=http%3A%2F%2Fappstore.cnmlynk.org%2Fdownload.apk", init)
  ];
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; return new Response("unexpected"); };
  try {
    for (const request of requests) assert.equal((await worker.fetch(request, env)).status, 403);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated Store requests never forward browser credentials upstream", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const cookie = await storeSession(env);
  const observed = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    observed.push({ url: String(input), headers: new Headers(init.headers) });
    return new Response("payload", { headers: { "Content-Type": "application/octet-stream" } });
  };
  try {
    const apiResponse = await worker.fetch(new Request("https://worker.example/store/api/fs/list", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://worker.example",
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "X-Token": "secret"
      },
      body: "{}"
    }), env);
    assert.equal(apiResponse.status, 200);
    const fileResponse = await worker.fetch(new Request(
      "https://worker.example/store/file?url=https%3A%2F%2Fappstore.cnmlynk.org%2Fsample.apk",
      { headers: { Cookie: cookie, Authorization: "Bearer secret", "X-Token": "secret" } }
    ), env);
    assert.equal(fileResponse.status, 200);
    assert.equal(observed.length, 2);
    assert.equal(observed[0].url, "http://appstore.cnmlynk.org/api/fs/list");
    assert.equal(observed[1].url, "https://appstore.cnmlynk.org/sample.apk");
    for (const request of observed) {
      assert.equal(request.headers.has("cookie"), false);
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.has("x-token"), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Store proxy rejects redirects away from the provider allowlist", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const cookie = await storeSession(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { Location: "https://attacker.example/secret" }
  });
  try {
    const response = await worker.fetch(new Request(
      "https://worker.example/store/file?url=http%3A%2F%2Fappstore.cnmlynk.org%2Fsample.apk",
      { headers: { Cookie: cookie } }
    ), env);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /不受信任/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
