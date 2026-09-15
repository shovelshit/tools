const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

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
