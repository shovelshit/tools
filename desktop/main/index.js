const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");

const pagePath = path.join(__dirname, "..", "..", "pages", "maoyan", "index.html");

function notReady(feature) {
  return { ok: false, code: "not-ready", feature };
}

function registerIpcHandlers() {
  ipcMain.handle("runtime:get-info", () => ({ kind: "electron", canLoginMaoyan: false, status: "not-ready" }));
  ipcMain.handle("worker:connect", () => notReady("worker-connect"));
  ipcMain.handle("worker:request", () => notReady("worker-request"));
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
