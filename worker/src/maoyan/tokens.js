// ---------------- 管理入口与定时维护 ----------------

import { json } from "../common/http.js";
import { runCheck } from "./check.js";
import { monitorError } from "./log.js";
import { businessTime } from "./business-time.js";
import { readBusinessPolicy } from "./business-policy-store.js";
import { listSeatFeedback, deleteSeatFeedback, updateSeatFeedback } from "./seat-feedback.js";
import { cleanupExpiredAccount } from "./account-lifecycle.js";
import { accountErrorResponse, handleAdminAccountApi } from "./account-api.js";
import { enqueueNotification, wakeNotificationDispatcher } from "./notification-outbox.js";
import { claimMaintenanceDay, finishMaintenanceDay, releaseMaintenanceDay } from "./maintenance-store.js";
import { retryRevocationCleanup } from "./user.js";

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

function checkAdminAuth(request, env) {
  const admin = String(env.ADMIN_TOKEN || "").trim();
  const given = request.headers.get("X-Admin-Token") || "";
  return Boolean(admin) && given === admin;
}

// cron 直接读取账号元数据，不维护会与删除操作竞争的副本。
// 窗口外(北京 23:00~06:59)批次整体跳过: 不抓上游、锁座链不执行(等待中的规则保留, 窗口内恢复)。
// opts.now 供测试注入固定时刻; 手动检查不经此函数, 不受窗口限制。
export async function runScheduledChecks(env, afterMonitor, opts = {}) {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now ?? Date.now());
  const policy = opts.policy || await readBusinessPolicy(env.DB);
  if (!businessTime(nowMs, policy).monitorOpen) return;
  const { results } = await env.DB.prepare(
    "SELECT id FROM users WHERE role='user' AND business_line='maoyan' AND state='active' " +
    "AND archived_at IS NULL AND expires_at>?"
  ).bind(nowMs).all();
  for (const row of results) {
    try {
      await runCheck(env, false, row.id, {
        afterPersist: typeof afterMonitor === "function"
          ? (cinemaData) => afterMonitor(row.id, cinemaData)
          : undefined
      });
    } catch (e) {
      monitorError("scheduled_check", { state: "failed", reason: "internal_error" });
    }
  }
}

function expiryStage(expiresAt, nowMs) {
  if (expiresAt <= nowMs) return "expired";
  const localDay = (ms) => Math.floor((ms + 8 * 3600_000) / DAY_MS);
  const days = localDay(expiresAt) - localDay(nowMs);
  return days === 1 ? "one-day" : days === 3 ? "three-day" : null;
}

async function processReminder(env, row, nowMs) {
  const expiresAt = Number(row.expires_at);
  if (expiresAt + 30 * DAY_MS <= nowMs) return false;
  const stage = expiryStage(expiresAt, nowMs);
  if (!stage) return false;
  const title = stage === "expired" ? "⏰ 猫眼监控｜账号已到期" : `⏳ 猫眼监控｜账号将在${stage === "one-day" ? " 1 天" : " 3 天"}内到期`;
  const content = stage === "expired"
    ? "🔒 监控与等待锁座已暂停\n🔄 有空余名额时，可在账号页自助续期"
    : `📅 到期时间：${new Date(expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\n🔑 请妥善保管当前访问密钥`;
  const result = await enqueueNotification(env.DB, {
    eventKey: `account-expiry:${row.id}:${expiresAt}:${stage}`,
    userId: row.id,
    kind: "account-expiry",
    title,
    content,
    credentialVersion: Number(row.config_version || 0),
    meta: { expiresAt, stage },
    nowMs
  });
  return result.created;
}

function candidateQuery(job) {
  if (job === "revocation") {
    return "SELECT user_id AS id FROM revocation_cleanup ORDER BY user_id LIMIT ?";
  }
  const active = "u.role='user' AND u.business_line='maoyan' AND u.state='active' AND u.archived_at IS NULL";
  if (job === "archive") {
    return "SELECT u.id,u.expires_at,u.version FROM users u WHERE " + active +
      " AND u.expires_at+?<=? ORDER BY u.id LIMIT ?";
  }
  const stage = "CASE WHEN u.expires_at<=? THEN 'expired' " +
    "WHEN u.expires_at>=? AND u.expires_at<? THEN 'one-day' " +
    "WHEN u.expires_at>=? AND u.expires_at<? THEN 'three-day' END";
  return "SELECT u.id,u.expires_at,c.version AS config_version FROM users u " +
    "LEFT JOIN user_config c ON c.token_id=u.id WHERE " + active +
    " AND ((u.expires_at<=? AND u.expires_at+?>?) " +
    "OR (u.expires_at>=? AND u.expires_at<?) OR (u.expires_at>=? AND u.expires_at<?)) " +
    "AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.event_key=" +
    "'account-expiry:' || u.id || ':' || u.expires_at || ':' || " + stage +
    ") ORDER BY u.id LIMIT ?";
}

