import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv } from "./account-fixtures.js";
import { getAccountByKey } from "../src/maoyan/accounts.js";
import { migrateAccounts } from "../src/maoyan/account-migration.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function addLegacyToken(env, id, key, remark = "old") {
  await env.DB.prepare("INSERT INTO tokens(id,token,remark) VALUES (?,?,?)").bind(id, key, remark).run();
}

test("migration retains key identity and grants fifteen days once", async () => {
  const env = await createAccountEnv();
  const id = "44444444-4444-4444-8444-444444444444";
  await addLegacyToken(env, id, "legacy-test-key");
  const nowMs = Date.UTC(2026, 8, 16);

  const first = await migrateAccounts(env, { nowMs });
  const second = await migrateAccounts(env, { nowMs: nowMs + DAY_MS });
  const user = await getAccountByKey(env.DB, "legacy-test-key");

  assert.deepEqual(first, { activatedAt: nowMs, migrated: 1, alreadyApplied: false });
  assert.deepEqual(second, { activatedAt: nowMs, migrated: 0, alreadyApplied: true });
  assert.equal(user.expiresAt, nowMs + 15 * DAY_MS);
  assert.equal(user.id, id);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT token_hash FROM access_keys WHERE user_id=?").bind(id).first()).token_hash.length, 64);
});

test("migration refuses more legacy users than configured capacity without partial writes", async () => {
  const env = await createAccountEnv({ maxUsers: 1 });
  await addLegacyToken(env, "11111111-1111-4111-8111-111111111111", "legacy-one");
  await addLegacyToken(env, "22222222-2222-4222-8222-222222222222", "legacy-two");

  await assert.rejects(() => migrateAccounts(env, { nowMs: 1_000 }), /超过账号上限/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first()).n, 2);
  assert.equal(await env.DB.prepare("SELECT activated_at FROM account_migrations WHERE name='accounts-v1'").first(), null);
});

test("migration transaction rolls back marker, users and token deletion on failure", async () => {
  const env = await createAccountEnv();
  await addLegacyToken(env, "33333333-3333-4333-8333-333333333333", "duplicate-key");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("duplicate-key"));
  const tokenHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(
    "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,?,?,?,?,?,?)"
  ).bind("99999999-9999-4999-8999-999999999999", "user", "active", 0, 50_000, "test", 1).run();
  await env.DB.prepare(
    "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
  ).bind("99999999-9999-4999-8999-999999999999", tokenHash, "dupl", "-key", 0).run();

  await assert.rejects(() => migrateAccounts(env, { nowMs: 1_000 }));
  assert.equal(await env.DB.prepare("SELECT activated_at FROM account_migrations WHERE name='accounts-v1'").first(), null);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first()).n, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n, 1);
});
