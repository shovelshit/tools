// ---------------- Worker 入口: 路由分发 ----------------

import { CORS, json } from "./common/http.js";
import { NOTIFY_CHANNELS } from "./common/notify.js";
import { getUserConfig, saveUserConfig } from "./maoyan/user.js";
import * as db from "./maoyan/db.js";
import { CITY_LIST, fetchCinemaDetail, publicCinemaShows, searchCinemasByKw, runCheck, appendChange, pushNotify, currentChannel, currentCredential, isNotificationVerified, notificationVerification, minBatchMinutes, describeCrons, isMinuteStepCrons, resolveCronExprs, handleAdminTokens, handleLockApi, runScheduledChecks, runScheduledLockAfterMonitor, runScheduledMaintenance } from "./maoyan/index.js";
import { authenticate, requireActiveAccount, serviceNow } from "./maoyan/auth.js";
import { accountErrorResponse, handleAccountApi, handlePublicAccountApi } from "./maoyan/account-api.js";
import { requireBusinessAccess } from "./common/business.js";
import { handleStoreApi, handleStoreFile } from "./store/proxy.js";
import { handleStoreAuth, requireActiveStoreAccount, requireStoreSameOrigin, storeErrorResponse } from "./store/auth.js";
import { testNotification } from "./maoyan/notification-copy.js";

export { LockCoordinator } from "./maoyan/lock-runner.js";
export { MonitorDispatcher } from "./maoyan/monitor-dispatcher.js";
export { MonitorCoordinator } from "./maoyan/monitor-coordinator.js";
export { NotificationDispatcher } from "./maoyan/notification-outbox.js";
import { dispatchMonitorBatch } from "./maoyan/monitor-dispatcher.js";
import { readBusinessPolicy } from "./maoyan/business-policy-store.js";
import { businessTime, formatMonitorWindowLabel } from "./maoyan/business-time.js";
import { recoverPendingNotifications } from "./maoyan/notification-outbox.js";
import { handleStatusApi } from "./maoyan/status-api.js";
import { checkManualOperationThroughCoordinator } from "./maoyan/lock-runner.js";
import { fetchManualCinemaThroughCoordinator } from "./maoyan/monitor-coordinator.js";
import { handleEnrollmentApi } from "./maoyan/enrollment-api.js";

const DECIMAL = /^\d+$/;
const MAOYAN_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: http:",
  "frame-src 'self' https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");
const STORE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

function staticAssetResponse(response, url, csp) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Content-Security-Policy", csp);
  if ((headers.get("Content-Type") || "").includes("text/html")) {
    headers.set("Cache-Control", "no-store");
  } else if (url.searchParams.has("v")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "public, max-age=300");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function serveMaoyanAsset(request, env, url = new URL(request.url)) {
  if (url.pathname === "/maoyan") {
    return Response.redirect(`${url.origin}/maoyan/`, 308);
  }
  if (!url.pathname.startsWith("/maoyan/") || !env.ASSETS) return null;
  const response = await env.ASSETS.fetch(request);
  return staticAssetResponse(response, url, MAOYAN_CSP);
}

