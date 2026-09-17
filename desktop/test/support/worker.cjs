const http = require("node:http");

async function startMockWorker({ rejectUpload = false } = {}) {
  const requests = [];
  const uploads = [];
  const rules = new Map();
  const sessions = new Map(["one", "two"].map((key) => [key, { uploaded: true, uidMasked: "UID 987***321", sourceSavedAt: "2026-01-01T00:00:00.000Z" }]));
  const cron = { cronMinutes: 5, cronExprs: ["*/5 * * * *"], cronText: "Every 5 minutes", cronMinuteStep: true };
  const configs = new Map(["one", "two"].map((key) => [key, {
    enabled: false,
    version: 1,
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
    logoutDeferred: null,
    detailAuthFailureDeferred: null,
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
      if (url.pathname === "/store/api/fs/get" && store.detailAuthFailureDeferred) {
        const pending = store.detailAuthFailureDeferred;
        store.detailAuthFailureDeferred = null;
        pending.startedResolve();
        await pending.promise;
        return reply({ ok: false, code: "UNAUTHORIZED", error: "登录状态无效" }, 401);
      }
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
        if (store.logoutDeferred) {
          const pending = store.logoutDeferred;
          store.logoutDeferred = null;
          pending.startedResolve();
          await pending.promise;
        }
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
        let totalOverride = null;
        if (store.deferred && (!store.deferred.path || store.deferred.path === body.path)) {
          const pending = store.deferred;
          store.deferred = null;
          pending.startedResolve(body.path);
          await pending.promise;
          totalOverride = pending.total;
        }
        if (store.mode === "error") return reply({ message: "provider unavailable" }, 502);
        const content = store.mode === "empty" ? [] : [
          { name: "Navigation.apk", is_dir: false, size: 1048576, modified: "2026-09-16T04:00:00Z" }
        ];
        return reply({ code: 200, data: { content, total: totalOverride ?? content.length } });
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
    const admin = request.headers["x-token"] === `${profile}-admin`;
    const adminSession = request.headers["x-token"] === `${profile}-monitor-session`;
    if (request.headers["x-token"] !== `${profile}-token` && !admin && !adminSession) return reply({ error: "Invalid token" }, 401);
    if (route === "/api/capabilities") return reply({ ok: true, accountLifecycle: true, adminMonitorSession: true });
    if (route === "/api/auth/session" && request.method === "POST") return reply({
      ok: true,
      account: { id: `${profile}-user`, role: admin || adminSession ? "admin" : "user", state: "active", accountStatus: "active", expiresAt: Date.now() + 86400000, version: 1 },
      ...(admin ? { monitorSession: `${profile}-monitor-session` } : {}),
    });
    if (route === "/api/status") return reply({ ok: true, authMode: "token", lockServiceEnabled: true, status: { lastCheckTs: 0, lastCheck: null, lastError: null, cinemaName: "", newTotal: 0, enabled: configs.get(profile)?.enabled === true, monitorDdl: null }, changes: [], ...cron });
    if (route === "/api/changes") return reply({ ok: true, items: [], nextAfterId: null });
    if (route === "/api/config") {
      if (request.method === "POST") {
        let text = "";
        for await (const chunk of request) text += chunk;
        const input = JSON.parse(text || "{}");
        const previous = configs.get(profile);
        if (input.expectedVersion && input.expectedVersion !== previous.version) return reply({ error: "配置已在其他设备更新" }, 409);
        const next = { ...previous, ...input, version: previous.version + 1 };
        if (input.barkKey) next.hasBark = true;
        if (input.serverChanKey) next.hasServerChan = true;
        for (const field of ["barkKey", "serverChanKey"]) {
          if (input[field]) next[`${field}Hint`] = input[field].slice(0, 4) + "••••••" + input[field].slice(-4);
          delete next[field];
        }
        delete next.expectedVersion;
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
      movies: [{ id: "100", nm: "奥德赛", showCount: 3, shows: [{ showDate: "2026-09-19", plist: [
        { seqNo: "900", tm: "18:40", lang: "英语", tp: "IMAX2D", th: "宽幅测试厅", ticketStatus: 0 },
        { seqNo: "901", tm: "19:10", lang: "英语", tp: "IMAX2D", th: "高排测试厅", ticketStatus: 0 },
        { seqNo: "902", tm: "19:40", lang: "英语", tp: "IMAX2D", th: "稀疏测试厅", ticketStatus: 0 },
        { seqNo: "903", tm: "09:40", lang: "英语", tp: "IMAX2D", th: "倒序情侣座测试厅", ticketStatus: 0 }
      ] }] }],
    });
    if (route === "/api/test-push" && request.method === "POST") {
      const next = { ...configs.get(profile), notifyVerified: true, version: configs.get(profile).version + 1 };
      configs.set(profile, next);
      return reply({ ok: true, label: next.notifyChannel === "serverchan" ? "Server酱" : "Bark", config: next });
    }
    if (route === "/api/check" && request.method === "POST") return reply({ ok: true, cinemaName: "寰映影城（大融城激光IMAX店）", newTotal: 0 });
    if (route === "/api/lock/rule" && request.method === "GET") return reply({ ok: true, rule: rules.get(profile) || null });
    if (route === "/api/lock/rule" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const input = JSON.parse(text);
      const rule = { ...input, state: "waiting_schedule", automationEnabled: true, movieName: "奥德赛", hall: "倒序情侣座测试厅", templateTime: "09:40", seats: input.seatNos.map((seatNo) => ({seatNo, label: `3排${seatNo.split("-")[2]}座`})) };
      rules.set(profile, rule);
      return reply({ ok: true, rule });
    }
    if (route === "/api/lock/session/status") return reply({ session: sessions.get(profile) });
    if (route === "/api/lock/template-seats" && request.method === "GET") {
      const seqNo = url.searchParams.get("seqNo") || "900";
      const seat = (row, column, availability = "available") => ({
        seatNo: `1-${column}-${row}`, rowId: String(row), columnId: String(column), type: "N",
        available: availability === "available", availability,
        disabledReason: availability === "sold" ? "已售" : availability === "unknown" ? "状态未知" : null,
        orderIndex: column
      });
      const wideSeats = Array.from({ length: 4 }, (_, rowIndex) =>
        Array.from({ length: 90 }, (_, columnIndex) => seat(rowIndex + 1, columnIndex + 1,
          rowIndex === 0 && columnIndex === 1 ? "sold" : rowIndex === 0 && columnIndex === 2 ? "unknown" : "available"))).flat();
      const tallSeats = Array.from({ length: 30 }, (_, rowIndex) =>
        Array.from({ length: 5 }, (_, columnIndex) => seat(rowIndex + 1, columnIndex + 1))).flat();
      const sparseSeats = [
        seat(1, 1), seat(1, 12), seat(1, 24), seat(8, 3), seat(8, 19), seat(16, 7), seat(16, 30)
      ];
      const maps = {
        "900": { sectionName: "宽幅测试厅", cols: 90, seats: wideSeats },
        "901": { sectionName: "高排测试厅", cols: 5, seats: tallSeats },
        "902": { sectionName: "稀疏测试厅", cols: 30, seats: sparseSeats },
        "903": { sectionName: "倒序情侣座测试厅", cols: 35, seats: Array.from({ length: 11 }, (_, r) => Array.from({ length: 29 }, (_, c) => ({
          ...seat(r + 1, 29 - c), seatNo: `1-${r + 1}-${29 - c}`, orderIndex: c + 5,
          type: r === 2 && c === 15 ? "L" : r === 2 && c === 16 ? "R" : "N"
        }))).flat() }
      };
      return reply({ seatMap: { seqNo, sectionId: "1", ...maps[seqNo] || maps["900"] } });
    }
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
    deferNextStoreList({ path = "", total = null } = {}) {
      let release;
      let startedResolve;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      store.deferred = { path, total, promise, started, startedResolve, release };
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
    deferNextStoreLogout() {
      let release;
      let startedResolve;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      store.logoutDeferred = { promise, started, startedResolve, release };
      return store.logoutDeferred;
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
    deferNextStoreDetailAuthFailure() {
      let release;
      let startedResolve;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      store.detailAuthFailureDeferred = {
        promise,
        started,
        startedResolve,
        release
      };
      return store.detailAuthFailureDeferred;
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
