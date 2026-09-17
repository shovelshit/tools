import test from "node:test";
import assert from "node:assert/strict";
import { handleEnrollmentApi } from "../src/maoyan/enrollment-api.js";
import { createAccountEnv } from "./account-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");
const ORIGIN = "https://tools.example";
const FINGERPRINT = "a".repeat(32);

async function enrollmentEnv() {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 1 });
  env.NOW_MS = String(NOW);
  env.ENROLLMENT_ORIGIN = ORIGIN;
  env.ENROLLMENT_HOSTNAME = "tools.example";
  env.TURNSTILE_SECRET_KEY = "secret";
  env.TURNSTILE_SITE_KEY = "site";
  env.RESOURCE_USAGE_JSON = JSON.stringify(Object.fromEntries(
    ["workerRequests", "d1RowsRead", "d1RowsWritten", "kvWrites", "doRequests"].map((key) => [key, { used: 1, limit: 100 }])
  ));
  await env.DB.prepare("UPDATE service_settings SET public_signup_enabled=1 WHERE id=1").run();
  return env;
}

function request(path, { method = "GET", body, token, origin = ORIGIN } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "2001:db8::1",
      ...(token ? { "X-Token": token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function turnstileFetch({ success = true } = {}) {
  return async (url, options) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(options.method, "POST");
    return Response.json({ success, hostname: "tools.example", action: "enroll", challenge_ts: new Date(NOW).toISOString() });
  };
}

test("reserve and confirm return a key once and never bind later use to the claim IP", async () => {
  const env = await enrollmentEnv();
  const requestId = crypto.randomUUID();
  let turnstileCalls = 0;
  const verify = async (...args) => { turnstileCalls += 1; return await turnstileFetch()(...args); };
  const reserveRequest = request("/api/enrollment/reserve", {
    method: "POST",
    body: { requestId, fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
  });
  const reserved = await handleEnrollmentApi(reserveRequest, env, new URL(reserveRequest.url), { fetchImpl: verify });
  assert.equal(reserved.status, 201);
  const reservation = await reserved.json();
  assert.match(reservation.key, /^[0-9a-f]{64}$/);
  assert.equal(reserved.headers.get("Cache-Control"), "no-store");

  const replayRequest = request("/api/enrollment/reserve", {
    method: "POST",
    body: { requestId, fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
  });
  const replay = await handleEnrollmentApi(replayRequest, env, new URL(replayRequest.url), { fetchImpl: verify });
  const replayPayload = await replay.json();
  assert.equal(Object.hasOwn(replayPayload, "key"), false);
  assert.equal(Object.hasOwn(replayPayload, "userId"), false);
  assert.equal(turnstileCalls, 1);

  const confirmRequest = request("/api/enrollment/confirm", { method: "POST", token: reservation.key, body: { requestId } });
  const confirmed = await handleEnrollmentApi(confirmRequest, env, new URL(confirmRequest.url));
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).account.accountStatus, "active");

  const confirmedReplay = request("/api/enrollment/reserve", {
    method: "POST",
    body: { requestId, fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
  });
  const confirmedReplayPayload = await (await handleEnrollmentApi(
    confirmedReplay, env, new URL(confirmedReplay.url), { fetchImpl: verify }
  )).json();
  assert.deepEqual(confirmedReplayPayload, { ok: true, status: "confirmed" });
  assert.equal(turnstileCalls, 1);
});

test("public enrollment configuration fails closed without disclosing missing deployment settings", async () => {
  const env = await enrollmentEnv();
  delete env.TURNSTILE_SECRET_KEY;
  const configRequest = request("/api/enrollment/config");
  const configResponse = await handleEnrollmentApi(configRequest, env, new URL(configRequest.url));
  const config = await configResponse.json();
  assert.equal(config.claimable, false);
  assert.equal(config.pendingConfirmable, false);
  assert.equal(Object.hasOwn(config, "missing"), false);

  const body = { requestId: crypto.randomUUID(), fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "bad" };
  const unavailable = request("/api/enrollment/reserve", { method: "POST", body });
  const unavailableResponse = await handleEnrollmentApi(unavailable, env, new URL(unavailable.url), { fetchImpl: turnstileFetch() });
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), {
    ok: false, code: "SERVICE_UNAVAILABLE", error: "当前暂不可领取"
  });
});

test("an invalid enrollment HMAC is hidden by the generic unavailable reserve response", async () => {
  const env = await enrollmentEnv();
  env.ENROLLMENT_HMAC_KEY = "too-short";
  const reserveRequest = request("/api/enrollment/reserve", {
    method: "POST",
    body: { requestId: crypto.randomUUID(), fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
  });
  const response = await handleEnrollmentApi(reserveRequest, env, new URL(reserveRequest.url), { fetchImpl: turnstileFetch() });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false, code: "SERVICE_UNAVAILABLE", error: "当前暂不可领取"
  });
});

