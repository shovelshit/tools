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

  function accountStatusPresentation({ account, resume } = {}) {
    if (resume) {
      if (resume.monitor && resume.lock) return { visible: true, tone: "success", text: "账号已续期，监控与等待锁座任务已恢复。", action: null };
      if (resume.monitor && resume.reasons?.includes("session_unavailable")) {
        return { visible: true, tone: "warning", text: "账号已续期，监控已恢复；锁座仍需重新登录猫眼。", action: "session" };
      }
      if (resume.reasons?.includes("notification_unverified")) {
        return { visible: true, tone: "warning", text: "账号已续期；通知尚未验证，监控暂未恢复。", action: "notification" };
      }
      return { visible: true, tone: "warning", text: "账号已续期，原任务未自动恢复，请检查当前配置。", action: null };
    }
    if (account?.accountStatus === "expired") {
      return { visible: true, tone: "warning", text: "账号已到期，监控和锁座已暂停；有空余名额时可续期 15 天。", action: "renew" };
    }
    if (account?.accountStatus === "suspended") {
      return { visible: true, tone: "neutral", text: "账号已暂停，现有配置会保留；管理员恢复账号后可继续使用。", action: null };
    }
    return { visible: false, tone: "neutral", text: "", action: null };
  }

  root.normalizeAccountConnection = normalizeAccountConnection;
  root.accountStatusPresentation = accountStatusPresentation;
})(typeof window === "undefined" ? globalThis : window);
