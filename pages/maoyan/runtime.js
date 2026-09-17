(function (root) {
  function createProfileGeneration() {
    let value = 0;
    const isCurrent = (generation) => generation === value;
    return {
      current: () => value,
      invalidate: () => ++value,
      isCurrent,
      async run(generation, operation, apply) {
        try {
          const result = await operation;
          if (!isCurrent(generation)) return false;
          apply(result);
          return true;
        } catch (error) {
          if (!isCurrent(generation)) return false;
          throw error;
        }
      }
    };
  }

  function switchWorkerProfile(state, normalizedUrl) {
    state.cinemaId = "";
    state.selectedMovies.length = 0;
    state.lockOpen = false;
    state.profileKey = normalizedUrl;
  }

  function createWebRuntime({ fetchImpl = root.fetch, getWorkerUrl, getToken } = {}) {
    const connectedTokens = new Map();
    async function requestWorker(path, options = {}, connection = {}) {
      if (!/^\/api\//.test(path) || /^https?:/i.test(path)) throw new Error("API 路径无效");
      const workerUrl = (connection.workerUrl ?? getWorkerUrl()).replace(/\/+$/, "");
      const headers = { "X-Token": connection.token ?? connectedTokens.get(workerUrl) ?? getToken() };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(workerUrl + path, { method: "GET", ...options, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = data.code;
        throw error;
      }
      return data;
    }

    return {
      kind: "web",
      getRuntimeInfo: async () => ({ kind: "web", canLoginMaoyan: false, persistentTokenStorage: true }),
      requestWorker,
      async connectWorker({ workerUrl, token, httpRiskConfirmed }) {
        const normalizedWorkerUrl = String(workerUrl || "").trim().replace(/\/+$/, "");
        if (!normalizedWorkerUrl) throw new Error("服务地址不能为空");
        const httpRisk = /^http:/i.test(normalizedWorkerUrl);
        if (httpRisk && !httpRiskConfirmed) throw new Error("HTTP 服务需要确认安全风险");
        try {
          const capabilities = await requestWorker("/api/capabilities", {}, { workerUrl: normalizedWorkerUrl, token });
          const auth = await requestWorker("/api/auth/session", { method: "POST" }, { workerUrl: normalizedWorkerUrl, token });
          const effectiveToken = auth.monitorSession || token;
          const status = await requestWorker("/api/status", {}, { workerUrl: normalizedWorkerUrl, token: effectiveToken });
          connectedTokens.set(normalizedWorkerUrl, effectiveToken);
          return { status, profile: auth.account || null, account: auth.account || null, capabilities, httpRisk, persistInputToken: !auth.monitorSession };
        } catch (error) {
          if (Number.isInteger(error?.status)) throw error;
          throw new Error("无法连接服务，请检查服务地址和网络");
        }
      },
      loginMaoyan: async () => ({ ok: false, code: "unsupported" }),
      cancelMaoyanLogin: async () => ({ ok: true }),
      uploadSessionFile: async () => ({ ok: false, code: "use-file-input" }),
      checkForUpdates: async () => ({ available: false }),
      openExternal: (url) => root.open(url, "_blank", "noopener")
    };
  }

  function createElectronRuntime({ bridge = root.maoyanElectron } = {}) {
    if (!bridge) throw new Error("Electron bridge unavailable");
    return {
      kind: "electron",
      ...bridge,
      async requestWorker(path, options = {}) {
        const { signal, ...serializable } = options;
        if (signal?.aborted) {
          const error = new Error("请求已取消");
          error.name = "AbortError";
          throw error;
        }
        return bridge.requestWorker(path, serializable);
      },
      getRuntimeInfo: async () => ({ persistentTokenStorage: true, ...(await bridge.getRuntimeInfo()) })
    };
  }

  function bridgeRuntime(scope) {
    const bridge = scope.maoyanElectron;
    const methods = [
      "getRuntimeInfo", "connectWorker", "requestWorker", "loginMaoyan", "cancelMaoyanLogin",
      "uploadSessionFile", "checkForUpdates", "openExternal"
    ];
    if (bridge && methods.every((name) => typeof bridge[name] === "function")) {
      return createElectronRuntime({ bridge });
    }
    return createWebRuntime({
      getWorkerUrl: () => scope.document.getElementById("worker-url")?.value.trim().replace(/\/+$/, "") || scope.location.origin,
      getToken: () => scope.document.getElementById("token-input")?.value.trim() || ""
    });
  }

  root.createWebRuntime = createWebRuntime;
  root.createElectronRuntime = createElectronRuntime;
  root.createProfileGeneration = createProfileGeneration;
  root.switchWorkerProfile = switchWorkerProfile;
  root.maoyanRuntime = bridgeRuntime(root);
})(window);
