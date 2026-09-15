const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session } = require("electron");
const { createWorkerClient } = require("./worker-client");
const { createMaoyanLogin } = require("./maoyan-login");
const { sanitizeError, safeError, publicSessionStatus } = require("./session-validation");

const pagePath = path.join(__dirname, "..", "..", "pages", "maoyan", "index.html");

function notReady(feature) {
  return { ok: false, code: "not-ready", feature };
}

function confirmRemoteHttp({ operation }) {
  const isSessionUpload = operation === "session-upload";
  return dialog.showMessageBox({
    type: "warning",
    buttons: ["继续", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: "非本机 HTTP 服务可能泄露访问令牌",
    detail: isSessionUpload ? "即将通过 HTTP 上传猫眼登录态。" : "即将通过 HTTP 连接 Worker 服务。"
  }).then(({ response }) => response === 0);
}

function registerIpcHandlers({ workerClient, createLogin = createMaoyanLogin } = {}) {
  const client = workerClient ?? createWorkerClient({ app, safeStorage, confirmHttp: confirmRemoteHttp });
  const logins = new Map();
  let quitting = false;
  let cleanupComplete = false;
  const localPageUrl = pathToFileURL(pagePath).toString();
  const trustedSender = (event) => event?.sender && event.senderFrame === event.sender.mainFrame && event.sender.getURL() === localPageUrl;
  function loginFor(sender) {
    if (logins.has(sender)) return logins.get(sender);
    const entry = { controller: createLogin({ BrowserWindow, session, workerClient: client }), busy: false };
    const disconnect = () => {
      entry.disposing = true;
      sender.removeListener("destroyed", disconnect);
      sender.removeListener("render-process-gone", disconnect);
      sender.removeListener("did-start-navigation", navigate);
      void Promise.resolve(entry.controller.dispose()).finally(() => { if (logins.get(sender) === entry) logins.delete(sender); });
    };
    const navigate = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) disconnect(); };
    sender.on("destroyed", disconnect);
    sender.on("render-process-gone", disconnect);
    sender.on("did-start-navigation", navigate);
    logins.set(sender, entry);
    return entry;
  }
  ipcMain.handle("runtime:get-info", () => ({ kind: "electron", canLoginMaoyan: true, status: "ready" }));
  ipcMain.handle("worker:connect", (_event, input) => client.connectWorker(input));
  ipcMain.handle("worker:request", (_event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求参数无效");
    return client.requestWorker(input.path, input.options);
  });
  ipcMain.handle("maoyan:login", async (event, input) => {
    if (quitting || !trustedSender(event)) return sanitizeError(safeError("unavailable"));
    const entry = loginFor(event.sender);
    if (entry.disposing) return sanitizeError(safeError("unavailable"));
    if (entry.busy) return sanitizeError(safeError("busy"));
    entry.busy = true;
    try {
      const result = await entry.controller.start(input?.cinemaId);
      if (result?.cancelled === true) return { cancelled: true };
      if (result?.session) return { session: publicSessionStatus(result.session) };
      return sanitizeError(result);
    } catch (error) { return sanitizeError(error); }
    finally { entry.busy = false; }
  });
  ipcMain.handle("maoyan:cancel", async (event) => {
    if (!trustedSender(event)) return sanitizeError(safeError("unavailable"));
    const result = await logins.get(event.sender)?.controller.cancel();
    if (result?.session) return { session: publicSessionStatus(result.session) };
    return result?.ok === false ? sanitizeError(result) : { cancelled: true };
  });
  ipcMain.handle("maoyan:upload-file", () => notReady("maoyan-upload-file"));
  ipcMain.handle("updates:check", () => notReady("updates-check"));
  ipcMain.handle("external:open", () => notReady("external-open"));
  app.on("before-quit", (event) => {
    if (cleanupComplete || logins.size === 0) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.allSettled([...logins.values()].map(({ controller }) => controller.dispose())).then(() => {
      cleanupComplete = true;
      app.quit();
    });
  });
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  const localPageUrl = pathToFileURL(pagePath).toString();
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== localPageUrl) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
  mainWindow.loadFile(pagePath);
  return mainWindow;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

module.exports = { createMainWindow, registerIpcHandlers };
