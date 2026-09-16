const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PURPOSE = "maoyan-notify-credentials:v1";

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function credentialKey(env) {
  const material = String(env.NOTIFY_ENCRYPTION_KEY || env.SESSION_ENCRYPTION_KEY || "");
  if (!material) throw new Error("通知服务尚未配置加密密钥");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${PURPOSE}\u0000${material}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(userId, channel) {
  return encoder.encode(`${PURPOSE}\u0000${String(userId)}\u0000${String(channel)}`);
}

export async function encryptNotifyCredential(env, userId, channel, credential) {
  const value = String(credential || "");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(userId, channel) },
    await credentialKey(env),
    encoder.encode(value)
  );
  return { v: 1, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
}

export async function decryptNotifyCredential(env, userId, channel, envelope) {
  if (envelope?.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.data !== "string") {
    throw new Error("通知凭据密文格式错误");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv),
      additionalData: aad(userId, channel)
    },
    await credentialKey(env),
    base64ToBytes(envelope.data)
  );
  return decoder.decode(plaintext);
}
