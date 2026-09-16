import { requireBusinessAccess } from "../common/business.js";
import {
  accountPrincipal, ensureAdminAccount, publicAccount, serviceNow
} from "../maoyan/auth.js";
import { accountStatus, getAccount, getAccountByKey, hashAccessKey } from "../maoyan/accounts.js";
import { renewAccount } from "../maoyan/enrollment-store.js";

const STORE_BUSINESS = "store";
const SESSION_MS = 24 * 60 * 60 * 1000;

class StoreAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new StoreAuthError(code, message);
}

function randomSession() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request) {
  const cookies = String(request.headers.get("Cookie") || "").split(";");
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === "store_session") return value.join("=");
  }
  return "";
}

function sessionCookie(value, url, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `store_session=${value}; HttpOnly; SameSite=Lax; Path=/store/; Max-Age=${maxAge}${secure}`;
}

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

export function requireStoreSameOrigin(request, url) {
  const origin = String(request.headers.get("Origin") || "");
  const fetchSite = String(request.headers.get("Sec-Fetch-Site") || "").toLowerCase();
  if ((origin && origin !== url.origin) || fetchSite === "cross-site") {
    fail("FORBIDDEN", "请求来源无效");
  }
}

export function storeErrorResponse(error) {
  const code = error?.code || "INTERNAL_ERROR";
  const status = code === "UNAUTHORIZED" ? 401
    : code === "ACCOUNT_NOT_FOUND" ? 404
      : code === "SERVICE_UNAVAILABLE" ? 503
        : code === "ACCOUNT_EXPIRED" || code === "ACCOUNT_SUSPENDED" || code === "ACCOUNT_REVOKED" || code === "FORBIDDEN" ? 403
          : ["CONFLICT", "REQUEST_CONFLICT", "VERSION_CONFLICT", "CONFIG_CONFLICT", "ACCOUNT_NOT_EXPIRED", "ACCOUNT_NOT_RENEWABLE", "CAPACITY_FULL", "FINGERPRINT_IN_USE"].includes(code) ? 409
            : code === "INVALID_REQUEST" ? 400 : 500;
  return response({ ok: false, code, error: error?.message || "服务暂时不可用" }, status);
}

async function jsonBody(request) {
  if (!String(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    fail("INVALID_REQUEST", "请求格式无效");
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object");
    return body;
  } catch (error) {
    if (error?.code) throw error;
    fail("INVALID_REQUEST", "请求格式无效");
  }
}

export async function authenticateStore(request, env, nowMs = Date.now()) {
  const raw = cookieValue(request);
  if (!raw) return null;
  const tokenHash = await hashAccessKey(raw);
  const row = await env.DB.prepare(
    "SELECT user_id,business_line,expires_at,admin_token_hash FROM store_sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, nowMs).first();
  if (!row) return null;
  if (row.admin_token_hash) {
    const currentAdminHash = await hashAccessKey(String(env.ADMIN_TOKEN || ""));
    if (row.admin_token_hash !== currentAdminHash) return null;
  }
  const account = await getAccount(env.DB, row.user_id);
  if (!account || accountStatus(account, nowMs) === "revoked") return null;
  return accountPrincipal(account, "store_session", nowMs);
}

async function storeLogin(request, env, url) {
  requireStoreSameOrigin(request, url);
  const body = await jsonBody(request);
  const raw = String(body.key ?? body.token ?? body.accessKey ?? "").trim();
  if (!raw) fail("UNAUTHORIZED", "访问密钥无效");
  const nowMs = serviceNow(env);
  const configuredAdmin = String(env.ADMIN_TOKEN || "").trim();
  let account;
  let adminTokenHash = null;
  if (configuredAdmin && raw === configuredAdmin) {
    account = await ensureAdminAccount(env, nowMs);
    adminTokenHash = await hashAccessKey(configuredAdmin);
  } else {
    account = await getAccountByKey(env.DB, raw);
    if (!account || accountStatus(account, nowMs) === "revoked") fail("UNAUTHORIZED", "访问密钥无效");
  }
  requireBusinessAccess(accountPrincipal(account, "access_key", nowMs), STORE_BUSINESS);
  const secret = randomSession();
  const tokenHash = await hashAccessKey(secret);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM store_sessions WHERE expires_at<=? OR (admin_token_hash IS NOT NULL AND admin_token_hash!=?)")
      .bind(nowMs, await hashAccessKey(String(env.ADMIN_TOKEN || ""))),
    env.DB.prepare(
      "INSERT INTO store_sessions(token_hash,business_line,user_id,expires_at,admin_token_hash,created_at) VALUES (?,?,?,?,?,?)"
    ).bind(tokenHash, STORE_BUSINESS, account.id, nowMs + SESSION_MS, adminTokenHash, nowMs)
  ]);
  return response({ ok: true, account: publicAccount(account, nowMs) }, 200, {
    "Set-Cookie": sessionCookie(secret, url, SESSION_MS / 1000)
  });
}

async function storePrincipal(request, env, nowMs) {
  const principal = await authenticateStore(request, env, nowMs);
  if (!principal) fail("UNAUTHORIZED", "登录状态无效");
  requireBusinessAccess(principal, STORE_BUSINESS);
  return principal;
}

export async function handleStoreAuth(request, env, url) {
  if (!url.pathname.startsWith("/store/auth/")) return null;
  const nowMs = serviceNow(env);
  if (url.pathname === "/store/auth/session" && request.method === "POST") {
    return await storeLogin(request, env, url);
  }
  if (url.pathname === "/store/auth/session" && request.method === "GET") {
    const principal = await storePrincipal(request, env, nowMs);
    return response({ ok: true, account: publicAccount(await getAccount(env.DB, principal.userId), nowMs) });
  }
  if (url.pathname === "/store/auth/logout" && request.method === "POST") {
    requireStoreSameOrigin(request, url);
    await storePrincipal(request, env, nowMs);
    await env.DB.prepare("DELETE FROM store_sessions WHERE token_hash=?")
      .bind(await hashAccessKey(cookieValue(request))).run();
    return response({ ok: true }, 200, { "Set-Cookie": sessionCookie("", url, 0) });
  }
  if (url.pathname === "/store/auth/renew" && request.method === "POST") {
    requireStoreSameOrigin(request, url);
    const principal = await storePrincipal(request, env, nowMs);
    const body = await jsonBody(request);
    if (principal.role !== "user") fail("FORBIDDEN", "管理员账号无需续期");
    const result = await renewAccount(env, {
      userId: principal.userId,
      requestId: body.requestId,
      expectedVersion: body.expectedVersion,
      nowMs
    });
    return response({ ok: true, account: publicAccount(result.account, nowMs), replayed: result.replayed === true });
  }
  return null;
}

export async function requireActiveStoreAccount(request, env, nowMs = Date.now()) {
  const principal = await storePrincipal(request, env, nowMs);
  const account = await getAccount(env.DB, principal.userId);
  if (accountStatus(account, nowMs) !== "active") {
    const code = accountStatus(account, nowMs) === "expired" ? "ACCOUNT_EXPIRED" : "ACCOUNT_SUSPENDED";
    fail(code, code === "ACCOUNT_EXPIRED" ? "账号已到期，请先续期" : "账号已暂停");
  }
  return principal;
}
