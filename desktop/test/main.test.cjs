const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

function loadMain(electron) {
  const mainPath = path.join(__dirname, "..", "main", "index.js");
  delete require.cache[mainPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(mainPath);
  } finally {
    Module._load = originalLoad;
  }
}

test("main window keeps Node disabled, isolates context, sandboxes preload, and blocks remote navigation", () => {
  const calls = { handlers: [] };
  class FakeBrowserWindow {
    constructor(options) {
      calls.options = options;
      this.webContents = {
        on(event, listener) { calls.webContentsListener = { event, listener }; },
        loadFile(file) { calls.loadedFile = file; }
      };
    }
    loadFile(file) { calls.loadedFile = file; }
  }
  const electron = {
    app: { whenReady: () => new Promise(() => {}), on() {} },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle(channel, handler) { calls.handlers.push({ channel, handler }); } }
  };
  const { createMainWindow } = loadMain(electron);
  createMainWindow();

  assert.equal(calls.options.webPreferences.nodeIntegration, false);
  assert.equal(calls.options.webPreferences.contextIsolation, true);
  assert.equal(calls.options.webPreferences.sandbox, true);
  assert.match(calls.loadedFile, /pages[\\/]maoyan[\\/]index\.html$/);

  let prevented = false;
  calls.webContentsListener.listener({ preventDefault() { prevented = true; } }, "https://example.com");
  assert.equal(prevented, true);
});

test("remote HTTP IPC connection needs a native main-process approval", async () => {
  const calls = { handlers: [] };
  const electron = {
    app: {
      getPath: () => path.join(__dirname, "fixtures"),
      whenReady: () => new Promise(() => {}),
      on() {}
    },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    ipcMain: { handle(channel, handler) { calls.handlers.push({ channel, handler }); } },
    safeStorage: { isEncryptionAvailable: () => false }
  };
  const { registerIpcHandlers } = loadMain(electron);
  registerIpcHandlers();
  const connect = calls.handlers.find(({ channel }) => channel === "worker:connect").handler;

  await assert.rejects(
    connect(null, { workerUrl: "http://worker.example", token: "t", httpRiskConfirmed: true }),
    /确认/
  );
});

test("login IPC enforces trusted main frame, one active login, public results and renderer cleanup", async () => {
  const handlers = new Map(); const controllers = [];
  const electron = { app: { whenReady: () => new Promise(() => {}), on() {} }, BrowserWindow: {}, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
  const sender = Object.assign(new EventEmitter(), { getURL: () => pathToFileURL(path.join(__dirname, "../../pages/maoyan/index.html")).href, mainFrame: {} });
  const event = { sender, senderFrame: sender.mainFrame };
  const { registerIpcHandlers } = loadMain(electron);
  registerIpcHandlers({ workerClient: {}, createLogin: () => {
    let done; const controller = { disposed: false,
      start: () => new Promise((resolve) => { done = resolve; }),
      cancel: async () => { done?.({ cancelled: true }); return { cancelled: true }; },
      dispose: async () => { controller.disposed = true; done?.({ cancelled: true }); },
      resolve: (value) => done(value)
    }; controllers.push(controller); return controller;
  } });
  assert.equal(handlers.get("runtime:get-info")().canLoginMaoyan, true);
  assert.equal((await handlers.get("maoyan:login")({ sender, senderFrame: {} }, { cinemaId: "25428" })).ok, false);
  const pending = handlers.get("maoyan:login")(event, { cinemaId: "25428" });
  assert.equal((await handlers.get("maoyan:login")(event, { cinemaId: "25428" })).code, "busy");
  controllers[0].resolve({ session: { uploaded: true, uidMasked: "UID 123***789", mtgsig: "signature-secret", cookies: [{ value: "123456789" }] } });
  const success = await pending;
  assert.deepEqual(success, { session: { uploaded: true, uidMasked: "UID 123***789" } });
  const cancelPending = handlers.get("maoyan:login")(event, { cinemaId: "25428" });
  assert.deepEqual(await handlers.get("maoyan:cancel")(event), { cancelled: true });
  assert.deepEqual(await cancelPending, { cancelled: true });
  const crashPending = handlers.get("maoyan:login")(event, { cinemaId: "25428" }); sender.emit("render-process-gone");
  assert.deepEqual(await crashPending, { cancelled: true }); assert.equal(controllers[0].disposed, true);
  const failurePending = handlers.get("maoyan:login")(event, { cinemaId: "25428" });
  controllers[1].resolve({ ok: false, code: "upload", message: "Cookie mtgsig signature-secret _csrf csrf-secret 123456789 token-secret ?token=secret" });
  const failure = await failurePending;
  assert.equal(failure.code, "upload");
  assert.doesNotMatch(JSON.stringify([success, failure]), /mtgsig|Cookie|_csrf|123456789|token-secret|signature-secret|\?token/);
});

test("application quit waits for pending login upload and temporary cleanup", async () => {
  const handlers = new Map(); const app = Object.assign(new EventEmitter(), { whenReady: () => new Promise(() => {}), quit: () => { app.quitCalled = true; } });
  const electron = { app, BrowserWindow: {}, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
  const sender = Object.assign(new EventEmitter(), { getURL: () => pathToFileURL(path.join(__dirname, "../../pages/maoyan/index.html")).href, mainFrame: {} });
  let complete;
  const result = new Promise((resolve) => { complete = resolve; });
  const { registerIpcHandlers } = loadMain(electron);
  registerIpcHandlers({ workerClient: {}, createLogin: () => ({ start: () => result, dispose: () => result }) });
  const pending = handlers.get("maoyan:login")({ sender, senderFrame: sender.mainFrame }, { cinemaId: "25428" });
  let prevented = false; app.emit("before-quit", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(app.quitCalled, undefined);
  complete({ session: { uploaded: true } }); await pending; await new Promise(setImmediate);
  assert.equal(app.quitCalled, true);
});
