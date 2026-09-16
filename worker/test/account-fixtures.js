import { MemoryD1, MemoryKV, testEncryptionKey } from "./helpers.js";
import { getAccount, hashAccessKey } from "../src/maoyan/accounts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createAccountEnv({ nowMs = Date.now(), maxUsers = 20 } = {}) {
  const DB = new MemoryD1();
  await DB.prepare(
    "UPDATE service_settings SET max_users=?,default_valid_days=15,public_signup_enabled=0,updated_at=? WHERE id=1"
  ).bind(maxUsers, nowMs).run();
  DB.resetWrites();
  return {
    DB,
    MAOYAN_KV: new MemoryKV(),
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    ENROLLMENT_HMAC_KEY: testEncryptionKey(),
    ADMIN_TOKEN: "test-admin-token"
  };
}

export async function seedAccount(env, {
  id = crypto.randomUUID(),
  key = `test-${crypto.randomUUID()}`,
  role = "user",
  state = "active",
  expiresAt,
  fingerprint = null,
  config = {}
} = {}) {
  const nowMs = Date.now();
  const actualExpiry = role === "admin" ? null : (expiresAt ?? nowMs + 15 * DAY_MS);
  const tokenHash = await hashAccessKey(key);
  await env.DB.prepare(
    "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,?,?,?,?,?,1)"
  ).bind(id, role, state, nowMs, actualExpiry, "test").run();
  await env.DB.prepare(
    "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
  ).bind(id, tokenHash, key.slice(0, 4), key.slice(-4), nowMs).run();
  await env.DB.prepare(
    "INSERT INTO user_config(token_id,data,updated_at) VALUES (?,?,?)"
  ).bind(id, JSON.stringify({ selectedMovieIds: [], enabled: false, ...config }), new Date(nowMs).toISOString()).run();
  if (fingerprint) {
    await env.DB.prepare(
      "INSERT INTO fingerprint_bindings(fingerprint_digest,fingerprint_version,user_id,bound_until,version) VALUES (?,?,?,?,1)"
    ).bind(fingerprint, "test-v1", id, actualExpiry).run();
  }
  return { account: await getAccount(env.DB, id), key };
}
