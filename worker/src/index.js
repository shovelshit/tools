// ---------------- Worker 入口: 路由分发 ----------------

import { CORS, json } from "./common/http.js";
import { NOTIFY_CHANNELS, pushBark } from "./common/notify.js";
import { userKey, getUserConfig } from "./maoyan/user.js";
import { CITY_LIST, fetchCinemaDetail, publicCinemaShows, searchCinemasByKw, runCheck, pushNotify, currentChannel, minBatchMinutes, describeCrons, isMinuteStepCrons, resolveCronExprs, ddlFromNow, checkAuthFull, handleAdminTokens, handleLockApi, runScheduledChecks, runScheduledLockAfterMonitor } from "./maoyan/index.js";
import { handleStoreApi, handleStoreFile } from "./store/proxy.js";

export { LockCoordinator } from "./maoyan/lock-runner.js";

function publicConfig(config) {
  const { barkKey, serverChanKey, ...safeConfig } = config || {};
  return {
    ...safeConfig,
    enabled: config?.enabled === true,
    hasBark: Boolean(barkKey),
    hasServerChan: Boolean(serverChanKey),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ---- store 工具页(无需登录) ----
    if (url.pathname.startsWith("/store/api/")) return handleStoreApi(request, url);
    if (url.pathname === "/store/file") return handleStoreFile(url);

    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "Not Found" }, 404);
    }

    // ---- 令牌管理接口(管理员, X-Admin-Token 鉴权) ----
    if (url.pathname === "/api/admin/tokens" || url.pathname === "/api/admin/tokens/revoke") {
      return handleAdminTokens(request, env, url);
    }

    // ---- 以下接口均需 X-Token ----
    const token = await checkAuthFull(request, env);
    if (token === null) return json({ error: "访问令牌错误" }, 401);
    try {
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
        if (!kw) return json({ ok: false, error: "缺少 kw" }, 400);
        const cinemas = await searchCinemasByKw(env, cityId, kw);
        return json({ ok: true, cinemas });
      }
      if (url.pathname === "/api/shows") {
        const cfg = await getUserConfig(env, token);
        const cinemaId = (url.searchParams.get("cinemaId") || "").trim() || cfg.cinemaId;
        if (!cinemaId) return json({ ok: false, error: "缺少 cinemaId" });
        const data = await fetchCinemaDetail(cinemaId);
        return json({ ok: true, cinemaId, ...publicCinemaShows(data) });
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        const cronExprs = await resolveCronExprs(env);
        return json({
          ok: true,
          config: {
            ...publicConfig(cfg),
            cronMinutes: minBatchMinutes(cronExprs),
            cronExprs,
            cronText: describeCrons(cronExprs),
            cronMinuteStep: isMinuteStepCrons(cronExprs),
          },
        });
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        const body = await request.json();
        const key = userKey(token, "config");
        const cfg = await env.MAOYAN_KV.get(key, "json") || await getUserConfig(env, token);
        if (body.enabled !== void 0) {
          cfg.enabled = Boolean(body.enabled);
          // 每次显式「开始监控」都刷新一次截止时间(30 天)
          if (cfg.enabled) cfg.monitorDdl = ddlFromNow();
        }
        if (body.cinemaId !== void 0 && String(body.cinemaId).trim()) {
          // 空值不覆盖: 防止异常状态下误清空已配置的影院
          cfg.cinemaId = String(body.cinemaId).trim();
        }
        if (body.selectedMovieIds !== void 0) cfg.selectedMovieIds = (body.selectedMovieIds || []).map(String);
        // 注: 检查频率已完全跟随 cron 批次, 旧前端的 intervalMinutes 字段不再生效
        if (body.barkKey !== void 0) cfg.barkKey = String(body.barkKey).trim();
        if (body.serverChanKey !== void 0) cfg.serverChanKey = String(body.serverChanKey).trim();
        if (body.notifyChannel !== void 0) {
          const ch = String(body.notifyChannel).trim();
          cfg.notifyChannel = NOTIFY_CHANNELS[ch] ? ch : "bark";
        }
        await env.MAOYAN_KV.put(key, JSON.stringify(cfg));
        return json({ ok: true, config: publicConfig(cfg) });
      }
      if (url.pathname === "/api/check" && request.method === "POST") {
        return json(await runCheck(env, true, token));
      }
      if (url.pathname === "/api/test-bark" && request.method === "POST") {
        const cfg = await getUserConfig(env, token);
        await pushBark(cfg.barkKey, "猫眼场次监控", "这是一条测试推送, 云端 Bark 配置成功 ✅");
        return json({ ok: true });
      }
      // ---- 按当前选中渠道发送测试推送 ----
      if (url.pathname === "/api/test-push" && request.method === "POST") {
        const cfg = await getUserConfig(env, token);
        const label = await pushNotify(cfg, "猫眼场次监控", "这是一条测试推送, 云端推送配置成功 ✅");
        return json({ ok: true, channel: currentChannel(cfg), label });
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        const cronExprs = await resolveCronExprs(env);
        const st = await env.MAOYAN_KV.get(userKey(token, "status"), "json") || {};
        const status = {
          lastCheckTs: st.lastCheckTs,
          lastCheck: st.lastCheck,
          lastError: st.lastError || null,
          cinemaName: st.cinemaName,
          newTotal: st.newTotal,
          enabled: cfg.enabled === true,
          monitorDdl: cfg.monitorDdl || null
        };
        const changes = await env.MAOYAN_KV.get(userKey(token, "changes"), "json") || [];
        return json({
          ok: true,
          authMode: "token",
          lockServiceEnabled: String(env.LOCK_SERVICE_ENABLED) === "true",
          status,
          changes,
          cronMinutes: minBatchMinutes(cronExprs),
          cronExprs,
          cronText: describeCrons(cronExprs),
          cronMinuteStep: isMinuteStepCrons(cronExprs),
        });
      }
      return json({ error: "Unknown API" }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },

  async scheduled(_event, env) {
    await runScheduledChecks(env, (tokenId, cinemaData) =>
      runScheduledLockAfterMonitor(env, tokenId, cinemaData));
  }
};
