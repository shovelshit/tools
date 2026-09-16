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
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const [, profile, ...parts] = url.pathname.split("/");
    const route = "/" + parts.join("/");
    requests.push({ path: url.pathname, method: request.method, token: request.headers["x-token"] });
    const reply = (data, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
    if (request.headers["x-token"] !== `${profile}-token`) return reply({ error: "Invalid token" }, 401);
    if (route === "/api/status") return reply({ ok: true, authMode: "token", lockServiceEnabled: true, status: { lastCheckTs: 0, lastCheck: null, lastError: null, cinemaName: "", newTotal: 0, enabled: false, monitorDdl: null }, changes: [], ...cron });
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
  return { url: `http://127.0.0.1:${server.address().port}`, requests, uploads, close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

module.exports = { startMockWorker };
