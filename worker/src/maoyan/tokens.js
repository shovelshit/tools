// ---------------- 令牌管理(KV 存储) + 鉴权 ----------------
// 令牌唯一来源: KV meta:tokens: [{id, token, remark, createdAt}]

import { cleanupUserData, getUserConfig } from "./user.js";
import { isExpired } from "./ddl.js";
import { json } from "../common/http.js";
import { runCheck } from "./check.js";

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
  const tokens = await env.MAOYAN_KV.get("meta:tokens", "json");
  return Array.isArray(tokens) ? tokens.filter((token) => token && token.id && token.token) : [];
}

async function saveManagedTokens(env, list) {
  await env.MAOYAN_KV.put("meta:tokens", JSON.stringify(list));
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
    state: config.enabled === true && !isExpired(config) ? "monitoring" : "stopped",
  };
}

// 仅认 X-Token; 返回随机 namespace ID，而不是令牌本身。
export async function checkAuthFull(request, env) {
  const given = request.headers.get("X-Token") || "";
  const hit = (await getManagedTokens(env)).find((token) => token.token === given);
  return hit ? hit.id : null;
}

// cron 直接读取唯一的令牌元数据，不维护会与删除操作竞争的副本。
export async function runScheduledChecks(env) {
  for (const token of await getManagedTokens(env)) {
    try {
      await runCheck(env, false, token.id);
    } catch (e) {
      console.error("[monitor] 定时检查异常:", e?.message || e);
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
    return json({ error: "Method Not Allowed" }, 405);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
