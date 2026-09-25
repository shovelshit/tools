import { getUserConfig } from "./user.js";
import { currentCredential, isNotificationVerified, pushNotify } from "./notify.js";
import { accountStatus } from "./accounts.js";
import { sanitizeFailureJson, sanitizeFailureText } from "./failure-detail.js";
import { readBusinessPolicy } from "./business-policy-store.js";
import { businessTime, nextMaintenanceStart } from "./business-time.js";

const RETRY_DELAYS = [30_000, 120_000, 600_000];
const LEASE_MS = 30_000;
const URGENT_KINDS = new Set(["new-shows", "lock-terminal", "seat-feedback"]);
const ROUTINE_KIND = "account-expiry";
const LOCK_RULE_SNAPSHOT_FIELDS = [
  "cinemaId", "cinemaName", "movieId", "movieName", "hall", "targetDate", "templateDate", "templateTime",
  "targetTime", "templateSeqNo", "targetSeqNo", "matchMode", "timeDeltaMinutes", "timeToleranceMinutes"
];
const LOCK_RULE_SEAT_FIELDS = ["label", "seatNo", "rowId", "columnId", "type"];

function lockRuleSnapshot(rule) {
  if (!rule || typeof rule !== "object") return null;
  const snapshot = {};
  for (const field of LOCK_RULE_SNAPSHOT_FIELDS) {
    if (Object.hasOwn(rule, field) && rule[field] !== undefined) snapshot[field] = rule[field];
  }
  if (Array.isArray(rule.seats)) {
    snapshot.seats = rule.seats.map((seat) => Object.fromEntries(
      LOCK_RULE_SEAT_FIELDS
        .filter((field) => seat && Object.hasOwn(seat, field) && seat[field] !== undefined)
        .map((field) => [field, seat[field]])
    ));
  }
  return snapshot;
}

function providerResponseSummary(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    if (text.length <= 24 * 1024) return value;
    if (typeof value.responseBody === "string") {
      return { ...value, responseBody: value.responseBody.slice(0, 16 * 1024), bodyTruncated: true };
    }
    return { summary: text.slice(0, 24 * 1024) };
  }
  return String(value).slice(0, 24 * 1024);
}

function errorDetail(error, config) {
  return sanitizeFailureText(String(error?.message || "通知发送失败"), [currentCredential(config)]);
}

export async function enqueueNotification(DB, {
  eventKey, userId, kind, title, content, credentialVersion, meta, detectedAt, nowMs = Date.now()
}) {
  const existing = await DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind(String(eventKey)).first();
  if (existing) return { id: Number(existing.id), created: false };
  const result = await DB.prepare(
    "INSERT OR IGNORE INTO notification_outbox(" +
    "event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at,detected_at" +
    ") VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?,?)"
  ).bind(
    String(eventKey), String(userId), String(kind), JSON.stringify({ title: String(title), content: String(content), ...(meta ? { meta } : {}) }),
    Number(credentialVersion || 0), Number(nowMs), Number(nowMs), Number(nowMs),
    detectedAt == null ? null : Number(detectedAt)
  ).run();
  const row = await DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind(String(eventKey)).first();
  return { id: Number(row.id), created: Number(result?.meta?.changes || 0) === 1 };
}

export async function persistTerminalNotification(env, {
  userId, rule, title, content, meta, triggerSource, failureStage, failureReason, providerResponse,
  failureDetail, failureSecrets = [], credentialVersion, nowMs = Date.now()
}) {
  const diagnosticMeta = meta && typeof meta === "object" ? meta : {};
  const safeFailureDetail = typeof failureDetail === "string"
    ? sanitizeFailureJson(failureDetail, Array.isArray(failureSecrets) ? failureSecrets : []) : null;
  const result = await env.DB.batch([
    rule.state === "failed" || rule.state === "expired" ? env.DB.prepare(
      "DELETE FROM lock_rule WHERE token_id=? AND json_extract(data,'$.id')=?"
    ).bind(userId, rule.id) : env.DB.prepare(
      "INSERT INTO lock_rule(token_id,data,updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(token_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at"
    ).bind(userId, JSON.stringify(rule), new Date(nowMs).toISOString()),
    env.DB.prepare(
      "INSERT OR IGNORE INTO notification_outbox(" +
      "event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at,detected_at,failure_detail" +
      ") VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?,?,?)"
    ).bind(
      `lock:${rule.id}:${rule.state}`, userId, "lock-terminal", JSON.stringify({
        title, content, meta: {
          triggerSource: diagnosticMeta.triggerSource ?? triggerSource ?? null,
          failureStage: diagnosticMeta.failureStage ?? failureStage ?? null,
          failureReason: diagnosticMeta.failureReason ?? failureReason ?? null,
          providerResponse: providerResponseSummary(diagnosticMeta.providerResponse ?? providerResponse),
          lockRule: lockRuleSnapshot(rule)
        }
      }),
      Number(credentialVersion || 0), Number(nowMs), Number(nowMs), Number(nowMs), Number(nowMs),
      safeFailureDetail
    )
  ]);
  return { created: Number(result[1]?.meta?.changes || 0) === 1 };
}

