import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import {
  NotificationDispatcher, deliverOutbox, enqueueNotification,
  recoverPendingNotifications, wakeNotificationDispatcher
} from "../src/maoyan/notification-outbox.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

function doStorage() {
  const values = new Map();
  return {
    alarmAt: null,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async setAlarm(at) { this.alarmAt = at; },
    async deleteAlarm() { this.alarmAt = null; }
  };
}

test("wake confirms before channel completes while the DO keeps draining", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env);
  await enqueueNotification(env.DB, {
    eventKey: "fast-ack", userId: account.id, kind: "new-shows",
    title: "new", content: "notice", nowMs: NOW
  });
  let release;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const state = { storage: doStorage() };
  const dispatcher = new NotificationDispatcher(state, env, {
    now: () => NOW, send: async () => { started(); await pending; }
  });
  const response = await dispatcher.fetch(new Request("https://internal/internal/drain", {
    method: "POST", body: JSON.stringify({ kind: "new-shows", userId: account.id })
  }));
  assert.equal(response.status, 200);
  await began;
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='fast-ack'").first()).state, "sending");
  release();
  await dispatcher.inFlight;
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='fast-ack'").first()).state, "sent");
});

test("expired lease from the old main dispatcher is reclaimed by its new lane", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env);
  await enqueueNotification(env.DB, {
    eventKey: "old-main", userId: account.id, kind: "lock-terminal",
    title: "lock", content: "notice", nowMs: NOW - 60000
  });
  await env.DB.prepare("UPDATE notification_outbox SET state='sending',attempts=1,lease_until=? WHERE event_key='old-main'")
    .bind(NOW - 1).run();
  const sent = [];
  await deliverOutbox(env, {
    lane: { kind: "lock-terminal", userId: account.id }, nowMs: NOW,
    send: async (_config, title) => sent.push(title)
  });
  assert.deepEqual(sent, ["lock"]);
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='old-main'").first()).state, "sent");
});

test("yesterday's one-day reminder is discarded when maintenance resumes today", async () => {
  const maintenance = Date.parse("2026-09-16T17:10:00.000Z"); // Beijing 17th 01:10
  const expiry = Date.parse("2026-09-16T16:10:00.000Z"); // Beijing 17th 00:10
  const env = await createAccountEnv({ nowMs: maintenance });
  const { account } = await seedAccount(env, { expiresAt: expiry });
  await enqueueNotification(env.DB, {
    eventKey: "stale-one-day", userId: account.id, kind: "account-expiry",
    title: "one day", content: "notice", meta: { expiresAt: expiry, stage: "one-day" },
    nowMs: maintenance - 86400000
  });
  let calls = 0;
  await deliverOutbox(env, {
    lane: { kind: "account-expiry" }, nowMs: maintenance,
    send: async () => { calls += 1; }
  });
  assert.equal(calls, 0);
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='stale-one-day'").first()).state, "failed");
});

test("a three-day reminder cannot be sent on the following natural day", async () => {
  const maintenance = Date.parse("2026-09-16T17:10:00.000Z"); // Beijing 17th 01:10
  const expiry = maintenance + 2 * 86400000;
  const env = await createAccountEnv({ nowMs: maintenance });
  const { account } = await seedAccount(env, { expiresAt: expiry });
  await enqueueNotification(env.DB, {
    eventKey: "stale-three-day", userId: account.id, kind: "account-expiry",
    title: "three days", content: "notice", meta: { expiresAt: expiry, stage: "three-day" },
    nowMs: maintenance - 86400000
  });
  let sends = 0;
  await deliverOutbox(env, {
    lane: { kind: "account-expiry" }, nowMs: maintenance,
    send: async () => { sends += 1; }
  });
  assert.equal(sends, 0);
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='stale-three-day'").first()).state, "failed");
});