export async function serveMaoyanApiAsset(request, env, url = new URL(request.url)) {
  if (request.method !== "GET" || url.pathname !== "/api/assets/thumbmark.umd.js" || !env.ASSETS) return null;
  const assetUrl = new URL("/maoyan/vendor/thumbmark.umd.js", url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, { headers: request.headers }));
  if (!response.ok || !/javascript/.test(response.headers.get("Content-Type") || "")) {
    return new Response("Asset unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return staticAssetResponse(response, url, MAOYAN_CSP);
}

export async function serveStoreAsset(request, env, url = new URL(request.url)) {
  if (url.pathname === "/store") return Response.redirect(`${url.origin}/store/`, 308);
  if (!url.pathname.startsWith("/store/") || !env.ASSETS) return null;
  const response = await env.ASSETS.fetch(request);
  return staticAssetResponse(response, url, STORE_CSP);
}

// 推送/上游失败的状态码: 凭据未配置属于客户端配置问题(400), 其余(渠道侧或猫眼侧异常)归为上游错误(502)
function upstreamStatus(message) {
  return /未配置$/.test(String(message || "")) ? 400 : 502;
}

async function publicConfig(config) {
  const { barkKey, serverChanKey, notifyVerification, monitorDdl, ...safeConfig } = config || {};
  const maskCredential = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.length <= 8) return text.slice(0, 1) + "•".repeat(Math.max(text.length - 2, 3)) + text.slice(-1);
    return text.slice(0, 4) + "•".repeat(6) + text.slice(-4);
  };
  return {
    ...safeConfig,
    enabled: config?.enabled === true,
    hasBark: Boolean(barkKey),
    hasServerChan: Boolean(serverChanKey),
    barkKeyHint: maskCredential(barkKey),
    serverChanKeyHint: maskCredential(serverChanKey),
    notifyVerified: await isNotificationVerified(config),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const enrollmentResponse = await handleEnrollmentApi(request, env, url);
    if (enrollmentResponse) return enrollmentResponse;
    try {
      const storeAuthResponse = await handleStoreAuth(request, env, url);
      if (storeAuthResponse) return storeAuthResponse;
      if (url.pathname.startsWith("/store/api/") || url.pathname === "/store/file") {
        await requireActiveStoreAccount(request, env, serviceNow(env));
        if (url.pathname.startsWith("/store/api/") && request.method === "POST") {
          requireStoreSameOrigin(request, url);
        }
        if (url.pathname.startsWith("/store/api/")) return handleStoreApi(request, url);
        return handleStoreFile(url);
      }
    } catch (error) {
      return storeErrorResponse(error);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const maoyanApiAsset = await serveMaoyanApiAsset(request, env, url);
    if (maoyanApiAsset) return maoyanApiAsset;

    if (!url.pathname.startsWith("/api/")) {
      const storeAssetResponse = await serveStoreAsset(request, env, url);
      if (storeAssetResponse) return storeAssetResponse;
      const assetResponse = await serveMaoyanAsset(request, env, url);
      if (assetResponse) return assetResponse;
      return json({ error: "Not Found" }, 404);
    }

    try {
      const publicAccountResponse = await handlePublicAccountApi(request, env, url);
      if (publicAccountResponse) return publicAccountResponse;
    } catch (error) {
      return accountErrorResponse(error);
    }

    // ---- 令牌管理接口(管理员, X-Admin-Token 鉴权) ----
    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminTokens(request, env, url);
    }

    // ---- 以下接口均需账号凭据或管理员监控会话 ----
    const principal = await authenticate(request, env, serviceNow(env));
    if (!principal) return json({ ok: false, code: "UNAUTHORIZED", error: "访问密钥无效" }, 401);
    const token = principal.userId;
    try {
      requireBusinessAccess(principal, "maoyan");
      const accountResponse = await handleAccountApi(request, env, url, principal);
      if (accountResponse) return accountResponse;

      // 到期/暂停账号仍可查看自身状态、既有规则，并主动清理会话或取消规则。
      const restrictedLockRoute =
        (url.pathname === "/api/lock/rule" && request.method === "GET") ||
        (url.pathname === "/api/lock/session/status" && request.method === "GET") ||
        (url.pathname === "/api/lock/session/remove" && request.method === "POST") ||
        (url.pathname === "/api/lock/rule/cancel" && request.method === "POST");
      if (restrictedLockRoute) return await handleLockApi(request, env, url, token);
      if (url.pathname === "/api/config" && request.method === "POST" && principal.accountStatus !== "active") {
        const body = await request.json().catch(() => null);
        const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
        if (keys.length === 1 && keys[0] === "enabled" && body.enabled === false) {
          const cfg = await getUserConfig(env, token);
          cfg.enabled = false;
          cfg.stopReason = "manual";
          await saveUserConfig(env, token, cfg);
          return json({ ok: true, config: await publicConfig(cfg) });
        }
      }
      const restrictedAccountRoute = url.pathname === "/api/status" && request.method === "GET";
      const restrictedHistoryRoute = url.pathname === "/api/changes" && request.method === "GET";
      if (!restrictedAccountRoute && !restrictedHistoryRoute) await requireActiveAccount(env, token, serviceNow(env));

      const statusResponse = await handleStatusApi(request, env, url, principal);
      if (statusResponse) return statusResponse;

      const lockResponse = await handleLockApi(request, env, url, token);
      if (lockResponse) return lockResponse;
      // ---- 城市列表 ----
      if (url.pathname === "/api/cities") {
        return json({ ok: true, cities: CITY_LIST });
      }
      // ---- 影院模糊搜索 ----
      if (url.pathname === "/api/cinemas") {
        const cityId = (url.searchParams.get("cityId") || "").trim();
        const kw = (url.searchParams.get("kw") || "").trim();
        if (!cityId) return json({ ok: false, error: "缺少 cityId" }, 400);
        if (!DECIMAL.test(cityId)) return json({ ok: false, error: "cityId 无效" }, 400);
        if (!kw) return json({ ok: false, error: "缺少 kw" }, 400);
        let cinemas;
        try {
          cinemas = await searchCinemasByKw(env, cityId, kw);
        } catch (e) {
          return json({ ok: false, error: e.message }, 502);
        }
        return json({ ok: true, cinemas });
      }
      if (url.pathname === "/api/shows") {
        const cfg = await getUserConfig(env, token);
        const cinemaId = (url.searchParams.get("cinemaId") || "").trim() || cfg.cinemaId;
        if (!cinemaId) return json({ ok: false, error: "缺少 cinemaId" }, 400);
        if (!DECIMAL.test(String(cinemaId))) return json({ ok: false, error: "cinemaId 无效" }, 400);
        let data;
        try {
          data = await fetchCinemaDetail(String(cinemaId));
        } catch (e) {
          return json({ ok: false, error: e.message }, 502);
        }
        return json({ ok: true, cinemaId, ...publicCinemaShows(data) });
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        const cronExprs = await resolveCronExprs(env);
        const policy = await readBusinessPolicy(env.DB);
        return json({
          ok: true,
          config: {
            ...await publicConfig(cfg),
            cronMinutes: minBatchMinutes(cronExprs),
            cronExprs,
            cronText: describeCrons(cronExprs) + " · " + formatMonitorWindowLabel(policy),
            cronMinuteStep: isMinuteStepCrons(cronExprs),
          },
        });
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json({ ok: false, error: "请求体须为 JSON 对象" }, 400);
        }
        const cfg = await getUserConfig(env, token);
        const expectedVersion = body.expectedVersion === undefined ? cfg.version : Number(body.expectedVersion);
        let cinemaChanged = false;
        if (body.cinemaId !== void 0 && String(body.cinemaId).trim()) {
          // 空值不覆盖: 防止异常状态下误清空已配置的影院
          const cinemaId = String(body.cinemaId).trim();
          if (!DECIMAL.test(cinemaId)) return json({ ok: false, error: "影院 ID 须为纯数字" }, 400);
          // 影院切换时旧场次快照失效: 快照按影片 id 记 seqNo, 换影院后同影片的 seqNo 全部不同,
          // 不清理会把新影院该影片的全部场次误报为"新增场次"; 同一影院重复保存不受影响
          if (cfg.cinemaId && cfg.cinemaId !== cinemaId) {
            cinemaChanged = true;
          }
          cfg.cinemaId = cinemaId;
        }
        if (body.selectedMovieIds !== void 0) cfg.selectedMovieIds = (body.selectedMovieIds || []).map(String);
        // 注: 检查频率已完全跟随 cron 批次, 旧前端的 intervalMinutes 字段不再生效
        if (body.barkKey !== void 0) cfg.barkKey = String(body.barkKey).trim();
        if (body.serverChanKey !== void 0) cfg.serverChanKey = String(body.serverChanKey).trim();
        if (body.notifyChannel !== void 0) {
          const ch = String(body.notifyChannel).trim();
          if (!NOTIFY_CHANNELS[ch]) return json({ ok: false, error: "推送渠道无效" }, 400);
          cfg.notifyChannel = ch;
        }
        if (body.enabled !== void 0) {
          const enabled = Boolean(body.enabled);
          if (enabled && !currentCredential(cfg)) {
            return json({ ok: false, error: `请先配置当前推送渠道（${NOTIFY_CHANNELS[currentChannel(cfg)].label}）` }, 400);
          }
          if (enabled && !await isNotificationVerified(cfg)) {
            return json({ ok: false, error: "请先发送并确认当前推送渠道的测试推送" }, 400);
          }
          cfg.enabled = enabled;
          if (enabled) delete cfg.stopReason;
          else cfg.stopReason = "manual";
        }
        // 运行中必须始终有「可用且已验证」的推送渠道: 切到未配置/未验证的渠道时自动停止监控,
        // 否则监控继续跑、推送全部失败, 页面却仍显示"监控中"(静默失效)
        let notice = "";
        if (cfg.enabled === true && (!currentCredential(cfg) || !await isNotificationVerified(cfg))) {
          cfg.enabled = false;
          cfg.stopReason = "notification_invalid";
          notice = `推送渠道（${NOTIFY_CHANNELS[currentChannel(cfg)].label}）未配置或未验证，监控已自动停止；配置并发送测试推送后可重新开始监控`;
        }
        await saveUserConfig(env, token, cfg, expectedVersion);
        if (cinemaChanged) await db.deleteSnapshot(env.DB, token);
        if (notice) await appendChange(env, token, { type: "warn", text: notice });
        return json({ ok: true, config: await publicConfig(cfg), ...(notice ? { notice } : {}) });
      }
      if (url.pathname === "/api/check" && request.method === "POST") {
        const cfg = await getUserConfig(env, token);
        if (!cfg.cinemaId || cfg.enabled !== true) {
          const result = await runCheck(env, true, token);
          return result.ok ? json(result) : json(result, result.status || 400);
        }
        const coordinated = cfg.cinemaId ? await fetchManualCinemaThroughCoordinator(env, {
          userId: token, cinemaId: cfg.cinemaId, nowMs: serviceNow(env)
        }) : null;
        const rate = coordinated || await checkManualOperationThroughCoordinator(env, token, {
          kind: "check", cinemaId: cfg.cinemaId || "", nowMs: serviceNow(env)
        });
        if (!rate.allowed) return json({ ok: false, code: "RATE_LIMITED", error: "操作过于频繁，请稍后重试" }, 429, {
          "Retry-After": String(rate.retryAfterSeconds)
        });
        const result = await runCheck(env, true, token, coordinated ? { fetchCinema: async () => coordinated.data } : {});
        return result.ok ? json(result) : json(result, result.status || 400);
      }
      // ---- 按当前选中渠道发送测试推送 ----
      if (url.pathname === "/api/test-push" && request.method === "POST") {
        const rate = await checkManualOperationThroughCoordinator(env, token, {
          kind: "test-push", nowMs: serviceNow(env)
        });
        if (!rate.allowed) return json({ ok: false, code: "RATE_LIMITED", error: "操作过于频繁，请稍后重试" }, 429, {
          "Retry-After": String(rate.retryAfterSeconds)
        });
        const cfg = await getUserConfig(env, token);
        const notification = testNotification();
        let label;
        try {
          label = await pushNotify(cfg, notification.title, notification.content);
        } catch (e) {
          return json({ ok: false, error: e.message }, upstreamStatus(e.message));
        }
        cfg.notifyVerification = await notificationVerification(cfg);
        await saveUserConfig(env, token, cfg);
        return json({ ok: true, channel: currentChannel(cfg), label, config: await publicConfig(cfg) });
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        const cronExprs = await resolveCronExprs(env);
        const policy = await readBusinessPolicy(env.DB);
        const st = await db.getStatus(env.DB, token) || {};
        const status = {
          lastCheckTs: st.lastCheckTs,
          lastCheck: st.lastCheck,
          lastError: st.lastError || null,
          cinemaName: st.cinemaName,
          newTotal: st.newTotal,
          enabled: cfg.enabled === true
        };
        const changes = await db.listChanges(env.DB, token);
        return json({
          ok: true,
          authMode: "token",
          lockServiceEnabled: String(env.LOCK_SERVICE_ENABLED) === "true",
          status,
          changes,
          cronMinutes: minBatchMinutes(cronExprs),
          cronExprs,
          cronText: describeCrons(cronExprs) + " · " + formatMonitorWindowLabel(policy),
          cronMinuteStep: isMinuteStepCrons(cronExprs),
        });
      }
      return json({ error: "Unknown API" }, 404);
    } catch (e) {
      if (e?.code) return accountErrorResponse(e);
      return json({ ok: false, error: e.message }, 500);
    }
  },

  async scheduled(event, env) {
    const nowMs = serviceNow(env);
    await recoverPendingNotifications(env, { nowMs, limit: 10 });
    const policy = await readBusinessPolicy(env.DB);
    const { monitorOpen, maintenanceOpen } = businessTime(nowMs, policy);
    if (maintenanceOpen) await runScheduledMaintenance(env, nowMs, policy);
    if (!monitorOpen) return;
    if (!env.MONITOR_DISPATCHER || !env.MONITOR_COORDINATOR) {
      await runScheduledChecks(env, (tokenId, cinemaData) =>
        runScheduledLockAfterMonitor(env, tokenId, cinemaData), { now: new Date(nowMs), policy });
      return;
    }
    const batchMinutes = minBatchMinutes(await resolveCronExprs(env));
    const scheduledTime = Number(event?.scheduledTime);
    const batchId = String(Math.floor((Number.isFinite(scheduledTime) && scheduledTime > 0 ? scheduledTime : nowMs) / (batchMinutes * 60_000)));
    await dispatchMonitorBatch(env, { batchId, nowMs });
  }
};
