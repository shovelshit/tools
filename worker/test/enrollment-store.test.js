import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { hashAccessKey } from "../src/maoyan/accounts.js";
import {
  confirmEnrollment,
  createManagedAccount,
  readCapacity,
  renewAccount,
  reserveEnrollment,
  updateManagedAccount
} from "../src/maoyan/enrollment-store.js";

test("reservations cannot oversubscribe the final slot", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  const nowMs = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
    reserveEnrollment(env, {
      requestId: crypto.randomUUID(),
      fingerprintDigest: `fp-${index}`,
      fingerprintVersion: "v1",
      ipDigest: "shared-ip",
      nowMs
    })
  ));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(await readCapacity(env.DB, nowMs), { maxUsers: 1, used: 1, remaining: 0 });
});

test("reservation retry never replays its one-time key", async () => {
  const env = await createAccountEnv();
  const input = {
    requestId: crypto.randomUUID(), fingerprintDigest: "fp-one",
    fingerprintVersion: "v1", ipDigest: "ip-one", nowMs: Date.now()
  };
  const first = await reserveEnrollment(env, input);
  const again = await reserveEnrollment(env, { ...input, nowMs: input.nowMs + 1 });

  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.equal(first.status, "reserved");
  assert.equal(again.status, "reserved");
  assert.equal(again.reservationId, first.reservationId);
  assert.equal("key" in again, false);
  const stored = await env.DB.prepare(
    "SELECT token_hash FROM enrollment_reservations WHERE request_id=?"
  ).bind(input.requestId).first();
  assert.notEqual(stored.token_hash, first.key);
  assert.equal(stored.token_hash, await hashAccessKey(first.key));
});

test("confirmation retry never extends validity or replays key", async () => {
  const env = await createAccountEnv();
  const requestId = crypto.randomUUID();
  const nowMs = Date.now();
  const reservation = await reserveEnrollment(env, {
    requestId, fingerprintDigest: "fp-confirm", fingerprintVersion: "v1", ipDigest: "ip", nowMs
  });
  const first = await confirmEnrollment(env, { requestId, key: reservation.key, nowMs });
  const again = await confirmEnrollment(env, { requestId, key: reservation.key, nowMs: nowMs + 1_000 });

  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(first.account.expiresAt, again.account.expiresAt);
  assert.equal("key" in again, false);
  assert.equal((await readCapacity(env.DB, nowMs)).used, 1);
});

test("same IP allows different fingerprints while one fingerprint cannot reserve twice", async () => {
  const env = await createAccountEnv({ maxUsers: 3 });
  const nowMs = Date.now();
  await reserveEnrollment(env, {
    requestId: crypto.randomUUID(), fingerprintDigest: "fp-a", fingerprintVersion: "v1", ipDigest: "shared", nowMs
  });
  await reserveEnrollment(env, {
    requestId: crypto.randomUUID(), fingerprintDigest: "fp-b", fingerprintVersion: "v1", ipDigest: "shared", nowMs
  });
  await assert.rejects(() => reserveEnrollment(env, {
    requestId: crypto.randomUUID(), fingerprintDigest: "fp-a", fingerprintVersion: "v1", ipDigest: "different", nowMs
  }), { code: "FINGERPRINT_IN_USE" });
  assert.equal((await readCapacity(env.DB, nowMs)).used, 2);
});

test("suspended users occupy capacity, expired and admin accounts do not", async () => {
  const env = await createAccountEnv({ maxUsers: 2 });
  const nowMs = Date.now();
  await seedAccount(env, { state: "suspended", expiresAt: nowMs + 60_000 });
  await seedAccount(env, { expiresAt: nowMs - 1 });
  await seedAccount(env, { role: "admin" });

  assert.deepEqual(await readCapacity(env.DB, nowMs), { maxUsers: 2, used: 1, remaining: 1 });
});

test("expired account renewal is idempotent and cannot stack while active", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  const nowMs = Date.now();
  const { account } = await seedAccount(env, { expiresAt: nowMs - 1, fingerprint: "renew-fp" });
  const requestId = crypto.randomUUID();
  const first = await renewAccount(env, {
    userId: account.id, requestId, expectedVersion: account.version, nowMs
  });
  const again = await renewAccount(env, {
    userId: account.id, requestId, expectedVersion: account.version, nowMs: nowMs + 1_000
  });

  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(first.account.expiresAt, again.account.expiresAt);
  await assert.rejects(() => renewAccount(env, {
    userId: account.id, requestId: crypto.randomUUID(), expectedVersion: first.account.version, nowMs: nowMs + 2_000
  }), { code: "ACCOUNT_NOT_EXPIRED" });
});

test("managed accounts obey capacity and optimistic updates", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  const created = await createManagedAccount(env, { remark: "managed", requestId: crypto.randomUUID(), nowMs: Date.now() });
  assert.match(created.key, /^[0-9a-f]{64}$/);
  assert.equal(created.account.remark, "managed");
  await assert.rejects(() => createManagedAccount(env, {
    remark: "too many", requestId: crypto.randomUUID(), nowMs: Date.now()
  }), { code: "CAPACITY_FULL" });

  const revoked = await updateManagedAccount(env, {
    userId: created.account.id,
    expectedVersion: created.account.version,
    patch: { state: "revoked" },
    nowMs: Date.now()
  });
  assert.equal(revoked.state, "revoked");
  assert.equal((await readCapacity(env.DB, Date.now())).remaining, 1);
});

