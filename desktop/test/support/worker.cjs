const http = require("node:http");

async function startMockWorker({ rejectUpload = false } = {}) {
  const requests = [];
  const uploads = [];
  const sessions = new Map(["one", "two"].map((key) => [key, { uploaded: true, uidMasked: "UID 987***321", sourceSavedAt: "2026-01-01T00:00:00.000Z" }]));
  const cron = { cronMinutes: 5, cronExprs: ["*/5 * * * *"], cronText: "Every 5 minutes", cronMinuteStep: true };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const [, profile, ...parts] = url.pathname.split("/");
    const route = "/" + parts.join("/");
    requests.push({ path: url.pathname, method: request.method, token: request.headers["x-token"] });
    const reply = (data, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
    if (request.headers["x-token"] !== `${profile}-token`) return reply({ error: "Invalid token" }, 401);
    if (route === "/api/status") return reply({ ok: true, authMode: "token", lockServiceEnabled: true, status: { lastCheckTs: 0, lastCheck: null, lastError: null, cinemaName: "", newTotal: 0, enabled: false, monitorDdl: null }, changes: [], ...cron });
    if (route === "/api/config") return reply({ ok: true, config: { enabled: false, cinemaId: "", selectedMovieIds: [], monitorDdl: null, notifyChannel: "bark", barkKey: "", serverChanKey: "", ...cron } });
    if (route === "/api/cities") return reply({ ok: true, cities: [] });
    if (route === "/api/lock/session/status") return reply({ session: sessions.get(profile) });
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
