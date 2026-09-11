import { userKey } from "./user.js";

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

function sessionKey(tokenId) {
  return userKey(tokenId, SESSION_NAME);
}

function sessionAad(tokenId) {
  return encoder.encode(`maoyan-session:${tokenId}`);
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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: sessionAad(tokenId) },
    await encryptionKey(env.SESSION_ENCRYPTION_KEY),
    encoder.encode(JSON.stringify(session))
  );
  const envelope = {
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(data)),
    uploadedAt: new Date().toISOString(),
    uidMasked: maskUid(session.uid),
    sourceSavedAt: session.sourceSavedAt
  };
  await env.MAOYAN_KV.put(sessionKey(tokenId), JSON.stringify(envelope));
  return publicStatus(envelope);
}

export async function loadLockSession(env, tokenId) {
  let envelope;
  try {
    envelope = await env.MAOYAN_KV.get(sessionKey(tokenId), "json");
  } catch {
    throw encryptedSessionError();
  }
  if (!envelope) throw new Error("未上传猫眼会话");
  if (envelope.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.data !== "string") {
    throw encryptedSessionError();
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(envelope.iv),
        additionalData: sessionAad(tokenId)
      },
      await encryptionKey(env.SESSION_ENCRYPTION_KEY),
      base64ToBytes(envelope.data)
    );
    return normalizeSession(normalizedSessionAsUpload(JSON.parse(decoder.decode(plaintext))));
  } catch (error) {
    if (error?.message === "锁座服务尚未配置加密密钥") throw error;
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
  try {
    envelope = await env.MAOYAN_KV.get(sessionKey(tokenId), "json");
  } catch {
    throw encryptedSessionError();
  }
  if (!envelope) return { uploaded: false };
  if (
    envelope.v !== 1 ||
    typeof envelope.uploadedAt !== "string" ||
    typeof envelope.uidMasked !== "string" ||
    typeof envelope.sourceSavedAt !== "string"
  ) {
    throw encryptedSessionError();
  }
  return publicStatus(envelope);
}

export async function removeLockSession(env, tokenId) {
  await env.MAOYAN_KV.delete(sessionKey(tokenId));
}
