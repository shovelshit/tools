import test from "node:test";
import assert from "node:assert/strict";
import { getRuleDeadlineAt, resumeEligibility } from "../src/maoyan/account-lifecycle.js";
import { cleanupExpiredAccount } from "../src/maoyan/account-lifecycle.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { saveLockSession } from "../src/maoyan/lock-session.js";
import { validSession } from "./helpers.js";
import * as db from "../src/maoyan/db.js";
import { cleanupUserData, retryPendingRevocationCleanups, userKey } from "../src/maoyan/user.js";
import { updateManagedAccount } from "../src/maoyan/enrollment-store.js";

test("renewal never revives manually stopped or uncertain work", () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const account = { role: "user", state: "active", expiresAt: nowMs + 100_000 };
  const result = resumeEligibility({
    account,
    config: { enabled: false, stopReason: "manual", notifyVerified: true, cinemaId: "1", selectedMovieIds: ["7"] },
    rule: { state: "unknown", targetDeadlineAt: nowMs + 50_000 },
    sessionUsable: true,
    nowMs
  });
  assert.deepEqual(result, { monitor: false, lock: false, reasons: ["monitor_stopped", "rule_not_waiting"] });
});

test("eligible monitor and waiting rule resume only before the derived deadline", () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const rule = { state: "waiting_schedule", targetDate: "2026-09-16", templateTime: "20:00" };
  const config = { enabled: true, notifyVerified: true, cinemaId: "1", selectedMovieIds: ["7"] };
  const account = { role: "user", state: "active", expiresAt: nowMs + 100_000 };
  const deadline = getRuleDeadlineAt(rule);
  assert.equal(deadline, Date.parse("2026-09-16T20:30:00+08:00"));
  assert.deepEqual(resumeEligibility({ account, config, rule, sessionUsable: true, nowMs }), {
    monitor: true,
    lock: true,
    reasons: []
  });
  assert.equal(resumeEligibility({ account, config, rule, sessionUsable: true, nowMs: deadline }).lock, false);
});

test("invalid rules do not produce a serializable fake deadline", () => {
  assert.equal(getRuleDeadlineAt(null), null);
  assert.equal(getRuleDeadlineAt({ targetDate: "invalid", templateTime: "nope" }), null);
});

test("missing notification verification or session never resumes execution", () => {
  const nowMs = Date.now();
  const account = { role: "user", state: "active", expiresAt: nowMs + 100_000 };
  const result = resumeEligibility({
    account,
    config: { enabled: true, notifyVerified: false, cinemaId: "1", selectedMovieIds: ["7"] },
    rule: { state: "waiting_schedule", targetDeadlineAt: nowMs + 50_000 },
    sessionUsable: false,
    nowMs
  });
  assert.equal(result.monitor, false);
  assert.equal(result.lock, false);
  assert.deepEqual(result.reasons, ["notification_unverified", "session_unavailable"]);
});

test("monitoring resumes without a lock session while locking remains paused", () => {
  const nowMs = Date.now();
  const result = resumeEligibility({
    account: { role: "user", state: "active", expiresAt: nowMs + 100_000 },
    config: { enabled: true, notifyVerified: true, cinemaId: "1", selectedMovieIds: ["7"] },
    rule: { state: "waiting_schedule", targetDeadlineAt: nowMs + 50_000 },
    sessionUsable: false,
    nowMs
  });
  assert.equal(result.monitor, true);
  assert.equal(result.lock, false);
  assert.deepEqual(result.reasons, ["session_unavailable"]);
});

test("expiry cleanup keeps the account and config but removes transient execution data", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const expiresAt = nowMs - 31 * 24 * 60 * 60 * 1000;
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt, config: { cinemaId: "1" } });
  await db.putStatus(env.DB, account.id, { enabled: true });
  await db.saveSnapshot(env.DB, account.id, { "7": ["8"] });
  await db.appendChange(env.DB, account.id, { time: new Date(nowMs).toISOString(), type: "ok", text: "x" });
  await db.putLockRuleRow(env.DB, account.id, { state: "waiting_schedule" });
  await saveLockSession(env, account.id, validSession());

  assert.deepEqual(await cleanupExpiredAccount(env, {
    userId: account.id,
    expectedExpiresAt: expiresAt,
    expectedVersion: account.version,
    nowMs
  }), { cleaned: true });
  assert.equal((await db.getConfig(env.DB, account.id)).cinemaId, "1");
  assert.equal(await db.getStatus(env.DB, account.id), null);
  assert.deepEqual(await db.getSnapshot(env.DB, account.id), {});
  assert.deepEqual(await db.listChanges(env.DB, account.id), []);
  assert.equal(await db.getLockRuleRow(env.DB, account.id), null);
  assert.equal(await db.getSessionVersion(env.DB, account.id), null);
  const archived = await env.DB.prepare("SELECT archived_at FROM users WHERE id=?").bind(account.id).first();
  assert.equal(Number(archived.archived_at), nowMs);
});

