const COOLDOWN_MS = 30_000;

export function evaluateBudget({ used, limit, reserveRatio = 0.3 }) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return { ratio: null, admissionAllowed: false };
  }
  const ratio = used / limit;
  return { ratio, admissionAllowed: ratio < 1 - reserveRatio };
}

function configuredUsage(env) {
  try {
    const parsed = JSON.parse(String(env.RESOURCE_USAGE_JSON || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function usageItem(input) {
  const used = Number(input?.used);
  const limit = Number(input?.limit);
  const evaluated = evaluateBudget({ used, limit });
  return {
    used: Number.isFinite(used) ? used : null,
    limit: Number.isFinite(limit) ? limit : null,
    ratio: evaluated.ratio,
    admissionAllowed: evaluated.admissionAllowed,
    measured: Number.isFinite(used) && Number.isFinite(limit)
  };
}

export async function readResourceSummary(env, nowMs = Date.now()) {
  const [capacity, cinemas, outbox, failed] = await Promise.all([
    env.DB.prepare(
      "SELECT s.max_users,(SELECT COUNT(*) FROM users u WHERE u.business_line='maoyan' AND u.role='user' AND u.state!='revoked' AND u.expires_at>?) + " +
      "(SELECT COUNT(*) FROM enrollment_reservations r WHERE r.expires_at>?) AS used FROM service_settings s WHERE s.id=1"
    ).bind(nowMs, nowMs).first(),
    env.DB.prepare(
      "SELECT COUNT(DISTINCT NULLIF(s.cinema_id,'')) AS n FROM monitor_subscriptions s " +
      "JOIN users u ON u.id=s.user_id WHERE s.enabled=1 AND u.role='user' AND u.business_line='maoyan' " +
      "AND u.state='active' AND u.archived_at IS NULL AND u.expires_at>?"
    ).bind(nowMs).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE u.business_line='maoyan' AND o.state IN ('pending','sending')").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE u.business_line='maoyan' AND o.state='failed'").first()
  ]);
  const raw = configuredUsage(env);
  const usage = {
    workerRequests: usageItem(raw.workerRequests),
    d1RowsRead: usageItem(raw.d1RowsRead),
    d1RowsWritten: usageItem(raw.d1RowsWritten),
    kvWrites: usageItem(raw.kvWrites),
    doRequests: usageItem(raw.doRequests)
  };
  const measured = Object.values(usage).filter((item) => item.measured);
  const explicitWarning = measured.some((item) => !item.admissionAllowed);
  return {
    window: "daily",
    measuredAt: nowMs,
    usage,
    activeCinemas: Number(cinemas?.n || 0),
    notificationPending: Number(outbox?.n || 0),
    notificationFailed: Number(failed?.n || 0),
    capacity: {
      used: Number(capacity?.used || 0),
      maxUsers: Number(capacity?.max_users || 0)
    },
    admissionAllowed: !explicitWarning,
    reason: explicitWarning ? "RESOURCE_EXHAUSTED" : null,
    estimates: {
      maxQueriesPerInvocation: 35,
      dispatcherCinemaPageSize: 20,
      statusPollSeconds: 180
    }
  };
}

export async function readAdminNotificationFailures(env) {
  const { results } = await env.DB.prepare(
    "SELECT o.kind,o.state,o.attempts,o.last_error,o.failure_detail,o.next_attempt_at,o.lease_until " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line='maoyan' AND (o.state='failed' OR o.last_error IS NOT NULL OR o.failure_detail IS NOT NULL) " +
    "ORDER BY o.updated_at DESC,o.id DESC LIMIT 5"
  ).all();
  return (results || []).map((row) => ({
    kind: String(row.kind), state: String(row.state), attempts: Number(row.attempts || 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    failureDetail: row.failure_detail == null ? null : String(row.failure_detail),
    retryEligible: row.state === "pending" && row.next_attempt_at != null || row.state === "sending"
  }));
}

export async function allowManualOperation(storage, { userId, cinemaId = "", kind, nowMs = Date.now() }) {
  const safeKind = String(kind || "");
  if (!new Set(["check", "test-push"]).has(safeKind)) throw new Error("manual operation kind invalid");
  const key = `manual:${safeKind}:${String(userId)}:${safeKind === "check" ? String(cinemaId) : ""}`;
  const evaluate = async (store) => {
    const previous = Number(await store.get(key) || 0);
    const remaining = previous + COOLDOWN_MS - Number(nowMs);
    if (remaining > 0) return { allowed: false, retryAfterSeconds: Math.ceil(remaining / 1000) };
    await store.put(key, Number(nowMs));
    return { allowed: true, retryAfterSeconds: 0 };
  };
  return typeof storage.transaction === "function" ? await storage.transaction(evaluate) : await evaluate(storage);
}
