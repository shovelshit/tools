import { businessTime } from "./business-time.js";
import { readBusinessPolicy } from "./business-policy-store.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 20;
const ACTIVE_USER_WHERE = "u.role='user' AND u.business_line=? AND u.state='active' AND u.archived_at IS NULL AND u.expires_at>?";

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_REQUEST";
  return error;
}

function safeJson(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function clampText(value, max = 2048) {
  const text = textOrNull(value);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cinemaNameFrom(data) {
  return textOrNull(data?.showData?.cinemaName);
}

function lockTerminalState(eventKey) {
  const text = String(eventKey || "");
  if (text.startsWith("lock:") && text.endsWith(":locked")) return "locked";
  if (text.startsWith("lock:") && text.endsWith(":failed")) return "failed";
  if (text.startsWith("lock:") && text.endsWith(":expired")) return "expired";
  if (text.startsWith("lock:") && text.endsWith(":completed")) return "completed";
  if (text.startsWith("lock:") && text.endsWith(":cancelled")) return "cancelled";
  if (text.startsWith("lock:") && text.endsWith(":unknown")) return "unknown";
  return null;
}

function payloadSummary(payloadText) {
  const payload = safeJson(payloadText);
  return {
    title: textOrNull(payload?.title),
    content: clampText(payload?.content, 1000),
    meta: payload?.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta) ? payload.meta : null
  };
}

async function all(DB, sql, ...params) {
  return (await DB.prepare(sql).bind(...params).all()).results || [];
}

async function first(DB, sql, ...params) {
  return await DB.prepare(sql).bind(...params).first();
}

function assertDashboardQuery({ businessLine, window }) {
  if (businessLine !== "maoyan") throw invalid("Dashboard 暂仅支持 maoyan 业务线");
  if (window !== "24h") throw invalid("Dashboard 暂仅支持 24h 窗口");
}

async function readSummary(DB, businessLine, nowMs, windowStart) {
  const active = await first(DB, `SELECT COUNT(*) AS n FROM users u WHERE ${ACTIVE_USER_WHERE}`, businessLine, nowMs);
  const monitoring = await first(DB,
    `SELECT COUNT(*) AS users,COUNT(DISTINCT NULLIF(s.cinema_id,'')) AS cinemas ` +
    `FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id WHERE ${ACTIVE_USER_WHERE} AND s.enabled=1`,
    businessLine, nowMs
  );
  const completed = await first(DB,
    "SELECT SUM(CASE WHEN o.state='sent' THEN 1 ELSE 0 END) AS sent," +
    "COUNT(*) AS total FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line=? AND o.created_at>=? AND o.state IN ('sent','failed')",
    businessLine, windowStart
  );
  const lock = await first(DB,
    "SELECT SUM(CASE WHEN o.event_key LIKE 'lock:%:locked' THEN 1 ELSE 0 END) AS locked," +
    "SUM(CASE WHEN o.event_key LIKE 'lock:%:failed' THEN 1 ELSE 0 END) AS failed " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line=? AND o.kind='lock-terminal' AND o.created_at>=?",
    businessLine, windowStart
  );
  const total = Number(completed?.total || 0);
  const sent = Number(completed?.sent || 0);
  return {
    activeUsers: Number(active?.n || 0),
    monitoringUsers: Number(monitoring?.users || 0),
    activeCinemas: Number(monitoring?.cinemas || 0),
    notificationSuccessRate: total > 0 ? Number((sent / total).toFixed(4)) : null,
    lockSuccess: Number(lock?.locked || 0),
    lockFailed: Number(lock?.failed || 0)
  };
}

async function readLatestNotificationByUser(DB, businessLine, nowMs) {
  const rows = await all(DB,
    "SELECT o.user_id,o.state,o.kind,o.last_error,o.failure_detail,o.created_at " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    `WHERE ${ACTIVE_USER_WHERE} AND o.id IN (` +
    "SELECT MAX(o2.id) FROM notification_outbox o2 GROUP BY o2.user_id" +
    ")",
    businessLine, nowMs
  );
  return new Map(rows.map((row) => [String(row.user_id), {
    state: row.state,
    kind: row.kind,
    lastError: clampText(row.last_error),
    failureDetail: clampText(row.failure_detail),
    createdAt: numberOrNull(row.created_at)
  }]));
}

async function readUsers(DB, businessLine, nowMs) {
  const notifications = await readLatestNotificationByUser(DB, businessLine, nowMs);
  const rows = await all(DB,
    "SELECT u.id,u.remark,u.state,u.expires_at,s.cinema_id,s.enabled,s.next_due_at," +
    "ms.data AS status_data,lr.data AS lock_data " +
    "FROM users u LEFT JOIN monitor_subscriptions s ON s.user_id=u.id " +
    "LEFT JOIN monitor_status ms ON ms.token_id=u.id LEFT JOIN lock_rule lr ON lr.token_id=u.id " +
    `WHERE ${ACTIVE_USER_WHERE} ORDER BY s.enabled DESC,u.created_at DESC,u.id DESC LIMIT 100`,
    businessLine, nowMs
  );
  return rows.map((row) => {
    const status = safeJson(row.status_data);
    const lock = safeJson(row.lock_data);
    const notification = notifications.get(String(row.id)) || null;
    return {
      userId: String(row.id),
      remark: String(row.remark || ""),
      accountStatus: "active",
      expiresAt: numberOrNull(row.expires_at),
      cinemaId: textOrNull(row.cinema_id),
      cinemaName: textOrNull(status?.cinemaName) || textOrNull(lock?.cinemaName) || textOrNull(row.cinema_id),
      monitorState: Number(row.enabled || 0) === 1 ? "monitoring" : "stopped",
      lastCheck: textOrNull(status?.lastCheck),
      lastCheckTs: numberOrNull(status?.lastCheckTs),
      nextDueAt: numberOrNull(row.next_due_at),
      lockState: textOrNull(lock?.state),
      lockMovie: textOrNull(lock?.movieName),
      lockHall: textOrNull(lock?.hall),
      orderId: textOrNull(lock?.orderId),
      lastError: clampText(lock?.lastError),
      lastNotification: notification
    };
  });
}

async function readCinemaNames(DB) {
  const rows = await all(DB,
    "SELECT b.cinema_id,b.public_data,b.captured_at FROM cinema_batches b " +
    "JOIN (SELECT cinema_id,MAX(captured_at) AS captured_at FROM cinema_batches GROUP BY cinema_id) latest " +
    "ON latest.cinema_id=b.cinema_id AND latest.captured_at=b.captured_at"
  );
  return new Map(rows.map((row) => [
    String(row.cinema_id),
    { name: cinemaNameFrom(safeJson(row.public_data)), latestBatchAt: numberOrNull(row.captured_at) }
  ]));
}

async function readCinemas(DB, businessLine, nowMs, windowStart) {
  const names = await readCinemaNames(DB);
  const subscriptions = await all(DB,
    "SELECT s.cinema_id,COUNT(*) AS user_count,MIN(s.next_due_at) AS next_due_at " +
    "FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id " +
    `WHERE ${ACTIVE_USER_WHERE} AND s.enabled=1 AND s.cinema_id<>'' ` +
    "GROUP BY s.cinema_id ORDER BY user_count DESC,s.cinema_id LIMIT 20",
    businessLine, nowMs
  );
  const events = new Map((await all(DB,
    "SELECT cinema_id,COUNT(*) AS n FROM cinema_events WHERE created_at>=? GROUP BY cinema_id",
    windowStart
  )).map((row) => [String(row.cinema_id), Number(row.n || 0)]));
  const notifications = new Map((await all(DB,
    "SELECT s.cinema_id,COUNT(o.id) AS n FROM notification_outbox o " +
    "JOIN users u ON u.id=o.user_id JOIN monitor_subscriptions s ON s.user_id=u.id " +
    `WHERE ${ACTIVE_USER_WHERE} AND s.enabled=1 AND o.created_at>=? ` +
    "GROUP BY s.cinema_id",
    businessLine, nowMs, windowStart
  )).map((row) => [String(row.cinema_id), Number(row.n || 0)]));
  const locks = new Map((await all(DB,
    "SELECT s.cinema_id AS cinema_id," +
    "SUM(CASE WHEN o.event_key LIKE 'lock:%:locked' THEN 1 ELSE 0 END) AS locked," +
    "SUM(CASE WHEN o.event_key LIKE 'lock:%:failed' THEN 1 ELSE 0 END) AS failed " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "LEFT JOIN monitor_subscriptions s ON s.user_id=u.id " +
    `WHERE ${ACTIVE_USER_WHERE} AND o.kind='lock-terminal' AND o.created_at>=? ` +
    "GROUP BY cinema_id",
    businessLine, nowMs, windowStart
  )).filter((row) => row.cinema_id).map((row) => [String(row.cinema_id), {
    locked: Number(row.locked || 0),
    failed: Number(row.failed || 0)
  }]));
  return subscriptions.map((row) => {
    const cinemaId = String(row.cinema_id);
    const latest = names.get(cinemaId) || {};
    const lock = locks.get(cinemaId) || {};
    return {
      cinemaId,
      cinemaName: latest.name || cinemaId,
      monitoringUsers: Number(row.user_count || 0),
      newShows: events.get(cinemaId) || 0,
      notifications: notifications.get(cinemaId) || 0,
      lockSuccess: Number(lock.locked || 0),
      lockFailed: Number(lock.failed || 0),
      latestBatchAt: latest.latestBatchAt || null,
      nextDueAt: numberOrNull(row.next_due_at)
    };
  });
}

async function readNotifications(DB, businessLine, windowStart) {
  const counts = await first(DB,
    "SELECT SUM(CASE WHEN o.state='pending' THEN 1 ELSE 0 END) AS pending," +
    "SUM(CASE WHEN o.state='sending' THEN 1 ELSE 0 END) AS sending," +
    "SUM(CASE WHEN o.state='failed' AND o.created_at>=? THEN 1 ELSE 0 END) AS failed " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE u.business_line=?",
    windowStart, businessLine
  );
  const rows = await all(DB,
    "SELECT o.id,o.event_key,o.user_id,o.kind,o.payload,o.state,o.attempts,o.last_error,o.failure_detail," +
    "o.next_attempt_at,o.lease_until,o.created_at,o.updated_at,o.detected_at,o.first_attempt_at,o.sent_at,u.remark " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line=? AND o.created_at>=? " +
    "ORDER BY o.id DESC LIMIT ?",
    businessLine, windowStart, RECENT_LIMIT
  );
  const kinds = await all(DB,
    "SELECT o.kind," +
    "SUM(CASE WHEN o.state='pending' THEN 1 ELSE 0 END) AS pending," +
    "SUM(CASE WHEN o.state='sending' THEN 1 ELSE 0 END) AS sending," +
    "SUM(CASE WHEN o.state='failed' AND o.created_at>=? THEN 1 ELSE 0 END) AS failed," +
    "MIN(CASE WHEN o.state IN ('pending','sending') THEN o.created_at END) AS oldest_created_at " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE u.business_line=? GROUP BY o.kind",
    windowStart, businessLine
  );
  return {
    pending: Number(counts?.pending || 0),
    sending: Number(counts?.sending || 0),
    failed: Number(counts?.failed || 0),
    byKind: Object.fromEntries(kinds.map((row) => [row.kind, {
      pending: Number(row.pending || 0), sending: Number(row.sending || 0),
      failed: Number(row.failed || 0), oldestPendingAt: numberOrNull(row.oldest_created_at)
    }])),
    recent: rows.map((row) => ({
      id: Number(row.id),
      eventKey: String(row.event_key),
      userId: String(row.user_id),
      remark: String(row.remark || ""),
      kind: String(row.kind),
      state: String(row.state),
      attempts: Number(row.attempts || 0),
      lockState: lockTerminalState(row.event_key),
      lastError: clampText(row.last_error),
      failureDetail: clampText(row.failure_detail),
      nextAttemptAt: numberOrNull(row.next_attempt_at),
      leaseUntil: numberOrNull(row.lease_until),
      createdAt: numberOrNull(row.created_at),
      updatedAt: numberOrNull(row.updated_at),
      detectedAt: numberOrNull(row.detected_at),
      firstAttemptAt: numberOrNull(row.first_attempt_at),
      sentAt: numberOrNull(row.sent_at),
      discoveryToFirstAttemptMs: row.detected_at == null || row.first_attempt_at == null
        ? null : Math.max(0, Number(row.first_attempt_at) - Number(row.detected_at)),
      ...payloadSummary(row.payload)
    }))
  };
}

async function readMaintenanceHealth(DB, nowMs) {
  const policy = await readBusinessPolicy(DB);
  const localDate = businessTime(nowMs, policy).localDate;
  const [baseline, runs, verifications] = await Promise.all([
    first(DB,
      "SELECT data,created_at FROM audit_events WHERE event_type='maoyan_maintenance_observation_started' " +
      "ORDER BY id LIMIT 1"
    ),
    all(DB,
      "SELECT job_id,completed_at,updated_at FROM maoyan_maintenance_runs WHERE local_date=?",
      localDate
    ),
    all(DB,
      "SELECT request_id,data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' " +
      "AND request_id IN (?,?,?) ORDER BY id DESC",
      `reminder:${localDate}`, `archive:${localDate}`, `revocation:${localDate}`
    )
  ]);
  const runByJob = new Map(runs.map((row) => [row.job_id, row]));
  const verificationByJob = new Map();
  for (const row of verifications) {
    const jobId = row.request_id.split(":")[0];
    if (!verificationByJob.has(jobId)) verificationByJob.set(jobId, safeJson(row.data));
  }
  const observedAt = numberOrNull(baseline?.created_at);
  const endAt = Date.parse(`${localDate}T00:00:00Z`) - 8 * 60 * 60_000 + policy.maintenanceEndMinute * 60_000;
  const unobserved = observedAt == null || observedAt > endAt;
  return {
    localDate,
    observedAt,
    jobs: ["reminder", "archive", "revocation"].map((jobId) => {
      const run = runByJob.get(jobId);
      const verification = verificationByJob.get(jobId);
      const completedAt = numberOrNull(run?.completed_at);
      const verified = verification?.complete === true && Number(verification.runUpdatedAt) === Number(run?.updated_at);
      return {
        jobId,
        status: !run ? (unobserved ? "unobserved" : "unrun") : verified && completedAt != null ? "completed" : "incomplete",
        completedAt
      };
    })
  };
}

async function readHealth(DB, businessLine, nowMs) {
  const latestBatch = await first(DB, "SELECT MAX(captured_at) AS at FROM cinema_batches");
  const oldestPending = await first(DB,
    "SELECT MIN(CASE WHEN o.state='sending' THEN o.lease_until ELSE o.next_attempt_at END) AS at " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line=? AND o.state IN ('pending','sending')",
    businessLine
  );
  const [maintenance, maintenanceHealth] = await Promise.all([first(DB,
    "SELECT MAX(local_date) AS local_date FROM maoyan_maintenance_runs " +
    "WHERE job_id='reminder' AND completed_at IS NOT NULL"
  ), readMaintenanceHealth(DB, nowMs)]);
  return {
    latestBatchAt: numberOrNull(latestBatch?.at),
    oldestPendingNotificationAt: numberOrNull(oldestPending?.at),
    lastMaintenanceDate: maintenance?.local_date || null,
    maintenance: maintenanceHealth
  };
}

async function readSeatFeedback(DB) {
  const count = await first(DB, "SELECT COUNT(*) AS n FROM seat_feedback");
  const rows = await all(DB,
    "SELECT fb_key,reported_at,day,token_id,cinema_id,movie_id,seq_no,source,status FROM seat_feedback " +
    "ORDER BY reported_at DESC"
  );
  return {
    count: Number(count?.n || 0),
    items: rows.map((row) => ({
      key: String(row.fb_key), reportedAt: String(row.reported_at), day: row.day || null,
      tokenId: row.token_id || null, cinemaId: row.cinema_id || null, movieId: row.movie_id || null,
      seqNo: row.seq_no || null, source: row.source || null, status: row.status || "unprocessed"
    }))
  };
}

export async function readAdminDashboard(DB, { businessLine = "maoyan", window = "24h", nowMs = Date.now() } = {}) {
  assertDashboardQuery({ businessLine, window });
  const generatedAt = Number(nowMs);
  const windowStart = generatedAt - WINDOW_MS;
  const [summary, users, cinemas, notifications, health, seatFeedback] = await Promise.all([
    readSummary(DB, businessLine, generatedAt, windowStart),
    readUsers(DB, businessLine, generatedAt),
    readCinemas(DB, businessLine, generatedAt, windowStart),
    readNotifications(DB, businessLine, windowStart),
    readHealth(DB, businessLine, generatedAt),
    readSeatFeedback(DB)
  ]);
  return { generatedAt, window, summary, users, cinemas, notifications, health, seatFeedback };
}
