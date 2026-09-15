const fs = require("node:fs");
const path = require("node:path");

const { createCredentialStore } = require("./credential-store");

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
      requiresHttpConfirmation: profile.requiresHttpConfirmation
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
  if (typeof requestPath !== "string" || !requestPath.startsWith("/api/") || requestPath.includes("?") || requestPath.includes("#") || requestPath.includes("\\")) {
    throw new Error("API 路径无效");
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    throw new Error("API 路径无效");
  }
  if (decodedPath.includes("\\") || decodedPath.split("/").includes("..") || /%2f|%5c/i.test(requestPath)) throw new Error("API 路径无效");
  return requestPath;
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

  async function requireHttpConfirmation(profile, confirmed, operation) {
    if (!profile.requiresHttpConfirmation) return;
    if (!confirmed || !(await confirmHttp({ operation, profile: { ...profile } }))) {
      throw new Error("非本机 HTTP 服务需要确认安全风险");
    }
  }

  async function send(profile, requestPath, { method = "GET", body } = {}) {
    const token = credentialStore.getToken(profile.baseUrl) ?? "";
    const headers = { "X-Token": token };
    const serializedBody = serializeJsonBody(body);
    if (serializedBody !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(buildRequestUrl(profile, requestPath), {
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody })
    });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  return {
    async connectWorker(input) {
      const connection = requireRecord(input, "连接参数");
      const normalized = normalizeWorkerUrl(connection.workerUrl);
      if (connection.token !== undefined && typeof connection.token !== "string") throw new Error("令牌无效");
      await requireHttpConfirmation(normalized, connection.httpRiskConfirmed === true, "connect");

      const suppliedToken = typeof connection.token === "string";
      if (suppliedToken) credentialStore.setToken(normalized.baseUrl, connection.token);
      try {
        const status = await send(normalized, "/api/status");
        const profile = {
          baseUrl: normalized.baseUrl,
          updatedAt: new Date().toISOString(),
          isLoopback: normalized.isLoopback,
          requiresHttpConfirmation: normalized.requiresHttpConfirmation
        };
        profiles[normalized.baseUrl] = profile;
        writeProfiles(profilesPath, profiles);
        activeProfileKey = normalized.baseUrl;
        return { status, profile: status?.profile ?? null, httpRisk: normalized.requiresHttpConfirmation };
      } catch (error) {
        if (suppliedToken) credentialStore.clearToken(normalized.baseUrl);
        throw error;
      }
    },

    async requestWorker(requestPath, input = {}) {
      const options = requireRecord(input, "请求参数");
      if (Object.hasOwn(options, "headers")) throw new Error("不允许自定义 Header");
      const pathValue = validateApiPath(requestPath);
      const method = String(options.method ?? "GET").toUpperCase();
      if (!ALLOWED_METHODS.has(method)) throw new Error("请求方法无效");
      if (!activeProfileKey || !profiles[activeProfileKey]) throw new Error("尚未连接服务");
      const profile = profiles[activeProfileKey];
      if (method === "POST" && pathValue === "/api/lock/session") {
        await requireHttpConfirmation(profile, options.httpRiskConfirmed === true, "session-upload");
      }
      return send(profile, pathValue, { method, body: options.body });
    },

    getProfile() {
      return activeProfileKey && profiles[activeProfileKey] ? { ...profiles[activeProfileKey] } : null;
    },

    clearProfile(profileKey = activeProfileKey) {
      if (typeof profileKey !== "string" || !profiles[profileKey]) return false;
      delete profiles[profileKey];
      credentialStore.clearToken(profileKey);
      writeProfiles(profilesPath, profiles);
      if (activeProfileKey === profileKey) activeProfileKey = null;
      return true;
    }
  };
}

module.exports = { createWorkerClient, normalizeWorkerUrl };
