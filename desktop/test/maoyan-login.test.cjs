const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createMaoyanLogin, isAllowedMaoyanNavigation } = require("../main/maoyan-login");

const tick = () => new Promise(setImmediate);
function fixture({ uploadError, loadError, cleanupError, deferredUpload = false, deferredApproval = false, missingSignature = false } = {}) {
  const state = { windows: [], uploads: [], logs: [], cleared: [], timers: new Map(), cookies: [], session: { uploaded: true, uidMasked: "UID 987***321" } };
  let nextTimer = 0;
  const cookies = Object.assign(new EventEmitter(), {
    get: async () => state.cookies,
    remove: async (url, name) => { state.cleared.push(name); }
  });
  const temporary = {
    cookies,
    getUserAgent: () => "Mozilla/5.0",
    webRequest: { onBeforeSendHeaders(filter, listener) { state.requestListener = arguments.length === 1 ? filter : listener; } },
    setPermissionRequestHandler(handler) { state.permissions = handler; },
    setPermissionCheckHandler(handler) { state.permissionCheck = handler; },
    on: (...args) => { state.sessionEvents ??= new EventEmitter(); state.sessionEvents.on(...args); },
    removeListener: (...args) => state.sessionEvents.removeListener(...args),
    clearStorageData: async () => { state.cleared.push("storage"); state.cookies = []; if (cleanupError) throw cleanupError; },
    clearCache: async () => { state.cleared.push("cache"); },
    clearAuthCache: async () => { state.cleared.push("auth"); },
    closeAllConnections: async () => { state.cleared.push("connections"); }
  };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.urls = []; state.windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        executeJavaScript: async (script) => {
          state.script = script;
          state.requestListener({ url: "https://www.maoyan.com/ajax/cinemaDetail?cinemaId=25428&yodaReady=h5&secret=drop", requestHeaders: { mtgsig: missingSignature ? "" : "signature-secret", Cookie: "uid=123456789" } }, (reply) => { state.requestReply = reply; });
        }
      });
    }
    async loadURL(url) { this.urls.push(url); if (loadError) throw loadError; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const workerClient = {
    prepareSessionUpload() {
      return async (body, { signal, onSend }) => {
        if (deferredApproval) await new Promise((resolve) => { state.approve = resolve; });
        signal.throwIfAborted();
        onSend?.();
        state.uploads.push(body); state.signal = signal;
        if (deferredUpload) await new Promise((resolve) => { state.accept = resolve; });
        if (uploadError) throw uploadError;
        state.session = { uploaded: true, uidMasked: "UID 123***789", cookies: body.cookies, mtgsig: body.mtgsig };
        return { session: state.session };
      };
    }
  };
  const login = createMaoyanLogin({ BrowserWindow, session: { fromPartition(partition, options) { state.partition = partition; state.partitionOptions = options; return temporary; } }, workerClient,
    clock: { setTimeout(fn, ms) { const id = ++nextTimer; state.timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { state.timers.delete(id); } },
    logger: { info: (value) => state.logs.push(value), warn: (value) => state.logs.push(value) }
  });
  async function authenticate() {
    state.cookies = [{ domain: ".maoyan.com", path: "/", name: "uid", value: "123456789", secure: true }, { domain: ".maoyan.com", path: "/", name: "_csrf", value: "csrf-secret", secure: true }];
    cookies.emit("changed", {}, state.cookies[1], "explicit", false);
    await tick();
  }
  return { login, state, authenticate, cookies };
}

function assertClean(f) {
  assert.equal(f.state.windows[0].destroyed, true);
  assert.equal(f.state.requestListener, null);
  assert.equal(f.cookies.listenerCount("changed"), 0);
  assert.equal(f.state.timers.size, 0);
  for (const name of ["storage", "cache", "auth", "connections"]) assert.ok(f.state.cleared.includes(name));
  const records = JSON.stringify(f.state.logs);
  assert.match(records, /phase/);
  assert.match(records, /status/);
  assert.doesNotMatch(records, /mtgsig|_csrf|Cookie|123456789|signature-secret|csrf-secret|token-secret|\?token|requestHeaders|body/);
}

test("navigation allows only HTTPS Maoyan domains and rejects deceptive URLs", () => {
  for (const url of ["https://www.maoyan.com/", "https://passport.maoyan.com/login", "https://maoyan.com/"]) assert.equal(isAllowedMaoyanNavigation(url), true);
  for (const url of ["http://www.maoyan.com/", "https://evil.example/", "https://www.maoyan.com.evil.example/", "https://user:pass@www.maoyan.com/", "file:///tmp/x", "not-url"]) assert.equal(isAllowedMaoyanNavigation(url), false);
});

test("successful capture uploads only from disposable session and exposes public status", async () => {
  const f = fixture(); const result = f.login.start("25428");
  await tick(); await f.authenticate();
  assert.deepEqual(await result, { session: { uploaded: true, uidMasked: "UID 123***789" } });
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.uploads[0].mtgsig, "signature-secret");
  assert.deepEqual(f.state.uploads[0].create_order_query, { yodaReady: "h5" });
  assert.equal(f.state.windows[0].urls[1], "https://www.maoyan.com/cinema/25428");
  assert.equal(new URL(f.state.windows[0].urls[0]).searchParams.get("redirectURL"), "https://www.maoyan.com/");
  assert.match(f.state.script, /ajax\/cinemaDetail/);
  assert.doesNotMatch(f.state.partition, /^persist:/);
  assert.equal(f.state.partitionOptions.cache, false);
  assert.deepEqual(f.state.windows[0].options.webPreferences, { session: f.state.windows[0].options.webPreferences.session, nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.deepEqual(f.state.windows[0].openHandler({ url: "https://evil.example" }), { action: "deny" });
  assertClean(f);
});

test("cancel, close, timeout and dispose clean temporary state without uploading", async () => {
  for (const action of ["cancel", "close", "timeout", "dispose"]) {
    const f = fixture(); const original = f.state.session; const pending = f.login.start("25428"); await tick();
    if (action === "close") f.state.windows[0].destroy();
    else if (action === "timeout") [...f.state.timers.values()].find((t) => t.ms === 600000).fn();
    else await f.login[action]();
    const result = await pending;
    if (action === "timeout") assert.equal(result.code, "timeout");
    else assert.deepEqual(result, { cancelled: true });
    assert.equal(f.state.uploads.length, 0); assert.equal(f.state.session, original); assertClean(f);
  }
});

test("concurrent login is rejected and a new start uses a fresh partition", async () => {
  const f = fixture(); const first = f.login.start("25428"); await tick(); const partition = f.state.partition;
  assert.equal((await f.login.start("25428")).code, "busy");
  await f.login.cancel(); await first;
  const second = f.login.start("25428"); await tick(); assert.notEqual(f.state.partition, partition);
  await f.login.cancel(); await second;
});

test("navigation, upload and loading errors remain safe and always clean up", async () => {
  const secretError = new Error("Cookie _csrf=csrf-secret mtgsig=signature-secret uid=123456789 token-secret https://worker/api?token=secret");
  for (const type of ["navigation", "redirect", "upload", "load", "crash"]) {
    const f = fixture({ uploadError: type === "upload" ? secretError : undefined, loadError: type === "load" ? secretError : undefined });
    const original = f.state.session; const pending = f.login.start("25428"); await tick();
    if (type === "navigation" || type === "redirect") {
      let prevented = false;
      f.state.windows[0].webContents.emit(type === "navigation" ? "will-navigate" : "will-redirect", { preventDefault() { prevented = true; } }, "https://evil.example/");
      assert.equal(prevented, true);
    } else if (type === "upload") await f.authenticate();
    else if (type === "crash") f.state.windows[0].webContents.emit("render-process-gone", {}, { reason: secretError.message });
    const result = await pending; assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /Cookie|_csrf|mtgsig|123456789|token-secret|\?token/);
    assert.equal(f.state.session, original); assertClean(f);
  }
});

test("cleanup failure still clears other layers and returns a safe error", async () => {
  const f = fixture({ cleanupError: new Error("Cookie secret") }); const pending = f.login.start("25428"); await tick();
  await f.login.cancel(); assert.equal((await pending).code, "cleanup"); assertClean(f);
});

test("invalid cinema IDs never allocate a session", async () => {
  const f = fixture();
  for (const value of ["1/../../evil", "", null, {}, "1;alert(1)"]) assert.equal((await f.login.start(value)).code, "validation");
  assert.equal(f.state.windows.length, 0);
});

test("third-party CAPTCHA frame redirects remain allowed while top-level redirects are blocked", async () => {
  const f = fixture(); const pending = f.login.start("25428"); await tick();
  let prevented = false;
  f.state.windows[0].webContents.emit("will-redirect", { preventDefault() { prevented = true; } }, "https://captcha.example/", false, false);
  assert.equal(prevented, false);
  await f.login.cancel(); await pending; assertClean(f);
});

test("missing captured signature fails validation without a Worker upload", async () => {
  const f = fixture({ missingSignature: true }); const pending = f.login.start("25428"); await tick(); await f.authenticate();
  assert.equal((await pending).code, "validation"); assert.equal(f.state.uploads.length, 0); assertClean(f);
});

test("cancel before native approval completes prevents any POST", async () => {
  const f = fixture({ deferredApproval: true }); const original = f.state.session;
  const pending = f.login.start("25428"); await tick(); await f.authenticate();
  await f.login.cancel(); f.state.approve(); await tick();
  assert.deepEqual(await pending, { cancelled: true }); assert.equal(f.state.uploads.length, 0);
  assert.equal(f.state.session, original); assertClean(f);
});

test("cancel or window close after sending waits for accepted upload instead of reporting cancellation", async () => {
  for (const action of ["cancel", "close", "dispose"]) {
    const f = fixture({ deferredUpload: true }); const pending = f.login.start("25428"); await tick(); await f.authenticate();
    let cancelResult;
    if (action === "close") f.state.windows[0].destroy();
    else cancelResult = f.login[action]();
    await tick(); assert.equal(f.state.signal.aborted, false);
    f.state.accept();
    assert.deepEqual(await pending, { session: { uploaded: true, uidMasked: "UID 123***789" } });
    if (cancelResult) assert.deepEqual(await cancelResult, { session: { uploaded: true, uidMasked: "UID 123***789" } });
    assertClean(f);
  }
});

test("deadline after sending reports unknown outcome and aborts outstanding transport", async () => {
  const f = fixture({ deferredUpload: true }); const pending = f.login.start("25428"); await tick(); await f.authenticate();
  [...f.state.timers.values()].find((t) => t.ms === 600000).fn();
  assert.equal((await pending).code, "unknown"); assert.equal(f.state.signal.aborted, true);
  f.state.accept(); await tick(); assertClean(f);
});
