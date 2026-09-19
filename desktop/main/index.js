const path = require("node:path");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { createWorkerClient } = require("./worker-client");
const { createMaoyanLogin } = require("./maoyan-login");
const { captureSession, normalizeUploadedSession, sanitizeError, safeError, publicLoginResult, publicSessionStatus } = require("./session-validation");
const { checkForUpdates, openExternal } = require("./updates");
const { createEnrollmentWindow } = require("./enrollment-window");

// Keep installed profiles across the product rename; explicit test profiles take precedence.
if (app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), "Maoyan Monitor"));
}

const pagePath = path.join(__dirname, "..", "..", "pages", "maoyan", "index.html");
const MAX_SESSION_FILE_BYTES = 256 * 1024;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const QUERY_KEYS = ["yodaReady", "csecplatform", "csecversion"];

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

function manualSessionPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError("validation");
  if (Array.isArray(value.cookies) || Object.hasOwn(value, "create_order_query")) return normalizeUploadedSession(value);
  const uid = typeof value.uid === "number" && Number.isSafeInteger(value.uid) ? String(value.uid) : value.uid;
  if (!/^\d+$/.test(uid || "") || typeof value._csrf !== "string" || typeof value.mtgsig !== "string" || typeof value.user_agent !== "string") {
    throw safeError("validation");
  }
  const query = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    if (typeof value[key] === "string") query.set(key, value[key]);
  }
  return captureSession({
    cookies: [
      { domain: ".maoyan.com", name: "uid", value: uid },
      { domain: ".maoyan.com", name: "_csrf", value: value._csrf }
    ],
    requestHeaders: { mtgsig: value.mtgsig },
    requestUrl: `https://www.maoyan.com/ajax/createOrder?${query}`,
    userAgent: value.user_agent
  });
}

async function readSessionFile(fileSystem, filePath) {
  let handle;
  let buffer;
  try {
    handle = await fileSystem.open(filePath, "r");
    const stats = await handle.stat();
    if (!stats?.isFile?.() || !Number.isSafeInteger(stats.size) || stats.size > MAX_SESSION_FILE_BYTES) throw safeError("validation");
    buffer = Buffer.allocUnsafe(MAX_SESSION_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > MAX_SESSION_FILE_BYTES) throw safeError("validation");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    buffer?.fill(0);
    await handle?.close?.().catch(() => {});
  }
}

function createUpdatePreference({ filePath, fileSystem = fs } = {}) {
  return {
    read() {
      try {
        const value = JSON.parse(fileSystem.readFileSync(filePath, "utf8"));
        return Number.isSafeInteger(value?.lastAutomaticCheckAt) && value.lastAutomaticCheckAt > 0 ? value.lastAutomaticCheckAt : 0;
      } catch { return 0; }
    },
    write(lastAutomaticCheckAt) {
      try {
        fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fileSystem.writeFileSync(temporaryPath, JSON.stringify({ lastAutomaticCheckAt }), { mode: 0o600 });
        fileSystem.renameSync(temporaryPath, filePath);
      } catch { /* The next automatic check can safely retry if preferences cannot be saved. */ }
    }
  };
}

async function uploadSessionFile({ dialog: fileDialog = dialog, workerClient, fs: fileSystem = fsPromises } = {}) {
  let fileText = "";
  let payload;
  try {
    const upload = workerClient?.prepareSessionUpload?.();
    if (typeof upload !== "function") throw safeError("disconnected");
    const selected = await fileDialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (selected?.canceled || !Array.isArray(selected?.filePaths) || selected.filePaths.length !== 1) return { cancelled: true };
    fileText = await readSessionFile(fileSystem, selected.filePaths[0]);
    payload = manualSessionPayload(JSON.parse(fileText));
    const result = await upload(payload);
    if (result?.session?.uploaded !== true) throw safeError("unknown");
    return { session: publicSessionStatus(result.session) };
  } catch (error) {
    return sanitizeError(error?.code ? error : safeError("validation"));
  } finally {
    fileText = "";
    payload = undefined;
  }
}

function registerIpcHandlers({ workerClient, createLogin = createMaoyanLogin, updateChecker = checkForUpdates, updatePreference, clock = Date.now } = {}) {
  const client = workerClient ?? createWorkerClient({ app, safeStorage, confirmHttp: confirmRemoteHttp });
  const logins = new Map();
  const openEnrollment = createEnrollmentWindow({ BrowserWindow, session });
  const preference = updatePreference ?? (typeof app.getPath === "function"
    ? createUpdatePreference({ filePath: path.join(app.getPath("userData"), "update-preferences.json") }) : null);
  let latestReleaseUrl = "";
  let lastUpdateCheckAt = preference?.read?.() || 0;
  let lastUpdateResult = { available: false, skipped: true };
  let updateInFlight = null;
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
  ipcMain.handle("runtime:get-info", () => ({ kind: "electron", canLoginMaoyan: true, status: "ready", version: app.getVersion?.() || "0.0.0" }));
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
      return publicLoginResult(result);
    } catch (error) { return sanitizeError(error); }
    finally { entry.busy = false; }
  });
  ipcMain.handle("maoyan:cancel", async (event) => {
    if (!trustedSender(event)) return sanitizeError(safeError("unavailable"));
    const result = await logins.get(event.sender)?.controller.cancel();
    return publicLoginResult(result ?? { cancelled: true });
  });
  ipcMain.handle("maoyan:upload-file", async (event) => {
    if (!trustedSender(event)) return sanitizeError(safeError("unavailable"));
    return uploadSessionFile({ workerClient: client });
  });
  ipcMain.handle("updates:check", async (event, options) => {
    if (!trustedSender(event)) return { available: false, error: "unavailable" };
    if (updateInFlight) return updateInFlight;
    const currentTime = clock();
    if (options?.manual === true || !lastUpdateCheckAt || currentTime - lastUpdateCheckAt >= UPDATE_CHECK_INTERVAL_MS) {
      updateInFlight = (async () => {
        try { lastUpdateResult = await updateChecker({ currentVersion: app.getVersion?.() || "0.0.0" }); }
        catch { lastUpdateResult = { available: false, error: "unavailable" }; }
        if (!lastUpdateResult.error) {
          lastUpdateCheckAt = currentTime;
          preference?.write?.(lastUpdateCheckAt);
        }
        latestReleaseUrl = lastUpdateResult.available === true ? lastUpdateResult.releaseUrl : "";
        return lastUpdateResult;
      })();
      try { return await updateInFlight; } finally { updateInFlight = null; }
    }
    return lastUpdateResult;
  });
  ipcMain.handle("enrollment:open", async (event) => {
    if (quitting || !trustedSender(event)) return { opened: false };
    return openEnrollment(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle("external:open", async (event, input) => {
    if (!trustedSender(event)) return { opened: false };
    return openExternal(input?.url, { shell, approvedUrls: latestReleaseUrl ? [latestReleaseUrl] : [], workerProfile: client.getProfile?.() });
  });
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

module.exports = { createMainWindow, registerIpcHandlers, uploadSessionFile, manualSessionPayload, normalizeUploadedSession, createUpdatePreference };
