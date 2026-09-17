import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import {
  getLockSessionStatus,
  loadLockSession,
  maskUid,
  normalizeSession,
  removeLockSession,
  saveLockSession
} from "../src/maoyan/lock-session.js";
import { retryPendingRevocationCleanups, userKey } from "../src/maoyan/user.js";
import { updateManagedAccount } from "../src/maoyan/enrollment-store.js";
import { enqueueRevocationCleanupKey } from "../src/maoyan/db.js";

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

test("D1 selects the only active versioned session", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  await saveLockSession(env, account.id, validSession());
  const first = await env.DB.prepare(
    "SELECT active_version FROM session_versions WHERE user_id=?"
  ).bind(account.id).first();
  const firstVersion = Number(first.active_version);
  assert.equal(firstVersion > 0, true);
  assert.equal(env.MAOYAN_KV.data.has(userKey(account.id, `maoyan-session:v${firstVersion}`)), true);

  await saveLockSession(env, account.id, validSession({
    cookies: validSession().cookies.map((cookie) => cookie.name === "uid" ? { ...cookie, value: "987654321" } : cookie)
  }));
  const second = await env.DB.prepare(
    "SELECT active_version FROM session_versions WHERE user_id=?"
  ).bind(account.id).first();
  assert.notEqual(Number(second.active_version), firstVersion);
  assert.equal(env.MAOYAN_KV.data.has(userKey(account.id, `maoyan-session:v${firstVersion}`)), false);
  assert.equal((await loadLockSession(env, account.id)).uid, "987654321");
});

test("removing a versioned session deletes only the active object and pointer", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  await saveLockSession(env, account.id, validSession());
  await saveLockSession(env, account.id, validSession());
  const current = await env.DB.prepare("SELECT active_version FROM session_versions WHERE user_id=?").bind(account.id).first();
  const activeKey = userKey(account.id, `maoyan-session:v${current.active_version}`);
  const unrelatedKey = userKey(account.id, "maoyan-session:v999");
  await env.MAOYAN_KV.put(unrelatedKey, "unrelated");
  await removeLockSession(env, account.id);
  assert.equal(env.MAOYAN_KV.data.has(activeKey), false);
  assert.equal(env.MAOYAN_KV.data.has(unrelatedKey), true);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM session_versions WHERE user_id=?").bind(account.id).first(), null);
  assert.deepEqual(await getLockSessionStatus(env, account.id), { uploaded: false });
});

test("a session save racing revocation cannot leave a pointer or KV ciphertext", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  let revoked = false;
  env.MAOYAN_KV.put = async (key, value) => {
    await put(key, value);
    if (!revoked) {
      revoked = true;
      await env.DB.prepare("UPDATE users SET state='revoked' WHERE id=?").bind(account.id).run();
    }
  };

  await assert.rejects(() => saveLockSession(env, account.id, validSession()), { code: "ACCOUNT_REVOKED" });

  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM session_versions WHERE user_id=?").bind(account.id).first(), null);
  assert.equal((await env.MAOYAN_KV.list({ prefix: userKey(account.id, "maoyan-session:v") })).keys.length, 0);
});

test("a failed revoke-race KV compensation retains a durable cleanup retry", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  let hideNewVersion = true;
  let failCompensation = false;
  let versionedKey = "";

  env.MAOYAN_KV.list = async (options) => hideNewVersion
    ? { keys: [], list_complete: true }
    : await list(options);
  env.MAOYAN_KV.delete = async (key) => {
    if (key === versionedKey && failCompensation) throw new Error("delete unavailable");
    return await remove(key);
  };
  env.MAOYAN_KV.put = async (key, value) => {
    await put(key, value);
    versionedKey = key;
    failCompensation = true;
    await updateManagedAccount(env, {
      userId: account.id, expectedVersion: account.version, patch: { state: "revoked" }, nowMs
    });
  };

  await assert.rejects(() => saveLockSession(env, account.id, validSession()), { code: "ACCOUNT_REVOKED" });

  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM session_versions WHERE user_id=?").bind(account.id).first(), null);
  assert.notEqual(await env.MAOYAN_KV.get(versionedKey), null);
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, versionedKey).first(), null);

  failCompensation = false;
  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 1 });
  assert.equal(await env.MAOYAN_KV.get(versionedKey), null);
  assert.equal(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, versionedKey).first(), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});

