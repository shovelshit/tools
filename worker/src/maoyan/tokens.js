// ---------------- 令牌管理(KV 存储) + 鉴权 ----------------
// 令牌唯一来源: KV meta:tokens: [{token, remark, createdAt, lastUsedAt}]
// KV 为空时监控页拒绝所有人访问; admin 页凭 ADMIN_TOKEN(secret) 管理

import { cleanupUserData } from "../common/user.js";
import { json } from "../common/http.js";
import { runCheck } from "./check.js";

export function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getManagedTokens(env) {
  return (await env.MAOYAN_KV.get("meta:tokens", "json")) || [];
}

async function saveManagedTokens(env, list) {
  await env.MAOYAN_KV.put("meta:tokens", JSON.stringify(list));
  // 同步到 cron 令牌列表(单一来源: KV)
  await env.MAOYAN_KV.put("meta:cron_tokens", JSON.stringify(list.map((t) => t.token).filter(Boolean)));
}

async function markTokenUsed(env, token) {
  try {
    const now = Date.now();
    const list = await getManagedTokens(env);
    const i = list.findIndex((t) => t.token === token);
    if (i >= 0) {
      // 节流: lastUsedAt 每 24 小时最多写一次 KV(免费版写入限额 1000 次/天)
      const last = Date.parse(list[i].lastUsedAt || "") || 0;
      if (now - last < 24 * 3600 * 1000) return;
      list[i].lastUsedAt = new Date(now).toISOString();
      await env.MAOYAN_KV.put("meta:tokens", JSON.stringify(list));
    }
  } catch (e) {
  }
}

function checkAdminAuth(request, env) {
  const admin = String(env.ADMIN_TOKEN || "").trim();
  if (!admin) return false; // 未配置 ADMIN_TOKEN 时管理接口不可用
  const given = request.headers.get("X-Admin-Token") || "";
  return given === admin;
}

// 鉴权: 仅认 KV meta:tokens 中的令牌; KV 为空则拒绝所有人
// 安全: 仅认 X-Token 请求头, 不接受 ?token= URL 参数(避免令牌进入日志/历史记录)
export async function checkAuthFull(request, env, url) {
  const given = request.headers.get("X-Token") || "";
  const managed = await getManagedTokens(env);
  if (!managed.length) return null; // 无任何令牌: 全站关闭
  const hit = managed.find((t) => t.token === given);
  if (hit) {
    markTokenUsed(env, given); // 异步更新使用时间, 不阻塞
    return given;
  }
  return null;
}

// cron 检查的令牌 = admin 页管理的 KV 令牌(单一来源); 请求时自动纠偏副本
export async function syncCronTokens(env) {
  try {
    const managed = await getManagedTokens(env);
    const list = managed.map((t) => t.token).filter(Boolean);
    const key = "meta:cron_tokens";
    const prev = await env.MAOYAN_KV.get(key, "json");
    if (JSON.stringify(prev) !== JSON.stringify(list)) {
      await env.MAOYAN_KV.put(key, JSON.stringify(list));
    }
  } catch (e) {
  }
}

// cron: 逐令牌执行检查; 无令牌则跳过
export async function runScheduledChecks(env) {
  let list = null;
  try {
    const meta = await env.MAOYAN_KV.get("meta:cron_tokens", "json");
    if (Array.isArray(meta)) list = meta.filter(Boolean);
  } catch (e) {
  }
  if (list === null) list = [];
  if (!list.length) return; // 无令牌: 不跑任何检查
  for (const token of list) {
    try {
      await runCheck(env, false, token);
    } catch (e) {
    }
  }
}

// /api/admin/tokens 路由(增删查, X-Admin-Token 鉴权); 删除时级联清理用户数据
export async function handleAdminTokens(request, env, url) {
  if (!checkAdminAuth(request, env)) {
    return json({ error: "管理令牌错误或未配置 ADMIN_TOKEN" }, 401);
  }
  try {
    if (request.method === "GET") {
      const managed = await getManagedTokens(env);
      const tokens = managed.map((t) => ({
        token: t.token,
        remark: t.remark || "",
        inUse: Boolean(t.lastUsedAt),
        createdAt: t.createdAt || null,
        lastUsedAt: t.lastUsedAt || null,
      }));
      return json({ ok: true, tokens });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || "").trim() || randomToken();
      if (!/^[\x21-\x7e]{6,64}$/.test(token)) {
        return json({ ok: false, error: "令牌须为 6-64 位可见 ASCII 字符" }, 400);
      }
      const list = await getManagedTokens(env);
      if (list.some((t) => t.token === token)) {
        return json({ ok: false, error: "令牌已存在" }, 400);
      }
      list.push({ token, remark: String(body.remark || "").slice(0, 50), createdAt: new Date().toISOString(), lastUsedAt: null });
      await saveManagedTokens(env, list);
      return json({ ok: true, token });
    }
    if (request.method === "DELETE") {
      const token = url.searchParams.get("token") || "";
      const list = await getManagedTokens(env);
      const next = list.filter((t) => t.token !== token);
      if (next.length === list.length) {
        return json({ ok: false, error: "令牌不存在" }, 404);
      }
      await saveManagedTokens(env, next);
      // 级联清理该令牌的用户数据(config/snapshot/changes/status), 避免孤儿数据
      await cleanupUserData(env, token);
      return json({ ok: true });
    }
    return json({ error: "Method Not Allowed" }, 405);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
