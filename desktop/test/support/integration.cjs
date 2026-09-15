const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { createWorkerClient } = require("../../main/worker-client");
const { createMaoyanLogin } = require("../../main/maoyan-login");
const { startMockWorker } = require("./worker.cjs");

// Only Electron's external process boundary is replaced; main, preload,
// runtime, session validation and the HTTP client execute their real code.
function loadWithElectron(file, electron) {
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__dirname){${fs.readFileSync(file, "utf8")}\n})`, { filename: file });
  wrapper((name) => name === "electron" ? electron : nativeRequire(name), module, module.exports, path.dirname(file));
  return module.exports;
}

async function launchWithMockWorker(t, options) {
  const worker = await startMockWorker(options);
  t.after(() => worker.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-integration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = Object.assign(new EventEmitter(), { whenReady: () => new Promise(() => {}), getPath: () => directory });
  const client = createWorkerClient({ app, safeStorage: { isEncryptionAvailable: () => false } });
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, getURL: () => pathToFileURL(path.resolve(__dirname, "../../../pages/maoyan/index.html")).href });
  const event = { sender, senderFrame: sender.mainFrame };
  const handlers = new Map();
  const state = { windows: [], cleared: [], cookies: [], logs: [] };
  const cookies = Object.assign(new EventEmitter(), { get: async () => state.cookies, remove: async () => {} });
  const temporary = Object.assign(new EventEmitter(), {
    cookies, getUserAgent: () => "Mozilla/5.0 MockMaoyan",
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeSendHeaders(filter, listener) { state.capture = listener ?? filter; } },
    clearStorageData: async () => { state.cookies = []; state.cleared.push("storage"); },
    clearCache: async () => { state.cleared.push("cache"); },
    clearAuthCache: async () => { state.cleared.push("auth"); },
    closeAllConnections: async () => { state.cleared.push("connections"); }
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; state.windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        executeJavaScript: async () => state.capture({ url: "https://www.maoyan.com/ajax/cinemaDetail?cinemaId=25428&yodaReady=h5", requestHeaders: { mtgsig: "mock-signature-secret" } }, () => {})
      });
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const electron = { app, BrowserWindow, session: { fromPartition: () => temporary }, ipcMain: { handle: (key, handler) => handlers.set(key, handler) } };
  const main = loadWithElectron(path.resolve(__dirname, "../../main/index.js"), electron);
  main.registerIpcHandlers({ workerClient: client, updatePreference: { read: () => 0 }, createLogin: (input) => createMaoyanLogin({ ...input, logger: { info: (value) => state.logs.push(value) } }) });
  let bridge;
  loadWithElectron(path.resolve(__dirname, "../../preload/index.js"), {
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { invoke: (name, ...args) => Promise.resolve(handlers.get(name)(event, ...args)) }
  });
  const window = { maoyanElectron: bridge };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../../pages/maoyan/runtime.js"), "utf8"), { window });
  t.after(async () => { await bridge.cancelMaoyanLogin(); sender.emit("destroyed"); });
  return {
    worker, client, bridge, window, runtime: window.maoyanRuntime,
    async authenticate() {
      await new Promise(setImmediate);
      state.cookies = [{ domain: ".maoyan.com", path: "/", name: "uid", value: "123456789", secure: true }, { domain: ".maoyan.com", path: "/", name: "_csrf", value: "mock-csrf-secret", secure: true }];
      cookies.emit("changed");
    },
    assertClean() {
      assert.equal(state.windows[0].destroyed, true);
      assert.equal(state.capture, null);
      assert.equal(cookies.listenerCount("changed"), 0);
      assert.deepEqual(state.cookies, []);
      assert.deepEqual(state.cleared, ["connections", "storage", "cache", "auth"]);
      assert.doesNotMatch(JSON.stringify(state.logs), /mock-signature|mock-csrf|123456789|one-token/);
    }
  };
}

module.exports = { launchWithMockWorker };
