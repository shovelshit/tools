const fs = require("node:fs");
const path = require("node:path");

const { createCredentialStore } = require("./credential-store");
const { safeError } = require("./session-validation");

const MAX_JSON_BODY_BYTES = 256 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

function normalizeWorkerUrl(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) throw new Error("服务地址不能为空");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("服务地址必须是 HTTP 或 HTTPS 地址");
  }
  if (url.username) throw new Error("服务地址不能包含用户名");
  if (url.password) throw new Error("服务地址不能包含密码");
  if (url.search) throw new Error("服务地址不能包含查询参数");
  if (url.hash) throw new Error("服务地址不能包含 fragment");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("服务地址仅支持 HTTP 或 HTTPS");
  if (!url.hostname) throw new Error("服务地址必须包含主机名");

  const isLoopback = ["", "localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  const baseUrl = url.toString().replace(/\/$/, "");
  return {
    baseUrl,
    protocol: url.protocol,
    hostname: url.hostname,
    isLoopback,
    requiresHttpConfirmation: url.protocol === "http:" && !isLoopback
  };
}

function readProfiles(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed.profiles).filter(([profileKey, profile]) => (
      typeof profileKey === "string" && profile && typeof profile === "object" && !Array.isArray(profile) &&
      typeof profile.baseUrl === "string" && typeof profile.updatedAt === "string" &&
      typeof profile.isLoopback === "boolean" && typeof profile.requiresHttpConfirmation === "boolean"
    )).map(([profileKey, profile]) => [profileKey, {
      baseUrl: profile.baseUrl,
      updatedAt: profile.updatedAt,
      isLoopback: profile.isLoopback,
      requiresHttpConfirmation: profile.requiresHttpConfirmation,
      httpRiskConfirmed: profile.httpRiskConfirmed === true,
      httpSessionUploadConfirmed: profile.httpSessionUploadConfirmed === true
    }]));
  } catch {
    return {};
  }
}

