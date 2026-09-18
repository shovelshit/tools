import { getUserConfig } from "./user.js";
import { currentCredential, isNotificationVerified, pushNotify } from "./notify.js";
import { accountStatus } from "./accounts.js";
import { sanitizeFailureText } from "./failure-detail.js";

const RETRY_DELAYS = [30_000, 120_000, 600_000];
const LEASE_MS = 30_000;

function errorDetail(error, config) {
  return sanitizeFailureText(String(error?.message || "通知发送失败"), [currentCredential(config)]);
}

export async function enqueueNotification(DB, {
  eventKey, userId, kind, title, content, credentialVersion, meta, nowMs = Date.now()
}) {
  const existing = await DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind(String(eventKey)).first();
  if (existing) return { id: Number(existing.id), created: false };
  const result = await DB.prepare(
    "INSERT OR IGNORE INTO notification_outbox(" +
    "event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at" +
    ") VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?)"
  ).bind(
    String(eventKey), String(userId), String(kind), JSON.stringify({ title: String(title), content: String(content), ...(meta ? { meta } : {}) }),
    Number(credentialVersion || 0), Number(nowMs), Number(nowMs), Number(nowMs)
  ).run();
  const row = await DB.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind(String(eventKey)).first();
  return { id: Number(row.id), created: Number(result?.meta?.changes || 0) === 1 };
}

export async function persistTerminalNotification(env, {
  userId, rule, title, content, failureDetail, credentialVersion, nowMs = Date.now()
}) {
  const result = await env.DB.batch([
    rule.state === "failed" || rule.state === "expired" ? env.DB.prepare(
      "DELETE FROM lock_rule WHERE token_id=? AND json_extract(data,'$.id')=?"
    ).bind(userId, rule.id) : env.DB.prepare(
      "INSERT INTO lock_rule(token_id,data,updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(token_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at"
    ).bind(userId, JSON.stringify(rule), new Date(nowMs).toISOString()),
    env.DB.prepare(
      "INSERT OR IGNORE INTO notification_outbox(" +
      "event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at,failure_detail" +
      ") VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?,?)"
    ).bind(
      `lock:${rule.id}:${rule.state}`, userId, "lock-terminal", JSON.stringify({ title, content }),
      Number(credentialVersion || 0), Number(nowMs), Number(nowMs), Number(nowMs), typeof failureDetail === "string" ? failureDetail : null
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

export async function deliverOutbox(env, { nowMs = Date.now(), limit = 10, send } = {}) {
  const pageSize = Math.min(10, Math.max(1, Number(limit) || 10));
  const { results } = await env.DB.prepare(
    "SELECT o.id,o.event_key,o.user_id,o.kind,o.payload,o.credential_version,o.state,o.attempts,o.next_attempt_at,o.lease_until " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id WHERE u.business_line='maoyan' AND " +
    "((o.state='pending' AND o.next_attempt_at<=?) OR (o.state='sending' AND o.lease_until<=?)) ORDER BY o.id LIMIT ?"
  ).bind(Number(nowMs), Number(nowMs), pageSize).all();
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    const claimed = await env.DB.prepare(
      "UPDATE notification_outbox SET state='sending',attempts=attempts+1,lease_until=?,updated_at=? " +
      "WHERE id=? AND ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?))"
    ).bind(Number(nowMs) + LEASE_MS, Number(nowMs), row.id, Number(nowMs), Number(nowMs)).run();
    if (Number(claimed?.meta?.changes || 0) !== 1) continue;
    const attempts = Number(row.attempts) + 1;
    const payload = JSON.parse(row.payload);
    let config;
    try {
      config = await getUserConfig(env, row.user_id);
      if (send) await send(config, payload.title, payload.content, row);
      else await defaultSend(env, row, payload, config);
      await env.DB.prepare(
        "UPDATE notification_outbox SET state='sent',last_error=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND state='sending'"
      ).bind(Number(nowMs), row.id).run();
      sent += 1;
    } catch (error) {
      const exhausted = error?.permanent === true || attempts >= 4;
      const nextAttemptAt = exhausted ? null : Number(nowMs) + RETRY_DELAYS[attempts - 1];
      await env.DB.prepare(
        "UPDATE notification_outbox SET state=?,last_error=?,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND state='sending'"
      ).bind(exhausted ? "failed" : "pending", errorDetail(error, config), nextAttemptAt, Number(nowMs), row.id).run();
      failed += 1;
    }
  }
  const pendingRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n,MIN(CASE WHEN o.state='sending' THEN o.lease_until ELSE o.next_attempt_at END) AS next_at " +
    "FROM notification_outbox o JOIN users u ON u.id=o.user_id " +
    "WHERE u.business_line='maoyan' AND o.state IN ('pending','sending')"
  ).first();
  return {
    sent, failed, pending: Number(pendingRow?.n || 0),
    nextAttemptAt: pendingRow?.next_at == null ? null : Number(pendingRow.next_at)
  };
}

export class NotificationDispatcher {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps;
  }

  async drain() {
    const nowMs = Number((this.deps.now || Date.now)());
    const result = await deliverOutbox(this.env, { nowMs, limit: 10, send: this.deps.send });
    if (result.nextAttemptAt != null) await this.state.storage.setAlarm(Math.max(nowMs + 1000, result.nextAttemptAt));
    else await this.state.storage.deleteAlarm();
    return result;
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/internal/drain") {
      return Response.json({ error: "Not Found" }, { status: 404 });
    }
    return Response.json({ ok: true, ...await this.drain() });
  }

  async alarm() {
    await this.drain();
  }
}

export async function wakeNotificationDispatcher(env) {
  if (!env.NOTIFICATION_DISPATCHER) return false;
  const stub = env.NOTIFICATION_DISPATCHER.get(env.NOTIFICATION_DISPATCHER.idFromName("main"));
  await stub.fetch(new Request("https://internal/internal/drain", { method: "POST" }));
  return true;
}
