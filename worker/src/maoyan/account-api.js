import { json } from "../common/http.js";
import { getAccount } from "./accounts.js";
import { exchangeSession, publicAccount, serviceNow } from "./auth.js";
import { renewAccount } from "./enrollment-store.js";
import { resumeAfterRenewal } from "./account-lifecycle.js";

export async function handlePublicAccountApi(request, env, url) {
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

export function accountErrorResponse(error) {
  const code = error?.code || "INTERNAL_ERROR";
  const status = code === "UNAUTHORIZED" ? 401
    : code === "ACCOUNT_NOT_FOUND" ? 404
      : code === "SERVICE_UNAVAILABLE" ? 503
      : code === "ACCOUNT_EXPIRED" || code === "ACCOUNT_SUSPENDED" || code === "ACCOUNT_REVOKED" || code === "FORBIDDEN" ? 403
        : ["CONFLICT", "REQUEST_CONFLICT", "VERSION_CONFLICT", "ACCOUNT_NOT_EXPIRED", "ACCOUNT_NOT_RENEWABLE", "CAPACITY_FULL"].includes(code) ? 409
          : code === "INVALID_REQUEST" ? 400 : 500;
  return json({ ok: false, code, error: error?.message || "服务暂时不可用" }, status);
}
