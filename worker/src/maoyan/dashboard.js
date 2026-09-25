import { businessTime } from "./business-time.js";
import { readBusinessPolicy } from "./business-policy-store.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 20;
const MAX_NEXT_SHOWS = 5;
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

function safeMeta(value, depth = 0) {
  if (depth > 2 || value == null) return null;
  if (typeof value === "string") return clampText(value, 512);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeMeta(item, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(credential|password|secret|token|cookie|accesskey)/i.test(key))
    .slice(0, 30)
    .map(([key, item]) => [key, safeMeta(item, depth + 1)]));
}

function cinemaNameFrom(data) {
  return textOrNull(data?.showData?.cinemaName);
}

function movieIdOf(movie) {
  return textOrNull(movie?.id);
}

function movieShows(movie) {
  const shows = [];
  for (const day of Array.isArray(movie?.shows) ? movie.shows : []) {
    const showDate = textOrNull(day?.showDate || day?.dt);
    const entries = Array.isArray(day?.plist) ? day.plist : day?.seqNo != null ? [day] : [];
    for (const show of entries) {
      if (show?.seqNo == null) continue;
      shows.push({
        seqNo: String(show.seqNo),
        showDate,
        time: textOrNull(show.tm),
        hall: textOrNull(show.th),
        ticketStatus: show.ticketStatus == null || !Number.isFinite(Number(show.ticketStatus))
          ? null : Number(show.ticketStatus)
      });
    }
  }
  return shows.sort((left, right) =>
    `${left.showDate || ""}\u0000${left.time || ""}\u0000${left.seqNo}`.localeCompare(
      `${right.showDate || ""}\u0000${right.time || ""}\u0000${right.seqNo}`
    )
  );
}

function moviesFrom(data) {
  return Array.isArray(data?.showData?.movies) ? data.showData.movies : [];
}

function summarizeSelectedMovies(data, selectedMovieIds) {
  const byId = new Map(moviesFrom(data).map((movie) => [movieIdOf(movie), movie]));
  const ids = [...new Set((Array.isArray(selectedMovieIds) ? selectedMovieIds : []).map(String).filter(Boolean))];
  const movies = ids.map((movieId) => {
    const movie = byId.get(movieId);
    const shows = movieShows(movie);
    return {
      movieId,
      movieName: textOrNull(movie?.nm) || movieId,
      showCount: shows.length,
      hasMoreShows: shows.length > MAX_NEXT_SHOWS,
      nextShows: shows.slice(0, MAX_NEXT_SHOWS)
    };
  });
  return {
    selectedCount: movies.length,
    availableShows: movies.reduce((total, movie) => total + movie.showCount, 0),
    movies
  };
}

function summarizeCinema(data) {
  const movies = moviesFrom(data);
  return {
    movieCount: movies.length,
    showCount: movies.reduce((total, movie) => total + movieShows(movie).length, 0)
  };
}

function enrichSummary(summary, users, cinemas, notifications) {
  const movieKeys = new Set();
  let currentShows = 0;
  for (const user of users) {
    for (const movie of user.monitorContent?.movies || []) {
      const key = `${user.cinemaId || ""}\u0000${movie.movieId}`;
      if (movieKeys.has(key)) continue;
      movieKeys.add(key);
      currentShows += Number(movie.showCount || 0);
    }
  }
  return {
    ...summary,
    monitoredMovies: movieKeys.size,
    currentShows,
    attentionCinemas: cinemas.filter((cinema) => cinema.stale || ["processing", "retryable"].includes(cinema.runState)).length,
    pendingNotifications: Number(notifications.pending || 0) + Number(notifications.sending || 0)
  };
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

function payloadSummary(payloadText, contentMax = 1000) {
  const payload = safeJson(payloadText);
  return {
    title: textOrNull(payload?.title),
    content: clampText(payload?.content, contentMax),
    meta: payload?.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta) ? safeMeta(payload.meta) : null
  };
}