test("a zero-change session update crossed by revocation retains its invisible KV key for retry", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await saveLockSession(env, account.id, validSession());
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  let newKey = "";
  let revoked = false;
  let failCompensation = false;

  env.MAOYAN_KV.list = async (options) => newKey
    ? { keys: [], list_complete: true }
    : await list(options);
  env.MAOYAN_KV.put = async (key, value) => {
    await put(key, value);
    if (!revoked) {
      revoked = true;
      newKey = key;
      failCompensation = true;
      await updateManagedAccount(env, {
        userId: account.id, expectedVersion: account.version, patch: { state: "revoked" }, nowMs
      });
    }
  };
  env.MAOYAN_KV.delete = async (key) => {
    if (key === newKey && failCompensation) throw new Error("delete unavailable");
    return await remove(key);
  };

  await assert.rejects(() => saveLockSession(env, account.id, validSession()), { code: "ACCOUNT_REVOKED" });

  assert.notEqual(await env.MAOYAN_KV.get(newKey), null);
  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?"
  ).bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, newKey).first(), null);

  failCompensation = false;
  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 1 });
  assert.equal(await env.MAOYAN_KV.get(newKey), null);
  assert.equal(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, newKey).first(), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});

test("a zero-change session update from a normal CAS conflict is retried without a revoke cleanup", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  await saveLockSession(env, account.id, validSession());
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  let puts = 0;
  env.MAOYAN_KV.put = async (key, value) => {
    await put(key, value);
    puts += 1;
    if (puts === 1) {
      await env.DB.prepare(
        "UPDATE session_versions SET active_version=active_version+1 WHERE user_id=?"
      ).bind(account.id).run();
    }
  };

  assert.equal((await saveLockSession(env, account.id, validSession())).uploaded, true);
  assert.equal((await env.DB.prepare("SELECT state FROM users WHERE id=?").bind(account.id).first()).state, "active");
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM pending_session_saves WHERE user_id=?").bind(account.id).first(), null);
});

test("a failed normal conflict compensation is captured when revocation follows the last state check", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await saveLockSession(env, account.id, validSession());
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  let newKey = "";
  let conflictInjected = false;
  let failDelete = true;

  env.MAOYAN_KV.list = async (options) => newKey
    ? { keys: [], list_complete: true }
    : await list(options);
  env.MAOYAN_KV.put = async (key, value) => {
    await put(key, value);
    if (!conflictInjected) {
      conflictInjected = true;
      newKey = key;
      await env.DB.prepare(
        "UPDATE session_versions SET active_version=active_version+1 WHERE user_id=?"
      ).bind(account.id).run();
    }
  };
  env.MAOYAN_KV.delete = async (key) => {
    if (key === newKey && failDelete) throw new Error("delete unavailable");
    return await remove(key);
  };

  await assert.rejects(() => saveLockSession(env, account.id, validSession()), /delete unavailable/);
  await updateManagedAccount(env, {
    userId: account.id, expectedVersion: account.version, patch: { state: "revoked" }, nowMs
  });

  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, newKey).first(), null);

  failDelete = false;
  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 1 });
  assert.equal(await env.MAOYAN_KV.get(newKey), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});

