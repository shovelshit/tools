// ---------------- 管理入口与定时维护 ----------------

import { json } from "../common/http.js";
import { runCheck } from "./check.js";
import { monitorError } from "./log.js";
import { inMonitorWindow } from "./cron.js";
import { listSeatFeedback, deleteSeatFeedback } from "./seat-feedback.js";
import { accountStatus } from "./accounts.js";
import { cleanupExpiredAccount } from "./account-lifecycle.js";
import { accountErrorResponse, handleAdminAccountApi } from "./account-api.js";
import { enqueueNotification, wakeNotificationDispatcher } from "./notification-outbox.js";

function checkAdminAuth(request, env) {
  const admin = String(env.ADMIN_TOKEN || "").trim();
  const given = request.headers.get("X-Admin-Token") || "";
  return Boolean(admin) && given === admin;
}

// cron 直接读取账号元数据，不维护会与删除操作竞争的副本。
// 窗口外(北京 23:00~06:59)批次整体跳过: 不抓上游、锁座链不执行(等待中的规则保留, 窗口内恢复)。
// opts.now 供测试注入固定时刻; 手动检查不经此函数, 不受窗口限制。
export async function runScheduledChecks(env, afterMonitor, opts = {}) {
  if (!inMonitorWindow(opts.now)) return;
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id,role,state,expires_at,archived_at,version FROM users WHERE role='user' AND business_line='maoyan'"
  ).all();
  for (const row of results) {
    const account = {
      role: row.role,
      state: row.state,
      expiresAt: row.expires_at === null ? null : Number(row.expires_at)
    };
    if (accountStatus(account, nowMs) !== "active") {
      if (row.state === "active" && row.archived_at == null) {
        try {
          await cleanupExpiredAccount(env, {
            userId: row.id,
            expectedExpiresAt: Number(row.expires_at),
            expectedVersion: Number(row.version),
            nowMs
          });
        } catch {
          monitorError("account_cleanup", { state: "failed", reason: "internal_error" });
        }
      }
      continue;
    }
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

export async function runScheduledMaintenance(env, nowMs = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT u.id,u.role,u.state,u.expires_at,u.archived_at,u.version,c.version AS config_version " +
    "FROM users u LEFT JOIN user_config c ON c.token_id=u.id WHERE u.role='user' AND u.business_line='maoyan'"
  ).all();
  let queued = 0;
  for (const row of results) {
    const expiresAt = Number(row.expires_at);
    if (row.state === "active" && row.archived_at == null && expiresAt + 30 * 86400000 <= nowMs) {
      try {
        await cleanupExpiredAccount(env, {
          userId: row.id,
          expectedExpiresAt: expiresAt,
          expectedVersion: Number(row.version),
          nowMs
        });
      } catch {
        monitorError("account_cleanup", { state: "failed", reason: "internal_error" });
      }
      continue;
    }
    if (row.state !== "active" || !Number.isFinite(expiresAt)) continue;
    const remaining = expiresAt - nowMs;
    const stage = remaining <= 0 ? "expired" : remaining <= 86400000 ? "one-day" : remaining <= 3 * 86400000 ? "three-day" : null;
    if (!stage) continue;
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
    if (result.created) queued += 1;
  }
  if (queued) await wakeNotificationDispatcher(env);
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
    return json({ error: "Method Not Allowed" }, 405);
  } catch (e) {
    if (e?.code) return accountErrorResponse(e);
    return json({ ok: false, error: e.message }, 500);
  }
}