async function defaultSend(env, row, payload, config) {
  const user = await env.DB.prepare("SELECT role,state,expires_at FROM users WHERE id=?").bind(row.user_id).first();
  if (!user || user.state === "revoked") {
    const error = new Error("账号已撤销");
    error.permanent = true;
    throw error;
  }
  if (row.kind === "account-expiry" && Number(payload?.meta?.expiresAt) !== Number(user.expires_at)) {
    const error = new Error("账号期限已变化");
    error.permanent = true;
    throw error;
  }
  if (row.kind === "new-shows" && (accountStatus({
    role: user.role, state: user.state, expiresAt: user.expires_at == null ? null : Number(user.expires_at)
  }) !== "active" || config.enabled !== true || Number(config.version) !== Number(row.credential_version))) {
    const error = new Error("监控订阅已变化");
    error.permanent = true;
    throw error;
  }
  if (!currentCredential(config) || !await isNotificationVerified(config)) {
    const error = new Error("通知渠道未配置或验证已失效");
    error.permanent = true;
    throw error;
  }
  return await pushNotify(config, payload.title, payload.content);
}

function normalizedLane(lane) {
  if (lane?.kind === ROUTINE_KIND && !lane.userId) return { kind: ROUTINE_KIND };
  if (URGENT_KINDS.has(lane?.kind) && lane.userId) {
    return { kind: lane.kind, userId: String(lane.userId) };
  }
  throw new Error("无效的通知通道");
}

function laneFilter(lane) {
  return lane.userId ? { sql: "o.user_id=? AND o.kind=?", args: [lane.userId, lane.kind] }
    : { sql: "o.kind=?", args: [ROUTINE_KIND] };
}

function localDay(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(ms));
  const part = (name) => Number(parts.find((entry) => entry.type === name).value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000;
}

async function validateReminder(env, row, payload, nowMs) {
  if (row.kind !== ROUTINE_KIND) return;
  const user = await env.DB.prepare("SELECT state,expires_at FROM users WHERE id=?").bind(row.user_id).first();
  const expiresAt = Number(payload?.meta?.expiresAt);
  const stage = payload?.meta?.stage;
  const daysLeft = localDay(expiresAt) - localDay(nowMs);
  const valid = user?.state === "active" && Number(user.expires_at) === expiresAt && (
    stage === "expired" ? nowMs >= expiresAt :
    stage === "one-day" ? daysLeft === 1 :
    stage === "three-day" ? daysLeft === 3 : false
  );
  if (!valid) {
    const error = new Error("到期提醒已过时");
    error.permanent = true;
    throw error;
  }
}

