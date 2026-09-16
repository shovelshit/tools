const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRuntime(windowOverrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, "runtime.js"), "utf8");
  const window = { ...windowOverrides };
  window.window = window;
  vm.runInNewContext(source, { window }, { filename: "runtime.js" });
  return window;
}

test("web runtime sends relative API requests with the token header", async () => {
  const { createWebRuntime } = loadRuntime();
  const requests = [];
  const runtime = createWebRuntime({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    getWorkerUrl: () => "https://worker.example",
    getToken: () => "token-a"
  });
  await runtime.requestWorker("/api/status");
  assert.equal(requests[0].url, "https://worker.example/api/status");
  assert.equal(requests[0].options.headers["X-Token"], "token-a");
});

test("electron runtime delegates login to the fixed bridge", async () => {
  const { createElectronRuntime } = loadRuntime();
  let calledWith;
  const runtime = createElectronRuntime({
    bridge: { loginMaoyan: async (cinemaId) => { calledWith = cinemaId; return { ok: true }; } }
  });
  await runtime.loginMaoyan("25428");
  assert.equal(calledWith, "25428");
});

test("web runtime connects with the supplied worker credentials", async () => {
  const { createWebRuntime } = loadRuntime();
  const requests = [];
  const runtime = createWebRuntime({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/capabilities")) return { ok: true, status: 200, json: async () => ({ accountLifecycle: true }) };
      if (url.endsWith("/api/auth/session")) return { ok: true, status: 200, json: async () => ({ account: { userId: "user-a", role: "user", accountStatus: "active" } }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, status: {} }) };
    },
    getWorkerUrl: () => "https://stale.example",
    getToken: () => "stale-token"
  });

  const result = await runtime.connectWorker({ workerUrl: "https://worker.example", token: "token-a" });
  assert.equal(requests[0].url, "https://worker.example/api/capabilities");
  assert.equal(requests[0].options.headers["X-Token"], "token-a");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: { ok: true, status: {} },
    profile: { userId: "user-a", role: "user", accountStatus: "active" },
    account: { userId: "user-a", role: "user", accountStatus: "active" },
    capabilities: { accountLifecycle: true },
    httpRisk: false,
    persistInputToken: true
  });
});

test("web runtime falls back only when capabilities explicitly returns 404", async () => {
  const requests = [];
  const runtime = loadRuntime().createWebRuntime({
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("/api/capabilities")) return { ok: false, status: 404, json: async () => ({ error: "Not Found" }) };
      return { ok: true, status: 200, json: async () => ({ profile: { id: "legacy" }, status: {} }) };
    },
    getWorkerUrl: () => "https://worker.example",
    getToken: () => "token-a"
  });
  const result = await runtime.connectWorker({ workerUrl: "https://worker.example", token: "token-a" });
  assert.deepEqual(requests, ["https://worker.example/api/capabilities", "https://worker.example/api/status"]);
  assert.equal(result.capabilities.accountLifecycle, false);
});

test("web runtime does not downgrade authentication failures to legacy", async () => {
  const requests = [];
  const runtime = loadRuntime().createWebRuntime({
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("/api/capabilities")) return { ok: true, status: 200, json: async () => ({ accountLifecycle: true }) };
      return { ok: false, status: 401, json: async () => ({ code: "UNAUTHORIZED", error: "访问密钥无效" }) };
    },
    getWorkerUrl: () => "https://worker.example",
    getToken: () => "bad"
  });
  await assert.rejects(runtime.connectWorker({ workerUrl: "https://worker.example", token: "bad" }), /访问密钥无效/);
  assert.deepEqual(requests, ["https://worker.example/api/capabilities", "https://worker.example/api/auth/session"]);
});

test("web runtime hides transport details when worker connection fails", async () => {
  const { createWebRuntime } = loadRuntime();
  const runtime = createWebRuntime({
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5"); },
    getWorkerUrl: () => "https://worker.example",
    getToken: () => "token-a"
  });

  await assert.rejects(
    runtime.connectWorker({ workerUrl: "https://worker.example", token: "token-a" }),
    { message: "无法连接服务，请检查服务地址和网络" }
  );
});
