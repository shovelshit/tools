const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");
const { createWorkerClient } = require("./worker-client");

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

function registerIpcHandlers({ workerClient } = {}) {
  const client = workerClient ?? createWorkerClient({ app, safeStorage, confirmHttp: confirmRemoteHttp });
  ipcMain.handle("runtime:get-info", () => ({ kind: "electron", canLoginMaoyan: false, status: "not-ready" }));
  ipcMain.handle("worker:connect", (_event, input) => client.connectWorker(input));
  ipcMain.handle("worker:request", (_event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求参数无效");
    return client.requestWorker(input.path, input.options);
  });
  ipcMain.handle("maoyan:login", () => notReady("maoyan-login"));
  ipcMain.handle("maoyan:cancel", () => notReady("maoyan-cancel"));
  ipcMain.handle("maoyan:upload-file", () => notReady("maoyan-upload-file"));
  ipcMain.handle("updates:check", () => notReady("updates-check"));
  ipcMain.handle("external:open", () => notReady("external-open"));
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