export async function deliverOutbox(env, { lane, nowMs = Date.now(), clock = () => nowMs, limit = 10, send } = {}) {
  lane = normalizedLane(lane);
  const filter = laneFilter(lane);
  if (lane.kind === ROUTINE_KIND) {
    const policy = await readBusinessPolicy(env.DB);
    if (!businessTime(nowMs, policy).maintenanceOpen) {
      const queued = await env.DB.prepare(
        "SELECT COUNT(*) AS n,MIN(CASE WHEN o.state='sending' THEN o.lease_until ELSE o.next_attempt_at END) AS next_at " +
        "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
        "WHERE u.business_line='maoyan' AND o.kind='account-expiry' AND o.state IN ('pending','sending')"
      ).first();
      const pending = Number(queued?.n || 0);
      if (!pending) return { sent: 0, failed: 0, pending: 0, nextAttemptAt: null };
      const start = nextMaintenanceStart(nowMs, policy);
      const due = Math.max(start, Number(queued.next_at || start));
      return {
        sent: 0, failed: 0, pending,
        nextAttemptAt: businessTime(due, policy).maintenanceOpen ? due : nextMaintenanceStart(due, policy)
      };
    }
  }
  const pageSize = Math.min(10, Math.max(1, Number(limit) || 10));
  const dueQuery =
    "SELECT o.id,o.event_key,o.user_id,o.kind,o.payload,o.credential_version,o.state,o.attempts,o.next_attempt_at,o.lease_until " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE u.business_line='maoyan' AND " + filter.sql + " AND ";
  const [{ results: pending }, { results: sending }] = await Promise.all([
    env.DB.prepare(dueQuery + "o.state='pending' AND o.next_attempt_at<=? ORDER BY o.next_attempt_at,o.id LIMIT ?")
      .bind(...filter.args, Number(nowMs), pageSize).all(),
    env.DB.prepare(dueQuery + "o.state='sending' AND o.lease_until<=? ORDER BY o.lease_until,o.id LIMIT ?")
      .bind(...filter.args, Number(nowMs), pageSize).all()
  ]);
  const results = pending.concat(sending).sort((a, b) =>
    Number(a.state === "sending" ? a.lease_until : a.next_attempt_at) -
    Number(b.state === "sending" ? b.lease_until : b.next_attempt_at) || a.id - b.id
  ).slice(0, pageSize);
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    const claimAt = Number(clock());
    if (lane.kind === ROUTINE_KIND && !businessTime(claimAt, await readBusinessPolicy(env.DB)).maintenanceOpen) break;
    const leaseUntil = claimAt + LEASE_MS;
    const claimed = await env.DB.prepare(
      "UPDATE notification_outbox SET state='sending',attempts=attempts+1,lease_until=?,updated_at=? " +
      "WHERE id=? AND ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?))"
    ).bind(leaseUntil, claimAt, row.id, claimAt, claimAt).run();
    if (Number(claimed?.meta?.changes || 0) !== 1) continue;
    const attempts = Number(row.attempts) + 1;
    const payload = JSON.parse(row.payload);
    let config;
    try {
      await validateReminder(env, row, payload, Number(clock()));
      config = await getUserConfig(env, row.user_id);
      const attemptAt = Number(clock());
      await env.DB.prepare(
        "UPDATE notification_outbox SET first_attempt_at=COALESCE(first_attempt_at,?),updated_at=? " +
        "WHERE id=? AND state='sending' AND lease_until=?"
      ).bind(attemptAt, attemptAt, row.id, leaseUntil).run();
      if (send) await send(config, payload.title, payload.content, row);
      else await defaultSend(env, row, payload, config);
      const sentAt = Number(clock());
      await env.DB.prepare(
        "UPDATE notification_outbox SET state='sent',last_error=NULL,lease_until=NULL,next_attempt_at=NULL,sent_at=?,updated_at=? " +
        "WHERE id=? AND state='sending' AND lease_until=?"
      ).bind(sentAt, sentAt, row.id, leaseUntil).run();
      sent += 1;
    } catch (error) {
      const exhausted = error?.permanent === true || attempts >= 4;
      const retryAfter = Number(error?.retryAfterMs);
      const failureAt = Number(clock());
      const nextAttemptAt = exhausted ? null : failureAt +
        Math.max(RETRY_DELAYS[attempts - 1], Number.isFinite(retryAfter) ? retryAfter : 0);
      await env.DB.prepare(
        "UPDATE notification_outbox SET state=?,last_error=?,lease_until=NULL,next_attempt_at=?,updated_at=? " +
        "WHERE id=? AND state='sending' AND lease_until=?"
      ).bind(exhausted ? "failed" : "pending", errorDetail(error, config), nextAttemptAt, failureAt, row.id, leaseUntil).run();
      failed += 1;
    }
  }
  const pendingRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n,MIN(CASE WHEN o.state='sending' THEN o.lease_until ELSE o.next_attempt_at END) AS next_at " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line='maoyan' AND " + filter.sql + " AND o.state IN ('pending','sending')"
  ).bind(...filter.args).first();
  let nextAttemptAt = pendingRow?.next_at == null ? null : Number(pendingRow.next_at);
  if (lane.kind === ROUTINE_KIND && nextAttemptAt != null) {
    const policy = await readBusinessPolicy(env.DB);
    const earliest = Math.max(nextAttemptAt, Number(clock()));
    if (!businessTime(earliest, policy).maintenanceOpen) {
      nextAttemptAt = nextMaintenanceStart(earliest, policy);
    } else {
      nextAttemptAt = earliest;
    }
  }
  return {
    sent, failed, pending: Number(pendingRow?.n || 0),
    nextAttemptAt
  };
}

