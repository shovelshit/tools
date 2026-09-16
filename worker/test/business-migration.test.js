import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { createPreBusinessLineD1, migrateBusinessLines } from "./helpers.js";
import { getAccount, getAccountByKey } from "../src/maoyan/accounts.js";
import { createManagedAccount, readServiceSettings } from "../src/maoyan/enrollment-store.js";

test("existing Maoyan accounts retain their business identity", async () => {
  const env = await createAccountEnv();
  const seeded = await seedAccount(env, { key: "maoyan-existing-key" });

  const byId = seeded.account;
  const byKey = await getAccountByKey(env.DB, "maoyan-existing-key");
  const settings = await readServiceSettings(env.DB, "maoyan");

  assert.equal(byId.businessLine, "maoyan");
  assert.equal(byKey.businessLine, "maoyan");
  assert.equal(settings.maxUsers, 20);
});

test("business migration preserves old Maoyan account and settings records", async () => {
  const DB = createPreBusinessLineD1();
  const id = "44444444-4444-4444-8444-444444444444";
  const expiresAt = Date.now() + 60_000;
  await DB.prepare(
    "INSERT INTO users(id,role,remark,state,created_at,expires_at,source,version) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(id, "user", "old account", "active", 1_000, expiresAt, "migration", 4).run();
  await DB.prepare(
    "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
  ).bind(id, "a".repeat(64), "old-", "-key", 1_000).run();
  await DB.prepare(
    "UPDATE service_settings SET max_users=1,default_valid_days=30,public_signup_enabled=1,version=7,updated_at=8 WHERE id=1"
  ).run();

  migrateBusinessLines(DB);

  const account = await getAccount(DB, id);
  const user = await DB.prepare("SELECT id,business_line,version FROM users WHERE id=?").bind(id).first();
  const key = await DB.prepare("SELECT token_hash FROM access_keys WHERE user_id=?").bind(id).first();
  const maoyan = await DB.prepare(
    "SELECT id,business_line,max_users,default_valid_days,public_signup_enabled,version,updated_at FROM service_settings WHERE id=1"
  ).first();
  const store = await DB.prepare("SELECT id,business_line FROM service_settings WHERE id=2").first();

  assert.equal(account.businessLine, "maoyan");
  assert.deepEqual({ ...user }, { id, business_line: "maoyan", version: 4 });
  assert.equal(key.token_hash, "a".repeat(64));
  assert.deepEqual({ ...maoyan }, {
    id: 1, business_line: "maoyan", max_users: 1, default_valid_days: 30,
    public_signup_enabled: 1, version: 7, updated_at: 8
  });
  assert.deepEqual({ ...store }, { id: 2, business_line: "store" });
  await assert.rejects(
    () => createManagedAccount({ DB }, { requestId: crypto.randomUUID(), remark: "too many" }),
    { code: "CAPACITY_FULL" }
  );
  const storeAccount = await createManagedAccount({ DB }, {
    businessLine: "store", requestId: crypto.randomUUID(), remark: "Store"
  });
  assert.equal(storeAccount.account.businessLine, "store");
});
