(function (root) {
  function normalizeAccountConnection(payload) {
    const account = payload?.account || null;
    const lifecycle = payload?.capabilities?.accountLifecycle === true;
    const status = account?.accountStatus || null;
    return {
      canRenew: lifecycle && account?.role === "user" && status === "expired",
      shouldForgetKey: lifecycle && (!account || status === "revoked"),
      canMonitor: !lifecycle || status === "active"
    };
  }

  root.normalizeAccountConnection = normalizeAccountConnection;
})(typeof window === "undefined" ? globalThis : window);