test("managed account retries return the existing account without replaying its key", async () => {
  const env = await createAccountEnv({ maxUsers: 2 });
  const requestId = crypto.randomUUID();
  const nowMs = Date.now();
  const results = await Promise.all([
    createManagedAccount(env, { remark: "managed", requestId, nowMs }),
    createManagedAccount(env, { remark: "managed", requestId, nowMs })
  ]);

  assert.equal(new Set(results.map((result) => result.account.id)).size, 1);
  assert.equal(results.filter((result) => "key" in result).length, 1);
  assert.equal((await readCapacity(env.DB, nowMs)).used, 1);
});

test("expired reservation cannot be confirmed", async () => {
  const env = await createAccountEnv();
  const nowMs = Date.now();
  const requestId = crypto.randomUUID();
  const reservation = await reserveEnrollment(env, {
    requestId, fingerprintDigest: "expiring-fp", fingerprintVersion: "v1", ipDigest: "ip", nowMs
  });

  await assert.rejects(() => confirmEnrollment(env, {
    requestId, key: reservation.key, nowMs: nowMs + 5 * 60_000
  }), { code: "RESERVATION_EXPIRED" });
});

test("renewal and a new reservation cannot both claim the same fingerprint", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  const nowMs = Date.now();
  const { account } = await seedAccount(env, { expiresAt: nowMs - 1, fingerprint: "shared-fp" });
  const results = await Promise.allSettled([
    renewAccount(env, {
      userId: account.id, requestId: crypto.randomUUID(), expectedVersion: account.version, nowMs
    }),
    reserveEnrollment(env, {
      requestId: crypto.randomUUID(), fingerprintDigest: "shared-fp",
      fingerprintVersion: "test-v1", ipDigest: "new-ip", nowMs
    })
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readCapacity(env.DB, nowMs)).used, 1);
  assert.equal((await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM fingerprint_bindings WHERE fingerprint_digest='shared-fp'"
  ).first()).n, 1);
});

test("one hundred renewal retries extend an expired account only once", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  const nowMs = Date.now();
  const { account } = await seedAccount(env, { expiresAt: nowMs - 1 });
  const requestId = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 100 }, () => renewAccount(env, {
    userId: account.id, requestId, expectedVersion: account.version, nowMs
  })));

  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  assert.equal(new Set(results.map((result) => result.account.expiresAt)).size, 1);
  assert.equal((await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM account_operations WHERE user_id=? AND kind='renew'"
  ).bind(account.id).first()).n, 1);
});

test("suspended and revoked accounts cannot self-renew", async () => {
  const env = await createAccountEnv({ maxUsers: 2 });
  const nowMs = Date.now();
  const suspended = await seedAccount(env, { state: "suspended", expiresAt: nowMs - 1 });
  const revoked = await seedAccount(env, { state: "revoked", expiresAt: nowMs - 1 });

  await assert.rejects(() => renewAccount(env, {
    userId: suspended.account.id, requestId: crypto.randomUUID(),
    expectedVersion: suspended.account.version, nowMs
  }), { code: "ACCOUNT_SUSPENDED" });
  await assert.rejects(() => renewAccount(env, {
    userId: revoked.account.id, requestId: crypto.randomUUID(),
    expectedVersion: revoked.account.version, nowMs
  }), { code: "ACCOUNT_REVOKED" });
});

test("capacity cannot be lowered below current users and reservations", async () => {
  const env = await createAccountEnv({ maxUsers: 2 });
  const nowMs = Date.now();
  await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await reserveEnrollment(env, {
    requestId: crypto.randomUUID(), fingerprintDigest: "reserved-fp",
    fingerprintVersion: "v1", ipDigest: "ip", nowMs
  });

  await assert.rejects(() => env.DB.prepare(
    "UPDATE service_settings SET max_users=1 WHERE id=1"
  ).run(), /CAPACITY_BELOW_USAGE/);
});

test("database failures are not mislabeled as capacity exhaustion", async () => {
  const env = await createAccountEnv();
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => { throw new Error("database offline"); };
  try {
    await assert.rejects(() => reserveEnrollment(env, {
      requestId: crypto.randomUUID(), fingerprintDigest: "failure-fp",
      fingerprintVersion: "v1", ipDigest: "ip", nowMs: Date.now()
    }), /database offline/);
  } finally {
    env.DB.batch = batch;
  }
});

test("managed renewal cannot reclaim a fingerprint held by a newer reservation", async () => {
  const env = await createAccountEnv({ maxUsers: 2 });
  const nowMs = Date.now();
  const old = await seedAccount(env, { expiresAt: nowMs - 1, fingerprint: "reused-fp" });
  await reserveEnrollment(env, {
    requestId: crypto.randomUUID(), fingerprintDigest: "reused-fp",
    fingerprintVersion: "test-v1", ipDigest: "new-ip", nowMs
  });

  await assert.rejects(() => updateManagedAccount(env, {
    userId: old.account.id,
    expectedVersion: old.account.version,
    patch: { expiresAt: nowMs + 15 * 86400000 },
    nowMs
  }), { code: "FINGERPRINT_IN_USE" });
});
