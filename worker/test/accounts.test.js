import test from "node:test";
import assert from "node:assert/strict";
import { MemoryD1 } from "./helpers.js";
import { accountStatus, getAccount, getAccountByKey, hashAccessKey } from "../src/maoyan/accounts.js";

test("batch failure rolls back every earlier write", async () => {
  const DB = new MemoryD1();
  DB.sqlite.exec("CREATE TABLE batch_probe(id TEXT PRIMARY KEY)");

  await assert.rejects(() => DB.batch([
    DB.prepare("INSERT INTO batch_probe VALUES (?)").bind("same"),
    DB.prepare("INSERT INTO batch_probe VALUES (?)").bind("same")
  ]));

  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM batch_probe").first()).n, 0);
});

test("account status uses revoke, expiry and suspension precedence", () => {
  const nowMs = 2_000;
  assert.equal(accountStatus({ role: "user", state: "active", expiresAt: nowMs + 1 }, nowMs), "active");
  assert.equal(accountStatus({ role: "user", state: "active", expiresAt: nowMs }, nowMs), "expired");
  assert.equal(accountStatus({ role: "user", state: "active", expiresAt: null }, nowMs), "expired");
  assert.equal(accountStatus({ role: "user", state: "suspended", expiresAt: nowMs }, nowMs), "expired");
  assert.equal(accountStatus({ role: "user", state: "revoked", expiresAt: nowMs + 1 }, nowMs), "revoked");
  assert.equal(accountStatus({ role: "admin", state: "active", expiresAt: null }, nowMs), "active");
  assert.equal(accountStatus({ role: "admin", state: "suspended", expiresAt: null }, nowMs), "suspended");
});

test("access keys are stored and queried by a stable digest", async () => {
  const DB = new MemoryD1();
  const digest = await hashAccessKey("secret-test-key");
  await DB.prepare(
    "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,?,?,?,?,?,?)"
  ).bind("44444444-4444-4444-8444-444444444444", "user", "active", 1_000, 5_000, "test", 1).run();
  await DB.prepare(
    "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
  ).bind("44444444-4444-4444-8444-444444444444", digest, "secr", "-key", 1_000).run();

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal((await getAccount(DB, "44444444-4444-4444-8444-444444444444")).expiresAt, 5_000);
  assert.equal((await getAccountByKey(DB, "secret-test-key")).id, "44444444-4444-4444-8444-444444444444");
  assert.equal(await getAccountByKey(DB, "wrong"), null);
});
