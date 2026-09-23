import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { deliverOutbox, enqueueNotification, persistTerminalNotification } from "../src/maoyan/notification-outbox.js";
import { runScheduledMaintenance } from "../src/maoyan/tokens.js";
import { putUserConfig } from "../src/maoyan/user.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

test("delivery errors retain provider reason and HTTP status while redacting configured keys", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env);
  await putUserConfig(env, account.id, { notifyChannel: "bark", barkKey: "known-device-secret" });
  await enqueueNotification(env.DB, {
    eventKey: "detailed-delivery", userId: account.id, kind: "lock-terminal", title: "failed", content: "failure", nowMs: NOW
  });
  await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW, send: async () => {
    throw new Error("Bark 推送失败: HTTP 429 quota exceeded for known-device-secret https://api.day.app/known-device-secret/title");
  } });
  const row = await env.DB.prepare("SELECT last_error FROM notification_outbox").first();
  assert.match(row.last_error, /Bark 推送失败: HTTP 429 quota exceeded/);
  assert.doesNotMatch(row.last_error, /known-device-secret|https:\/\/api.day.app/);
});

test("terminal diagnostics survive notification retries without leaking delivery credentials", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const event = { userId: account.id, rule: { id: "failed-1", state: "failed" }, title: "failure", content: "failed", failureDetail: '{"status":403}', nowMs: NOW };
  assert.equal((await persistTerminalNotification(env, event)).created, true);
  assert.equal((await persistTerminalNotification(env, event)).created, false);
  await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW, send: async () => { throw new Error("Bark https://api.day.app/secret-device-key/title?token=secret-token failed"); } });
  let row = await env.DB.prepare("SELECT failure_detail,last_error FROM notification_outbox").first();
  assert.equal(row.failure_detail, '{"status":403}');
  assert.doesNotMatch(row.last_error, /secret-device-key|secret-token/);
  await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW + 30_000, send: async () => {} });
  row = await env.DB.prepare("SELECT failure_detail,last_error FROM notification_outbox").first();
  assert.equal(row.failure_detail, '{"status":403}');
  assert.equal(row.last_error, null);
});

test("bounded response diagnostics remain valid JSON above sixteen thousand characters", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const diagnostic = { httpStatus: 403, responseBody: "x".repeat(16384), bodyTruncated: true };
  await persistTerminalNotification(env, {
    userId: account.id, rule: { id: "large-failure", state: "failed" }, title: "failure", content: "failed",
    failureDetail: JSON.stringify(diagnostic), nowMs: NOW
  });
  const row = await env.DB.prepare("SELECT failure_detail FROM notification_outbox").first();
  assert.deepEqual(JSON.parse(row.failure_detail), diagnostic);
});

test("failed lock removes waiting rule but retains a deliverable failure notification", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await env.DB.prepare("INSERT INTO lock_rule(token_id,data,updated_at) VALUES (?,?,?)")
    .bind(account.id, JSON.stringify({ id: "r1", state: "matching" }), new Date(NOW).toISOString()).run();
  await persistTerminalNotification(env, {
    userId: account.id, rule: { id: "r1", state: "failed" }, title: "failure", content: "failed",
    credentialVersion: 1, nowMs: NOW
  });
  assert.equal(await env.DB.prepare("SELECT data FROM lock_rule WHERE token_id=?").bind(account.id).first(), null);
  const result = await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW, send: async () => {} });
  assert.equal(result.sent, 1);
});

test("duplicate notification events enqueue once", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const event = {
    eventKey: "rule:r1:locked", userId: account.id, kind: "lock-terminal",
    title: "result", content: "test", credentialVersion: 1, nowMs: NOW
  };
  assert.equal((await enqueueNotification(env.DB, event)).created, true);
  assert.equal((await enqueueNotification(env.DB, event)).created, false);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 1);
});

test("delivery failures retry on a bounded schedule and never call lock work", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await enqueueNotification(env.DB, {
    eventKey: "rule:r1:failed", userId: account.id, kind: "lock-terminal",
    title: "result", content: "test", credentialVersion: 1, nowMs: NOW
  });
  let sends = 0;
  let lockCalls = 0;
  const send = async () => { sends += 1; throw new Error("network"); };
  for (const nowMs of [NOW, NOW + 30_000, NOW + 150_000, NOW + 750_000]) {
    await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs, limit: 10, send, runLock: async () => { lockCalls += 1; } });
  }
  assert.equal(sends, 4);
  assert.equal(lockCalls, 0);
  const row = await env.DB.prepare("SELECT state,attempts,next_attempt_at,last_error FROM notification_outbox").first();
  assert.deepEqual([row.state, Number(row.attempts), row.next_attempt_at, row.last_error], ["failed", 4, null, "network"]);
});

