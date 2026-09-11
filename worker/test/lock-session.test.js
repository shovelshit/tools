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

test("stores ciphertext bound to the token namespace", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  const status = await saveLockSession(env, "token-a", validSession());
  const stored = env.MAOYAN_KV.data.get("u:token-a:maoyan-session");
  assert.equal(status.uidMasked, "UID 123***789");
  assert.equal(stored.includes("cookie-secret"), false);
  assert.equal(stored.includes("signature-secret"), false);
  assert.equal((await loadLockSession(env, "token-a")).uid, "123456789");
  await assert.rejects(() => loadLockSession(env, "token-b"), /未上传猫眼会话/);
});

test("status and removal never return credentials", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  await saveLockSession(env, "token-a", validSession());
  const status = await getLockSessionStatus(env, "token-a");
  assert.deepEqual(Object.keys(status).sort(), ["sourceSavedAt", "uidMasked", "uploaded", "uploadedAt"]);
  await removeLockSession(env, "token-a");
  assert.deepEqual(await getLockSessionStatus(env, "token-a"), { uploaded: false });
});
