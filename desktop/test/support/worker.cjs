const http = require("node:http");

async function startMockWorker({ rejectUpload = false } = {}) {
  const requests = [];
  const uploads = [];
  const sessions = new Map(["one", "two"].map((key) => [key, { uploaded: true, uidMasked: "UID 987***321", sourceSavedAt: "2026-01-01T00:00:00.000Z" }]));
  const cron = { cronMinutes: 5, cronExprs: ["*/5 * * * *"], cronText: "Every 5 minutes", cronMinuteStep: true };
  const configs = new Map(["one", "two"].map((key) => [key, {
    enabled: false,
    cinemaId: "",
    selectedMovieIds: [],
    monitorDdl: null,
    notifyChannel: "bark",
    hasBark: false,
    hasServerChan: false,
    notifyVerified: false,
    ...cron,
  }]));
  const store = {
    catalogRequests: 0,
    mode: "normal",
    deferred: null,
    loginDeferred: null,
    detailDeferred: null,
    fileDeferred: null,
    account: null,
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const reply = (data, code = 200, headers = {}) => {
      response.writeHead(code, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith("/store/")) {
      let text = "";
      for await (const chunk of request) text += chunk;
      let body = {};
      try { body = JSON.parse(text || "{}"); } catch {}
      const authenticated = /(?:^|;\s*)store_session=valid(?:;|$)/.test(request.headers.cookie || "");
      if (url.pathname === "/store/auth/session" && request.method === "POST") {
        if (store.loginDeferred) {
          store.loginDeferred.startedResolve();
          await store.loginDeferred.promise;
        }
        const expired = body.key === "expired-store-token";
        if (body.key !== "store-token" && !expired) return reply({ ok: false, code: "UNAUTHORIZED", error: "访问密钥无效" }, 401);
        store.account = {
          userId: "store-user", role: "user", businessLine: "store", remark: "车载应用",
          accountStatus: expired ? "expired" : "active", expiresAt: expired ? Date.now() - 1000 : Date.now() + 86400000,
          version: 1, accountVersion: 1
        };
        return reply({ ok: true, account: store.account }, 200, { "Set-Cookie": "store_session=valid; HttpOnly; SameSite=Lax; Path=/store/" });
      }
      if (url.pathname === "/store/auth/session" && request.method === "GET") {
        if (!authenticated || !store.account) return reply({ ok: false, code: "UNAUTHORIZED", error: "登录状态无效" }, 401);
        return reply({ ok: true, account: store.account });
      }
      if (url.pathname === "/store/auth/logout" && request.method === "POST") {
        store.account = null;
        return reply({ ok: true }, 200, { "Set-Cookie": "store_session=; HttpOnly; SameSite=Lax; Path=/store/; Max-Age=0" });
      }
      if (url.pathname === "/store/auth/renew" && request.method === "POST") {
        if (!authenticated || !store.account) return reply({ ok: false, code: "UNAUTHORIZED", error: "登录状态无效" }, 401);
        store.account = { ...store.account, accountStatus: "active", expiresAt: Date.now() + 86400000, version: 2, accountVersion: 2 };
        return reply({ ok: true, account: store.account });
      }
      if (!authenticated || store.account?.accountStatus !== "active") {
        return reply({ ok: false, code: store.account ? "ACCOUNT_EXPIRED" : "UNAUTHORIZED", error: "无权访问" }, store.account ? 403 : 401);
      }
      if (url.pathname === "/store/api/fs/list") {
        store.catalogRequests += 1;
        if (store.deferred) await store.deferred.promise;
        if (store.mode === "error") return reply({ message: "provider unavailable" }, 502);
        const content = store.mode === "empty" ? [] : [
          { name: "Navigation.apk", is_dir: false, size: 1048576, modified: "2026-09-16T04:00:00Z" }
        ];
        return reply({ code: 200, data: { content, total: content.length } });
      }
      if (url.pathname === "/store/api/fs/get") {
        if (store.detailDeferred) {
          const pending = store.detailDeferred;
          store.detailDeferred = null;
          pending.startedResolve();
          await pending.promise;
        }
        const requestedPath = String(body.path || "/Navigation.apk");
        const name = requestedPath.split("/").pop() || "Navigation.apk";
        return reply({ code: 200, data: {
          name, size: 1048576, modified: "2026-09-16T04:00:00Z",
          created: "2026-09-16T04:00:00Z", provider: "Mock", raw_url: `http://appstore.cnmlynk.org/${encodeURIComponent(name)}`
        } });
      }
      if (url.pathname === "/store/file") {
        if (store.fileDeferred) {
          const pending = store.fileDeferred;
          store.fileDeferred = null;
          pending.startedResolve();
          await pending.promise;
        }
        const target = new URL(url.searchParams.get("url"));
        const name = decodeURIComponent(target.pathname.split("/").pop() || "Navigation.apk");
        const text = name.endsWith(".txt");
        response.writeHead(200, {
          "Content-Type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
          "Content-Disposition": `attachment; filename=${name}`
        });
        response.end(text ? `${name} preview` : "mock-apk");
        return;
      }
      return reply({ error: "Unknown Store API" }, 404);
    }
    const [, profile, ...parts] = url.pathname.split("/");
    const route = "/" + parts.join("/");
    requests.push({ path: url.pathname, method: request.method, token: request.headers["x-token"] });
    if (route === "/api/enrollment/config") return reply({
      ok: true,
      enabled: true,
      validDays: 15,
      capacity: { maxUsers: 20, used: 20, reserved: 0, remaining: 0 },
      sourceUrl: "https://github.com/shovelshit/tools",
      turnstileSiteKey: "mock-site-key",
    });
    if (request.headers["x-token"] !== `${profile}-token`) return reply({ error: "Invalid token" }, 401);
    if (route === "/api/capabilities") return reply({ ok: true, accountLifecycle: true, adminMonitorSession: true });
    if (route === "/api/auth/session" && request.method === "POST") return reply({
      ok: true,
      account: { id: `${profile}-user`, role: "user", state: "active", accountStatus: "active", expiresAt: Date.now() + 86400000, version: 1 },
    });
    if (route === "/api/status") return reply({ ok: true, authMode: "token", lockServiceEnabled: true, status: { lastCheckTs: 0, lastCheck: null, lastError: null, cinemaName: "", newTotal: 0, enabled: false, monitorDdl: null }, changes: [], ...cron });
    if (route === "/api/changes") return reply({ ok: true, items: [], nextAfterId: null });
    if (route === "/api/config") {
      if (request.method === "POST") {
        let text = "";
        for await (const chunk of request) text += chunk;
        const input = JSON.parse(text || "{}");
        const previous = configs.get(profile);
        const next = { ...previous, ...input };
        if (input.barkKey) next.hasBark = true;
        if (input.serverChanKey) next.hasServerChan = true;
        configs.set(profile, next);
      }
      return reply({ ok: true, config: configs.get(profile) });
    }
    if (route === "/api/cities") return reply({ ok: true, cities: [{ id: "10", name: "上海", pinyin: "shanghai" }] });
    if (route === "/api/cinemas") return reply({ ok: true, cinemas: [{ id: "25428", nm: "寰映影城（大融城激光IMAX店）", addr: "上海市静安区" }] });
    if (route === "/api/shows") return reply({
      ok: true,
      cinemaId: "25428",
      cinemaName: "寰映影城（大融城激光IMAX店）",
      movies: [{ id: "100", nm: "奥德赛", showCount: 1, shows: [{ showDate: "2026-09-19", plist: [{ seqNo: "900", tm: "18:40", lang: "英语", tp: "IMAX2D", th: "1号激光IMAX厅", ticketStatus: 0 }] }] }],
    });
    if (route === "/api/test-push" && request.method === "POST") {
      const next = { ...configs.get(profile), notifyVerified: true };
      configs.set(profile, next);
      return reply({ ok: true, label: next.notifyChannel === "serverchan" ? "Server酱" : "Bark" });
    }
    if (route === "/api/check" && request.method === "POST") return reply({ ok: true, cinemaName: "寰映影城（大融城激光IMAX店）", newTotal: 0 });
    if (route === "/api/lock/rule" && request.method === "GET") return reply({ ok: true, rule: null });
    if (route === "/api/lock/session/status") return reply({ session: sessions.get(profile) });
    if (route === "/api/lock/template-seats" && request.method === "GET") return reply({
      seatMap: {
        seqNo: url.searchParams.get("seqNo") || "900",
        sectionId: "1",
        sectionName: "1号激光IMAX厅",
        cols: 4,
        seats: [
          { seatNo: "1-1-1", rowId: "1", columnId: "1", type: "N", available: true, availability: "available", disabledReason: null, orderIndex: 1 },
          { seatNo: "1-1-2", rowId: "1", columnId: "2", type: "N", available: false, availability: "sold", disabledReason: "已售", orderIndex: 2 },
          { seatNo: "1-1-3", rowId: "1", columnId: "3", type: "N", available: false, availability: "unknown", disabledReason: "状态未知", orderIndex: 3 },
        ],
      },
    });
    if (route === "/api/lock/official-seats" && request.method === "GET") return reply({
      seqNo: url.searchParams.get("seqNo") || "900",
      officialHtml: '<div class="seats-block" data-section-id="1" data-section-name="1号激光IMAX厅" data-seq-no="900"><span class="seat selectable" data-row-id="1" data-column-id="1" data-no="1-1-1" data-st="N"></span></div>',
    });
    if (route === "/api/lock/session/remove" && request.method === "POST") {
      sessions.set(profile, { uploaded: false });
      return reply({ removed: true });
    }
    if (route === "/api/lock/session" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      let body;
      try { body = JSON.parse(text); } catch { return reply({ error: "Invalid JSON" }, 400); }
      uploads.push(body);
      if (rejectUpload) return reply({ error: "Upload rejected" }, 400);
      sessions.set(profile, { uploaded: true, uidMasked: "UID 123***789", sourceSavedAt: body.saved_at });
      return reply({ session: sessions.get(profile) });
    }
    reply({ error: "Unknown API" }, 404);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    uploads,
    store,
    setStoreMode(mode) { store.mode = mode; },
    deferNextStoreList() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      store.deferred = { promise, release: () => { store.deferred = null; release(); } };
      return store.deferred;
    },
    deferNextStoreLogin() {
      let release;
      let startedResolve;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      store.loginDeferred = {
        promise,
        started,
        startedResolve,
        release: () => { store.loginDeferred = null; release(); }
      };
      return store.loginDeferred;
    },
    deferNextStoreDetail() {
      let release;
      let startedResolve;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      store.detailDeferred = {
        promise,
        started,
        startedResolve,
        release: () => { store.detailDeferred = null; release(); }
      };
      return store.detailDeferred;
    },
    deferNextStoreFile() {
      let release;
      let startedResolve;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      store.fileDeferred = {
        promise,
        started,
        startedResolve,
        release: () => { store.fileDeferred = null; release(); }
      };
      return store.fileDeferred;
    },
    close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); })
  };
}

module.exports = { startMockWorker };