test("revocation captures a successfully activated session that replaced its stale pointer", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await saveLockSession(env, account.id, validSession());
  const batch = env.DB.batch.bind(env.DB);
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  let releaseRevocation;
  let startedRevocation;
  let newKey = "";
  let failDelete = false;

  env.DB.batch = async (statements) => {
    if (!startedRevocation) {
      startedRevocation = true;
      await new Promise((resolve) => { releaseRevocation = resolve; });
    }
    return await batch(statements);
  };
  env.MAOYAN_KV.list = async (options) => newKey
    ? { keys: [], list_complete: true }
    : await list(options);
  env.MAOYAN_KV.put = async (key, value) => {
    newKey = key;
    return await put(key, value);
  };
  env.MAOYAN_KV.delete = async (key) => {
    if (key === newKey && failDelete) throw new Error("delete unavailable");
    return await remove(key);
  };

  const revoking = updateManagedAccount(env, {
    userId: account.id, expectedVersion: account.version, patch: { state: "revoked" }, nowMs
  });
  while (!startedRevocation) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await saveLockSession(env, account.id, validSession())).uploaded, true);
  failDelete = true;
  releaseRevocation();
  await revoking;

  assert.notEqual(await env.MAOYAN_KV.get(newKey), null);
  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, newKey).first(), null);

  failDelete = false;
  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 1 });
  assert.equal(await env.MAOYAN_KV.get(newKey), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});

test("a failed old-version deletion is retained when revocation cannot enumerate the old key", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await saveLockSession(env, account.id, validSession());
  const oldVersion = await env.DB.prepare(
    "SELECT active_version FROM session_versions WHERE user_id=?"
  ).bind(account.id).first();
  const oldKey = userKey(account.id, `maoyan-session:v${oldVersion.active_version}`);
  const list = env.MAOYAN_KV.list.bind(env.MAOYAN_KV);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  let failOldDelete = true;

  env.MAOYAN_KV.list = async (options) => {
    const page = await list(options);
    return { ...page, keys: page.keys.filter((entry) => entry.name !== oldKey) };
  };
  env.MAOYAN_KV.delete = async (key) => {
    if (key === oldKey && failOldDelete) throw new Error("delete unavailable");
    return await remove(key);
  };

  await assert.rejects(() => saveLockSession(env, account.id, validSession()), /delete unavailable/);
  assert.notEqual(await env.MAOYAN_KV.get(oldKey), null);

  await updateManagedAccount(env, {
    userId: account.id, expectedVersion: account.version, patch: { state: "revoked" }, nowMs
  });
  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, oldKey).first(), null);

  failOldDelete = false;
  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 1 });
  assert.equal(await env.MAOYAN_KV.get(oldKey), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});

test("a failed KV put releases this save's pending reservations", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  await saveLockSession(env, account.id, validSession());
  env.MAOYAN_KV.put = async () => { throw new Error("put unavailable"); };

  await assert.rejects(() => saveLockSession(env, account.id, validSession()), /put unavailable/);
  assert.equal(await env.DB.prepare(
    "SELECT 1 AS ok FROM pending_session_saves WHERE user_id=?"
  ).bind(account.id).first(), null);
});

