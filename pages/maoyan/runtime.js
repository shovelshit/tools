(function (root) {
  function createWebRuntime({ fetchImpl = root.fetch, getWorkerUrl, getToken } = {}) {
    async function requestWorker(path, options = {}, connection = {}) {
      if (!/^\/api\//.test(path) || /^https?:/i.test(path)) throw new Error("API 路径无效");
      const headers = { "X-Token": connection.token ?? getToken() };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const workerUrl = (connection.workerUrl ?? getWorkerUrl()).replace(/\/+$/, "");
      const response = await fetchImpl(workerUrl + path, { method: "GET", ...options, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    return {
      kind: "web",
      getRuntimeInfo: async () => ({ kind: "web", canLoginMaoyan: false }),
      requestWorker,
      async connectWorker({ workerUrl, token, httpRiskConfirmed }) {
        const normalizedWorkerUrl = String(workerUrl || "").trim().replace(/\/+$/, "");
        if (!normalizedWorkerUrl) throw new Error("服务地址不能为空");
        const httpRisk = /^http:/i.test(normalizedWorkerUrl);
        if (httpRisk && !httpRiskConfirmed) throw new Error("HTTP 服务需要确认安全风险");
        let status;
        try {
          status = await requestWorker("/api/status", {}, { workerUrl: normalizedWorkerUrl, token });
        } catch {
          throw new Error("无法连接服务，请检查服务地址和网络");
        }
        return { status, profile: status.profile || null, httpRisk };
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
    return { kind: "electron", ...bridge };
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
  root.maoyanRuntime = bridgeRuntime(root);
})(window);
