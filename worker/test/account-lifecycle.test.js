import test from "node:test";
import assert from "node:assert/strict";
import { getRuleDeadlineAt, resumeEligibility } from "../src/maoyan/account-lifecycle.js";
import { cleanupExpiredAccount } from "../src/maoyan/account-lifecycle.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { saveLockSession } from "../src/maoyan/lock-session.js";
import { validSession } from "./helpers.js";
import * as db from "../src/maoyan/db.js";

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
