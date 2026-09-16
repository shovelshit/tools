import { accountStatus } from "./accounts.js";
import { getAccount } from "./accounts.js";
import * as db from "./db.js";
import { getLockSessionStatus } from "./lock-session.js";
import { isNotificationVerified } from "./notify.js";
import { getUserConfig, userKey } from "./user.js";
import { runCheck } from "./check.js";
import { prepareAccountCleanupThroughCoordinator, runScheduledLockAfterMonitor } from "./lock-runner.js";
import { inMonitorWindow } from "./cron.js";

const SHANGHAI_OFFSET = "+08:00";
const MATCH_WINDOW_MS = 30 * 60 * 1000;

function hasConfiguredMovies(config) {
  return Array.isArray(config?.selectedMovieIds) && config.selectedMovieIds.length > 0;
}

export function getRuleDeadlineAt(rule) {
  if (!rule || typeof rule !== "object") return null;
  const derived = Date.parse(`${String(rule.targetDate || "")}T${String(rule.templateTime || "")}:00${SHANGHAI_OFFSET}`);
  if (Number.isFinite(derived)) return derived + MATCH_WINDOW_MS;
  const stored = Number(rule.targetDeadlineAt);
  return Number.isFinite(stored) ? stored : null;
}

export function resumeEligibility({ account, config, rule, sessionUsable, nowMs = Date.now() }) {
  const reasons = [];
  const active = accountStatus(account, nowMs) === "active";
  if (!active) reasons.push("account_inactive");
  if (config?.enabled !== true || config?.stopReason === "manual") reasons.push("monitor_stopped");
  if (config?.notifyVerified !== true) reasons.push("notification_unverified");
  if (!String(config?.cinemaId || "").trim() || !hasConfiguredMovies(config)) reasons.push("monitor_unconfigured");
  if (!sessionUsable) reasons.push("session_unavailable");

  const monitorReady = active && config?.enabled === true && config?.stopReason !== "manual" &&
    config?.notifyVerified === true && String(config?.cinemaId || "").trim() && hasConfiguredMovies(config);
  const waiting = rule?.state === "waiting_schedule";
  if (rule && !waiting) reasons.push("rule_not_waiting");
  const deadline = getRuleDeadlineAt(rule);
  const deadlineValid = deadline !== null && Number.isFinite(deadline) && nowMs < deadline;
  if (waiting && !deadlineValid) reasons.push("rule_expired");

  return {
    monitor: Boolean(monitorReady),
    lock: Boolean(monitorReady && sessionUsable && waiting && deadlineValid),
    reasons
  };
}

export async function resumeAfterRenewal(env, userId, accountVersion, nowMs = Date.now()) {
  const account = await getAccount(env.DB, userId);
  if (!account || account.version !== Number(accountVersion)) {
    return { monitor: false, lock: false, reasons: ["account_changed"] };
  }
  const config = await getUserConfig(env, userId);
  const notifyVerified = await isNotificationVerified(config);
  const rule = await db.getLockRuleRow(env.DB, userId);
  let sessionUsable = false;
  try {
    sessionUsable = (await getLockSessionStatus(env, userId)).uploaded === true;
  } catch {
    sessionUsable = false;
  }
  const result = resumeEligibility({
    account,
    config: { ...config, notifyVerified },
    rule,
    sessionUsable,
    nowMs
  });
  if (result.monitor && inMonitorWindow(nowMs)) {
    try {
      await runCheck(env, false, userId, {
        afterPersist: result.lock
          ? (cinemaData) => runScheduledLockAfterMonitor(env, userId, cinemaData)
          : undefined
      });
    } catch {
      result.reasons.push("immediate_check_failed");
    }
  }
  await env.DB.prepare(
    "INSERT INTO audit_events(event_type,actor_user_id,subject_user_id,data,created_at) VALUES ('account_resume_evaluated',?,?,?,?)"
  ).bind(userId, userId, JSON.stringify(result), nowMs).run();
  return result;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function cleanupExpiredAccount(env, {
  userId,
  expectedExpiresAt,
  expectedVersion,
  nowMs = Date.now()
}) {
  if (!Number.isFinite(Number(expectedExpiresAt)) || nowMs < Number(expectedExpiresAt) + RETENTION_MS) return { cleaned: false };
  if (env.LOCK_COORDINATOR) await prepareAccountCleanupThroughCoordinator(env, userId);
  const session = await db.getSessionVersion(env.DB, userId);
  const requestId = `expiry-cleanup:${userId}:${expectedVersion}:${expectedExpiresAt}`;
  const statements = [
    env.DB.prepare(
      "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
      "SELECT 1 FROM users WHERE id=? AND role='user' AND state='active' AND version=? " +
      "AND expires_at=? AND archived_at IS NULL AND expires_at+?<=?) THEN 1 ELSE 0 END)"
    ).bind(requestId, userId, expectedVersion, expectedExpiresAt, RETENTION_MS, nowMs),
    env.DB.prepare(
      "UPDATE users SET archived_at=?,archive_reason='expired_retention',version=version+1 " +
      "WHERE id=? AND version=? AND expires_at=?"
    ).bind(nowMs, userId, expectedVersion, expectedExpiresAt),
    env.DB.prepare("DELETE FROM monitor_status WHERE token_id=?").bind(userId),
    env.DB.prepare("DELETE FROM monitor_snapshot WHERE token_id=?").bind(userId),
    env.DB.prepare("DELETE FROM monitor_subscriptions WHERE user_id=?").bind(userId),
    env.DB.prepare("DELETE FROM notification_outbox WHERE user_id=?").bind(userId),
    env.DB.prepare("DELETE FROM change_log WHERE token_id=?").bind(userId),
    env.DB.prepare("DELETE FROM lock_rule WHERE token_id=?").bind(userId)
  ];
  if (session) {
    statements.push(env.DB.prepare(
      "UPDATE session_versions SET active=0,updated_at=? WHERE user_id=? AND active_version=? AND active=1"
    ).bind(nowMs, userId, session.activeVersion));
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO audit_events(event_type,subject_user_id,data,created_at) VALUES ('account_expired_archived',?,?,?)"
    ).bind(userId, JSON.stringify({ expiresAt: Number(expectedExpiresAt) }), nowMs),
    env.DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId)
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/mutation_guards\.ok|CHECK constraint failed: ok = 1/.test(String(error?.message || error))) return { cleaned: false };
    throw error;
  }
  if (session) {
    await env.MAOYAN_KV.delete(userKey(userId, `maoyan-session:v${session.activeVersion}`));
    await env.DB.prepare(
      "DELETE FROM session_versions WHERE user_id=? AND active_version=? AND active=0"
    ).bind(userId, session.activeVersion).run();
  }
  await env.MAOYAN_KV.delete(userKey(userId, "maoyan-session"));
  return { cleaned: true };
}