test("successful delivery is not repeated", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await enqueueNotification(env.DB, {
    eventKey: "cinema:b1:user:7", userId: account.id, kind: "new-shows",
    title: "new", content: "shows", credentialVersion: 1, nowMs: NOW
  });
  let sends = 0;
  const send = async () => { sends += 1; };
  await deliverOutbox(env, { lane: { kind: "new-shows", userId: account.id }, nowMs: NOW, send });
  await deliverOutbox(env, { lane: { kind: "new-shows", userId: account.id }, nowMs: NOW + 60_000, send });
  assert.equal(sends, 1);
  const row = await env.DB.prepare("SELECT state,last_error FROM notification_outbox").first();
  assert.equal(row.state, "sent");
  assert.equal(row.last_error, null);
});

test("provider Retry-After delays retry and delivery timestamps reflect actual attempts", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await enqueueNotification(env.DB, {
    eventKey: "rate-limited", userId: account.id, kind: "lock-terminal",
    title: "lock", content: "notice", nowMs: NOW - 1000, detectedAt: NOW - 2000
  });
  const lane = { kind: "lock-terminal", userId: account.id };
  await deliverOutbox(env, { lane, nowMs: NOW, send: async () => {
    throw Object.assign(new Error("HTTP 429"), { retryAfterMs: 120000 });
  } });
  let row = await env.DB.prepare(
    "SELECT state,next_attempt_at,detected_at,created_at,first_attempt_at,sent_at FROM notification_outbox"
  ).first();
  assert.deepEqual([
    row.state, row.next_attempt_at, row.detected_at, row.created_at, row.first_attempt_at, row.sent_at
  ], ["pending", NOW + 120000, NOW - 2000, NOW - 1000, NOW, null]);
  await deliverOutbox(env, { lane, nowMs: NOW + 120000, send: async () => {} });
  row = await env.DB.prepare("SELECT state,first_attempt_at,sent_at FROM notification_outbox").first();
  assert.deepEqual([row.state, row.first_attempt_at, row.sent_at], ["sent", NOW, NOW + 120000]);
});

test("slow batches claim each row and timestamp delivery using its actual time", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env);
  for (const eventKey of ["slow-first", "slow-second"]) {
    await enqueueNotification(env.DB, {
      eventKey, userId: account.id, kind: "lock-terminal",
      title: eventKey, content: "notice", nowMs: NOW
    });
  }
  let current = NOW;
  await deliverOutbox(env, {
    lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW, clock: () => current,
    send: async () => { current += 90000; }
  });
  const { results } = await env.DB.prepare(
    "SELECT event_key,first_attempt_at,sent_at FROM notification_outbox ORDER BY id"
  ).all();
  assert.deepEqual(results.map((row) => [row.event_key, row.first_attempt_at, row.sent_at]), [
    ["slow-first", NOW, NOW + 90000],
    ["slow-second", NOW + 90000, NOW + 180000]
  ]);
});

test("urgent lane claims only its kind and user, leaving other work independent", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const first = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const second = await seedAccount(env, { expiresAt: NOW + 60_000 });
  for (const [eventKey, userId, kind] of [
    ["first-show", first.account.id, "new-shows"],
    ["first-lock", first.account.id, "lock-terminal"],
    ["second-show", second.account.id, "new-shows"]
  ]) {
    await enqueueNotification(env.DB, { eventKey, userId, kind, title: eventKey, content: "notice", nowMs: NOW });
  }
  const delivered = [];
  const send = async (_config, title) => delivered.push(title);
  await deliverOutbox(env, { lane: { kind: "new-shows", userId: first.account.id }, nowMs: NOW, send });
  assert.deepEqual(delivered, ["first-show"]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE state='pending'").first()).n, 2);
});

