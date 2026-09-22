(function () {
  function createAdminDashboard({ root, request }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const state = { loading: false };
    const fmt = (v) => v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "-";
    const set = (id, value) => { const el = $(id); if (el) el.textContent = value == null ? "-" : String(value); };
    function rows(id, values, columns, empty) {
      const body = $(id); body.textContent = "";
      if (!values?.length) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = columns; td.className = "muted empty-tip"; td.textContent = empty; tr.append(td); body.append(tr); return; }
      for (const item of values) { const tr = document.createElement("tr"); for (const value of item) { const td = document.createElement("td"); td.textContent = value == null ? "-" : String(value); tr.append(td); } body.append(tr); }
    }
    function render(data) {
      const s = data.summary || {};
      set("dashboard-active-users", s.activeUsers ?? 0); set("dashboard-monitoring-users", s.monitoringUsers ?? 0);
      set("dashboard-active-cinemas", s.activeCinemas ?? 0); set("dashboard-notification-rate", s.notificationSuccessRate == null ? "暂无" : `${Math.round(s.notificationSuccessRate * 100)}%`);
      set("dashboard-lock-success", s.lockSuccess ?? 0); set("dashboard-lock-failed", s.lockFailed ?? 0);
      set("dashboard-updated-at", `数据更新时间：${fmt(data.generatedAt)}`); set("dashboard-health-updated", fmt(data.generatedAt));
      rows("dashboard-users-body", (data.users || []).map((u) => [u.remark || u.userId, u.cinemaName || u.cinemaId, u.monitorState, fmt(u.lastCheck), u.lockState, u.lastNotificationState]), 6, "暂无用户监控");
      rows("dashboard-cinemas-body", (data.cinemas || []).map((c) => [c.cinemaName || c.cinemaId, c.monitoringUsers ?? c.userCount, c.newShows, c.notifications ?? c.notificationCount, `${c.lockSuccess || 0}/${c.lockFailed || 0}`]), 5, "暂无影院数据");
      const list = $("dashboard-notification-list"); list.textContent = "";
      const n = data.notifications || {}; set("dashboard-notification-summary", `待发送 ${n.pending || 0} · 失败 ${n.failed || 0}`);
      if (!(n.recent || []).length) { const p = document.createElement("p"); p.className = "muted empty-tip"; p.textContent = "暂无通知记录"; list.append(p); } else for (const item of n.recent) { const p = document.createElement("p"); p.textContent = `${item.kind || "通知"} · ${item.state || "-"} · ${fmt(item.createdAt)}` + (item.lastError ? ` · ${item.lastError}` : ""); list.append(p); }
      set("dashboard-latest-batch", fmt(data.health?.latestBatchAt)); set("dashboard-oldest-pending", fmt(data.health?.oldestPendingNotificationAt));
      const feedback = data.seatFeedback || {};
      set("dashboard-seat-feedback-summary", `近 24 小时：${feedback.count || 0} 条`);
      rows("dashboard-seat-feedback-body", (feedback.items || feedback.recent || []).map((item) => [fmt(item.reportedAt), item.cinemaId, item.movieId, item.seqNo, item.source === "manual" ? "手动" : "自动", item.tokenId, item.status === "processed" ? "已处理" : "未处理"]), 7, "暂无座位反馈");
    }
    async function load() {
      if (state.loading) return;
      state.loading = true; $("dashboard-loading")?.classList.remove("hidden"); $("dashboard-error")?.classList.add("hidden");
      try { render(await request("/api/admin/dashboard?businessLine=maoyan&window=24h")); }
      catch (error) { const el = $("dashboard-error"); if (el) { el.textContent = `看板加载失败：${error.message}`; el.classList.remove("hidden"); } }
      finally { state.loading = false; $("dashboard-loading")?.classList.add("hidden"); }
    }
    function clear() { $("dashboard-error")?.classList.add("hidden"); }
    return { load, clear };
  }
  window.createAdminDashboard = createAdminDashboard;
})();