test("wake routes urgent user/type separately and reminders to routine", async () => {
  const names = [];
  const env = {
    NOTIFICATION_DISPATCHER: {
      idFromName(name) { names.push(name); return name; },
      get() { return { fetch: async () => Response.json({ ok: true }) }; }
    }
  };
  await wakeNotificationDispatcher(env, { kind: "new-shows", userId: "alice" });
  await wakeNotificationDispatcher(env, { kind: "lock-terminal", userId: "bob" });
  await wakeNotificationDispatcher(env, { kind: "seat-feedback", userId: "admin" });
  await wakeNotificationDispatcher(env, { kind: "account-expiry" });
  assert.deepEqual(names, [
    "urgent:new-shows:alice", "urgent:lock-terminal:bob",
    "urgent:seat-feedback:admin", "routine"
  ]);
});

test("routine wake with no queued reminders clears the fallback alarm", async () => {
  const outside = Date.parse("2026-09-16T04:10:00.000Z");
  const env = await createAccountEnv({ nowMs: outside });
  const storage = doStorage();
  const dispatcher = new NotificationDispatcher({ storage }, env, { now: () => outside });
  await dispatcher.fetch(new Request("https://internal/internal/drain", {
    method: "POST", body: JSON.stringify({ kind: "account-expiry" })
  }));
  await dispatcher.inFlight;
  assert.equal(storage.alarmAt, null);
});

test("bounded recovery wakes a due urgent lane without draining or touching Store", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const maoyan = await seedAccount(env);
  const store = await seedAccount(env, { businessLine: "store" });
  for (const [userId, eventKey] of [[maoyan.account.id, "due"], [store.account.id, "store"]]) {
    await enqueueNotification(env.DB, {
      eventKey, userId, kind: "lock-terminal", title: eventKey, content: "notice", nowMs: NOW
    });
  }
  const names = [];
  env.NOTIFICATION_DISPATCHER = {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async () => { names.push(name); return Response.json({ ok: true }); }
    })
  };
  const result = await recoverPendingNotifications(env, { nowMs: NOW, limit: 1 });
  assert.equal(result.woken, 1);
  assert.deepEqual(names, [`urgent:lock-terminal:${maoyan.account.id}`]);
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='due'").first()).state, "pending");
});

test("routine stops between rows when maintenance closes during a slow batch", async () => {
  const start = Date.parse("2026-09-16T17:59:59.000Z"); // Beijing 01:59:59
  const outside = start + 2000;
  const env = await createAccountEnv({ nowMs: start });
  const { account } = await seedAccount(env, { expiresAt: start + 86400000 });
  for (const eventKey of ["first", "second"]) {
    await enqueueNotification(env.DB, {
      eventKey, userId: account.id, kind: "account-expiry", title: eventKey,
      content: "notice", meta: { expiresAt: account.expiresAt, stage: "one-day" }, nowMs: start
    });
  }
  let current = start;
  const titles = [];
  const result = await deliverOutbox(env, {
    lane: { kind: "account-expiry" }, nowMs: start, clock: () => current,
    send: async (_config, title) => { titles.push(title); current = outside; }
  });
  assert.deepEqual(titles, ["first"]);
  assert.equal(result.pending, 1);
  assert.ok(result.nextAttemptAt > outside + 20 * 3600000);
});

test("a wake between empty scan and alarm deletion starts another urgent drain", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env);
  const lane = { kind: "new-shows", userId: account.id };
  const state = { storage: doStorage() };
  let dispatcher;
  const sent = [];
  let injected = false;
  state.storage.deleteAlarm = async () => {
    if (!injected) {
      injected = true;
      await enqueueNotification(env.DB, {
        eventKey: "wake-during-finalize", userId: account.id, kind: "new-shows",
        title: "new", content: "notice", nowMs: NOW
      });
      await dispatcher.fetch(new Request("https://internal/internal/drain", {
        method: "POST", body: JSON.stringify(lane)
      }));
    }
    state.storage.alarmAt = null;
  };
  dispatcher = new NotificationDispatcher(state, env, {
    now: () => NOW, send: async (_config, title) => { sent.push(title); }
  });
  await dispatcher.fetch(new Request("https://internal/internal/drain", {
    method: "POST", body: JSON.stringify(lane)
  }));
  for (let i = 0; i < 30 && !sent.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["new"]);
  assert.equal((await env.DB.prepare("SELECT state FROM notification_outbox WHERE event_key='wake-during-finalize'").first()).state, "sent");
});
