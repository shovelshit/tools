import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import {
  getLockSessionStatus,
  loadLockSession,
  maskUid,
  normalizeSession,
  removeLockSession,
  saveLockSession
} from "../src/maoyan/lock-session.js";
import { userKey } from "../src/maoyan/user.js";

test("normalizes a local session and masks its uid", () => {
  const session = normalizeSession(validSession());
  assert.equal(session.uid, "123456789");
  assert.equal(maskUid(session.uid), "UID 123***789");
  assert.deepEqual(session.createOrderQuery, {
    yodaReady: "h5",
    csecplatform: "4",
    csecversion: "2.6.0"
  });
});

test("rejects a session without uid or mtgsig", () => {
  assert.throws(() => normalizeSession(validSession({ mtgsig: "" })), /会话不完整/);
  assert.throws(() => normalizeSession(validSession({ cookies: [] })), /会话不完整/);
});

test("rejects camelCase upload fields", () => {
  const raw = validSession();
  raw.userAgent = raw.user_agent;
  delete raw.user_agent;
  assert.throws(() => normalizeSession(raw), /会话不完整/);
});

test("stores ciphertext bound to the token namespace", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  const status = await saveLockSession(env, "token-a", validSession());
  const stored = env.MAOYAN_KV.data.get(userKey("token-a", "maoyan-session"));
  assert.equal(status.uidMasked, "UID 123***789");
  assert.equal(stored.includes("cookie-secret"), false);
  assert.equal(stored.includes("signature-secret"), false);
  assert.equal((await loadLockSession(env, "token-a")).uid, "123456789");
  await env.MAOYAN_KV.put(userKey("token-b", "maoyan-session"), stored);
  await assert.rejects(
    () => loadLockSession(env, "token-b"),
    (error) => {
      assert.match(error.message, /猫眼会话不可用/);
      assert.equal(error.message.includes("cookie-secret"), false);
      assert.equal(error.message.includes("signature-secret"), false);
      return true;
    }
  );
});

test("rejects unavailable encryption keys without echoing them", async () => {
  const keys = [undefined, "not-base64!", Buffer.alloc(31, 9).toString("base64")];
  for (const key of keys) {
    const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: key };
    await assert.rejects(
      () => saveLockSession(env, "token-a", validSession()),
      (error) => {
        assert.equal(error.message, "锁座服务尚未配置加密密钥");
        if (key) assert.equal(error.message.includes(key), false);
        return true;
      }
    );
  }
});

test("uses a fresh 12-byte IV for every session save", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  const key = userKey("token-a", "maoyan-session");
  await saveLockSession(env, "token-a", validSession());
  const first = JSON.parse(await env.MAOYAN_KV.get(key));
  await saveLockSession(env, "token-a", validSession());
  const second = JSON.parse(await env.MAOYAN_KV.get(key));
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  assert.equal(Buffer.from(second.iv, "base64").length, 12);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test("status and removal never return credentials", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  await saveLockSession(env, "token-a", validSession());
  const status = await getLockSessionStatus(env, "token-a");
  assert.deepEqual(Object.keys(status).sort(), ["sourceSavedAt", "uidMasked", "uploaded", "uploadedAt"]);
  await removeLockSession(env, "token-a");
  assert.deepEqual(await getLockSessionStatus(env, "token-a"), { uploaded: false });
});
