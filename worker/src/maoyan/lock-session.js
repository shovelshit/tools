import { userKey } from "./user.js";
import {
  activateSessionVersion, completePendingSessionSave, deleteSessionVersion,
  enqueueRevocationCleanupKey, getSessionVersion, isAccountRevoked, reservePendingSessionSave
} from "./db.js";

const QUERY_KEYS = ["yodaReady", "csecplatform", "csecversion"];
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._:-]{1,64}$/;
const SESSION_NAME = "maoyan-session";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function legacySessionKey(tokenId) {
  return userKey(tokenId, SESSION_NAME);
}

function versionedSessionKey(tokenId, version) {
  return userKey(tokenId, `${SESSION_NAME}:v${version}`);
}

function sessionAad(tokenId, version = null) {
  return encoder.encode(version == null
    ? `maoyan-session:${tokenId}`
    : `maoyan-session:${tokenId}:v${version}`);
}

async function encryptionKey(value) {
  let bytes;
  try {
    bytes = base64ToBytes(String(value || ""));
  } catch {
    throw new Error("锁座服务尚未配置加密密钥");
  }
  if (bytes.length !== 32) throw new Error("锁座服务尚未配置加密密钥");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encryptedSessionError() {
  return new Error("猫眼会话不可用，请重新上传");
}

function normalizedSessionAsUpload(raw) {
  return {
    cookies: raw.cookies,
    csrf: raw.csrf,
    mtgsig: raw.mtgsig,
    user_agent: raw.userAgent,
    create_order_query: raw.createOrderQuery,
    saved_at: raw.sourceSavedAt
  };
}

export function maskUid(uid) {
  const value = String(uid || "");
  if (value.length <= 6) return `UID ${"*".repeat(Math.max(3, value.length))}`;
  return `UID ${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") throw new Error("猫眼会话格式错误");
  const cookies = (Array.isArray(raw.cookies) ? raw.cookies : [])
    .filter((cookie) => cookie && /^\.?([a-z0-9-]+\.)*maoyan\.com$/i.test(String(cookie.domain || ".maoyan.com")))
    .map((cookie) => ({ name: String(cookie.name || "").trim(), value: String(cookie.value || "") }))
    .filter((cookie) => /^[A-Za-z0-9_-]{1,128}$/.test(cookie.name) && cookie.value.length <= 4096)
    .slice(0, 64);
  const uid = cookies.find((cookie) => cookie.name === "uid")?.value || "";
  const csrf = String(raw.csrf || "");
  const mtgsig = String(raw.mtgsig || "");
  const userAgent = String(raw.user_agent || "");

  if (!cookies.length || !/^\d+$/.test(uid) || !csrf || !mtgsig || !userAgent) {
    throw new Error("猫眼会话不完整，请重新登录后上传");
  }

  const sourceQuery = raw.create_order_query && typeof raw.create_order_query === "object"
    ? raw.create_order_query
    : {};
  // 仅保留白名单键, 且值须为安全字符(防止注入任意查询参数)
  const createOrderQuery = Object.fromEntries(
    QUERY_KEYS
      .map((key) => [key, String(sourceQuery[key] || "")])
      .filter(([, value]) => value && SAFE_QUERY_VALUE.test(value))
  );

  return {
    cookies,
    uid,
    csrf,
    mtgsig,
    userAgent,
    createOrderQuery,
    sourceSavedAt: String(raw.saved_at || "")
  };
}

export async function saveLockSession(env, tokenId, raw) {
  const session = normalizeSession(raw);
  if (!env.DB) return saveLegacySession(env, tokenId, session);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getSessionVersion(env.DB, tokenId);
    let version;
    do {
      version = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    } while (version === current?.activeVersion);
    const envelope = await encryptSessionEnvelope(env, tokenId, session, version);
    const key = versionedSessionKey(tokenId, version);
    const reservation = await reservePendingSessionSave(env.DB, tokenId, key);
    if (Number(reservation?.meta?.changes || 0) !== 1) {
      if (await isAccountRevoked(env.DB, tokenId)) throw revokedSessionError();
      throw new Error("猫眼会话保存冲突，请重试");
    }
    await env.MAOYAN_KV.put(key, JSON.stringify(envelope));
    let result;
    try {
      result = await activateSessionVersion(env.DB, tokenId, version, current?.activeVersion ?? null);
    } catch (error) {
      const isRevoked = String(error?.message || "").includes("ACCOUNT_REVOKED");
      if (isRevoked) {
        await compensateRevokedSessionKey(env, tokenId, key);
        throw revokedSessionError();
      }
      let deleted = false;
      try {
        await env.MAOYAN_KV.delete(key);
        deleted = true;
      } catch {}
      if (!deleted) {
        console.error(isRevoked
          ? "[maoyan] revoked session cleanup incomplete"
          : "[maoyan] lock session compensation incomplete");
      } else {
        await completePendingSessionSave(env.DB, tokenId, key);
      }
      throw error;
    }
    if (Number(result?.meta?.changes ?? 1) > 0) {
      if (current) await env.MAOYAN_KV.delete(versionedSessionKey(tokenId, current.activeVersion));
      await completePendingSessionSave(env.DB, tokenId, key);
      return publicStatus(envelope);
    }
    if (await isAccountRevoked(env.DB, tokenId)) {
      await compensateRevokedSessionKey(env, tokenId, key);
      throw revokedSessionError();
    }
    try {
      await env.MAOYAN_KV.delete(key);
      await completePendingSessionSave(env.DB, tokenId, key);
    } catch (error) {
      if (await isAccountRevoked(env.DB, tokenId)) {
        await compensateRevokedSessionKey(env, tokenId, key);
        throw revokedSessionError();
      }
      throw error;
    }
  }
  throw new Error("猫眼会话保存冲突，请重试");
}

function revokedSessionError() {
  const error = new Error("账号已撤销");
  error.code = "ACCOUNT_REVOKED";
  return error;
}

async function compensateRevokedSessionKey(env, tokenId, key) {
  try {
    // Persist before compensation: a delete failure must leave a retryable key.
    await enqueueRevocationCleanupKey(env.DB, tokenId, key, Date.now());
  } catch {
    console.error("[maoyan] revoked session cleanup marker unavailable");
  }
  try {
    await env.MAOYAN_KV.delete(key);
  } catch {
    console.error("[maoyan] revoked session cleanup incomplete");
  }
}

async function encryptSessionEnvelope(env, tokenId, session, version = null) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: sessionAad(tokenId, version) },
    await encryptionKey(env.SESSION_ENCRYPTION_KEY),
    encoder.encode(JSON.stringify(session))
  );
  return {
    v: version == null ? 1 : 2,
    ...(version == null ? {} : { sessionVersion: version }),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(data)),
    uploadedAt: new Date().toISOString(),
    uidMasked: maskUid(session.uid),
    sourceSavedAt: session.sourceSavedAt
  };
}

async function saveLegacySession(env, tokenId, session) {
  const envelope = await encryptSessionEnvelope(env, tokenId, session);
  await env.MAOYAN_KV.put(legacySessionKey(tokenId), JSON.stringify(envelope));
  return publicStatus(envelope);
}

async function readEnvelope(env, tokenId) {
  if (!env.DB) {
    return { envelope: await env.MAOYAN_KV.get(legacySessionKey(tokenId), "json"), version: null };
  }
  const current = await getSessionVersion(env.DB, tokenId);
  if (current) {
    return {
      envelope: await env.MAOYAN_KV.get(versionedSessionKey(tokenId, current.activeVersion), "json"),
      version: current.activeVersion
    };
  }
  const legacy = await env.MAOYAN_KV.get(legacySessionKey(tokenId), "json");
  if (!legacy) return { envelope: null, version: null };
  const session = await decryptSessionEnvelope(env, tokenId, legacy, null);
  await saveLockSession(env, tokenId, normalizedSessionAsUpload(session));
  await env.MAOYAN_KV.delete(legacySessionKey(tokenId));
  return readEnvelope(env, tokenId);
}

async function decryptSessionEnvelope(env, tokenId, envelope, version) {
  const expectedEnvelopeVersion = version == null ? 1 : 2;
  if (
    envelope?.v !== expectedEnvelopeVersion ||
    (version != null && Number(envelope.sessionVersion) !== version) ||
    typeof envelope?.iv !== "string" || typeof envelope?.data !== "string"
  ) throw encryptedSessionError();
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv),
      additionalData: sessionAad(tokenId, version)
    },
    await encryptionKey(env.SESSION_ENCRYPTION_KEY),
    base64ToBytes(envelope.data)
  );
  return normalizeSession(normalizedSessionAsUpload(JSON.parse(decoder.decode(plaintext))));
}

export async function loadLockSession(env, tokenId) {
  let envelope;
  let version;
  try {
    ({ envelope, version } = await readEnvelope(env, tokenId));
  } catch {
    throw encryptedSessionError();
  }
  if (!envelope) throw new Error("未上传猫眼会话");

  try {
    return await decryptSessionEnvelope(env, tokenId, envelope, version);
  } catch (error) {
    if (error?.message === "锁座服务尚未配置加密密钥") throw error;
    // 解密得到的明文若本身不合法, 保留其可操作提示(格式错误/不完整), 不要笼统归因为"会话不可用"
    if (/^猫眼会话(格式错误|不完整)/.test(String(error?.message || ""))) throw error;
    throw encryptedSessionError();
  }
}

function publicStatus(envelope) {
  return {
    uploaded: true,
    uploadedAt: envelope.uploadedAt,
    uidMasked: envelope.uidMasked,
    sourceSavedAt: envelope.sourceSavedAt
  };
}

export async function getLockSessionStatus(env, tokenId) {
  let envelope;
  let version;
  try {
    ({ envelope, version } = await readEnvelope(env, tokenId));
  } catch {
    throw encryptedSessionError();
  }
  if (!envelope) return { uploaded: false };
  if (
    envelope.v !== (version == null ? 1 : 2) ||
    (version != null && Number(envelope.sessionVersion) !== version) ||
    typeof envelope.uploadedAt !== "string" ||
    typeof envelope.uidMasked !== "string" ||
    typeof envelope.sourceSavedAt !== "string"
  ) {
    throw encryptedSessionError();
  }
  return publicStatus(envelope);
}

export async function removeLockSession(env, tokenId) {
  if (!env.DB) {
    await env.MAOYAN_KV.delete(legacySessionKey(tokenId));
    return;
  }
  const current = await getSessionVersion(env.DB, tokenId);
  if (!current) {
    await env.MAOYAN_KV.delete(legacySessionKey(tokenId));
    return;
  }
  await env.MAOYAN_KV.delete(versionedSessionKey(tokenId, current.activeVersion));
  await deleteSessionVersion(env.DB, tokenId, current.activeVersion);
}
