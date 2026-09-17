import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createDB, testEncryptionKey } from "./helpers.js";
import { getConfig, putConfigVersioned } from "../src/maoyan/db.js";
import { putUserConfig } from "../src/maoyan/user.js";

const tokenId = "11111111-1111-4111-8111-111111111111";

async function runtime(config = {}) {
  const env = {
    DB: await createDB({
      tokens: [{ id: tokenId, token: "access-token" }]
    }),
    SESSION_ENCRYPTION_KEY: testEncryptionKey()
  };
  await putUserConfig(env, tokenId, config);
  return env;
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
  const missingResponse = await worker.fetch(request("/api/config", { enabled: true }), await missing);
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error, /配置.*Server酱/);

  const untested = runtime({ notifyChannel: "bark", barkKey: "test-key", enabled: false });
  const untestedResponse = await worker.fetch(request("/api/config", { enabled: true }), await untested);
  assert.equal(untestedResponse.status, 400);
  assert.match((await untestedResponse.json()).error, /测试推送/);
});

test("a successful test verifies only the current channel and credential", async () => {
  const env = await runtime({ notifyChannel: "bark", barkKey: "test-key", enabled: false });
  let notification;

  await withMockFetch(async (input) => {
    const [, , title, content] = new URL(String(input)).pathname.split("/");
    notification = { title: decodeURIComponent(title), content: decodeURIComponent(content) };
    return Response.json({ code: 200 });
  }, async () => {
    const testResponse = await worker.fetch(request("/api/test-push", {}), env);
    assert.equal(testResponse.status, 200);
  });
  assert.deepEqual(notification, {
    title: "🔔 猫眼监控｜通知测试",
    content: "✅ 这是一条测试消息\n📡 收到此消息，说明当前通知通道可用"
  });

  const verifiedConfig = await getConfig(env.DB, tokenId);
  assert.match(verifiedConfig.notifyVerification.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(verifiedConfig.notifyVerification).includes("test-key"), false);
  assert.equal(Object.hasOwn(verifiedConfig, "barkKey"), false);
  assert.equal(verifiedConfig.notifyCredentials.bark.v, 1);
  assert.equal(JSON.stringify(verifiedConfig.notifyCredentials).includes("test-key"), false);

  const getResponse = await worker.fetch(request("/api/config"), env);
  const getBody = await getResponse.json();
  assert.equal(getBody.config.notifyVerified, true);
  assert.equal(Object.hasOwn(getBody.config, "notifyVerification"), false);

  const startResponse = await worker.fetch(request("/api/config", { enabled: true }), env);
  assert.equal(startResponse.status, 200);
  const started = (await startResponse.json()).config;
  assert.equal(started.enabled, true);
  const subscription = await env.DB.prepare(
    "SELECT cinema_id,enabled,config_version FROM monitor_subscriptions WHERE user_id=?"
  ).bind(tokenId).first();
  assert.deepEqual({
    cinemaId: subscription.cinema_id,
    enabled: Number(subscription.enabled),
    configVersion: Number(subscription.config_version)
  }, { cinemaId: "", enabled: 0, configVersion: started.version });

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

test("the removed Bark-specific test route is unsupported", async () => {
  const response = await worker.fetch(request("/api/test-bark", {}), await runtime());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Unknown API");
});

test("stale config writes cannot overwrite another device", async () => {
  const env = await runtime({ cinemaId: "1" });
  const before = await getConfig(env.DB, tokenId);
  const first = await putConfigVersioned(env.DB, tokenId, { ...before, cinemaId: "2" }, before.version);
  assert.equal(first.version, before.version + 1);
  await assert.rejects(
    () => putConfigVersioned(env.DB, tokenId, { ...before, cinemaId: "3" }, before.version),
    { code: "CONFIG_CONFLICT" }
  );
  assert.equal((await getConfig(env.DB, tokenId)).cinemaId, "2");
});

test("config API rejects a stale expectedVersion", async () => {
  const env = await runtime({ cinemaId: "1" });
  const current = (await (await worker.fetch(request("/api/config"), env)).json()).config;
  const first = await worker.fetch(request("/api/config", { cinemaId: "2", expectedVersion: current.version }), env);
  assert.equal(first.status, 200);
  const stale = await worker.fetch(request("/api/config", { cinemaId: "3", expectedVersion: current.version }), env);
  assert.equal(stale.status, 409);
  assert.equal((await getConfig(env.DB, tokenId)).cinemaId, "2");
});
