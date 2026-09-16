import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { deliverOutbox, enqueueNotification } from "../src/maoyan/notification-outbox.js";
import { runScheduledMaintenance } from "../src/maoyan/tokens.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

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
  const row = await env.DB.prepare("SELECT state,attempts,next_attempt_at FROM notification_outbox").first();
  assert.deepEqual([row.state, Number(row.attempts), row.next_attempt_at], ["failed", 4, null]);
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
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox").first()).state, "sent");
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
