const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createWorkerClient, normalizeWorkerUrl } = require("../main/worker-client");

function makeFixture({ encryptionAvailable = true, fetchImpl, confirmHttp } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-worker-client-"));
  return {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => Buffer.from(`protected:${value}`),
      decryptString: (value) => value.toString().slice("protected:".length)
    },
    fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ profile: { id: "profile-a" } }) })),
    confirmHttp: confirmHttp ?? (async () => true),
    userData,
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true })
  };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("normalizes an HTTPS Worker and rejects credentials query fragment and non-HTTP URLs", () => {
  assert.deepEqual(normalizeWorkerUrl(" https://worker.example/api/ "), {
    baseUrl: "https://worker.example/api",
    protocol: "https:",
    hostname: "worker.example",
    isLoopback: false,
    requiresHttpConfirmation: false
  });
  assert.throws(() => normalizeWorkerUrl("https://u:p@worker.example"), /用户名|密码/);
  assert.throws(() => normalizeWorkerUrl("https://worker.example?token=x"), /查询|fragment/);
  assert.throws(() => normalizeWorkerUrl("https://worker.example#token"), /查询|fragment/);
  assert.throws(() => normalizeWorkerUrl("file:///tmp/worker"), /HTTP|HTTPS/);
});

test("non-loopback HTTP requires confirmation before connect and upload", async () => {
  const fixture = makeFixture({ confirmHttp: async () => false });
  try {
    const client = createWorkerClient(fixture);
    await assert.rejects(client.connectWorker({ workerUrl: "http://worker.example", token: "t" }), /确认/);
    assert.equal(client.getProfile(), null);
  } finally {
    fixture.cleanup();
  }
});

test("requestWorker cannot send absolute URLs or arbitrary headers", async () => {
  const fixture = makeFixture();
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "https://worker.example", token: "t" });

    await assert.rejects(client.requestWorker("https://evil.example/api/status"), /路径/);
    await assert.rejects(client.requestWorker("/api/status", { headers: { Cookie: "secret" } }), /Header/);
  } finally {
    fixture.cleanup();
  }
});

test("requestWorker rejects encoded traversal before attaching the profile token", async () => {
  const requests = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "https://worker.example/prefix", token: "t" });

    await assert.rejects(client.requestWorker("/api/%2e%2e/admin"), /路径/);
    await assert.rejects(client.requestWorker("/api\\..\\admin"), /路径/);
    assert.equal(requests.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("requestWorker rejects cross-origin redirects before the token leaves the profile", async () => {
  let redirectedRequests = 0;
  let redirectedToken;
  const redirectTarget = await listen((request, response) => {
    redirectedRequests += 1;
    redirectedToken = request.headers["x-token"];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  const worker = await listen((request, response) => {
    if (request.url === "/api/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ profile: {} }));
      return;
    }
    response.writeHead(307, { Location: `${serverUrl(redirectTarget)}/stolen-token` });
    response.end();
  });
  const fixture = makeFixture({ fetchImpl: fetch });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: serverUrl(worker), token: "redirect-secret" });

    await assert.rejects(client.requestWorker("/api/redirect"));
    assert.equal(redirectedRequests, 0);
    assert.equal(redirectedToken, undefined);
  } finally {
    fixture.cleanup();
    await Promise.all([closeServer(worker), closeServer(redirectTarget)]);
  }
});

test("profiles use full normalized URLs so tokens and HTTP risk stay isolated", async () => {
  const requests = [];
  const fixture = makeFixture({
    encryptionAvailable: false,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ profile: { id: url } }) };
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example:8443/a/", token: "token-a", httpRiskConfirmed: true });
    await client.connectWorker({ workerUrl: "https://worker.example:9443/b", token: "token-b" });
    await client.requestWorker("/api/status");

    assert.equal(requests[2].url, "https://worker.example:9443/b/api/status");
    assert.deepEqual(requests[2].options.headers, { "X-Token": "token-b" });
    assert.deepEqual(client.getProfile(), {
      baseUrl: "https://worker.example:9443/b",
      updatedAt: client.getProfile().updatedAt,
      isLoopback: false,
      requiresHttpConfirmation: false
    });
    assert.doesNotMatch(fs.readFileSync(path.join(fixture.userData, "worker-profiles.json"), "utf8"), /token-[ab]/);
  } finally {
    fixture.cleanup();
  }
});

test("a failed status request clears only the newly supplied profile token", async () => {
  const requests = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === "https://worker.example/b/api/status") {
        return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
      }
      return { ok: true, status: 200, json: async () => ({ profile: {} }) };
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "https://worker.example/a", token: "token-a" });
    await assert.rejects(client.connectWorker({ workerUrl: "https://worker.example/b", token: "token-b" }), /unavailable/);
    await client.connectWorker({ workerUrl: "https://worker.example/a" });

    assert.equal(requests[2].options.headers["X-Token"], "token-a");
  } finally {
    fixture.cleanup();
  }
});

test("remote HTTP session upload requires a second explicit confirmation before fetch", async () => {
  const requests = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ profile: {} }) };
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", token: "t", httpRiskConfirmed: true });
    await assert.rejects(client.requestWorker("/api/lock/session", { method: "POST", body: "{}" }), /确认/);
    assert.equal(requests.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("requestWorker limits methods and JSON body size while constructing the fixed headers", async () => {
  const requests = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "https://worker.example", token: "t" });
    await assert.rejects(client.requestWorker("/api/status", { method: "PATCH" }), /方法/);
    await assert.rejects(client.requestWorker("/api/status", { method: "POST", body: JSON.stringify("x".repeat(256 * 1024 + 1)) }), /256 KiB/);
    await client.requestWorker("/api/test", { method: "POST", body: { ok: true } });

    assert.deepEqual(requests[1].options.headers, { "X-Token": "t", "Content-Type": "application/json" });
    assert.equal(requests[1].options.body, '{"ok":true}');
  } finally {
    fixture.cleanup();
  }
});
