const QUERY_KEYS = ["yodaReady", "csecplatform", "csecversion"];
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._:-]{1,64}$/;
const MESSAGES = {
  validation: "Maoyan session is incomplete or invalid. Please log in again.",
  busy: "A Maoyan login is already in progress.",
  timeout: "Maoyan login timed out. Please try again.",
  navigation: "The login window attempted an unsupported navigation.",
  upload: "Session upload failed. Check the Worker connection and try again.",
  unknown: "The upload outcome is unknown. Refresh the remote session status before trying again.",
  cleanup: "Temporary login cleanup failed. Please restart the application.",
  disconnected: "The Worker connection changed. Please start login again.",
  unavailable: "Maoyan login is unavailable.",
  login: "Maoyan login failed. Please try again."
};

function safeError(code = "login") {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.login), { code: Object.hasOwn(MESSAGES, code) ? code : "login" });
}

// Never interpolate third-party messages: they can contain complete credentials.
function sanitizeError(error) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : "login";
  return { ok: false, code, message: MESSAGES[code] };
}

function safeQuery(url) {
  return Object.fromEntries(QUERY_KEYS.map((key) => [key, url.searchParams.get(key) || ""]).filter(([, value]) => SAFE_QUERY_VALUE.test(value)));
}

function captureSession({ cookies, requestHeaders, requestUrl, userAgent } = {}) {
  let url;
  try { url = new URL(requestUrl); } catch { throw safeError("validation"); }
  if (url.origin !== "https://www.maoyan.com" || url.username || url.password) throw safeError("validation");
  const filtered = (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie && /^\.?([a-z0-9-]+\.)*maoyan\.com$/i.test(cookie.domain || ""))
    .map((cookie) => ({ name: String(cookie.name || "").trim(), value: String(cookie.value || "") }))
    .filter((cookie) => /^[A-Za-z0-9_-]{1,128}$/.test(cookie.name) && cookie.value.length <= 4096 && !/[\r\n\0]/.test(cookie.value))
    .slice(0, 64);
  const uid = filtered.find((cookie) => cookie.name === "uid")?.value;
  const csrf = filtered.find((cookie) => cookie.name === "_csrf")?.value;
  const mtgsig = Object.entries(requestHeaders || {}).find(([key]) => key.toLowerCase() === "mtgsig")?.[1];
  if (!/^\d+$/.test(uid || "") || !csrf?.trim() || typeof mtgsig !== "string" || !mtgsig.trim() || mtgsig.length > 16384 || /[\r\n\0]/.test(mtgsig) || typeof userAgent !== "string" || !userAgent.trim() || userAgent.length > 4096 || /[\r\n\0]/.test(userAgent)) throw safeError("validation");
  return { cookies: filtered, csrf, mtgsig, create_order_query: safeQuery(url), user_agent: userAgent, saved_at: new Date().toISOString() };
}

function publicSessionStatus(value) {
  const status = { uploaded: value?.uploaded === true };
  if (typeof value?.uidMasked === "string" && /^UID (?:\d{3}\*{3}\d{3}|\*{3,6})$/.test(value.uidMasked)) status.uidMasked = value.uidMasked;
  for (const key of ["uploadedAt", "sourceSavedAt"]) {
    if (typeof value?.[key] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value[key])) status[key] = value[key];
  }
  return status;
}

module.exports = { captureSession, sanitizeError, safeError, safeQuery, publicSessionStatus };