test("expiry cleanup loses the race to renewal without deleting anything", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const expiresAt = nowMs - 31 * 24 * 60 * 60 * 1000;
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt, config: { cinemaId: "1" } });
  await db.putStatus(env.DB, account.id, { enabled: true });
  await env.DB.prepare("UPDATE users SET version=version+1,expires_at=? WHERE id=?")
    .bind(nowMs + 10_000, account.id).run();
  assert.deepEqual(await cleanupExpiredAccount(env, {
    userId: account.id,
    expectedExpiresAt: expiresAt,
    expectedVersion: account.version,
    nowMs
  }), { cleaned: false });
  assert.deepEqual(await db.getStatus(env.DB, account.id), { enabled: true });
});

test("Maoyan expiry cleanup does not mutate Store account state", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const expiresAt = nowMs - 31 * 24 * 60 * 60 * 1000;
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, {
    businessLine: "store", expiresAt, config: { cinemaId: "store-data" }
  });
  await db.putStatus(env.DB, account.id, { enabled: true });
  assert.deepEqual(await cleanupExpiredAccount(env, {
    userId: account.id, expectedExpiresAt: expiresAt, expectedVersion: account.version, nowMs
  }), { cleaned: false });
  assert.deepEqual(await db.getStatus(env.DB, account.id), { enabled: true });
  assert.equal((await env.DB.prepare("SELECT archived_at FROM users WHERE id=?").bind(account.id).first()).archived_at, null);
});

test("runtime cleanup removes Store sessions and session pointers but preserves lifecycle records", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await saveLockSession(env, account.id, validSession());
  await env.DB.prepare(
    "INSERT INTO store_sessions(token_hash,business_line,user_id,expires_at,created_at) VALUES (?,?,?,?,?)"
  ).bind("b".repeat(64), "store", account.id, nowMs + 60_000, nowMs).run();
  await env.DB.prepare(
    "INSERT INTO audit_events(event_type,subject_user_id,data,created_at) VALUES ('test',?,?,?)"
  ).bind(account.id, "{}", nowMs).run();

  await cleanupUserData(env, account.id);

  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM store_sessions WHERE user_id=?").bind(account.id).first(), null);
  assert.equal(await db.getSessionVersion(env.DB, account.id), null);
  assert.equal((await env.MAOYAN_KV.list({ prefix: userKey(account.id, "maoyan-session:v") })).keys.length, 0);
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM users WHERE id=?").bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM access_keys WHERE user_id=?").bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM audit_events WHERE subject_user_id=?").bind(account.id).first(), null);
});

test("revocation retains a durable KV cleanup marker until failed enumeration and deletion retry", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await saveLockSession(env, account.id, validSession());
  const orphan = userKey(account.id, "maoyan-session:v999");
  await env.MAOYAN_KV.put(orphan, "orphan");
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  let failList = true;
  env.MAOYAN_KV.list = async (options) => {
    if (failList) throw new Error("list unavailable");
    return await list(options);
  };
  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    await updateManagedAccount(env, {
      userId: account.id, expectedVersion: account.version, patch: { state: "revoked" }, nowMs
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(await env.MAOYAN_KV.get(orphan), "orphan");
  const failed = await env.DB.prepare(
    "SELECT attempt_count,last_error FROM revocation_cleanup WHERE user_id=?"
  ).bind(account.id).first();
  assert.equal(Number(failed.attempt_count), 1);
  assert.equal(failed.last_error, "kv_enumeration_failed");
  assert.equal(errors.some((message) => message.includes(account.id)), false);

  failList = false;
  let failDelete = true;
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  env.MAOYAN_KV.delete = async (key) => {
    if (key === orphan && failDelete) throw new Error("delete unavailable");
    return await remove(key);
  };
  await retryPendingRevocationCleanups(env, { nowMs });
  const deleteFailed = await env.DB.prepare(
    "SELECT attempt_count,last_error FROM revocation_cleanup WHERE user_id=?"
  ).bind(account.id).first();
  assert.equal(Number(deleteFailed.attempt_count), 2);
  assert.equal(deleteFailed.last_error, "kv_delete_failed");
  assert.equal(await env.MAOYAN_KV.get(orphan), "orphan");

  failDelete = false;
  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 1 });
  assert.equal(await env.MAOYAN_KV.get(orphan), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});
