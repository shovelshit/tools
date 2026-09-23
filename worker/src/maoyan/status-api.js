import * as db from "./db.js";
import { json } from "../common/http.js";
import { describeCrons, isMinuteStepCrons, minBatchMinutes, resolveCronExprs } from "./cron.js";
import { readBusinessPolicy } from "./business-policy-store.js";
import { formatMonitorWindowLabel } from "./business-time.js";

function lockSummary(data) {
  if (!data) return null;
  try {
    const rule = JSON.parse(data);
    return {
      id: rule.id || null,
      state: rule.state || null,
      updatedAt: rule.updatedAt || null,
      targetDate: rule.targetDate || null,
      movieName: rule.movieName || null
    };
  } catch {
    return null;
  }
}

export async function readStatusSummary(env, principal) {
  const row = await env.DB.prepare(
    "SELECT s.data AS status_data,s.changes_version,c.data AS config_data,l.data AS lock_data " +
    "FROM users u LEFT JOIN monitor_status s ON s.token_id=u.id " +
    "LEFT JOIN user_config c ON c.token_id=u.id LEFT JOIN lock_rule l ON l.token_id=u.id WHERE u.id=?"
  ).bind(principal.userId).first();
  let status = {};
  let config = {};
  try { status = JSON.parse(row?.status_data || "{}"); } catch {}
  try { config = JSON.parse(row?.config_data || "{}"); } catch {}
  const [cronExprs, policy] = await Promise.all([resolveCronExprs(env), readBusinessPolicy(env.DB)]);
  return {
    account: {
      userId: principal.userId,
      role: principal.role,
      accountStatus: principal.accountStatus,
      expiresAt: principal.expiresAt,
      accountVersion: principal.accountVersion
    },
    status: {
      lastCheckTs: status.lastCheckTs,
      lastCheck: status.lastCheck,
      lastError: status.lastError || null,
      cinemaName: status.cinemaName,
      newTotal: status.newTotal,
      enabled: config.enabled === true
    },
    changesVersion: Number(row?.changes_version || 0),
    lockSummary: lockSummary(row?.lock_data),
    lockServiceEnabled: String(env.LOCK_SERVICE_ENABLED) === "true",
    pollAfterSeconds: config.enabled === true ? 180 : null,
    cronMinutes: minBatchMinutes(cronExprs),
    cronExprs,
    cronText: describeCrons(cronExprs) + " · " + formatMonitorWindowLabel(policy),
    cronMinuteStep: isMinuteStepCrons(cronExprs)
  };
}

function cursor(value, name, { zero = false } = {}) {
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(String(value))) {
    const error = new Error(`${name} 无效`);
    error.code = "INVALID_REQUEST";
    throw error;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (zero ? parsed < 0 : parsed < 1)) {
    const error = new Error(`${name} 无效`);
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return parsed;
}

export async function handleStatusApi(request, env, url, principal) {
  if (request.method === "GET" && url.pathname === "/api/status" && url.searchParams.get("view") === "summary") {
    return json({ ok: true, ...await readStatusSummary(env, principal) }, 200, { "Cache-Control": "no-store" });
  }
  if (request.method === "GET" && url.pathname === "/api/changes") {
    const afterId = cursor(url.searchParams.get("after_id"), "after_id", { zero: true });
    const beforeId = cursor(url.searchParams.get("before_id"), "before_id");
    if (afterId != null && beforeId != null) {
      const error = new Error("after_id 与 before_id 不能同时使用");
      error.code = "INVALID_REQUEST";
      throw error;
    }
    const limit = cursor(url.searchParams.get("limit") || "20", "limit");
    return json({ ok: true, ...await db.listChangesAfter(env.DB, principal.userId, { afterId, beforeId, limit }) }, 200, { "Cache-Control": "no-store" });
  }
  return null;
}
