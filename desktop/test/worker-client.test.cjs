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

test("session path aliases are rejected before upload or an HTTP confirmation", async () => {
  const requests = []; const confirmations = [];
  const fixture = makeFixture({
    fetchImpl: async (url) => { requests.push(url); return { ok: true, json: async () => ({}) }; },
    confirmHttp: async ({ operation }) => { confirmations.push(operation); return true; }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example/prefix", token: "t", httpRiskConfirmed: true });
    for (const alias of ["/api/lock/./session", "/api/lock/%2e/session", "/api/lock/%2E/session?x=1", "/api/lock/sess\tion"]) {
      await assert.rejects(client.requestWorker(alias, { method: "POST", body: {}, httpRiskConfirmed: true }), /路径/);
    }
    assert.deepEqual(requests, ["http://worker.example/prefix/api/status"]);
    assert.deepEqual(confirmations, ["connect"]);
    await client.requestWorker("/api/lock/session", { method: "POST", body: {}, httpRiskConfirmed: true });
    await client.requestWorker("/api/lock/session?x=1", { method: "POST", body: {} });
    assert.deepEqual(confirmations, ["connect", "session-upload"]);
    assert.equal(requests.length, 3);
  } finally { fixture.cleanup(); }
});

test("a delayed older connection cannot replace a newer active Worker", async () => {
  let releaseA; const requests = [];
  const fixture = makeFixture({ fetchImpl: async (url, options) => {
    requests.push({ url, token: options.headers["X-Token"] });
    if (url === "https://a.example/api/status") await new Promise((resolve) => { releaseA = resolve; });
    return { ok: true, json: async () => ({}) };
  } });
  try {
    const client = createWorkerClient(fixture);
    const older = client.connectWorker({ workerUrl: "https://a.example", token: "a" }).catch((error) => error);
    await new Promise(setImmediate);
    await client.connectWorker({ workerUrl: "https://b.example", token: "b" });
    releaseA();
    assert.equal((await older).code, "disconnected");
    assert.equal(client.getProfile().baseUrl, "https://b.example");
    await client.requestWorker("/api/config");
    assert.deepEqual(requests.at(-1), { url: "https://b.example/api/config", token: "b" });
  } finally { fixture.cleanup(); }
});

test("an older same-profile failure cannot erase newer accepted credentials", async () => {
  let failOlder; const requests = [];
  const fixture = makeFixture({ fetchImpl: async (url, options) => {
    const token = options.headers["X-Token"];
    requests.push({ url, token });
    if (token === "older") await new Promise((_resolve, reject) => { failOlder = reject; });
    return { ok: true, json: async () => ({}) };
  } });
  try {
    const client = createWorkerClient(fixture);
    const older = client.connectWorker({ workerUrl: "https://worker.example", token: "older" }).catch((error) => error);
    await new Promise(setImmediate);
    await client.connectWorker({ workerUrl: "https://worker.example", token: "newer" });
    failOlder(new Error("older failed")); await older;
    await client.requestWorker("/api/config");
    assert.deepEqual(requests.at(-1), { url: "https://worker.example/api/config", token: "newer" });
    const restored = createWorkerClient(fixture);
    await restored.connectWorker({ workerUrl: "https://worker.example" });
    assert.equal(requests.at(-1).token, "newer");
  } finally { fixture.cleanup(); }
});

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

test("requestWorker permits query parameters only on an in-profile API path", async () => {
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

    await client.requestWorker("/api/cinemas?cityId=1&kw=imax");
    assert.equal(requests[1].url, "https://worker.example/prefix/api/cinemas?cityId=1&kw=imax");
    await assert.rejects(client.requestWorker("/api/cinemas#other"), /路径/);
    await assert.rejects(client.requestWorker("/api/%2e%2e/admin?cityId=1"), /路径/);
    await assert.rejects(client.requestWorker("https://evil.example/api/cinemas?cityId=1"), /路径/);
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
      requiresHttpConfirmation: false,
      httpRiskConfirmed: false,
      httpSessionUploadConfirmed: false
    });
    assert.doesNotMatch(fs.readFileSync(path.join(fixture.userData, "worker-profiles.json"), "utf8"), /token-[ab]/);
  } finally {
    fixture.cleanup();
  }
});

