const QUERY_KEYS = ["yodaReady", "csecplatform", "csecversion"];
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAOYAN_COOKIE_DOMAIN = /^\.?([a-z0-9-]+\.)*maoyan\.com$/i;
const COOKIE_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const HEADER_CONTROL = /[\r\n\0]/;
const MAX_COOKIE_VALUE_LENGTH = 4096;
const MAX_CSRF_LENGTH = 4096;
const MAX_MTGSIG_LENGTH = 16384;
const MAX_USER_AGENT_LENGTH = 4096;
const MAX_COOKIE_COUNT = 64;
const MAX_SAVED_AT_LENGTH = 64;
const SAVED_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
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

function normalizeCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    // Python exports may omit the domain; the Worker treats those as Maoyan cookies.
    .filter((cookie) => cookie && MAOYAN_COOKIE_DOMAIN.test(String(cookie.domain || ".maoyan.com")))
    .map((cookie) => ({ name: String(cookie.name || "").trim(), value: String(cookie.value || "") }))
    .filter((cookie) => COOKIE_NAME.test(cookie.name) && cookie.value.length <= MAX_COOKIE_VALUE_LENGTH && !HEADER_CONTROL.test(cookie.value))
    .slice(0, MAX_COOKIE_COUNT);
}

function validHeaderValue(value, maximumLength) {
  return typeof value === "string" && value.trim() && value.length <= maximumLength && !HEADER_CONTROL.test(value);
}

function validSavedAt(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SAVED_AT_LENGTH || HEADER_CONTROL.test(value)) return false;
  const match = value.match(SAVED_AT);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
    && calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && hour <= 23 && minute <= 59 && second <= 59 && !Number.isNaN(Date.parse(value));
}

function normalizeUploadedSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError("validation");
  const cookies = normalizeCookies(value.cookies);
  const uid = cookies.find((cookie) => cookie.name === "uid")?.value || "";
  const csrf = value.csrf;
  const mtgsig = value.mtgsig;
  const userAgent = value.user_agent;
  if (!cookies.length || !/^\d+$/.test(uid) || !validHeaderValue(csrf, MAX_CSRF_LENGTH)
    || !validHeaderValue(mtgsig, MAX_MTGSIG_LENGTH) || !validHeaderValue(userAgent, MAX_USER_AGENT_LENGTH)
    || !validSavedAt(value.saved_at)) throw safeError("validation");
  const sourceQuery = value.create_order_query && typeof value.create_order_query === "object" && !Array.isArray(value.create_order_query)
    ? value.create_order_query : {};
  const createOrderQuery = Object.fromEntries(QUERY_KEYS
    .map((key) => [key, typeof sourceQuery[key] === "string" ? sourceQuery[key] : ""])
    .filter(([, queryValue]) => SAFE_QUERY_VALUE.test(queryValue)));
  return { cookies, csrf, mtgsig, user_agent: userAgent, create_order_query: createOrderQuery, saved_at: value.saved_at };
}

function captureSession({ cookies, requestHeaders, requestUrl, userAgent } = {}) {
  let url;
  try { url = new URL(requestUrl); } catch { throw safeError("validation"); }
  if (url.origin !== "https://www.maoyan.com" || url.username || url.password) throw safeError("validation");
  const filtered = normalizeCookies(cookies);
  const csrf = filtered.find((cookie) => cookie.name === "_csrf")?.value;
  const mtgsig = Object.entries(requestHeaders || {}).find(([key]) => key.toLowerCase() === "mtgsig")?.[1];
  return normalizeUploadedSession({
    cookies: filtered,
    csrf,
    mtgsig,
    create_order_query: safeQuery(url),
    user_agent: userAgent,
    saved_at: new Date().toISOString()
  });
}

function publicSessionStatus(value) {
  const status = { uploaded: value?.uploaded === true };
  if (typeof value?.uidMasked === "string" && /^UID (?:\d{3}\*{3}\d{3}|\*{3,6})$/.test(value.uidMasked)) status.uidMasked = value.uidMasked;
  for (const key of ["uploadedAt", "sourceSavedAt"]) {
    if (typeof value?.[key] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value[key])) status[key] = value[key];
  }
  return status;
}

function publicLoginResult(value) {
  const result = value?.cancelled === true ? { cancelled: true }
    : value?.session ? { session: publicSessionStatus(value.session) } : sanitizeError(value);
  if (Array.isArray(value?.warnings) && value.warnings.some((warning) => warning?.code === "cleanup")) {
    result.warnings = [{ code: "cleanup", message: MESSAGES.cleanup }];
  }
  return result;
}

module.exports = { captureSession, normalizeUploadedSession, sanitizeError, safeError, safeQuery, publicSessionStatus, publicLoginResult };
