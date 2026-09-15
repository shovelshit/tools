const { randomUUID } = require("node:crypto");
const { captureSession, sanitizeError, safeError, safeQuery, publicSessionStatus } = require("./session-validation");

const ORIGIN = "https://www.maoyan.com";
const LOGIN_URL = "https://passport.maoyan.com/pc/login?pagesource=maoyan&redirectURL=https%3A%2F%2Fwww.maoyan.com%2F";

function isAllowedMaoyanNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "maoyan.com" || url.hostname.endsWith(".maoyan.com"));
  } catch { return false; }
}

function createMaoyanLogin({ BrowserWindow, session, workerClient, clock = globalThis, logger = console }) {
  let active = null;
  let disposed = false;
  function log(phase, status, category) {
    try { logger.info?.({ phase, status, category }); } catch { /* Logging cannot interrupt cleanup. */ }
  }

  function start(cinemaId) {
    if (disposed) return Promise.resolve(sanitizeError(safeError("unavailable")));
    if (active) return Promise.resolve(sanitizeError(safeError("busy")));
    if (!/^[1-9]\d{0,19}$/.test(typeof cinemaId === "number" && Number.isSafeInteger(cinemaId) ? String(cinemaId) : typeof cinemaId === "string" ? cinemaId : "")) return Promise.resolve(sanitizeError(safeError("validation")));

    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const state = { result, abort: new AbortController(), finished: false, phase: "login", listeners: [], signature: "", query: {}, checking: false };
    active = state;
    const on = (target, event, listener) => { target.on(event, listener); state.listeners.push(() => target.removeListener(event, listener)); };

    async function finish(value) {
      if (state.finished) return result;
      state.finished = true;
      state.abort.abort();
      clock.clearTimeout(state.deadline);
      clock.clearTimeout(state.poll);
      let cleanupFailed = false;
      const attempt = async (fn) => { try { await fn(); } catch { cleanupFailed = true; } };
      for (const remove of state.listeners) await attempt(remove);
      if (state.temporary) await attempt(() => state.temporary.webRequest.onBeforeSendHeaders(null));
      if (state.window) await attempt(() => { if (!state.window.isDestroyed()) state.window.destroy(); });
      if (state.temporary) {
        const temporary = state.temporary;
        await attempt(async () => {
          const cookies = await temporary.cookies.get({});
          await Promise.all(cookies.map((cookie) => temporary.cookies.remove(`${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`, cookie.name)));
        });
        await attempt(() => temporary.closeAllConnections());
        await attempt(() => temporary.clearStorageData());
        await attempt(() => temporary.clearCache());
        await attempt(() => temporary.clearAuthCache());
      }
      state.signature = "";
      state.query = {};
      state.listeners = [];
      if (cleanupFailed) {
        disposed = true;
        value = { ...value, warnings: [{ code: "cleanup", message: safeError("cleanup").message }] };
      }
      log("cleanup", cleanupFailed ? "failed" : "complete", value.code || (value.cancelled ? "cancelled" : "success"));
      active = null;
      resolve(value);
      return result;
    }
    state.finish = finish;
    const fail = (code) => finish(sanitizeError(safeError(code)));
    state.cancel = () => state.uploadInFlight ? result : finish({ cancelled: true });

    function hasLoginCookies(cookies) {
      return cookies.some((c) => c.name === "uid" && /^\d+$/.test(c.value)) && cookies.some((c) => c.name === "_csrf" && c.value?.trim());
    }

    async function checkLogin() {
      if (state.finished || state.checking || !["login", "capture"].includes(state.phase)) return;
      state.checking = true;
      try {
        const cookies = await state.temporary.cookies.get({ url: ORIGIN });
        if (state.finished) return;
        if (!hasLoginCookies(cookies)) return;
        if (state.phase === "login") {
          state.phase = "capture";
          log("capture", "started", "login");
          await state.window.loadURL(`${ORIGIN}/cinema/${cinemaId}`);
          if (state.finished) return;
          await state.window.webContents.executeJavaScript(`fetch("/ajax/cinemaDetail?cinemaId=${cinemaId}", { credentials: "include" }).then(() => undefined)`);
        }
        if (state.finished) return;
        const capturedCookies = await state.temporary.cookies.get({ url: ORIGIN });
        if (state.finished) return;
        if (!state.signature || !hasLoginCookies(capturedCookies)) return;
        let payload = captureSession({ cookies: capturedCookies, requestHeaders: { mtgsig: state.signature }, requestUrl: `${ORIGIN}/ajax/cinemaDetail?${new URLSearchParams(state.query)}`, userAgent: state.temporary.getUserAgent() });
        state.phase = "approval";
        let uploaded;
        try {
          uploaded = await state.upload(payload, { signal: state.abort.signal, onSend: () => {
            state.uploadInFlight = true;
            state.phase = "upload";
            log("upload", "started", "login");
          } });
        }
        finally { payload = null; }
        if (state.finished) return;
        if (uploaded?.session?.uploaded !== true) throw safeError("unknown");
        await finish({ session: publicSessionStatus(uploaded.session) });
      } catch (error) {
        if (!state.finished) await fail(["validation", "disconnected", "unknown", "upload"].includes(error?.code) ? error.code : state.phase === "upload" ? "unknown" : state.phase === "approval" ? "upload" : "login");
      } finally { state.checking = false; }
    }

    try {
      state.upload = workerClient.prepareSessionUpload();
      state.temporary = session.fromPartition(`maoyan-login-${randomUUID()}`, { cache: false });
      const temporary = state.temporary;
      temporary.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      temporary.setPermissionCheckHandler(() => false);
      on(temporary, "will-download", (event) => event.preventDefault());
      temporary.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
        try {
          const url = new URL(details.url);
          if (!state.finished && url.origin === ORIGIN && !url.username && !url.password) {
            const signature = Object.entries(details.requestHeaders || {}).find(([key]) => key.toLowerCase() === "mtgsig")?.[1];
            if (typeof signature === "string" && signature.trim() && signature.length <= 16384 && !/[\r\n\0]/.test(signature)) {
              state.signature = signature;
              Object.assign(state.query, safeQuery(url));
            }
          }
        } catch { /* Ignore malformed request metadata. */ }
        callback({ requestHeaders: details.requestHeaders });
      });
      state.window = new BrowserWindow({ width: 1000, height: 760, webPreferences: { session: temporary, nodeIntegration: false, contextIsolation: true, sandbox: true } });
      const contents = state.window.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      const navigation = (event, url, _isInPlace, isMainFrame) => {
        if (isMainFrame === false) return;
        if (!isAllowedMaoyanNavigation(url)) { event.preventDefault(); if (!state.uploadInFlight) void fail("navigation"); }
      };
      on(contents, "will-navigate", navigation);
      on(contents, "will-redirect", navigation);
      on(contents, "render-process-gone", () => { if (!state.uploadInFlight) void fail("login"); });
      on(contents, "did-fail-load", (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3 && !state.uploadInFlight) void fail("navigation"); });
      on(state.window, "closed", () => { void state.cancel(); });
      on(temporary.cookies, "changed", () => { void checkLogin(); });
      state.deadline = clock.setTimeout(() => { void fail(state.uploadInFlight ? "unknown" : "timeout"); }, 10 * 60 * 1000);
      const poll = () => {
        if (state.finished) return;
        void checkLogin();
        state.poll = clock.setTimeout(poll, 500);
      };
      state.poll = clock.setTimeout(poll, 500);
      log("login", "started", "login");
      Promise.resolve(state.window.loadURL(LOGIN_URL)).then(checkLogin).catch((error) => {
        if (!state.finished && !(error?.errno === -3 && state.phase !== "login")) void fail("navigation");
      });
    } catch { void fail("login"); }
    return result;
  }

  function cancel() { return active ? active.cancel() : Promise.resolve({ cancelled: true }); }
  function dispose() { disposed = true; return cancel(); }
  return { start, cancel, dispose };
}

module.exports = { createMaoyanLogin, isAllowedMaoyanNavigation };
