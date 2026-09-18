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
  await deliverOutbox(env, { nowMs: NOW, send: async () => {
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
  await deliverOutbox(env, { nowMs: NOW, send: async () => { throw new Error("Bark https://api.day.app/secret-device-key/title?token=secret-token failed"); } });
  let row = await env.DB.prepare("SELECT failure_detail,last_error FROM notification_outbox").first();
  assert.equal(row.failure_detail, '{"status":403}');
  assert.doesNotMatch(row.last_error, /secret-device-key|secret-token/);
  await deliverOutbox(env, { nowMs: NOW + 30_000, send: async () => {} });
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
  const result = await deliverOutbox(env, { nowMs: NOW, send: async () => {} });
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
    await deliverOutbox(env, { nowMs, limit: 10, send, runLock: async () => { lockCalls += 1; } });
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
  await deliverOutbox(env, { nowMs: NOW, send });
  await deliverOutbox(env, { nowMs: NOW + 60_000, send });
  assert.equal(sends, 1);
  const row = await env.DB.prepare("SELECT state,last_error FROM notification_outbox").first();
  assert.equal(row.state, "sent");
  assert.equal(row.last_error, null);
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
    nowMs: NOW,
    send: async (_config, title, _content, row) => delivered.push({ title, userId: row.user_id })
  });
  assert.deepEqual(delivered, [{ title: "maoyan", userId: maoyan.account.id }]);
  assert.deepEqual(result, { sent: 1, failed: 0, pending: 0, nextAttemptAt: null });
  const storeRow = await env.DB.prepare("SELECT state,attempts FROM notification_outbox WHERE user_id=?")
    .bind(store.account.id).first();
  assert.deepEqual([storeRow.state, Number(storeRow.attempts)], ["pending", 0]);
});

test("account expiry reminders are idempotent and keyed to the current expiry", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const expiresAt = NOW + 86400000;
  const { account } = await seedAccount(env, { expiresAt });
  assert.deepEqual(await runScheduledMaintenance(env, NOW), { queued: 1 });
  assert.deepEqual(await runScheduledMaintenance(env, NOW), { queued: 0 });
  const renewedExpiry = expiresAt + 15 * 86400000;
  await env.DB.prepare("UPDATE users SET expires_at=?,version=version+1 WHERE id=?")
    .bind(renewedExpiry, account.id).run();
  assert.deepEqual(await runScheduledMaintenance(env, renewedExpiry - 86400000), { queued: 1 });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 2);
});