test("remote HTTP approvals persist only on the current Worker profile", async () => {
  const confirmations = [];
  const fixture = makeFixture({
    confirmHttp: async ({ operation }) => { confirmations.push(operation); return true; },
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => options.method === "POST" ? { session: { uploaded: true } } : { profile: {} }
    })
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", httpRiskConfirmed: true });
    assert.equal(client.getProfile().httpRiskConfirmed, true);
    assert.equal(client.getProfile().httpSessionUploadConfirmed, false);

    await client.prepareSessionUpload()({ saved_at: "2026-09-15T00:00:00.000Z" });
    assert.deepEqual(confirmations, ["connect", "session-upload"]);
    assert.equal(client.getProfile().httpSessionUploadConfirmed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.userData, "worker-profiles.json"), "utf8")).profiles["http://worker.example"], {
      baseUrl: "http://worker.example",
      updatedAt: client.getProfile().updatedAt,
      isLoopback: false,
      requiresHttpConfirmation: true,
      httpRiskConfirmed: true,
      httpSessionUploadConfirmed: true
    });
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

test("remote HTTP session upload with query parameters still needs a second confirmation", async () => {
  const requests = [];
  const confirmations = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ profile: {} }) };
    },
    confirmHttp: async ({ operation }) => {
      confirmations.push(operation);
      return operation === "connect";
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", token: "t", httpRiskConfirmed: true });

    await assert.rejects(
      client.requestWorker("/api/lock/session?bypass=1", { method: "POST", body: "{}", httpRiskConfirmed: true }),
      /确认/
    );
    assert.deepEqual(confirmations, ["connect", "session-upload"]);
    assert.equal(requests.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("remote HTTP session upload with a trailing slash still needs a second confirmation", async () => {
  const requests = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ profile: {} }) };
    },
    confirmHttp: async ({ operation }) => operation === "connect"
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", token: "t", httpRiskConfirmed: true });
    await assert.rejects(
      client.requestWorker("/api/lock/session/", { method: "POST", body: "{}", httpRiskConfirmed: true }),
      /确认/
    );
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

test("main-only upload confirms HTTP again and sends a bound payload with abort signal", async () => {
  const requests = []; const confirmations = [];
  const fixture = makeFixture({
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ session: { uploaded: true } }) }; },
    confirmHttp: async ({ operation }) => { confirmations.push(operation); return true; }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", token: "secret-token", httpRiskConfirmed: true });
    const upload = client.prepareSessionUpload();
    const controller = new AbortController();
    await upload({ cookies: [], mtgsig: "signature" }, { signal: controller.signal });
    assert.deepEqual(confirmations, ["connect", "session-upload"]);
    assert.equal(requests[1].url, "http://worker.example/api/lock/session");
    assert.equal(requests[1].options.signal, controller.signal);
    assert.equal(requests[1].options.body, '{"cookies":[],"mtgsig":"signature"}');
    assert.equal(requests[1].options.redirect, "error");
  } finally { fixture.cleanup(); }
});

test("upload cannot follow a changed profile or continue after cancellation during confirmation", async () => {
  const requests = []; let confirmUpload;
  const fixture = makeFixture({
    fetchImpl: async (url) => { requests.push(url); return { ok: true, json: async () => ({}) }; },
    confirmHttp: async ({ operation }) => operation === "connect" ? true : new Promise((resolve) => { confirmUpload = resolve; })
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", token: "a", httpRiskConfirmed: true });
    const oldUpload = client.prepareSessionUpload();
    await client.connectWorker({ workerUrl: "https://other.example", token: "b" });
    await assert.rejects(oldUpload({}), { code: "disconnected" });
    await client.connectWorker({ workerUrl: "http://worker.example", httpRiskConfirmed: true });
    const controller = new AbortController();
    const pending = client.prepareSessionUpload()({}, { signal: controller.signal });
    await new Promise(setImmediate); controller.abort(); confirmUpload(true);
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requests.length, 3);
  } finally { fixture.cleanup(); }
});

