import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv } from "./account-fixtures.js";
import { decryptNotifyCredential, encryptNotifyCredential } from "../src/maoyan/notify-secrets.js";
import { getUserConfig } from "../src/maoyan/user.js";
import { getConfig } from "../src/maoyan/db.js";

test("notification ciphertext cannot move across users or channels", async () => {
  const env = await createAccountEnv();
  const encrypted = await encryptNotifyCredential(env, "u1", "bark", "test-key");
  assert.equal(JSON.stringify(encrypted).includes("test-key"), false);
  assert.equal(await decryptNotifyCredential(env, "u1", "bark", encrypted), "test-key");
  await assert.rejects(() => decryptNotifyCredential(env, "u2", "bark", encrypted));
  await assert.rejects(() => decryptNotifyCredential(env, "u1", "serverchan", encrypted));
});

test("notification encryption uses a fresh IV", async () => {
  const env = await createAccountEnv();
  const first = await encryptNotifyCredential(env, "u1", "bark", "same-key");
  const second = await encryptNotifyCredential(env, "u1", "bark", "same-key");
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test("legacy plaintext migration preserves both channels and verification metadata", async () => {
  const env = await createAccountEnv();
  const userId = crypto.randomUUID();
  const verification = { channel: "bark", fingerprint: "abc", testedAt: "2026-09-16T00:00:00.000Z" };
  await env.DB.prepare(
    "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,'user','active',?,?,?,1)"
  ).bind(userId, Date.now(), Date.now() + 10_000, "test").run();
  await env.DB.prepare("INSERT INTO user_config(token_id,data,updated_at) VALUES (?,?,?)")
    .bind(userId, JSON.stringify({ barkKey: "bark-secret", serverChanKey: "server-secret", notifyVerification: verification }), new Date().toISOString()).run();

  const runtime = await getUserConfig(env, userId);
  assert.equal(runtime.barkKey, "bark-secret");
  assert.equal(runtime.serverChanKey, "server-secret");
  assert.deepEqual(runtime.notifyVerification, verification);
  const stored = await getConfig(env.DB, userId);
  assert.equal(Object.hasOwn(stored, "barkKey"), false);
  assert.equal(Object.hasOwn(stored, "serverChanKey"), false);
  assert.deepEqual(stored.notifyVerification, verification);
  assert.equal(JSON.stringify(stored).includes("bark-secret"), false);
  assert.equal(JSON.stringify(stored).includes("server-secret"), false);
});
