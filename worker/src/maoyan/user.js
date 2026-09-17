// ---------------- 猫眼用户数据(D1 存储 + KV 会话键名) ----------------
// 用户状态(config/snapshot/changes/status/lock-rule/seatfb)已迁移 D1(见 db.js),
// KV 仅保留加密会话(maoyan-session)。userKey 现在只服务会话键名。

import {
  completeRevocationCleanup, deleteUserData, getConfigRecord, getSessionVersion,
  listRevocationCleanupKeys, listRevocationCleanups, putConfig,
  recordRevocationCleanupAttempt
} from "./db.js";
import { decryptNotifyCredential, encryptNotifyCredential } from "./notify-secrets.js";
import { saveConfigWithSubscription } from "./monitor-store.js";

const CREDENTIALS = {
  bark: "barkKey",
  serverchan: "serverChanKey"
};

export function userKey(tokenId, name) {
  return tokenId ? `u:${tokenId}:${name}` : `shared:${name}`;
}

export async function getUserConfig(env, tokenId) {
  const record = await getConfigRecord(env.DB, tokenId);
  if (!record) return {};
  const config = { ...record.config };
  const encrypted = config.notifyCredentials && typeof config.notifyCredentials === "object"
    ? config.notifyCredentials : {};
  delete config.notifyCredentials;
  for (const field of Object.values(CREDENTIALS)) delete config[field];
  for (const [channel, field] of Object.entries(CREDENTIALS)) {
    if (encrypted[channel]) {
      config[field] = await decryptNotifyCredential(env, tokenId, channel, encrypted[channel]);
    }
  }

  return config;
}

async function storedConfig(env, tokenId, config) {
  const stored = { ...(config || {}) };
  delete stored.version;
  delete stored.notifyCredentials;
  const credentials = {};
  for (const [channel, field] of Object.entries(CREDENTIALS)) {
    const value = String(stored[field] || "").trim();
    delete stored[field];
    if (value) credentials[channel] = await encryptNotifyCredential(env, tokenId, channel, value);
  }
  if (Object.keys(credentials).length) stored.notifyCredentials = credentials;
  return stored;
}

export async function putUserConfig(env, tokenId, config) {
  const account = await env.DB.prepare("SELECT 1 AS ok FROM users WHERE id=?").bind(tokenId).first();
  if (!account) {
    await putConfig(env.DB, tokenId, await storedConfig(env, tokenId, config));
    return config;
  }
  return await saveConfigWithSubscription(env.DB, {
    userId: tokenId,
    storedConfig: await storedConfig(env, tokenId, config),
    config,
    nowMs: Date.now()
  });
}

export async function putUserConfigVersioned(env, tokenId, config, expectedVersion) {
  return await saveConfigWithSubscription(env.DB, {
    userId: tokenId,
    storedConfig: await storedConfig(env, tokenId, config),
    config,
    expectedVersion,
    nowMs: Date.now()
  });
}

export async function saveUserConfig(env, tokenId, config, expectedVersion = config?.version) {
  if (Number.isInteger(Number(expectedVersion)) && Number(expectedVersion) > 0) {
    const saved = await putUserConfigVersioned(env, tokenId, config, Number(expectedVersion));
    config.version = saved.version;
    return config;
  }
  await putUserConfig(env, tokenId, config);
  const saved = await getUserConfig(env, tokenId);
  config.version = saved.version;
  return config;
}

async function deleteKvSession(env, key) {
  try {
    await env.MAOYAN_KV.delete(key);
    return true;
  } catch {
    return false;
  }
}

// 撤销后的 KV 残留不再可被使用：账号状态和 D1 会话指针已先持久化失效。
// 这里保留尽力删除语义，避免 KV 瞬时故障回滚已经成功的账号撤销。
export async function cleanupUserKvSessions(env, tokenId, session = null, cleanupKeys = []) {
  const keys = new Set([userKey(tokenId, "maoyan-session")]);
  if (session) keys.add(userKey(tokenId, `maoyan-session:v${session.activeVersion}`));
  for (const key of cleanupKeys) keys.add(key);
  let enumerationFailed = false;
  try {
    let cursor;
    do {
      const page = await env.MAOYAN_KV.list({ prefix: userKey(tokenId, "maoyan-session:v"), cursor });
      for (const entry of page.keys || []) keys.add(entry.name);
      cursor = page.cursor;
      if (page.list_complete) break;
    } while (cursor);
  } catch {
    // The known active and legacy keys below are still deleted individually.
    enumerationFailed = true;
  }
  const results = await Promise.all([...keys].map((key) => deleteKvSession(env, key)));
  const deletionFailed = results.some((deleted) => !deleted);
  return {
    complete: !enumerationFailed && !deletionFailed,
    error: enumerationFailed ? "kv_enumeration_failed" : deletionFailed ? "kv_delete_failed" : null
  };
}

function logRevocationCleanupFailure() {
  console.error("[maoyan] revoked session cleanup incomplete");
}

// This consumes only durable markers created as part of a successful revocation.
// A failure leaves the marker intact so a later scheduled run can converge.
export async function retryRevocationCleanup(env, tokenId, { session = null, nowMs = Date.now() } = {}) {
  let cleanupKeys = [];
  let outcome;
  try {
    cleanupKeys = await listRevocationCleanupKeys(env.DB, tokenId);
    outcome = await cleanupUserKvSessions(env, tokenId, session, cleanupKeys);
  } catch {
    outcome = { complete: false, error: "kv_delete_failed" };
  }
  try {
    if (outcome.complete) await completeRevocationCleanup(env.DB, tokenId, cleanupKeys);
    else await recordRevocationCleanupAttempt(env.DB, tokenId, nowMs, outcome.error);
  } catch {
    // The marker was atomically created with revocation and remains for a later retry.
    outcome = { complete: false, error: outcome.error || "kv_delete_failed" };
  }
  if (!outcome.complete) logRevocationCleanupFailure();
  return outcome;
}

export async function retryPendingRevocationCleanups(env, { limit = 100, nowMs = Date.now() } = {}) {
  let userIds;
  try {
    userIds = await listRevocationCleanups(env.DB, limit);
  } catch {
    logRevocationCleanupFailure();
    return { attempted: 0, completed: 0 };
  }
  let completed = 0;
  for (const tokenId of userIds) {
    const outcome = await retryRevocationCleanup(env, tokenId, { nowMs });
    if (outcome.complete) completed += 1;
  }
  return { attempted: userIds.length, completed };
}

// 令牌注销: 清 D1 全部运行时状态行 + KV 加密会话
export async function cleanupUserData(env, tokenId) {
  const session = await getSessionVersion(env.DB, tokenId);
  await deleteUserData(env.DB, tokenId);
  const outcome = await cleanupUserKvSessions(env, tokenId, session);
  if (!outcome.complete) logRevocationCleanupFailure();
}