test("profile changes during native HTTP confirmation cannot upload to an old Worker", async () => {
  const requests = []; let confirmUpload;
  const fixture = makeFixture({
    fetchImpl: async (url) => { requests.push(url); return { ok: true, json: async () => ({}) }; },
    confirmHttp: async ({ operation }) => operation === "connect" ? true : new Promise((resolve) => { confirmUpload = resolve; })
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", httpRiskConfirmed: true });
    const pending = client.prepareSessionUpload()({});
    await new Promise(setImmediate);
    await client.connectWorker({ workerUrl: "https://other.example" }); confirmUpload(true);
    await assert.rejects(pending, { code: "disconnected" });
    assert.equal(requests.length, 2);
  } finally { fixture.cleanup(); }
});

test("lost upload response reconciles only an exact source timestamp and otherwise reports unknown", async () => {
  for (const matches of [true, false]) {
    const savedAt = "2026-09-15T00:00:00.000Z"; const requests = [];
    const fixture = makeFixture({ fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "POST") throw new Error("Cookie uid=123456789 mtgsig=secret");
      return { ok: true, json: async () => ({ session: { uploaded: true, sourceSavedAt: matches ? savedAt : "2026-09-14T00:00:00.000Z", uidMasked: "UID 123***789" } }) };
    } });
    try {
      const client = createWorkerClient(fixture); await client.connectWorker({ workerUrl: "https://worker.example" });
      let sent = false; const pending = client.prepareSessionUpload()({ saved_at: savedAt }, { onSend: () => { sent = true; } });
      if (matches) assert.equal((await pending).session.uploaded, true);
      else await assert.rejects(pending, (error) => error.code === "unknown" && !/Cookie|123456789|mtgsig/.test(error.message));
      assert.equal(sent, true); assert.equal(requests[2].url, "https://worker.example/api/lock/session/status");
    } finally { fixture.cleanup(); }
  }
});

test("server upload errors redact remote messages and treat server failures as ambiguous", async () => {
  for (const status of [400, 500]) {
    const requests = [];
    const fixture = makeFixture({ fetchImpl: async (url, options) => {
      requests.push(url);
      if (options.method === "POST") return { ok: false, status, json: async () => ({ error: "Cookie uid=123456789 mtgsig=secret" }) };
      return { ok: true, json: async () => ({ session: { uploaded: false } }) };
    } });
    try {
      const client = createWorkerClient(fixture); await client.connectWorker({ workerUrl: "https://worker.example" });
      await assert.rejects(client.prepareSessionUpload()({}), (error) => error.code === (status === 400 ? "upload" : "unknown") && !/Cookie|123456789|mtgsig/.test(error.message));
      assert.equal(requests.length, status === 400 ? 2 : 3);
    } finally { fixture.cleanup(); }
  }
});

test("same-URL token replacement blocks login preparation throughout approval and status wait", async () => {
  const requests = []; let approveReconnect; let completeStatus; let connectionCount = 0;
  const fixture = makeFixture({
    confirmHttp: async ({ operation }) => {
      if (operation !== "connect" || ++connectionCount === 1) return true;
      return new Promise((resolve) => { approveReconnect = resolve; });
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/status") && options.headers["X-Token"] === "token-b") {
        await new Promise((resolve) => { completeStatus = resolve; });
      }
      return { ok: true, json: async () => ({ session: { uploaded: true } }) };
    }
  });
  try {
    const client = createWorkerClient(fixture);
    await client.connectWorker({ workerUrl: "http://worker.example", token: "token-a", httpRiskConfirmed: true });
    const uploadUnderA = client.prepareSessionUpload();
    const reconnect = client.connectWorker({ workerUrl: "http://worker.example/", token: "token-b", httpRiskConfirmed: true });
    assert.throws(() => client.prepareSessionUpload(), { code: "disconnected" });
    await assert.rejects(uploadUnderA({}), { code: "disconnected" });
    approveReconnect(true); await new Promise(setImmediate);
    assert.throws(() => client.prepareSessionUpload(), { code: "disconnected" });
    completeStatus(); await reconnect;
    await assert.rejects(uploadUnderA({}), { code: "disconnected" });
    assert.equal(requests.filter(({ options }) => options.method === "POST").length, 0);
    await client.prepareSessionUpload()({});
    assert.equal(requests[2].options.headers["X-Token"], "token-b");
  } finally { fixture.cleanup(); }
});
