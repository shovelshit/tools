import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { MemoryKV } from "./helpers.js";
import { userKey } from "../src/maoyan/user.js";

const tokenId = "11111111-1111-4111-8111-111111111111";

function runtime(config = {}) {
  return {
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([{ id: tokenId, token: "access-token" }]),
      [userKey(tokenId, "config")]: JSON.stringify(config)
    })
  };
}

function request(path, body) {
  return new Request(`https://worker.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Token": "access-token",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("monitoring cannot start without a configured and tested current notification channel", async () => {
  const missing = runtime({ notifyChannel: "serverchan", enabled: false });
  const missingResponse = await worker.fetch(request("/api/config", { enabled: true }), missing);
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error, /配置.*Server酱/);

  const untested = runtime({ notifyChannel: "bark", barkKey: "test-key", enabled: false });
  const untestedResponse = await worker.fetch(request("/api/config", { enabled: true }), untested);
  assert.equal(untestedResponse.status, 400);
  assert.match((await untestedResponse.json()).error, /测试推送/);
});

test("a successful test verifies only the current channel and credential", async () => {
  const env = runtime({ notifyChannel: "bark", barkKey: "test-key", enabled: false });

  await withMockFetch(async () => new Response("ok", { status: 200 }), async () => {
    const testResponse = await worker.fetch(request("/api/test-push", {}), env);
    assert.equal(testResponse.status, 200);
  });

  const verifiedConfig = await env.MAOYAN_KV.get(userKey(tokenId, "config"), "json");
  assert.match(verifiedConfig.notifyVerification.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(verifiedConfig.notifyVerification).includes("test-key"), false);

  const getResponse = await worker.fetch(request("/api/config"), env);
  const getBody = await getResponse.json();
  assert.equal(getBody.config.notifyVerified, true);
  assert.equal(Object.hasOwn(getBody.config, "notifyVerification"), false);

  const startResponse = await worker.fetch(request("/api/config", { enabled: true }), env);
  assert.equal(startResponse.status, 200);
  assert.equal((await startResponse.json()).config.enabled, true);

  const changedResponse = await worker.fetch(request("/api/config", {
    enabled: false,
    barkKey: "changed-key"
  }), env);
  assert.equal(changedResponse.status, 200);
  assert.equal((await changedResponse.json()).config.notifyVerified, false);

  const restartResponse = await worker.fetch(request("/api/config", { enabled: true }), env);
  assert.equal(restartResponse.status, 400);
  assert.match((await restartResponse.json()).error, /测试推送/);
});