function notificationDto(row, contentMax = 1000) {
  return {
    id: Number(row.id),
    eventKey: String(row.event_key),
    userId: String(row.user_id),
    remark: String(row.remark || ""),
    kind: String(row.kind),
    state: String(row.state),
    attempts: Number(row.attempts || 0),
    lockState: lockTerminalState(row.event_key),
    lastError: clampText(row.last_error),
    failureDetail: clampText(row.failure_detail, contentMax),
    nextAttemptAt: numberOrNull(row.next_attempt_at),
    leaseUntil: numberOrNull(row.lease_until),
    createdAt: numberOrNull(row.created_at),
    updatedAt: numberOrNull(row.updated_at),
    detectedAt: numberOrNull(row.detected_at),
    firstAttemptAt: numberOrNull(row.first_attempt_at),
    sentAt: numberOrNull(row.sent_at),
    discoveryToFirstAttemptMs: row.detected_at == null || row.first_attempt_at == null
      ? null : Math.max(0, Number(row.first_attempt_at) - Number(row.detected_at)),
    ...payloadSummary(row.payload, contentMax)
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
    "c.data AS config_data,cs.current_data AS status_data,cs.run_state,cs.active_run_id,cs.attempt_count,cs.completed_at,lr.data AS lock_data " +
    "FROM users u LEFT JOIN monitor_subscriptions s ON s.user_id=u.id " +
    "LEFT JOIN user_config c ON c.token_id=u.id AND c.version=s.config_version " +
    "LEFT JOIN cinema_state cs ON cs.cinema_id=s.cinema_id LEFT JOIN lock_rule lr ON lr.token_id=u.id " +
    `WHERE ${ACTIVE_USER_WHERE} ORDER BY s.enabled DESC,u.created_at DESC,u.id DESC LIMIT 100`,
    businessLine, nowMs
  );
  return rows.map((row) => {
    const config = safeJson(row.config_data) || {};
    const status = safeJson(row.status_data);
    const lock = safeJson(row.lock_data);
    const notification = notifications.get(String(row.id)) || null;
    const monitorContent = summarizeSelectedMovies(status, config.selectedMovieIds);
    return {
      userId: String(row.id),
      remark: String(row.remark || ""),
      accountStatus: "active",
      expiresAt: numberOrNull(row.expires_at),
      cinemaId: textOrNull(row.cinema_id),
      cinemaName: cinemaNameFrom(status) || textOrNull(status?.cinemaName) || textOrNull(lock?.cinemaName) || textOrNull(row.cinema_id),
      monitorState: Number(row.enabled || 0) === 1 ? "monitoring" : "stopped",
      cinemaRunState: textOrNull(row.run_state),
      activeRunId: textOrNull(row.active_run_id),
      attemptCount: numberOrNull(row.attempt_count),
      monitorContent,
      lastCheck: numberOrNull(row.completed_at) == null ? null : new Date(Number(row.completed_at)).toISOString(),
      lastCheckTs: numberOrNull(row.completed_at),
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
    "SELECT cinema_id,current_data,completed_at,updated_at,run_state,active_run_id,attempt_count FROM cinema_state"
  );
  return new Map(rows.map((row) => [
    String(row.cinema_id),
    {
      name: cinemaNameFrom(safeJson(row.current_data)),
      latestBatchAt: numberOrNull(row.completed_at ?? row.updated_at),
      ...summarizeCinema(safeJson(row.current_data)),
      runState: textOrNull(row.run_state),
      activeRunId: textOrNull(row.active_run_id),
      attemptCount: numberOrNull(row.attempt_count)
    }
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
  const newShows = new Map((await all(DB,
    "SELECT s.cinema_id,COUNT(o.id) AS n FROM notification_outbox o " +
    "JOIN users u ON u.id=o.user_id JOIN monitor_subscriptions s ON s.user_id=u.id " +
    `WHERE ${ACTIVE_USER_WHERE} AND s.enabled=1 AND o.kind='new-shows' AND o.created_at>=? ` +
    "GROUP BY s.cinema_id",
    businessLine, nowMs, windowStart
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
      movieCount: Number(latest.movieCount || 0),
      showCount: Number(latest.showCount || 0),
      runState: latest.runState || null,
      activeRunId: latest.activeRunId || null,
      attemptCount: latest.attemptCount || 0,
      stale: row.next_due_at != null && Number(row.next_due_at) <= Number(nowMs),
      newShows: newShows.get(cinemaId) || 0,
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
    recent: rows.map((row) => notificationDto(row))
  };
}

export async function readAdminNotification(DB, { id, businessLine = "maoyan" } = {}) {
  const notificationId = Number(id);
  if (!Number.isSafeInteger(notificationId) || notificationId < 1) throw invalid("通知 ID 无效");
  const row = await first(DB,
    "SELECT o.id,o.event_key,o.user_id,o.kind,o.payload,o.state,o.attempts,o.last_error,o.failure_detail," +
    "o.next_attempt_at,o.lease_until,o.created_at,o.updated_at,o.detected_at,o.first_attempt_at,o.sent_at,u.remark " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE o.id=? AND u.business_line=?",
    notificationId, String(businessLine || "")
  );
  return row ? notificationDto(row, 8192) : null;
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
  const latestBatch = await first(DB,
    "SELECT MAX(COALESCE(cs.completed_at,cs.updated_at)) AS at FROM cinema_state cs " +
    "JOIN monitor_subscriptions s ON s.cinema_id=cs.cinema_id JOIN users u ON u.id=s.user_id " +
    "WHERE u.business_line=?",
    businessLine
  );
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
  return { generatedAt, window, summary: enrichSummary(summary, users, cinemas, notifications), users, cinemas, notifications, health, seatFeedback };
}