test("concurrent saves never delete the winner when their proposed versions collide", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  await saveLockSession(env, account.id, validSession());
  const originalRandom = crypto.getRandomValues;
  const originalPrepare = env.DB.prepare.bind(env.DB);
  const originalPut = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  const proposedVersions = [7, 7, 8];
  let sessionReads = 0;
  let releaseSessionReads;
  let puts = 0;

  env.DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!sql.startsWith("SELECT active_version,updated_at FROM session_versions")) return statement;
    return {
      bind: (...args) => {
        const bound = statement.bind(...args);
        return {
          ...bound,
          first: async () => {
            const row = await bound.first();
            sessionReads += 1;
            if (sessionReads === 1) await new Promise((resolve) => { releaseSessionReads = resolve; });
            return row;
          }
        };
      }
    };
  };
  crypto.getRandomValues = (bytes) => {
    if (bytes instanceof Uint32Array) bytes[0] = proposedVersions.shift() || 9;
    else originalRandom.call(crypto, bytes);
    return bytes;
  };
  env.MAOYAN_KV.put = async (key, value) => {
    puts += 1;
    if (puts === 2) {
      while (Number((await env.DB.prepare(
        "SELECT active_version FROM session_versions WHERE user_id=?"
      ).bind(account.id).first()).active_version) !== 7) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (key.endsWith(":v8")) throw new Error("later put unavailable");
    return await originalPut(key, value);
  };
  try {
    const firstSave = saveLockSession(env, account.id, validSession());
    while (sessionReads < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const secondSave = saveLockSession(env, account.id, validSession({
      cookies: validSession().cookies.map((cookie) => cookie.name === "uid" ? { ...cookie, value: "987654321" } : cookie)
    }));
    while (puts < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSessionReads();
    const results = await Promise.allSettled([firstSave, secondSave]);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(results.find((result) => result.status === "rejected").reason.message, /later put unavailable/);
  } finally {
    crypto.getRandomValues = originalRandom;
    env.DB.prepare = originalPrepare;
  }

  const active = await env.DB.prepare(
    "SELECT active_version FROM session_versions WHERE user_id=?"
  ).bind(account.id).first();
  assert.notEqual(active, null, JSON.stringify(env.MAOYAN_KV.ops));
  assert.notEqual(await env.MAOYAN_KV.get(userKey(account.id, `maoyan-session:v${active.active_version}`)), null);
  assert.match((await loadLockSession(env, account.id)).uid, /^(123456789|987654321)$/);
});

test("a late exact cleanup key prevents an in-flight retry from clearing its parent", async () => {
  const nowMs = Date.parse("2026-09-16T04:00:00.000Z");
  const env = await createAccountEnv({ nowMs });
  const { account } = await seedAccount(env, { expiresAt: nowMs + 60_000 });
  await env.DB.prepare("UPDATE users SET state='revoked' WHERE id=?").bind(account.id).run();
  const firstKey = userKey(account.id, "maoyan-session:v111");
  const lateKey = userKey(account.id, "maoyan-session:v222");
  await env.MAOYAN_KV.put(firstKey, "first");
  await enqueueRevocationCleanupKey(env.DB, account.id, firstKey, nowMs);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  let insertedLateKey = false;
  env.MAOYAN_KV.delete = async (key) => {
    if (key === firstKey && !insertedLateKey) {
      insertedLateKey = true;
      await put(lateKey, "late");
      await enqueueRevocationCleanupKey(env.DB, account.id, lateKey, nowMs + 1);
    }
    return await remove(key);
  };

  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 2 });

  assert.equal(await env.MAOYAN_KV.get(firstKey), null);
  assert.equal(await env.MAOYAN_KV.get(lateKey), "late");
  assert.notEqual(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
  assert.notEqual(await env.DB.prepare(
    "SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(account.id, lateKey).first(), null);

  await retryPendingRevocationCleanups(env, { nowMs: nowMs + 3 });
  assert.equal(await env.MAOYAN_KV.get(lateKey), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup_keys WHERE user_id=?").bind(account.id).first(), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
});

test("a non-revocation pointer failure with failed compensation is observable without a revoke retry", async () => {
  const env = await createAccountEnv();
  const { account } = await seedAccount(env);
  const prepare = env.DB.prepare.bind(env.DB);
  const remove = env.MAOYAN_KV.delete.bind(env.MAOYAN_KV);
  let versionedKey = "";
  env.MAOYAN_KV.delete = async (key) => {
    if (key === versionedKey) throw new Error("delete unavailable");
    return await remove(key);
  };
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("INSERT INTO session_versions")) return statement;
    return {
      bind: (...args) => {
        const bound = statement.bind(...args);
        return { ...bound, run: async () => { throw new Error("D1 unavailable"); } };
      }
    };
  };
  const put = env.MAOYAN_KV.put.bind(env.MAOYAN_KV);
  env.MAOYAN_KV.put = async (key, value) => {
    versionedKey = key;
    return await put(key, value);
  };
  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    await assert.rejects(() => saveLockSession(env, account.id, validSession()), /D1 unavailable/);
  } finally {
    console.error = originalError;
  }

  assert.notEqual(await env.MAOYAN_KV.get(versionedKey), null);
  assert.equal(await env.DB.prepare("SELECT 1 AS ok FROM revocation_cleanup WHERE user_id=?").bind(account.id).first(), null);
  assert.equal(errors.includes("[maoyan] lock session compensation incomplete"), true);
  assert.equal(errors.some((message) => message.includes(account.id)), false);
});
