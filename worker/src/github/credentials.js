const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PURPOSE = "store-github-token:v1";

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function key(env) {
  if (!env.GITHUB_TOKEN_ENCRYPTION_KEY) throw new Error("GitHub Token 加密密钥未配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${PURPOSE}\0${env.GITHUB_TOKEN_ENCRYPTION_KEY}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function associated(userId, login) {
  return encoder.encode(`${PURPOSE}\0${userId}\0${login.toLowerCase()}`);
}

export async function encryptGithubToken(env, userId, login, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associated(userId, login) },
    await key(env), encoder.encode(token)
  );
  return { v: 1, iv: encode(iv), data: encode(new Uint8Array(data)) };
}

export async function decryptGithubToken(env, userId, login, envelope) {
  if (envelope?.v !== 1 || !envelope.iv || !envelope.data) throw new Error("GitHub Token 密文格式无效");
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(envelope.iv), additionalData: associated(userId, login) },
    await key(env), decode(envelope.data)
  );
  return decoder.decode(data);
}
