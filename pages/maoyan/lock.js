// 猫眼锁座 Beta 配置弹窗。会话文件仅在一次上传请求中存在于浏览器内存。
(function (root) {
  const RULE_LABELS = {
    waiting_schedule: "等待目标场次",
    matching: "正在锁座",
    locked: "已锁座，等待支付",
    failed: "锁座失败",
    expired: "目标日期已过期",
    unknown: "订单结果待人工确认"
  };

  function chinaDate(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(value);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function addChinaDays(date, days) {
    const [year, month, day] = chinaDate(date).split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  function chinaDateBounds(now = new Date()) {
    return { min: addChinaDays(now, 1), max: addChinaDays(now, 30) };
  }

  function templatesFromMovies(movies) {
    return (movies || []).filter((movie) => movie.checked).flatMap((movie) =>
      (movie.shows || []).flatMap((day) => (day.plist || []).filter(Boolean).flatMap((show) => {
        const seqNo = String(show.seqNo || "");
        if (!/^\d+$/.test(seqNo)) return [];
        return [{
          movieId: String(movie.id), movieName: String(movie.nm || ""), showDate: String(day.showDate || ""),
          tm: String(show.tm || ""), seqNo, lang: String(show.lang || ""), tp: String(show.tp || ""),
          th: String(show.th || ""), disabled: Number(show.ticketStatus) !== 0
        }];
      }))
    );
  }

  function seatLabel(seatNo) {
    const parts = String(seatNo || "").split("-");
    return parts.at(-1) || String(seatNo || "");
  }

  function isReadyToSubmit({ session, templateSeqNo, selectedSeatNos, targetDate, riskAccepted }) {
    return Boolean(session?.uploaded && templateSeqNo && selectedSeatNos?.size && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && riskAccepted);
  }

  function createMaoyanLockController({ api, getContext, onLog }) {
    const $ = (id) => document.getElementById(id);
    const els = {
      button: $("btn-lock-seats"), overlay: $("lock-overlay"), close: $("btn-lock-close"),
      cinema: $("lock-cinema"), movie: $("lock-movie"), template: $("lock-template"), date: $("lock-target-date"),
      file: $("lock-session-file"), upload: $("btn-lock-upload"), removeSession: $("btn-lock-remove-session"),
      sessionStatus: $("lock-session-status"), seatGrid: $("lock-seat-grid"), seatCount: $("lock-seat-count"),
      risk: $("lock-risk-accepted"), ruleStatus: $("lock-rule-status"), cancelRule: $("btn-lock-cancel-rule"),
      cancel: $("btn-lock-cancel"), submit: $("btn-lock-submit")
    };
    const state = {
      context: null, session: { uploaded: false }, movieId: "", templateSeqNo: "", seatMap: null,
      selectedSeatNos: new Set(), rule: null, automationEnabled: false, templates: []
    };

    function show(message, type = "info") {
      if (typeof root.showToast === "function") root.showToast(message, type);
    }

    function setHidden(el, hidden) { el?.classList.toggle("hidden", hidden); }

    function templateForCurrent() {
      return state.templates.find((item) => item.seqNo === state.templateSeqNo && item.movieId === state.movieId) || null;
    }

    function resetSeats() {
      state.seatMap = null;
      state.selectedSeatNos.clear();
      if (els.seatGrid) els.seatGrid.innerHTML = '<div class="lock-empty">选择可售场次后加载座位表</div>';
      renderSelection();
    }

    function renderSelection() {
      const seats = [...state.selectedSeatNos];
      if (els.seatCount) els.seatCount.textContent = seats.length ? `已选 ${seats.length} 座：${seats.join("、")}` : "尚未选择座位";
      if (els.submit) els.submit.disabled = !isReadyToSubmit({
        session: state.session, templateSeqNo: state.templateSeqNo, selectedSeatNos: state.selectedSeatNos,
        targetDate: els.date?.value || "", riskAccepted: els.risk?.checked
      });
    }

    function renderSession() {
      const session = state.session || { uploaded: false };
      if (!els.sessionStatus) return;
      if (!session.uploaded) {
        els.sessionStatus.textContent = "尚未上传猫眼会话";
        setHidden(els.removeSession, true);
        return;
      }
      const parts = [session.uidMasked, session.sourceSavedAt && `来源 ${session.sourceSavedAt}`, session.uploadedAt && `上传 ${session.uploadedAt}`].filter(Boolean);
      els.sessionStatus.textContent = parts.join(" · ");
      setHidden(els.removeSession, false);
    }

    function renderRule() {
      if (!els.ruleStatus) return;
      const rule = state.rule;
      if (!rule) {
        els.ruleStatus.textContent = "暂无已保存的锁座规则";
        setHidden(els.cancelRule, true);
        return;
      }
      const seats = (rule.seats || []).map((seat) => seat.seatNo || seat).join("、");
      const status = RULE_LABELS[rule.state] || "规则状态未知";
      const suffix = rule.automationEnabled ? "" : " · 规则已保存，等待服务验证，当前不会自动建单";
      els.ruleStatus.textContent = `${rule.cinemaName || "影院"} · ${rule.movieName || "影片"} · ${rule.targetDate || ""} ${rule.templateTime || ""} · ${seats} · ${status}${suffix}`;
      setHidden(els.cancelRule, false);
    }

    function renderTemplates() {
      state.templates = templatesFromMovies(state.context?.movies || []);
      els.movie.innerHTML = "";
      const movieIds = [...new Set(state.templates.map((item) => item.movieId))];
      if (!movieIds.length) {
        els.movie.append(new Option("请先勾选至少一部影片", ""));
        els.movie.disabled = true;
        els.template.innerHTML = "";
        els.template.append(new Option("暂无可用场次", ""));
        els.template.disabled = true;
        state.movieId = "";
        state.templateSeqNo = "";
        resetSeats();
        return;
      }
      els.movie.disabled = false;
      for (const movieId of movieIds) {
        const movie = state.templates.find((item) => item.movieId === movieId);
        els.movie.append(new Option(movie.movieName, movieId));
      }
      if (!movieIds.includes(state.movieId)) state.movieId = movieIds[0];
      els.movie.value = state.movieId;
      renderTemplateOptions();
    }

    function renderTemplateOptions() {
      els.template.innerHTML = "";
      const templates = state.templates.filter((item) => item.movieId === state.movieId);
      if (!templates.length) {
        els.template.append(new Option("暂无场次", ""));
        els.template.disabled = true;
        state.templateSeqNo = "";
      } else {
        els.template.disabled = false;
        els.template.append(new Option("选择当前场次作为座位模板", ""));
        for (const item of templates) {
          const details = [item.showDate, item.tm, item.lang, item.tp, item.th].filter(Boolean).join(" · ");
          const option = new Option(item.disabled ? `${details}（停售）` : details, item.seqNo);
          option.disabled = item.disabled;
          els.template.append(option);
        }
        const current = templates.find((item) => item.seqNo === state.templateSeqNo && !item.disabled);
        state.templateSeqNo = current ? current.seqNo : "";
      }
      els.template.value = state.templateSeqNo;
      resetSeats();
    }

    function renderSeatMap() {
      els.seatGrid.innerHTML = "";
      const seats = state.seatMap?.seats || [];
      if (!seats.length) {
        els.seatGrid.innerHTML = '<div class="lock-empty">该场次暂无可用座位图</div>';
        return;
      }
      const rows = new Map();
      for (const seat of seats) {
        if (!/^\d+$/.test(String(seat.rowId)) || !/^\d+$/.test(String(seat.columnId))) continue;
        const key = String(seat.rowId);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(seat);
      }
      for (const [rowId, rowSeats] of [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const row = document.createElement("div");
        row.className = "lock-seat-row";
        const label = document.createElement("span");
        label.className = "lock-row-label";
        label.textContent = `${rowId}排`;
        const grid = document.createElement("div");
        grid.className = "lock-seat-grid";
        for (const seat of rowSeats) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `lock-seat${seat.available ? " available" : " unavailable"}`;
          button.style.gridColumn = String(Number(seat.columnId));
          button.textContent = seatLabel(seat.seatNo);
          button.title = String(seat.seatNo);
          button.disabled = !seat.available;
          button.classList.toggle("selected", state.selectedSeatNos.has(String(seat.seatNo)));
          if (seat.available) {
            button.addEventListener("click", () => {
              const key = String(seat.seatNo);
              if (state.selectedSeatNos.has(key)) state.selectedSeatNos.delete(key);
              else state.selectedSeatNos.add(key);
              button.classList.toggle("selected", state.selectedSeatNos.has(key));
              renderSelection();
            });
          }
          grid.append(button);
        }
        row.append(label, grid);
        els.seatGrid.append(row);
      }
      renderSelection();
    }

    async function loadSeats() {
      const template = templateForCurrent();
      resetSeats();
      if (!template || template.disabled || !state.context?.cinemaId) return;
      els.seatGrid.innerHTML = '<div class="lock-empty">正在加载座位表...</div>';
      try {
        const params = new URLSearchParams({ cinemaId: state.context.cinemaId, movieId: state.movieId, seqNo: state.templateSeqNo });
        const { seatMap } = await api(`/api/lock/template-seats?${params}`);
        state.seatMap = seatMap;
        renderSeatMap();
      } catch (error) {
        state.seatMap = null;
        els.seatGrid.innerHTML = '<div class="lock-empty">座位表加载失败，请确认猫眼会话后重试</div>';
        show(error.message || "座位表加载失败", "error");
      }
    }

    async function refreshRemoteState() {
      const [sessionResult, ruleResult] = await Promise.allSettled([
        api("/api/lock/session/status"), api("/api/lock/rule")
      ]);
      state.session = sessionResult.status === "fulfilled" ? (sessionResult.value.session || { uploaded: false }) : { uploaded: false };
      state.rule = ruleResult.status === "fulfilled" ? (ruleResult.value.rule || null) : null;
      state.automationEnabled = Boolean(state.rule?.automationEnabled);
      renderSession();
      renderRule();
    }

    async function uploadSession() {
      const file = els.file.files?.[0];
      if (!file) return show("请选择猫眼会话文件", "warn");
      if (file.size > 256 * 1024) {
        els.file.value = "";
        return show("会话文件不能超过 256KiB", "error");
      }
      let sessionText = "";
      try {
        sessionText = await file.text();
        const { session } = await api("/api/lock/session", { method: "POST", body: sessionText });
        state.session = session || { uploaded: false };
        renderSession();
        renderSelection();
        show("猫眼会话已加密保存", "success");
        onLog?.("ok", "猫眼会话已上传，用于锁座 Beta");
      } catch (error) {
        show(error.message || "上传失败", "error");
      } finally {
        sessionText = "";
        els.file.value = "";
      }
    }

    async function removeSession() {
      const confirmed = await root.showConfirm("删除后将不能查询座位或自动锁座，是否继续？", { title: "删除猫眼会话", okText: "删除", danger: true });
      if (!confirmed) return;
      try {
        await api("/api/lock/session/remove", { method: "POST" });
        state.session = { uploaded: false };
        state.rule = null;
        state.automationEnabled = false;
        resetSeats();
        renderSession();
        renderRule();
        show("猫眼会话已删除", "success");
      } catch (error) {
        show(error.message || "删除失败", "error");
      }
    }

    async function createRule() {
      const payload = {
        cinemaId: state.context.cinemaId, movieId: state.movieId, templateSeqNo: state.templateSeqNo,
        targetDate: els.date.value, seatNos: [...state.selectedSeatNos], riskAccepted: els.risk.checked
      };
      try {
        const { rule } = await api("/api/lock/rule", { method: "POST", body: JSON.stringify(payload) });
        state.rule = rule || null;
        state.automationEnabled = Boolean(rule?.automationEnabled);
        renderRule();
        show(state.automationEnabled ? "自动锁座规则已启用" : "规则已保存，等待服务验证", "success");
        onLog?.("ok", "自动锁座 Beta 规则已保存");
      } catch (error) {
        show(error.message || "保存锁座规则失败", "error");
      }
    }

    async function cancelRule() {
      const confirmed = await root.showConfirm("取消后不会影响已上传的猫眼会话，是否继续？", { title: "取消锁座规则", okText: "取消规则", danger: true });
      if (!confirmed) return;
      try {
        await api("/api/lock/rule/cancel", { method: "POST" });
        state.rule = null;
        state.automationEnabled = false;
        renderRule();
        show("锁座规则已取消", "success");
      } catch (error) {
        show(error.message || "取消失败", "error");
      }
    }

    function close() {
      els.overlay.classList.add("hidden");
      document.removeEventListener("keydown", onKeydown);
    }

    function onKeydown(event) { if (event.key === "Escape") close(); }

    function syncAvailability() {
      const context = getContext();
      const available = Boolean(context?.cinemaId && context.movies?.length);
      els.button.disabled = !available;
      els.button.title = available ? "配置自动锁座" : "请先加载影院并勾选至少一部影片";
      return available;
    }

    async function open() {
      if (!syncAvailability()) return show("请先加载影院并勾选至少一部影片", "warn");
      state.context = getContext();
      els.cinema.value = state.context.cinemaName || `影院 ${state.context.cinemaId}`;
      const bounds = chinaDateBounds();
      els.date.min = bounds.min;
      els.date.max = bounds.max;
      if (!els.date.value || els.date.value < bounds.min || els.date.value > bounds.max) els.date.value = bounds.min;
      els.risk.checked = false;
      renderTemplates();
      renderSelection();
      els.overlay.classList.remove("hidden");
      document.addEventListener("keydown", onKeydown);
      try {
        await refreshRemoteState();
      } catch {
        show("锁座状态加载失败，请稍后重试", "error");
      }
    }

    els.button.addEventListener("click", open);
    els.close.addEventListener("click", close);
    els.cancel.addEventListener("click", close);
    els.overlay.addEventListener("click", (event) => { if (event.target === els.overlay) close(); });
    els.movie.addEventListener("change", () => { state.movieId = els.movie.value; state.templateSeqNo = ""; renderTemplateOptions(); });
    els.template.addEventListener("change", async () => { state.templateSeqNo = els.template.value; await loadSeats(); });
    els.date.addEventListener("change", renderSelection);
    els.risk.addEventListener("change", renderSelection);
    els.upload.addEventListener("click", uploadSession);
    els.removeSession.addEventListener("click", removeSession);
    els.submit.addEventListener("click", createRule);
    els.cancelRule.addEventListener("click", cancelRule);
    resetSeats();

    return { syncAvailability, open };
  }

  const exported = { createMaoyanLockController, lockUtils: { templatesFromMovies, chinaDateBounds, seatLabel, isReadyToSubmit } };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root?.document) root.createMaoyanLockController = createMaoyanLockController;
})(typeof window !== "undefined" ? window : globalThis);
