// ---------------- 猫眼用户数据(D1 存储 + KV 会话键名) ----------------
// 用户状态(config/snapshot/changes/status/lock-rule/seatfb)已迁移 D1(见 db.js),
// KV 仅保留加密会话(maoyan-session)。userKey 现在只服务会话键名。

import { deleteUserData, getConfigRecord, getSessionVersion, putConfig, replaceConfigIfUnchanged } from "./db.js";
import { decryptNotifyCredential, encryptNotifyCredential } from "./notify-secrets.js";
import { saveConfigWithSubscription, syncSubscription } from "./monitor-store.js";

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
  for (const [channel, field] of Object.entries(CREDENTIALS)) {
    if (encrypted[channel]) {
      config[field] = await decryptNotifyCredential(env, tokenId, channel, encrypted[channel]);
    }
  }

  const hasLegacyPlaintext = Object.values(CREDENTIALS).some((field) => Object.hasOwn(record.config, field));
  if (hasLegacyPlaintext && (env.NOTIFY_ENCRYPTION_KEY || env.SESSION_ENCRYPTION_KEY)) {
    const migrated = await storedConfig(env, tokenId, config);
    const result = await replaceConfigIfUnchanged(env.DB, tokenId, record.raw, migrated);
    if (Number(result?.meta?.changes || 0) === 1) {
      config.version += 1;
      await syncSubscription(env.DB, tokenId, config, config.version, Date.now());
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

// 令牌注销: 清 D1 全部用户状态行 + KV 加密会话
export async function cleanupUserData(env, tokenId) {
  const session = await getSessionVersion(env.DB, tokenId);
  await deleteUserData(env.DB, tokenId);
  try {
    if (session) await env.MAOYAN_KV.delete(userKey(tokenId, `maoyan-session:v${session.activeVersion}`));
    await env.MAOYAN_KV.delete(userKey(tokenId, "maoyan-session"));
  } catch (e) {
  }
}
