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
      return { ok: true, json: async () => ({ profile: { id: "user-a" } }) };
    },
    getWorkerUrl: () => "https://stale.example",
    getToken: () => "stale-token"
  });

  const result = await runtime.connectWorker({ workerUrl: "https://worker.example", token: "token-a" });
  assert.equal(requests[0].url, "https://worker.example/api/status");
  assert.equal(requests[0].options.headers["X-Token"], "token-a");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: { profile: { id: "user-a" } }, profile: { id: "user-a" }, httpRisk: false
  });
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