test("routine reminders never send outside the maintenance window", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 2 * 86400000 });
  await enqueueNotification(env.DB, {
    eventKey: "expiry-window", userId: account.id, kind: "account-expiry",
    title: "reminder", content: "notice", meta: { expiresAt: account.expiresAt, stage: "three-day" }, nowMs: NOW
  });
  let sends = 0;
  await deliverOutbox(env, {
    lane: { kind: "account-expiry" }, nowMs: NOW,
    send: async () => { sends += 1; }
  });
  assert.equal(sends, 0);
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='expiry-window'").first()).state, "pending");
});

test("urgent lanes do not send account-expiry reminders outside maintenance", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  for (let i = 0; i < 3; i++) {
    await enqueueNotification(env.DB, {
      eventKey: `expiry:${i}`, userId: account.id, kind: "account-expiry",
      title: `expiry:${i}`, content: "notice", nowMs: NOW
    });
  }
  for (let i = 0; i < 11; i++) {
    await enqueueNotification(env.DB, {
      eventKey: `monitor:${i}`, userId: account.id, kind: i === 0 ? "lock-terminal" : "new-shows",
      title: `monitor:${i}`, content: "notice", nowMs: NOW
    });
  }
  const delivered = [];
  const send = async (_config, title) => delivered.push(title);
  await deliverOutbox(env, { lane: { kind: "new-shows", userId: account.id }, nowMs: NOW, send });
  await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW, send });
  assert.deepEqual(delivered, [...Array.from({ length: 10 }, (_, i) => `monitor:${i + 1}`), "monitor:0"]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry' AND state='pending'").first()).n, 3);
});

test("urgent lanes retain independent batch limits", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  for (const [kind, title] of [["account-expiry", "expiry"], ["new-shows", "new"], ["lock-terminal", "lock"]]) {
    await enqueueNotification(env.DB, { eventKey: title, userId: account.id, kind, title, content: "notice", nowMs: NOW });
  }
  const delivered = [];
  const send = async (_config, title) => delivered.push(title);
  await deliverOutbox(env, { lane: { kind: "new-shows", userId: account.id }, nowMs: NOW, limit: 2, send });
  await deliverOutbox(env, { lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW, limit: 2, send });
  assert.deepEqual(delivered, ["new", "lock"]);
});

test("notification delivery ignores Store outbox rows", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const maoyan = await seedAccount(env, { expiresAt: NOW + 60_000, businessLine: "maoyan" });
  const store = await seedAccount(env, { expiresAt: NOW + 60_000, businessLine: "store" });
  await enqueueNotification(env.DB, {
    eventKey: "maoyan:event", userId: maoyan.account.id, kind: "new-shows",
    title: "maoyan", content: "allowed", credentialVersion: 1, nowMs: NOW
  });
  await enqueueNotification(env.DB, {
    eventKey: "store:event", userId: store.account.id, kind: "new-shows",
    title: "store", content: "excluded", credentialVersion: 1, nowMs: NOW
  });
  const delivered = [];
  const result = await deliverOutbox(env, {
    lane: { kind: "new-shows", userId: maoyan.account.id }, nowMs: NOW,
    send: async (_config, title, _content, row) => delivered.push({ title, userId: row.user_id })
  });
  assert.deepEqual(delivered, [{ title: "maoyan", userId: maoyan.account.id }]);
  assert.deepEqual(result, { sent: 1, failed: 0, pending: 0, nextAttemptAt: null });
  const storeRow = await env.DB.prepare("SELECT state,attempts FROM notification_outbox WHERE user_id=?")
    .bind(store.account.id).first();
  assert.deepEqual([storeRow.state, Number(storeRow.attempts)], ["pending", 0]);
});

test("account expiry reminders are idempotent and keyed to the current expiry", async () => {
  const maintenance = Date.parse("2026-09-15T17:10:00.000Z");
  const env = await createAccountEnv({ nowMs: maintenance });
  const expiresAt = maintenance + 86400000;
  const { account } = await seedAccount(env, { expiresAt });
  assert.deepEqual(await runScheduledMaintenance(env, maintenance), { queued: 1 });
  assert.deepEqual(await runScheduledMaintenance(env, maintenance), { queued: 0 });
  const renewedExpiry = expiresAt + 15 * 86400000;
  await env.DB.prepare("UPDATE users SET expires_at=?,version=version+1 WHERE id=?")
    .bind(renewedExpiry, account.id).run();
  assert.deepEqual(await runScheduledMaintenance(env, renewedExpiry - 86400000), { queued: 1 });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 2);
});
