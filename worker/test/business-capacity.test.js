import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import {
  createManagedAccount, readCapacity, renewAccount, updateServiceSettings
} from "../src/maoyan/enrollment-store.js";

test("Store allocation does not consume a full Maoyan quota", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  await seedAccount(env, { businessLine: "maoyan" });
  const created = await createManagedAccount(env, {
    businessLine: "store", remark: "Store user", requestId: crypto.randomUUID()
  });

  assert.equal(created.account.businessLine, "store");
  assert.equal((await readCapacity(env.DB, Date.now(), "maoyan")).used, 1);
  assert.equal((await readCapacity(env.DB, Date.now(), "store")).used, 1);
});

test("a Store request ID cannot replay a Maoyan account", async () => {
  const env = await createAccountEnv();
  const requestId = crypto.randomUUID();
  const maoyan = await createManagedAccount(env, { requestId, remark: "Maoyan" });

  await assert.rejects(
    () => createManagedAccount(env, { requestId, businessLine: "store", remark: "Store" }),
    { code: "REQUEST_CONFLICT" }
  );
  assert.equal(maoyan.account.businessLine, "maoyan");
});

test("Store capacity rejects lowering below Store use without affecting Maoyan", async () => {
  const env = await createAccountEnv();
  const store = await createManagedAccount(env, {
    businessLine: "store", remark: "Store", requestId: crypto.randomUUID()
  });
  const storeSettings = await env.DB.prepare(
    "SELECT version FROM service_settings WHERE business_line='store'"
  ).first();

  await assert.rejects(() => updateServiceSettings(env, {
    businessLine: "store", expectedVersion: storeSettings.version,
    maxUsers: 0, defaultValidDays: 15, publicSignupEnabled: false
  }), { code: "CAPACITY_FULL" });
  assert.equal(store.account.businessLine, "store");
  assert.equal((await readCapacity(env.DB, Date.now(), "maoyan")).used, 0);
});

test("simultaneous Store creation and renewal share the final Store place", async () => {
  const env = await createAccountEnv();
  const nowMs = Date.now();
  await env.DB.prepare(
    "UPDATE service_settings SET max_users=1 WHERE business_line='store'"
  ).run();
  const expired = await seedAccount(env, {
    businessLine: "store", expiresAt: nowMs - 1
  });

  const results = await Promise.allSettled([
    createManagedAccount(env, {
      businessLine: "store", remark: "Store", requestId: crypto.randomUUID(), nowMs
    }),
    renewAccount(env, {
      userId: expired.account.id, expectedVersion: expired.account.version,
      requestId: crypto.randomUUID(), nowMs
    })
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readCapacity(env.DB, nowMs, "store")).used, 1);
});
