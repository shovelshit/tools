const VERSION = "thumbmark-1.11.0-v1";

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_REQUEST";
  throw error;
}

function canonicalIp(value) {
  const input = String(value || "").trim();
  if (!input || /[\s/%]/.test(input)) invalid("来源地址无效");
  try {
    const url = new URL(input.includes(":") ? `http://[${input}]/` : `http://${input}/`);
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    invalid("来源地址无效");
  }
}

function decodeKey(value) {
  try {
    const binary = atob(String(value || ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length < 32) throw new Error("short");
    return bytes;
  } catch {
    const error = new Error("ENROLLMENT_HMAC_KEY 配置无效");
    error.code = "SERVICE_UNAVAILABLE";
    throw error;
  }
}

async function digest(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
  return [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestEnrollmentIdentity(env, { fingerprint, version, edgeIp }) {
  const normalizedFingerprint = String(fingerprint || "").trim().toLowerCase();
  if (!/^[a-f0-9]{16,128}$/.test(normalizedFingerprint)) invalid("浏览器标识无效");
  if (String(version || "") !== VERSION) invalid("浏览器标识版本不受支持");
  const ip = canonicalIp(edgeIp);
  const key = decodeKey(env.ENROLLMENT_HMAC_KEY);
  return {
    fingerprintDigest: await digest(key, `fp:v1\0${normalizedFingerprint}`),
    ipDigest: await digest(key, `ip:v1\0${ip}`),
    fingerprintVersion: VERSION
  };
}

export const ENROLLMENT_FINGERPRINT_VERSION = VERSION;
