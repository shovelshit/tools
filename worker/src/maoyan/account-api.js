import { json } from "../common/http.js";
import { accountStatus, getAccount } from "./accounts.js";
import { exchangeSession, publicAccount, serviceNow } from "./auth.js";
import { createManagedAccount, readCapacity, readServiceSettings, renewAccount, updateManagedAccount, updateServiceSettings } from "./enrollment-store.js";
import { resumeAfterRenewal } from "./account-lifecycle.js";
import { readResourceSummary } from "./resource-budget.js";
import { getReleaseDownloads } from "./releases.js";

export async function handlePublicAccountApi(request, env, url) {
  if (url.pathname === "/api/releases" && request.method === "GET") {
    return json({ ok: true, ...await getReleaseDownloads(env) }, 200, { "Cache-Control": "public, max-age=300" });
  }
  if (url.pathname === "/api/capabilities" && request.method === "GET") {
    return json({ ok: true, accountLifecycle: true, adminMonitorSession: true }, 200, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/auth/session" && request.method === "POST") {
    return json({ ok: true, ...await exchangeSession(request, env, serviceNow(env)) }, 200, { "Cache-Control": "no-store" });
  }
  return null;
}

export async function handleAccountApi(request, env, url, principal) {
  const nowMs = serviceNow(env);
  if (url.pathname === "/api/account" && request.method === "GET") {
    return json({ ok: true, account: publicAccount(await getAccount(env.DB, principal.userId), nowMs) }, 200, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/account/renew" && request.method === "POST") {
    if (principal.role !== "user") return json({ ok: false, code: "FORBIDDEN", error: "管理员账号无需续期" }, 403);
    const body = await request.json().catch(() => ({}));
    const result = await renewAccount(env, {
      userId: principal.userId,
      requestId: body.requestId,
      expectedVersion: body.expectedVersion,
      nowMs
    });
    const resume = await resumeAfterRenewal(env, principal.userId, result.account.version, nowMs);
    return json({ ok: true, account: publicAccount(result.account, nowMs), replayed: result.replayed === true, resume });
  }
  return null;
}

function adminAccount(row, nowMs) {
  let config = {};
  let status = {};
  try { config = JSON.parse(row.config_data || "{}"); } catch {}
  try { status = JSON.parse(row.status_data || "{}"); } catch {}
  const account = {
    id: row.id,
    role: row.role,
    remark: row.remark || "",
    state: row.state,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    source: row.source,
    businessLine: row.business_line || "maoyan",
    version: Number(row.version)
  };
  return {
    userId: account.id,
    remark: account.remark,
    state: account.state,
    accountStatus: accountStatus(account, nowMs),
    createdAt: account.createdAt,
    expiresAt: account.expiresAt,
    archivedAt: account.archivedAt,
    source: account.source,
    businessLine: account.businessLine,
    accountVersion: account.version,
    keyHint: `${row.key_prefix || ""}...${row.key_suffix || ""}`,
    monitorState: account.businessLine === "maoyan" ? (config.enabled === true ? "monitoring" : "stopped") : null,
    lastActivityAt: account.businessLine === "maoyan" ? (status.lastCheck || null) : null
  };
}

export async function listAdminAccounts(env, url, nowMs) {
  const businessLine = String(url.searchParams.get("businessLine") || "maoyan").trim();
  const statusFilter = String(url.searchParams.get("status") || "").trim();
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const after = String(url.searchParams.get("after") || "").trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const { results } = await env.DB.prepare(
    "SELECT u.id,u.role,u.remark,u.state,u.created_at,u.expires_at,u.archived_at,u.source,u.business_line,u.version," +
    "k.key_prefix,k.key_suffix,c.data AS config_data,s.data AS status_data " +
    "FROM users u LEFT JOIN access_keys k ON k.user_id=u.id " +
    "LEFT JOIN user_config c ON c.token_id=u.id LEFT JOIN monitor_status s ON s.token_id=u.id " +
    "WHERE u.role='user' AND u.business_line=? ORDER BY u.created_at DESC,u.id DESC"
  ).bind(businessLine).all();
  let accounts = results.map((row) => adminAccount(row, nowMs));
  if (statusFilter) accounts = accounts.filter((account) => account.accountStatus === statusFilter);
  if (query) accounts = accounts.filter((account) =>
    account.userId.toLowerCase().includes(query) || account.remark.toLowerCase().includes(query));
  if (after) {
    const index = accounts.findIndex((account) => account.userId === after);
    accounts = index >= 0 ? accounts.slice(index + 1) : [];
  }
  const page = accounts.slice(0, limit);
  return {
    accounts: page,
    nextAfter: accounts.length > limit ? page.at(-1)?.userId || null : null,
    capacity: await readCapacity(env.DB, nowMs, businessLine)
  };
}

export async function handleAdminAccountApi(request, env, url) {
  const nowMs = serviceNow(env);
  if (url.pathname === "/api/admin/resources" && request.method === "GET") {
    return json({ ok: true, resources: await readResourceSummary(env, nowMs) }, 200, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/admin/accounts" && request.method === "GET") {
    return json({ ok: true, ...await listAdminAccounts(env, url, nowMs) }, 200, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/admin/accounts/create" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const result = await createManagedAccount(env, {
      remark: body.remark,
      requestId: body.requestId,
      businessLine: body.businessLine,
      nowMs
    });
    return json({
      ok: true,
      account: publicAccount(result.account, nowMs),
      replayed: result.replayed === true,
      ...(result.key ? { key: result.key } : {})
    }, result.replayed ? 200 : 201, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/admin/accounts/update" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
    const allowed = new Set(["remark", "state", "expiresAt"]);
    if (Object.keys(patch).some((key) => !allowed.has(key))) {
      const error = new Error("账号修改字段无效");
      error.code = "INVALID_REQUEST";
      throw error;
    }
    if (patch.expiresAt !== undefined && !Number.isFinite(Number(patch.expiresAt))) {
      const error = new Error("到期时间无效");
      error.code = "INVALID_REQUEST";
      throw error;
    }
    const account = await updateManagedAccount(env, {
      userId: body.id,
      expectedVersion: body.expectedVersion,
      patch,
      nowMs
    });
    return json({ ok: true, account: publicAccount(account, nowMs) });
  }
  if (url.pathname === "/api/admin/settings" && request.method === "GET") {
    return json({
      ok: true,
      settings: await readServiceSettings(env.DB, url.searchParams.get("businessLine") || "maoyan")
    }, 200, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/admin/settings" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, settings: await updateServiceSettings(env, { ...body, nowMs }) });
  }
  return null;
}

export function accountErrorResponse(error) {
  const code = error?.code || "INTERNAL_ERROR";
  const status = code === "UNAUTHORIZED" ? 401
    : code === "ACCOUNT_NOT_FOUND" ? 404
      : code === "SERVICE_UNAVAILABLE" ? 503
      : code === "ACCOUNT_EXPIRED" || code === "ACCOUNT_SUSPENDED" || code === "ACCOUNT_REVOKED" || code === "FORBIDDEN" ? 403
        : ["CONFLICT", "REQUEST_CONFLICT", "VERSION_CONFLICT", "CONFIG_CONFLICT", "ACCOUNT_NOT_EXPIRED", "ACCOUNT_NOT_RENEWABLE", "CAPACITY_FULL", "FINGERPRINT_IN_USE"].includes(code) ? 409
          : code === "INVALID_REQUEST" ? 400 : 500;
  return json({ ok: false, code, error: error?.message || "服务暂时不可用" }, status, { "Cache-Control": "no-store" });
}
