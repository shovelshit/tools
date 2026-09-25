(function () {
  function createAdminDashboard({ root, request }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const state = { loading: false, notifications: [] };
    const fmt = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
    const set = (id, value) => { const element = $(id); if (element) element.textContent = value == null ? "-" : String(value); };
    const text = (value) => value == null || value === "" ? "-" : String(value);
    const statusNames = { monitoring: "监控中", stopped: "已停止", processing: "运行中", retryable: "待重试", completed: "已完成" };
    const notificationStates = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败" };
    const lockStates = { locked: "已锁座", failed: "锁座失败", expired: "已过期", completed: "已完成", cancelled: "已取消", waiting_schedule: "等待排期", unknown: "未知" };
    const kindNames = { "new-shows": "新场次", "lock-terminal": "锁座结果", "seat-feedback": "座位反馈", "account-expiry": "到期提醒" };

    function rows(id, values, columns, empty) {
      const body = $(id); body.textContent = "";
      if (!values.length) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = columns; td.className = "muted empty-tip"; td.textContent = empty; tr.append(td); body.append(tr); return; }
      for (const rowValues of values) { const tr = document.createElement("tr"); for (const value of rowValues) { const td = document.createElement("td"); td.textContent = text(value); tr.append(td); } body.append(tr); }
    }

    function renderFeedback(items) {
      const body = $("dashboard-seat-feedback-body"); body.textContent = "";
      if (!items.length) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 7; td.className = "muted empty-tip"; td.textContent = "暂无座位反馈"; tr.append(td); body.append(tr); return; }
      for (const item of items) {
        const tr = document.createElement("tr");
        [fmt(item.reportedAt), item.cinemaId, item.movieId, item.seqNo, item.source === "manual" ? "手动" : "自动", item.tokenId].forEach((value) => { const td = document.createElement("td"); td.textContent = text(value); tr.append(td); });
        const status = document.createElement("td"); const button = document.createElement("button"); button.type = "button"; button.className = "link-btn"; button.textContent = item.status === "processed" ? "重新打开" : "标记已处理";
        button.addEventListener("click", async () => { button.disabled = true; const nextStatus = item.status === "processed" ? "unprocessed" : "processed"; try { await request("/api/admin/seat-feedback", { method: "POST", body: JSON.stringify({ key: item.key, status: nextStatus }) }); item.status = nextStatus; button.textContent = item.status === "processed" ? "重新打开" : "标记已处理"; $("dashboard-error")?.classList.add("hidden"); } catch (error) { const alert = $("dashboard-error"); alert.textContent = `状态更新失败：${error.message}`; alert.classList.remove("hidden"); } finally { button.disabled = false; } });
        status.append(button); tr.append(status); body.append(tr);
      }
    }

    function closeDrawer() { $("dashboard-notification-drawer")?.classList.add("hidden"); }
    function showDrawer(notification) {
      const drawer = $("dashboard-notification-drawer"); const content = $("dashboard-notification-drawer-content"); content.textContent = "";
      const title = document.createElement("h4"); title.textContent = text(notification.title || "通知详情"); content.append(title);
      for (const [label, value] of [["通知 ID", notification.id], ["用户", notification.remark || notification.userId], ["状态", notificationStates[notification.state] || notification.state], ["通知类型", kindNames[notification.kind] || notification.kind], ["创建时间", fmt(notification.createdAt)], ["尝试次数", notification.attempts], ["正文", notification.content], ["发送错误", notification.lastError], ["失败详情", notification.failureDetail]]) {
        if (value == null || value === "") continue; const section = document.createElement("section"); const heading = document.createElement("strong"); heading.textContent = label; const body = document.createElement("p"); body.textContent = String(value); section.append(heading, body); content.append(section);
      }
      if (notification.meta && typeof notification.meta === "object") { const meta = document.createElement("section"); const heading = document.createElement("strong"); heading.textContent = "附加信息"; const body = document.createElement("p"); body.textContent = JSON.stringify(notification.meta); meta.append(heading, body); content.append(meta); }
      drawer.classList.remove("hidden");
    }
    async function openNotification(item) { try { showDrawer((await request(`/api/admin/notifications/${encodeURIComponent(item.id)}?businessLine=maoyan`)).notification || item); } catch (error) { const alert = $("dashboard-error"); alert.textContent = `通知详情加载失败：${error.message}`; alert.classList.remove("hidden"); } }
    function renderNotifications() {
      const list = $("dashboard-notification-list"); list.textContent = ""; const stateFilter = $("dashboard-notification-state-filter")?.value || ""; const kindFilter = $("dashboard-notification-kind-filter")?.value || "";
      const items = state.notifications.filter((item) => (!stateFilter || item.state === stateFilter) && (!kindFilter || item.kind === kindFilter));
      if (!items.length) { const p = document.createElement("p"); p.className = "muted empty-tip"; p.textContent = "暂无符合条件的通知"; list.append(p); return; }
      for (const item of items) { const row = document.createElement("div"); row.className = "dashboard-notification-row"; const button = document.createElement("button"); button.type = "button"; button.className = "dashboard-notification-trigger"; button.textContent = `${kindNames[item.kind] || item.kind || "通知"} · ${notificationStates[item.state] || item.state || "-"} · ${fmt(item.createdAt)}`; button.addEventListener("click", () => openNotification(item)); row.append(button); list.append(row); }
    }
    function bindNotificationControls() {
      $("dashboard-notification-state-filter")?.addEventListener("change", renderNotifications); $("dashboard-notification-kind-filter")?.addEventListener("change", renderNotifications); $("dashboard-notification-drawer-close")?.addEventListener("click", closeDrawer);
      $("dashboard-notification-drawer")?.addEventListener("click", (event) => { if (event.target === $("dashboard-notification-drawer")) closeDrawer(); }); root.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
    }

    function render(data) {
      const summary = data.summary || {}; set("dashboard-active-users", summary.activeUsers ?? 0); set("dashboard-monitoring-users", summary.monitoringUsers ?? 0); set("dashboard-active-cinemas", summary.activeCinemas ?? 0); set("dashboard-monitored-movies", summary.monitoredMovies ?? 0); set("dashboard-current-shows", summary.currentShows ?? 0); set("dashboard-attention-cinemas", summary.attentionCinemas ?? 0); set("dashboard-pending-notifications", summary.pendingNotifications ?? 0); set("dashboard-notification-rate", summary.notificationSuccessRate == null ? "暂无" : `${Math.round(summary.notificationSuccessRate * 100)}%`); set("dashboard-lock-success", summary.lockSuccess ?? 0); set("dashboard-lock-failed", summary.lockFailed ?? 0); set("dashboard-updated-at", `数据更新时间：${fmt(data.generatedAt)}`); set("dashboard-health-updated", fmt(data.generatedAt));
      rows("dashboard-users-body", (data.users || []).map((user) => [user.remark || user.userId, user.cinemaName || user.cinemaId, statusNames[user.monitorState] || user.monitorState, (user.monitorContent?.movies || []).map((movie) => `${movie.movieName} · ${movie.showCount}场${movie.hasMoreShows ? "（仅展示前 5 场）" : ""}`).join("、") || "暂无电影", `场次 ${user.monitorContent?.availableShows ?? 0}`, fmt(user.lastCheck), fmt(user.nextDueAt), lockStates[user.lockState] || user.lockState, notificationStates[user.lastNotification?.state] || user.lastNotification?.state]), 9, "暂无用户监控");
      rows("dashboard-cinemas-body", (data.cinemas || []).map((cinema) => [cinema.cinemaName || cinema.cinemaId, statusNames[cinema.runState] || (cinema.stale ? "逾期" : cinema.runState || "暂无"), `影片 ${cinema.movieCount ?? 0}`, `场次 ${cinema.showCount ?? 0}`, `重试 ${cinema.attemptCount ?? 0}`, cinema.activeRunId || "-", fmt(cinema.latestBatchAt), fmt(cinema.nextDueAt), cinema.monitoringUsers ?? cinema.userCount, cinema.newShows, cinema.notifications ?? cinema.notificationCount, `${cinema.lockSuccess || 0}/${cinema.lockFailed || 0}`]), 12, "暂无影院数据");
      const notifications = data.notifications || {}; state.notifications = notifications.recent || []; set("dashboard-notification-summary", `待发送 ${notifications.pending || 0} · 发送中 ${notifications.sending || 0} · 失败 ${notifications.failed || 0}`); const kinds = $("dashboard-notification-kinds"); kinds.textContent = "";
      for (const [kind, counts] of Object.entries(notifications.byKind || {})) { const line = document.createElement("p"); line.textContent = `${kindNames[kind] || kind} · 待发送 ${counts.pending || 0} · 发送中 ${counts.sending || 0} · 失败 ${counts.failed || 0}`; kinds.append(line); } renderNotifications();
      set("dashboard-latest-batch", fmt(data.health?.latestBatchAt)); set("dashboard-oldest-pending", fmt(data.health?.oldestPendingNotificationAt)); const maintenance = data.health?.maintenance; set("dashboard-maintenance-date", maintenance?.localDate || "暂无数据"); const maintenanceStatus = { unobserved: "未开始观测", unrun: "未执行", incomplete: "未完成", completed: "已完成" };
      for (const jobId of ["reminder", "archive", "revocation"]) { const job = maintenance?.jobs?.find((item) => item.jobId === jobId); set(`dashboard-maintenance-${jobId}`, job?.completedAt ? `${maintenanceStatus[job?.status] || "暂无数据"} · ${fmt(job.completedAt)}` : maintenanceStatus[job?.status] || "暂无数据"); }
      const feedback = data.seatFeedback || {}; set("dashboard-seat-feedback-summary", `全部反馈：${feedback.count || 0} 条`); renderFeedback(feedback.items || feedback.recent || []);
    }
    async function load() { if (state.loading) return; state.loading = true; $("dashboard-loading")?.classList.remove("hidden"); $("dashboard-error")?.classList.add("hidden"); try { render(await request("/api/admin/dashboard?businessLine=maoyan&window=24h")); } catch (error) { const alert = $("dashboard-error"); if (alert) { alert.textContent = `看板加载失败：${error.message}`; alert.classList.remove("hidden"); } } finally { state.loading = false; $("dashboard-loading")?.classList.add("hidden"); } }
    function clear() { $("dashboard-error")?.classList.add("hidden"); closeDrawer(); }
    bindNotificationControls(); return { load, clear };
  }
  window.createAdminDashboard = createAdminDashboard;
})();
