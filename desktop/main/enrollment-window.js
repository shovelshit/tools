const CLAIM_URL = "https://movie.ltools.asia/claim.html?client=desktop";
const ENROLLMENT_ORIGINS = new Set(["https://movie.ltools.asia", "https://ltools.asia"]);

function allowedNavigation(value) {
  try {
    const url = new URL(value);
    return ENROLLMENT_ORIGINS.has(url.origin) && !url.username && !url.password &&
      ["/claim", "/claim.html", "/maoyan/claim", "/maoyan/claim.html"].includes(url.pathname) &&
      url.searchParams.get("client") === "desktop";
  } catch { return false; }
}

function createEnrollmentWindow({ BrowserWindow, session }) {
  let window = null;
  return async (parent) => {
    if (window && !window.isDestroyed()) { window.focus(); return { opened: true }; }
    const isolated = session.fromPartition("persist:enrollment");
    const mayCopyKey = (permission, details) => permission === "clipboard-sanitized-write" &&
      details?.isMainFrame === true && allowedNavigation(details.requestingUrl);
    isolated.setPermissionRequestHandler((_contents, permission, callback, details) => callback(mayCopyKey(permission, details)));
    isolated.setPermissionCheckHandler((_contents, permission, _origin, details) => mayCopyKey(permission, details));
    const current = new BrowserWindow({
      width: 620, height: 820, minWidth: 480, minHeight: 680,
      parent, title: "领取访问密钥",
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    window = current;
    current.setMenuBarVisibility(false);
    current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); };
    current.webContents.on("will-navigate", guard);
    current.webContents.on("will-redirect", guard);
    current.on("closed", () => { if (window === current) window = null; });
    try { await current.loadURL(CLAIM_URL); return { opened: true }; }
    catch { if (!current.isDestroyed()) current.close(); return { opened: false }; }
  };
}

module.exports = { createEnrollmentWindow };