test("noncanonical enrollment hostname variants are unavailable before Turnstile verification", async () => {
  for (const hostname of [" tools.example", "TOOLS.EXAMPLE"]) {
    const env = await enrollmentEnv();
    env.ENROLLMENT_HOSTNAME = hostname;
    const configRequest = request("/api/enrollment/config");
    assert.equal((await (await handleEnrollmentApi(configRequest, env, new URL(configRequest.url))).json()).claimable, false);

    let turnstileCalls = 0;
    const reserveRequest = request("/api/enrollment/reserve", {
      method: "POST",
      body: { requestId: crypto.randomUUID(), fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
    });
    const response = await handleEnrollmentApi(reserveRequest, env, new URL(reserveRequest.url), {
      fetchImpl: async (...args) => { turnstileCalls += 1; return await turnstileFetch()(...args); }
    });
    assert.deepEqual(await response.json(), {
      ok: false, code: "SERVICE_UNAVAILABLE", error: "当前暂不可领取"
    });
    assert.equal(turnstileCalls, 0);
  }
});

test("origin and Turnstile checks reject invalid reserve requests", async () => {
  const env = await enrollmentEnv();
  const body = { requestId: crypto.randomUUID(), fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "bad" };
  const wrongOrigin = request("/api/enrollment/reserve", { method: "POST", body, origin: "https://evil.example" });
  assert.equal((await handleEnrollmentApi(wrongOrigin, env, new URL(wrongOrigin.url), { fetchImpl: turnstileFetch() })).status, 403);
  const invalid = request("/api/enrollment/reserve", { method: "POST", body });
  assert.equal((await handleEnrollmentApi(invalid, env, new URL(invalid.url), { fetchImpl: turnstileFetch({ success: false }) })).status, 400);
});

test("optional resource measurements allow enrollment while measured exhaustion blocks it", async () => {
  const env = await enrollmentEnv();
  const body = { fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" };
  delete env.RESOURCE_USAGE_JSON;
  const optionalMetrics = request("/api/enrollment/reserve", { method: "POST", body: { ...body, requestId: crypto.randomUUID() } });
  assert.equal((await handleEnrollmentApi(optionalMetrics, env, new URL(optionalMetrics.url), { fetchImpl: turnstileFetch() })).status, 201);

  const exhausted = await enrollmentEnv();
  exhausted.RESOURCE_USAGE_JSON = JSON.stringify({ workerRequests: { used: 70, limit: 100 } });
  const exhaustedRequest = request("/api/enrollment/reserve", { method: "POST", body: { ...body, requestId: crypto.randomUUID() } });
  const exhaustedResponse = await handleEnrollmentApi(exhaustedRequest, exhausted, new URL(exhaustedRequest.url), { fetchImpl: turnstileFetch() });
  assert.equal(exhaustedResponse.status, 503);
  assert.deepEqual(await exhaustedResponse.json(), {
    ok: false, code: "SERVICE_UNAVAILABLE", error: "当前暂不可领取"
  });
});

test("confirm fails closed with a generic unavailable response when the service gate closes", async () => {
  for (const closeGate of [
    async (env) => { await env.DB.prepare("UPDATE service_settings SET public_signup_enabled=0 WHERE id=1").run(); },
    async (env) => { delete env.TURNSTILE_SECRET_KEY; },
    async (env) => { env.RESOURCE_USAGE_JSON = JSON.stringify({ workerRequests: { used: 70, limit: 100 } }); }
  ]) {
    const env = await enrollmentEnv();
    const requestId = crypto.randomUUID();
    const reserveRequest = request("/api/enrollment/reserve", {
      method: "POST",
      body: { requestId, fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
    });
    const reservation = await (await handleEnrollmentApi(
      reserveRequest, env, new URL(reserveRequest.url), { fetchImpl: turnstileFetch() }
    )).json();
    await closeGate(env);

    const confirmRequest = request("/api/enrollment/confirm", { method: "POST", token: reservation.key, body: { requestId } });
    const confirmResponse = await handleEnrollmentApi(confirmRequest, env, new URL(confirmRequest.url));
    assert.equal(confirmResponse.status, 503);
    assert.deepEqual(await confirmResponse.json(), {
      ok: false, code: "SERVICE_UNAVAILABLE", error: "当前暂不可领取"
    });
  }
});

test("a reservation holding the final capacity slot remains confirmable", async () => {
  const env = await enrollmentEnv();
  const requestId = crypto.randomUUID();
  const reserveRequest = request("/api/enrollment/reserve", {
    method: "POST",
    body: { requestId, fingerprint: FINGERPRINT, version: "thumbmark-1.11.0-v1", turnstileToken: "test-token" }
  });
  const reservation = await (await handleEnrollmentApi(
    reserveRequest, env, new URL(reserveRequest.url), { fetchImpl: turnstileFetch() }
  )).json();
  const configRequest = request("/api/enrollment/config");
  const config = await (await handleEnrollmentApi(configRequest, env, new URL(configRequest.url))).json();
  assert.equal(config.capacity.remaining, 0);
  assert.equal(config.claimable, false);
  assert.equal(config.pendingConfirmable, true);

  const confirmRequest = request("/api/enrollment/confirm", { method: "POST", token: reservation.key, body: { requestId } });
  const confirmed = await handleEnrollmentApi(confirmRequest, env, new URL(confirmRequest.url));
  assert.equal(confirmed.status, 200);
});

test("enrollment preflight is scoped to the configured origin", async () => {
  const env = await enrollmentEnv();
  const allowed = request("/api/enrollment/reserve", { method: "OPTIONS" });
  const response = await handleEnrollmentApi(allowed, env, new URL(allowed.url));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const denied = request("/api/enrollment/reserve", { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal((await handleEnrollmentApi(denied, env, new URL(denied.url))).status, 403);
});

test("status exposes no key or user identity", async () => {
  const env = await enrollmentEnv();
  const response = await handleEnrollmentApi(
    request(`/api/enrollment/status?request_id=${crypto.randomUUID()}`), env,
    new URL(`https://worker.example/api/enrollment/status?request_id=${crypto.randomUUID()}`)
  );
  const text = await response.text();
  assert.equal(text.includes("userId"), false);
  assert.equal(text.includes("key"), false);
});
