// ---------------- Worker 入口: 路由分发 ----------------

import { CORS, json } from "./common/http.js";
import { userKey, getUserConfig } from "./common/user.js";
import { CITY_LIST, fetchCinemaDetail, searchCinemasByKw, runCheck, pushBark, checkAuthFull, syncCronTokens, handleAdminTokens, runScheduledChecks } from "./maoyan/index.js";
import { handleStoreApi, handleStoreFile } from "./store/proxy.js";

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
    if (url.pathname === "/api/admin/tokens") return handleAdminTokens(request, env, url);

    // ---- 以下接口均需 X-Token ----
    const token = await checkAuthFull(request, env, url);
    if (token === null) return json({ error: "访问令牌错误" }, 401);
    await syncCronTokens(env);
    try {
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
        return json({
          ok: true,
          cinemaId,
          cinemaName: data.showData.cinemaName,
          movies: (data.showData.movies || []).map((m) => ({
            id: m.id,
            nm: m.nm,
            showCount: m.showCount,
            shows: (m.shows || []).map((d) => ({
              showDate: d.showDate || d.dt || "",
              plist: (d.plist || []).map((p) => ({
                tm: p.tm,
                lang: p.lang,
                tp: p.tp,
                th: p.th,
                vipPrice: p.vipPrice,
                vipPriceSuffix: p.vipPriceSuffix,
                ticketStatus: p.ticketStatus
              }))
            }))
          }))
        });
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        return json({ ok: true, config: { enabled: cfg.enabled !== false, ...cfg } });
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        const body = await request.json();
        const key = userKey(token, "config");
        const cfg = await env.MAOYAN_KV.get(key, "json") || await getUserConfig(env, token);
        if (body.enabled !== void 0) cfg.enabled = Boolean(body.enabled);
        if (body.cinemaId !== void 0) cfg.cinemaId = String(body.cinemaId).trim();
        if (body.selectedMovieIds !== void 0) cfg.selectedMovieIds = (body.selectedMovieIds || []).map(String);
        if (body.intervalMinutes !== void 0) cfg.intervalMinutes = Math.max(1, parseInt(body.intervalMinutes, 10) || 10);
        if (body.barkKey !== void 0) cfg.barkKey = String(body.barkKey).trim();
        if (body.enabled === void 0 && body.cinemaId !== void 0) cfg.enabled = true;
        await env.MAOYAN_KV.put(key, JSON.stringify(cfg));
        return json({ ok: true, config: { enabled: cfg.enabled !== false, ...cfg } });
      }
      if (url.pathname === "/api/check" && request.method === "POST") {
        return json(await runCheck(env, true, token));
      }
      if (url.pathname === "/api/test-bark" && request.method === "POST") {
        const cfg = await getUserConfig(env, token);
        await pushBark(cfg.barkKey, "猫眼场次监控", "这是一条测试推送, 云端 Bark 配置成功 ✅");
        return json({ ok: true });
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        const st = await env.MAOYAN_KV.get(userKey(token, "status"), "json") || {};
        const status = {
          lastCheckTs: st.lastCheckTs,
          lastCheck: st.lastCheck,
          cinemaName: st.cinemaName,
          newTotal: st.newTotal,
          enabled: cfg.enabled !== false
        };
        const changes = await env.MAOYAN_KV.get(userKey(token, "changes"), "json") || [];
        return json({ ok: true, authMode: "token", status, changes });
      }
      return json({ error: "Unknown API" }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },

  async scheduled(event, env) {
    await runScheduledChecks(env);
  }
};