export class NotificationDispatcher {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps;
    this.inFlight = null;
    this.wakeRevision = 0;
  }

  async drain() {
    const nowMs = Number((this.deps.now || Date.now)());
    const lane = await this.state.storage.get("lane");
    if (!lane) return { sent: 0, failed: 0, pending: 0, nextAttemptAt: null };
    const result = await deliverOutbox(this.env, {
      lane, nowMs, clock: this.deps.now || Date.now, limit: 10, send: this.deps.send
    });
    if (result.nextAttemptAt != null) {
      await this.state.storage.setAlarm(Math.max(Number((this.deps.now || Date.now)()) + 1000, result.nextAttemptAt));
    }
    else await this.state.storage.deleteAlarm();
    return result;
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/internal/drain") {
      return Response.json({ error: "Not Found" }, { status: 404 });
    }
    const lane = normalizedLane(await request.json());
    await this.state.storage.put("lane", lane);
    this.wakeRevision++;
    await this.state.storage.setAlarm(Number((this.deps.now || Date.now)()) + LEASE_MS);
    this.startDrain();
    return Response.json({ ok: true });
  }

  async alarm() {
    await this.startDrain();
  }

  startDrain() {
    if (!this.inFlight) {
      const startedAtRevision = this.wakeRevision;
      this.inFlight = this.drain().catch(async (error) => {
        console.error("notification_dispatcher", sanitizeFailureText(String(error?.message || "drain failed")));
        await this.state.storage.setAlarm(Number((this.deps.now || Date.now)()) + LEASE_MS);
      }).finally(() => {
        this.inFlight = null;
        if (this.wakeRevision !== startedAtRevision) this.startDrain();
      });
    }
    return this.inFlight;
  }
}

export async function wakeNotificationDispatcher(env, lane) {
  if (!env.NOTIFICATION_DISPATCHER) return false;
  const selected = normalizedLane(lane);
  const name = selected.userId ? `urgent:${selected.kind}:${selected.userId}` : "routine";
  const stub = env.NOTIFICATION_DISPATCHER.get(env.NOTIFICATION_DISPATCHER.idFromName(name));
  const response = await stub.fetch(new Request("https://internal/internal/drain", {
    method: "POST", body: JSON.stringify(selected), headers: { "Content-Type": "application/json" }
  }));
  if (!response.ok) throw new Error("通知发送器唤醒失败");
  return true;
}

export async function recoverPendingNotifications(env, { nowMs = Date.now(), limit = 10 } = {}) {
  const pageSize = Math.min(20, Math.max(1, Number(limit) || 10));
  let includeRoutine = false;
  try {
    includeRoutine = businessTime(nowMs, await readBusinessPolicy(env.DB)).maintenanceOpen;
  } catch {
    // A missing policy must not delay urgent notifications.
  }
  const kinds = includeRoutine
    ? ["lock-terminal", "new-shows", "seat-feedback", "account-expiry"]
    : ["lock-terminal", "new-shows", "seat-feedback"];
  const placeholders = kinds.map(() => "?").join(",");
  const base =
    "SELECT o.user_id,o.kind,";
  const from =
    " FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line='maoyan' AND o.kind IN (" + placeholders + ") AND ";
  const [{ results: pending }, { results: leased }] = await Promise.all([
    env.DB.prepare(base + "o.next_attempt_at AS due_at" + from +
      "o.state='pending' AND o.next_attempt_at<=? ORDER BY o.next_attempt_at,o.id LIMIT ?")
      .bind(...kinds, Number(nowMs), pageSize).all(),
    env.DB.prepare(base + "o.lease_until AS due_at" + from +
      "o.state='sending' AND o.lease_until<=? ORDER BY o.lease_until,o.id LIMIT ?")
      .bind(...kinds, Number(nowMs), pageSize).all()
  ]);
  const due = pending.concat(leased).sort((a, b) => Number(a.due_at) - Number(b.due_at))
    .slice(0, pageSize);
  const lanes = new Map();
  for (const row of due) {
    const lane = row.kind === ROUTINE_KIND
      ? { kind: ROUTINE_KIND } : { kind: row.kind, userId: row.user_id };
    lanes.set(lane.userId ? `${lane.kind}:${lane.userId}` : ROUTINE_KIND, lane);
  }
  let woken = 0;
  for (const lane of lanes.values()) {
    try {
      if (await wakeNotificationDispatcher(env, lane)) woken++;
    } catch (error) {
      console.error("notification_recovery", sanitizeFailureText(String(error?.message || "wake failed")));
    }
  }
  return { woken };
}
