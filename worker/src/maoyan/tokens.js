// ---------------- 令牌管理(D1 存储) + 鉴权 ----------------
// 令牌唯一来源: D1 tokens 表(id, token UNIQUE, remark, created_at), 鉴权按 token 点查一行。

import * as db from "./db.js";
import { cleanupUserData, getUserConfig } from "./user.js";
import { json } from "../common/http.js";
import { runCheck } from "./check.js";
import { monitorError } from "./log.js";
import { inMonitorWindow } from "./cron.js";
import { listSeatFeedback, deleteSeatFeedback } from "./seat-feedback.js";
import { migrateKvToD1 } from "./migrate.js";
import { accountStatus } from "./accounts.js";
import { authenticate } from "./auth.js";

export function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskToken(token) {
  const value = String(token || "");
  if (!value) return "";
  const edge = value.length <= 10 ? 2 : 4;
  return `${value.slice(0, edge)} **** ${value.slice(-edge)}`;
}

export async function getManagedTokens(env) {
  return await db.listTokens(env.DB);
}

async function saveManagedTokens(env, list) {
  await db.saveTokens(env.DB, list);
}

function checkAdminAuth(request, env) {
  const admin = String(env.ADMIN_TOKEN || "").trim();
  const given = request.headers.get("X-Admin-Token") || "";
  return Boolean(admin) && given === admin;
}

async function publicTokenRecord(env, token) {
  const config = await getUserConfig(env, token.id);
  return {
    id: token.id,
    token: maskToken(token.token),
    remark: token.remark || "",
    createdAt: token.createdAt || null,
    state: config.enabled === true ? "monitoring" : "stopped",
  };
}

// 仅认 X-Token; 返回随机 namespace ID，而不是令牌本身。按 token 点查(D1 unique 索引)。
export async function checkAuthFull(request, env) {
  const principal = await authenticate(request, env);
  return principal ? principal.userId : null;
}

// cron 直接读取唯一的令牌元数据，不维护会与删除操作竞争的副本。
// 窗口外(北京 23:00~06:59)批次整体跳过: 不抓上游、锁座链不执行(等待中的规则保留, 窗口内恢复)。
// opts.now 供测试注入固定时刻; 手动检查不经此函数, 不受窗口限制。
export async function runScheduledChecks(env, afterMonitor, opts = {}) {
  if (!inMonitorWindow(opts.now)) return;
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id,role,state,expires_at FROM users WHERE role='user'"
  ).all();
  for (const row of results) {
    const account = {
      role: row.role,
      state: row.state,
      expiresAt: row.expires_at === null ? null : Number(row.expires_at)
    };
    if (accountStatus(account, nowMs) !== "active") continue;
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

export async function handleAdminTokens(request, env, url) {
  if (!checkAdminAuth(request, env)) {
    return json({ error: "管理令牌错误或未配置 ADMIN_TOKEN" }, 401);
  }
  try {
    if (url.pathname === "/api/admin/tokens" && request.method === "GET") {
      const tokens = await Promise.all((await getManagedTokens(env)).map((token) => publicTokenRecord(env, token)));
      return json({ ok: true, tokens });
    }
    if (url.pathname === "/api/admin/tokens" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || "").trim() || randomToken();
      if (!/^[\x21-\x7e]{6,64}$/.test(token)) {
        return json({ ok: false, error: "令牌须为 6-64 位可见 ASCII 字符" }, 400);
      }
      const list = await getManagedTokens(env);
      if (list.some((item) => item.token === token)) {
        return json({ ok: false, error: "令牌已存在" }, 400);
      }
      const id = crypto.randomUUID();
      list.push({ id, token, remark: String(body.remark || "").slice(0, 50), createdAt: new Date().toISOString() });
      await saveManagedTokens(env, list);
      return json({ ok: true, id, token });
    }
    if (url.pathname === "/api/admin/tokens/revoke" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "");
      const list = await getManagedTokens(env);
      const revoked = list.find((token) => token.id === id);
      if (!revoked) return json({ ok: false, error: "令牌不存在" }, 404);
      await saveManagedTokens(env, list.filter((token) => token.id !== id));
      await cleanupUserData(env, id);
      return json({ ok: true });
    }
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
    if (url.pathname === "/api/admin/migrate-kv-to-d1" && request.method === "POST") {
      // 一次性 KV→D1 迁移(upsert, 可重复执行; 不删 KV 数据, 回滚=重新部署 KV 版)
      return json({ ok: true, ...(await migrateKvToD1(env)) });
    }
    return json({ error: "Method Not Allowed" }, 405);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