function writeProfiles(filePath, profiles) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ profiles }), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}无效`);
  return value;
}

function validateApiPath(requestPath) {
  if (typeof requestPath !== "string" || !requestPath.startsWith("/api/") || requestPath.includes("#") || requestPath.includes("\\") || /[\u0000-\u0020\u007f]/.test(requestPath)) {
    throw new Error("API 路径无效");
  }
  const pathOnly = requestPath.slice(0, requestPath.indexOf("?") === -1 ? requestPath.length : requestPath.indexOf("?"));
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    throw new Error("API 路径无效");
  }
  if (decodedPath.includes("\\") || decodedPath.split("/").some((segment) => segment === "." || segment === "..") || /%2f|%5c/i.test(pathOnly)) throw new Error("API 路径无效");
  return { requestPath, pathname: pathOnly };
}

function buildRequestUrl(profile, requestPath) {
  const workerUrl = new URL(profile.baseUrl);
  const requestUrl = new URL(`${profile.baseUrl}${requestPath}`);
  const expectedPathPrefix = `${workerUrl.pathname.replace(/\/$/, "")}/api/`;
  if (requestUrl.origin !== workerUrl.origin || !requestUrl.pathname.startsWith(expectedPathPrefix)) throw new Error("API 路径无效");
  return requestUrl.toString();
}

function serializeJsonBody(body) {
  if (body === undefined) return undefined;
  let serialized;
  try {
    serialized = typeof body === "string" ? body : JSON.stringify(body);
    if (typeof serialized !== "string") throw new Error("not serializable");
    JSON.parse(serialized);
  } catch {
    throw new Error("请求体必须是 JSON");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BODY_BYTES) throw new Error("请求体不能超过 256 KiB");
  return serialized;
}

function responseJson(response) {
  return response.json().catch(() => ({}));
}

function createWorkerClient({ app, safeStorage, fetchImpl = globalThis.fetch, confirmHttp = async () => false }) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch 实现不可用");
  if (typeof confirmHttp !== "function") throw new TypeError("HTTP 确认处理器无效");

  const credentialStore = createCredentialStore({ app, safeStorage });
  const profilesPath = path.join(app.getPath("userData"), "worker-profiles.json");
  const profiles = readProfiles(profilesPath);
  let activeProfileKey = null;
  let profileGeneration = 0;
  let connectionAttempt = 0;
  let connecting = false;

  async function requireHttpConfirmation(profile, confirmed, operation) {
    if (!profile.requiresHttpConfirmation) return;
    const confirmationKey = operation === "session-upload" ? "httpSessionUploadConfirmed" : "httpRiskConfirmed";
    if (profile[confirmationKey] === true) return false;
    if (!confirmed || !(await confirmHttp({ operation, profile: { ...profile } }))) {
      throw new Error("非本机 HTTP 服务需要确认安全风险");
    }
    return true;
  }

  function persistProfile(profile) {
    profiles[profile.baseUrl] = { ...profile };
    writeProfiles(profilesPath, profiles);
  }

  async function send(profile, requestPath, { method = "GET", body, signal, onSend, sessionUpload = false, token = credentialStore.getToken(profile.baseUrl) ?? "" } = {}) {
    signal?.throwIfAborted();
    const headers = { "X-Token": token };
    const serializedBody = serializeJsonBody(body);
    if (serializedBody !== undefined) headers["Content-Type"] = "application/json";
    const requestUrl = buildRequestUrl(profile, requestPath);
    let response;
    try {
      signal?.throwIfAborted();
      onSend?.();
      response = await fetchImpl(requestUrl, {
        method,
        headers,
        redirect: "error",
        ...(signal ? { signal } : {}),
        ...(serializedBody === undefined ? {} : { body: serializedBody })
      });
    } catch (error) {
      if (sessionUpload) throw safeError("unknown");
      throw error;
    }
    const data = await responseJson(response);
    if (!response.ok) throw sessionUpload ? safeError(response.status >= 500 ? "unknown" : "upload") : new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  return {
    async connectWorker(input) {
      const connection = requireRecord(input, "连接参数");
      const normalized = normalizeWorkerUrl(connection.workerUrl);
      if (connection.token !== undefined && typeof connection.token !== "string") throw new Error("令牌无效");
      profileGeneration += 1;
      const attempt = ++connectionAttempt;
      connecting = true;
      const checkCurrentAttempt = () => {
        if (attempt !== connectionAttempt) throw safeError("disconnected");
      };
      try {
        const previousProfile = profiles[normalized.baseUrl];
        const candidate = {
          ...normalized,
          // A newly supplied token changes the sensitive material sent over HTTP.
          httpRiskConfirmed: previousProfile?.httpRiskConfirmed === true && connection.token === undefined,
          httpSessionUploadConfirmed: previousProfile?.httpSessionUploadConfirmed === true
        };
        const httpRiskConfirmed = await requireHttpConfirmation(candidate, connection.httpRiskConfirmed === true, "connect");
        checkCurrentAttempt();
        const suppliedToken = typeof connection.token === "string";
        // Keep unverified credentials local to this attempt until it owns the commit.
        const token = suppliedToken ? connection.token : credentialStore.getToken(normalized.baseUrl) ?? "";
        const status = await send(normalized, "/api/status", { token });
        checkCurrentAttempt();
        const profile = {
          baseUrl: normalized.baseUrl,
          updatedAt: new Date().toISOString(),
          isLoopback: normalized.isLoopback,
          requiresHttpConfirmation: normalized.requiresHttpConfirmation,
          httpRiskConfirmed: normalized.requiresHttpConfirmation && (candidate.httpRiskConfirmed || httpRiskConfirmed === true),
          httpSessionUploadConfirmed: normalized.requiresHttpConfirmation && candidate.httpSessionUploadConfirmed
        };
        if (suppliedToken) credentialStore.setToken(normalized.baseUrl, token);
        persistProfile(profile);
        activeProfileKey = normalized.baseUrl;
        return { status, profile: status?.profile ?? null, httpRisk: normalized.requiresHttpConfirmation };
      } finally {
        if (attempt === connectionAttempt) connecting = false;
      }
    },

    prepareSessionUpload() {
      if (connecting || !activeProfileKey || !profiles[activeProfileKey]) throw safeError("disconnected");
      const profile = { ...profiles[activeProfileKey] };
      const generation = profileGeneration;
      return async (body, { signal, onSend } = {}) => {
        const checkCurrent = () => {
          signal?.throwIfAborted();
          if (connecting || profileGeneration !== generation || activeProfileKey !== profile.baseUrl) throw safeError("disconnected");
        };
        checkCurrent();
        const uploadConfirmed = await requireHttpConfirmation(profile, true, "session-upload");
        checkCurrent();
        if (uploadConfirmed) {
          profile.httpSessionUploadConfirmed = true;
          persistProfile(profile);
        }
        try {
          const result = await send(profile, "/api/lock/session", { method: "POST", body, signal, onSend, sessionUpload: true });
          if (result?.session?.uploaded !== true) throw safeError("unknown");
          return result;
        } catch (error) {
          if (error?.code !== "unknown") throw error;
          // A lost POST response is not proof that the old remote session survived.
          // Reconcile only against this upload's source timestamp on the same profile.
          try {
            checkCurrent();
            const status = await send(profile, "/api/lock/session/status", { signal });
            if (body?.saved_at && status?.session?.uploaded === true && status.session.sourceSavedAt === body.saved_at) return status;
          } catch { /* The original upload outcome remains unknown. */ }
          throw safeError("unknown");
        }
      };
    },

    async requestWorker(requestPath, input = {}) {
      const options = requireRecord(input, "请求参数");
      if (Object.hasOwn(options, "headers")) throw new Error("不允许自定义 Header");
      const pathValue = validateApiPath(requestPath);
      const method = String(options.method ?? "GET").toUpperCase();
      if (!ALLOWED_METHODS.has(method)) throw new Error("请求方法无效");
      if (!activeProfileKey || !profiles[activeProfileKey]) throw new Error("尚未连接服务");
      const profile = profiles[activeProfileKey];
      if (method === "POST" && /^\/api\/lock\/session\/?$/.test(pathValue.pathname)) {
        const uploadConfirmed = await requireHttpConfirmation(profile, options.httpRiskConfirmed === true, "session-upload");
        if (uploadConfirmed) {
          profile.httpSessionUploadConfirmed = true;
          persistProfile(profile);
        }
      }
      return send(profile, pathValue.requestPath, { method, body: options.body });
    },

    getProfile() {
      return activeProfileKey && profiles[activeProfileKey] ? { ...profiles[activeProfileKey] } : null;
    },

    clearProfile(profileKey = activeProfileKey) {
      if (typeof profileKey !== "string" || !profiles[profileKey]) return false;
      if (activeProfileKey === profileKey) profileGeneration += 1;
      delete profiles[profileKey];
      credentialStore.clearToken(profileKey);
      writeProfiles(profilesPath, profiles);
      if (activeProfileKey === profileKey) activeProfileKey = null;
      return true;
    }
  };
}

module.exports = { createWorkerClient, normalizeWorkerUrl };
