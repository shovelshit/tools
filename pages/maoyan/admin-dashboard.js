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
    function renderFeedback(items) {
      const body = $("dashboard-seat-feedback-body"); body.textContent = "";
      if (!items.length) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 7; td.className = "muted empty-tip"; td.textContent = "暂无座位反馈"; tr.append(td); body.append(tr); return; }
      for (const item of items) {
        const tr = document.createElement("tr");
        [fmt(item.reportedAt), item.cinemaId, item.movieId, item.seqNo, item.source === "manual" ? "手动" : "自动", item.tokenId].forEach((value) => { const td = document.createElement("td"); td.textContent = value == null ? "-" : String(value); tr.append(td); });
        const status = document.createElement("td");
        const button = document.createElement("button"); button.type = "button"; button.className = "link-btn";
        const renderAction = () => { button.textContent = item.status === "processed" ? "重新打开" : "标记已处理"; };
        renderAction();
        button.addEventListener("click", async () => {
          button.disabled = true;
          const nextStatus = item.status === "processed" ? "unprocessed" : "processed";
          try {
            await request("/api/admin/seat-feedback", { method: "POST", body: JSON.stringify({ key: item.key, status: nextStatus }) });
            item.status = nextStatus;
            renderAction();
            $("dashboard-error")?.classList.add("hidden");
          } catch (error) {
            const alert = $("dashboard-error"); alert.textContent = `状态更新失败：${error.message}`; alert.classList.remove("hidden");
          } finally { button.disabled = false; }
        });
        status.append(button); tr.append(status); body.append(tr);
      }
    }
    function render(data) {
      const s = data.summary || {};
      set("dashboard-active-users", s.activeUsers ?? 0); set("dashboard-monitoring-users", s.monitoringUsers ?? 0);
      set("dashboard-active-cinemas", s.activeCinemas ?? 0); set("dashboard-notification-rate", s.notificationSuccessRate == null ? "暂无" : `${Math.round(s.notificationSuccessRate * 100)}%`);
      set("dashboard-lock-success", s.lockSuccess ?? 0); set("dashboard-lock-failed", s.lockFailed ?? 0);
      set("dashboard-updated-at", `数据更新时间：${fmt(data.generatedAt)}`); set("dashboard-health-updated", fmt(data.generatedAt));
      rows("dashboard-users-body", (data.users || []).map((u) => [u.remark || u.userId, u.cinemaName || u.cinemaId, u.monitorState, fmt(u.lastCheck), u.lockState, u.lastNotification?.state]), 6, "暂无用户监控");
      rows("dashboard-cinemas-body", (data.cinemas || []).map((c) => [c.cinemaName || c.cinemaId, c.monitoringUsers ?? c.userCount, c.newShows, c.notifications ?? c.notificationCount, `${c.lockSuccess || 0}/${c.lockFailed || 0}`]), 5, "暂无影院数据");
      const list = $("dashboard-notification-list"); list.textContent = "";
      const n = data.notifications || {}; set("dashboard-notification-summary", `待发送 ${n.pending || 0} · 发送中 ${n.sending || 0} · 失败 ${n.failed || 0}`);
      const kindNames = { "new-shows": "新场次", "lock-terminal": "锁座结果", "seat-feedback": "座位反馈", "account-expiry": "到期提醒" };
      const kinds = $("dashboard-notification-kinds"); kinds.textContent = "";
      for (const [kind, counts] of Object.entries(n.byKind || {})) {
        const line = document.createElement("p");
        const age = counts.oldestPendingAt == null ? "" : ` · 最久等待 ${Math.max(0, Math.floor((data.generatedAt - counts.oldestPendingAt) / 60000))} 分钟`;
        line.textContent = `${kindNames[kind] || kind} · 待发送 ${counts.pending || 0} · 发送中 ${counts.sending || 0} · 失败 ${counts.failed || 0}${age}`;
        kinds.append(line);
      }
      if (!(n.recent || []).length) { const p = document.createElement("p"); p.className = "muted empty-tip"; p.textContent = "暂无通知记录"; list.append(p); } else for (const item of n.recent) { const p = document.createElement("p"); p.textContent = `${kindNames[item.kind] || item.kind || "通知"} · ${item.state || "-"} · ${fmt(item.createdAt)}` + (item.discoveryToFirstAttemptMs == null ? "" : ` · 首次尝试 ${Math.round(item.discoveryToFirstAttemptMs / 1000)} 秒`) + (item.lastError ? ` · ${item.lastError}` : ""); list.append(p); }
      set("dashboard-latest-batch", fmt(data.health?.latestBatchAt)); set("dashboard-oldest-pending", fmt(data.health?.oldestPendingNotificationAt)); set("dashboard-last-maintenance", data.health?.lastMaintenanceDate || "暂无数据");
      const feedback = data.seatFeedback || {};
      set("dashboard-seat-feedback-summary", `全部反馈：${feedback.count || 0} 条`);
      renderFeedback(feedback.items || feedback.recent || []);
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