async function maintenanceCandidates(DB, job, nowMs, limit = PAGE_SIZE) {
  const query = DB.prepare(candidateQuery(job));
  if (job === "revocation") return (await query.bind(limit).all()).results;
  if (job === "archive") return (await query.bind(30 * DAY_MS, nowMs, limit).all()).results;
  const today = Math.floor((nowMs + 8 * 3600_000) / DAY_MS) * DAY_MS - 8 * 3600_000;
  const tomorrow = today + DAY_MS;
  const dayAfterTomorrow = tomorrow + DAY_MS;
  const inThreeDays = today + 3 * DAY_MS;
  const params = [nowMs, 30 * DAY_MS, nowMs, tomorrow, dayAfterTomorrow, inThreeDays, inThreeDays + DAY_MS];
  return (await query.bind(...params, nowMs, tomorrow, dayAfterTomorrow, inThreeDays, inThreeDays + DAY_MS, limit).all()).results;
}

async function runMaintenancePage(env, job, localDate, nowMs) {
  const claim = await claimMaintenanceDay(env.DB, { job, localDate, nowMs });
  if (!claim) return 0;
  let queued = 0;
  try {
    const results = await maintenanceCandidates(env.DB, job, nowMs);
    let failed = false;
    for (const row of results) {
      try {
        if (job === "reminder") {
          if (await processReminder(env, row, nowMs)) queued += 1;
        } else if (job === "archive") {
          await cleanupExpiredAccount(env, {
            userId: row.id, expectedExpiresAt: Number(row.expires_at),
            expectedVersion: Number(row.version), nowMs
          });
        } else if (job === "revocation") {
          const result = await retryRevocationCleanup(env, row.id, { nowMs });
          if (!result.complete) throw new Error("撤销会话清理未完成");
        }
      } catch {
        failed = true;
        monitorError(`account_${job}`, { state: "failed", reason: "candidate_failed" });
      }
    }
    const remaining = await maintenanceCandidates(env.DB, job, nowMs, results.length === PAGE_SIZE ? PAGE_SIZE : 1);
    const pending = remaining.length > 0;
    if (results.length === PAGE_SIZE && remaining.length === PAGE_SIZE &&
      results.every((row, index) => row.id === remaining[index].id)) {
      monitorError(`account_${job}`, { state: "failed", reason: "backlog_no_progress" });
    }
    const complete = !failed && !pending;
    const runUpdatedAt = await finishMaintenanceDay(env.DB, {
      job, localDate, nowMs, leaseUntil: claim.leaseUntil,
      complete
    });
    if (!complete) await recordIncompleteScan(env.DB, job, localDate, runUpdatedAt, nowMs);
  } catch (error) {
    const runUpdatedAt = await releaseMaintenanceDay(env.DB, { job, localDate, nowMs, leaseUntil: claim.leaseUntil });
    if (runUpdatedAt !== null) await recordIncompleteScan(env.DB, job, localDate, runUpdatedAt, nowMs);
    monitorError(`account_${job}`, { state: "failed", reason: "internal_error" });
    throw error;
  }
  return queued;
}

async function recordIncompleteScan(DB, job, localDate, runUpdatedAt, nowMs) {
  await DB.prepare(
    "INSERT INTO audit_events(event_type,request_id,data,created_at) " +
    "VALUES ('maoyan_maintenance_scan_incomplete',?,?,?)"
  ).bind(`${job}:${localDate}`, JSON.stringify({ jobId: job, localDate, runUpdatedAt }), nowMs).run();
}

async function observeMaintenance(DB, localDate, nowMs) {
  await DB.prepare(
    "INSERT INTO audit_events(event_type,request_id,data,created_at) " +
    "SELECT 'maoyan_maintenance_observation_started','maintenance-observation',?,? " +
    "WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE event_type='maoyan_maintenance_observation_started')"
  ).bind(JSON.stringify({ localDate }), nowMs).run();
}

