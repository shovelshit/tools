import { accountStatus, getAccount, getAccountByKey, hashAccessKey } from "./accounts.js";

const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000;

export class AccountAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function serviceNow(env) {
  const injected = Number(env?.NOW_MS);
  return Number.isFinite(injected) ? injected : Date.now();
}

function randomCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function principal(account, credentialType, nowMs) {
  return {
    userId: account.id,
    role: account.role,
    accountStatus: accountStatus(account, nowMs),
    credentialType
  };
}

export async function authenticate(request, env, nowMs = Date.now()) {
  const raw = String(request.headers.get("X-Token") || "").trim();
  if (!raw) return null;
  const account = await getAccountByKey(env.DB, raw);
  if (account) {
    if (accountStatus(account, nowMs) === "revoked") return null;
    return principal(account, "access_key", nowMs);
  }

  const tokenHash = await hashAccessKey(raw);
  const adminTokenHash = await hashAccessKey(String(env.ADMIN_TOKEN || ""));
  const row = await env.DB.prepare(
    "SELECT user_id FROM admin_monitor_sessions WHERE token_hash=? AND expires_at>? AND admin_token_hash=?"
  ).bind(tokenHash, nowMs, adminTokenHash).first();
  if (!row) return null;
  const monitorAccount = await getAccount(env.DB, row.user_id);
  if (!monitorAccount || monitorAccount.role !== "admin" || accountStatus(monitorAccount, nowMs) !== "active") return null;
  return principal(monitorAccount, "admin_monitor_session", nowMs);
}

export async function requireActiveAccount(env, userId, nowMs = Date.now()) {
  const account = await getAccount(env.DB, userId);
  const status = accountStatus(account, nowMs);
  if (!account || status === "revoked") throw new AccountAuthError("UNAUTHORIZED", "访问密钥无效");
  if (status === "expired") throw new AccountAuthError("ACCOUNT_EXPIRED", "账号已到期，请先续期");
  if (status === "suspended") throw new AccountAuthError("ACCOUNT_SUSPENDED", "账号已暂停");
  return account;
}

export function publicAccount(account, nowMs = Date.now()) {
  return {
    userId: account.id,
    role: account.role,
    accountStatus: accountStatus(account, nowMs),
    expiresAt: account.expiresAt,
    accountVersion: account.version
  };
}

export async function exchangeSession(request, env, nowMs = Date.now()) {
  const raw = String(request.headers.get("X-Token") || "").trim();
  if (!raw) throw new AccountAuthError("UNAUTHORIZED", "访问密钥无效");
  const configuredAdmin = String(env.ADMIN_TOKEN || "").trim();
  if (configuredAdmin && raw === configuredAdmin) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users(id,role,remark,state,created_at,expires_at,source,version) " +
      "VALUES (?,?,?,'active',?,NULL,'admin',1)"
    ).bind(ADMIN_USER_ID, "admin", "管理员", nowMs).run();
    const account = await getAccount(env.DB, ADMIN_USER_ID);
    if (account?.role !== "admin") throw new AccountAuthError("SERVICE_UNAVAILABLE", "管理员身份初始化失败");
    const monitorSession = randomCredential();
    const tokenHash = await hashAccessKey(monitorSession);
    const adminTokenHash = await hashAccessKey(configuredAdmin);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM admin_monitor_sessions WHERE expires_at<=? OR admin_token_hash!=?")
        .bind(nowMs, adminTokenHash),
      env.DB.prepare(
        "INSERT INTO admin_monitor_sessions(token_hash,user_id,expires_at,admin_token_hash,created_at) VALUES (?,?,?,?,?)"
      ).bind(tokenHash, ADMIN_USER_ID, nowMs + ADMIN_SESSION_MS, adminTokenHash, nowMs)
    ]);
    return { account: publicAccount(account, nowMs), monitorSession };
  }
  const account = await getAccountByKey(env.DB, raw);
  if (!account || accountStatus(account, nowMs) === "revoked") {
    throw new AccountAuthError("UNAUTHORIZED", "访问密钥无效");
  }
  return { account: publicAccount(account, nowMs) };
}