async function verifyClosedMaintenance(env, localDate, nowMs) {
  for (const job of ["reminder", "archive", "revocation"]) {
    const row = await env.DB.prepare(
      "SELECT updated_at,completed_at FROM maoyan_maintenance_runs WHERE job_id=? AND local_date=?"
    ).bind(job, localDate).first();
    if (!row) continue;
    const requestId = `${job}:${localDate}`;
    const prior = await env.DB.prepare(
      "SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_close_verified' AND request_id=? ORDER BY id DESC LIMIT 1"
    ).bind(requestId).first();
    if (prior && JSON.parse(prior.data).runUpdatedAt === Number(row.updated_at)) continue;
    const claim = await claimMaintenanceDay(env.DB, { job, localDate, nowMs });
    if (!claim) continue;
    try {
      const claimed = await env.DB.prepare(
        "SELECT completed_at,updated_at FROM maoyan_maintenance_runs WHERE job_id=? AND local_date=?"
      ).bind(job, localDate).first();
      const lastIncomplete = await env.DB.prepare(
        "SELECT data FROM audit_events WHERE event_type='maoyan_maintenance_scan_incomplete' " +
        "AND request_id=? ORDER BY id DESC LIMIT 1"
      ).bind(requestId).first();
      const incomplete = lastIncomplete && JSON.parse(lastIncomplete.data).runUpdatedAt === Number(claimed.updated_at);
      const complete = (await maintenanceCandidates(env.DB, job, nowMs, 1)).length === 0 &&
        claimed.completed_at !== null && !incomplete;
      const runUpdatedAt = await finishMaintenanceDay(env.DB, {
        job, localDate, nowMs, leaseUntil: claim.leaseUntil, complete
      });
      await env.DB.prepare(
        "INSERT INTO audit_events(event_type,request_id,data,created_at) " +
        "VALUES ('maoyan_maintenance_close_verified',?,?,?)"
      ).bind(requestId, JSON.stringify({ jobId: job, localDate, complete, runUpdatedAt }), nowMs).run();
    } catch (error) {
      await releaseMaintenanceDay(env.DB, { job, localDate, nowMs, leaseUntil: claim.leaseUntil });
      throw error;
    }
  }
}

async function reportMissedReminderDay(DB, localDate, nowMs) {
  const previousDate = new Date(Date.parse(`${localDate}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const requestId = `reminder-missed:${previousDate}`;
  const result = await DB.prepare(
    "INSERT INTO audit_events(event_type,request_id,data,created_at) " +
    "SELECT 'maoyan_maintenance_reminder_missed',?,?,? " +
    "WHERE EXISTS (SELECT 1 FROM maoyan_maintenance_runs WHERE job_id='reminder' AND local_date<=?) " +
    "AND NOT EXISTS (SELECT 1 FROM maoyan_maintenance_runs r JOIN audit_events a " +
    "ON a.event_type='maoyan_maintenance_close_verified' AND a.request_id='reminder:' || r.local_date " +
    "WHERE r.job_id='reminder' AND r.local_date=? AND json_extract(a.data,'$.complete')=1 " +
    "AND json_extract(a.data,'$.runUpdatedAt')=r.updated_at) " +
    "AND NOT EXISTS (SELECT 1 FROM audit_events WHERE event_type='maoyan_maintenance_reminder_missed' AND request_id=?)"
  ).bind(requestId, JSON.stringify({ localDate: previousDate }), nowMs, previousDate, previousDate, requestId).run();
  if (Number(result?.meta?.changes || 0) === 1) {
    monitorError("account_reminder_missed", { state: "failed", reason: "previous_business_day_incomplete" });
  }
}

export async function runScheduledMaintenance(env, nowMs = Date.now(), policy) {
  const currentPolicy = policy || await readBusinessPolicy(env.DB);
  const time = businessTime(nowMs, currentPolicy);
  await observeMaintenance(env.DB, time.localDate, nowMs);
  if (!time.maintenanceOpen) {
    const localMinute = Math.floor(((nowMs + 8 * 3600_000) % DAY_MS) / 60_000);
    if (localMinute >= currentPolicy.maintenanceEndMinute) {
      await verifyClosedMaintenance(env, time.localDate, nowMs);
    }
    return { queued: 0 };
  }
  await reportMissedReminderDay(env.DB, time.localDate, nowMs);
  const queued = await runMaintenancePage(env, "reminder", time.localDate, nowMs);
  for (const job of ["archive", "revocation"]) {
    await runMaintenancePage(env, job, time.localDate, nowMs);
  }
  if (queued) await wakeNotificationDispatcher(env, { kind: "account-expiry" });
  return { queued };
}

export async function handleAdminTokens(request, env, url) {
  if (!checkAdminAuth(request, env)) {
    return json({ error: "管理令牌错误或未配置 ADMIN_TOKEN" }, 401);
  }
  try {
    const accountResponse = await handleAdminAccountApi(request, env, url);
    if (accountResponse) return accountResponse;
    if (url.pathname === "/api/admin/seat-feedback" && request.method === "GET") {
      // 座位解析失败反馈全量列表: 记录只有标识, 管理员拿 id 现场重拉座位页复习
      return json({ ok: true, feedback: await listSeatFeedback(env) });
    }
    if (url.pathname === "/api/admin/seat-feedback" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const key = String(url.searchParams.get("key") || body.key || "");
      if (!await deleteSeatFeedback(env, key)) {
        return json({ ok: false, error: "无效的反馈记录" }, 400);
      }
      return json({ ok: true });
    }
    if (url.pathname === "/api/admin/seat-feedback" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || "");
      const status = String(body.status || "");
      if (!await updateSeatFeedback(env, key, status)) return json({ ok: false, error: "无效的反馈状态或记录" }, 400);
      return json({ ok: true, key, status }, 200, { "Cache-Control": "no-store" });
    }
    return json({ error: "Method Not Allowed" }, 405);
  } catch (e) {
    if (e?.code) return accountErrorResponse(e);
    return json({ ok: false, error: e.message }, 500);
  }
}
