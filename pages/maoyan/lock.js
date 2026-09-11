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
    return { min: addChinaDays(now, 0), max: addChinaDays(now, 30) };
  }

  function lockDateBounds(templateDate, now = new Date()) {
    const today = chinaDate(now);
    const max = addChinaDays(now, 30);
    // 目标日期允许当天: 不早于今天, 且不早于模板场次日期
    const min = templateDate && templateDate > today ? templateDate : today;
    return { min, max, valid: min <= max };
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

  function isActiveLockRule(rule) {
    return rule?.state === "waiting_schedule" || rule?.state === "matching";
  }

  function isReadyToSubmit({ session, templateSeqNo, selectedSeatNos, targetDate, riskAccepted, dateBounds, rule }) {
    const boundsValid = !dateBounds || (dateBounds.valid && targetDate >= dateBounds.min && targetDate <= dateBounds.max);
    return Boolean(session?.uploaded && templateSeqNo && selectedSeatNos?.size && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && riskAccepted && boundsValid && !isActiveLockRule(rule));
  }

  function isLockAvailable({ connected, cinemaId, cinemaSelected }) {
    return Boolean(connected && cinemaId && cinemaSelected);
  }

  function createMaoyanLockController({ api, getContext, onLog }) {
    const $ = (id) => document.getElementById(id);
    const els = {
      button: $("btn-lock-seats"), overlay: $("lock-overlay"), close: $("btn-lock-close"),
      cinema: $("lock-cinema"), movie: $("lock-movie"), template: $("lock-template"), date: $("lock-target-date"),
      file: $("lock-session-file"), upload: $("btn-lock-upload"), removeSession: $("btn-lock-remove-session"),
      sessionStatus: $("lock-session-status"), seatGrid: $("lock-seat-grid"), seatCount: $("lock-seat-count"),
      risk: $("lock-risk-accepted"), ruleStatus: $("lock-rule-status"), cancelRule: $("btn-lock-cancel-rule"),
      templateLabel: $("lock-template-label"),
      seatSource: $("lock-seat-source"),
      cancel: $("btn-lock-cancel"), submit: $("btn-lock-submit"),
      zoomIn: $("btn-lock-zoom-in"), zoomOut: $("btn-lock-zoom-out"), zoomReset: $("btn-lock-zoom-reset"), zoomLabel: $("lock-zoom-label")
    };
    const state = {
      context: null, session: { uploaded: false }, movieId: "", templateSeqNo: "", seatMap: null,
      selectedSeatNos: new Set(), rule: null, automationEnabled: false, templates: [], dateBounds: lockDateBounds(),
      zoom: 1
    };

    function show(message, type = "info") {
      if (typeof root.showToast === "function") root.showToast(message, type);
    }

    function buttonLoading(btn, text, task) {
      if (typeof root.withButtonLoading === "function") return root.withButtonLoading(btn, text, task);
      return task();
    }

    function loadingHtml(text) {
      return `<span class="spinner"></span>${text}`;
    }

    function setHidden(el, hidden) { el?.classList.toggle("hidden", hidden); }

    function templateForCurrent() {
      return state.templates.find((item) => item.seqNo === state.templateSeqNo && item.movieId === state.movieId) || null;
    }

    function resetSeats() {
      state.seatMap = null;
      state.selectedSeatNos.clear();
      state.seatMapSource = "";
      renderSeatSource();
      if (els.seatGrid) els.seatGrid.innerHTML = '<div class="lock-empty">选择可售场次后加载座位表</div>';
      renderSelection();
    }

    // 座位图来源提示: 目标场次真实座位图 / 无场次时的未来推断提醒
    function renderSeatSource() {
      if (!els.seatSource) return;
      if (!state.seatMapSource) {
        els.seatSource.classList.add("hidden");
        return;
      }
      els.seatSource.textContent = state.seatMapSource;
      els.seatSource.classList.toggle("warn", state.seatMapIsTemplate === true);
      els.seatSource.classList.remove("hidden");
    }

    function seatDisplayLabel(seat) {
      return `${seat.rowId}排${seat.columnId}座`;
    }

    function seatLabelMap() {
      const map = new Map();
      for (const seat of state.seatMap?.seats || []) {
        map.set(String(seat.seatNo), seatDisplayLabel(seat));
      }
      return map;
    }

    function renderSelection() {
      const labels = seatLabelMap();
      const seats = [...state.selectedSeatNos].map((seatNo) => labels.get(seatNo) || seatNo);
      if (els.seatCount) {
        const source = state.seatMapSource ? `${state.seatMapSource} · ` : "";
        els.seatCount.textContent = seats.length
          ? `${source}已选 ${seats.length} 座：${seats.join("、")}`
          : `${source}尚未选择座位`;
      }
      if (els.submit) els.submit.disabled = !isReadyToSubmit({
        session: state.session, templateSeqNo: state.templateSeqNo, selectedSeatNos: state.selectedSeatNos,
        targetDate: els.date?.value || "", riskAccepted: els.risk?.checked, dateBounds: state.dateBounds, rule: state.rule
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
        renderSelection();
        return;
      }
      const seats = (rule.seats || []).map((seat) => seat.seatNo || seat).join("、");
      const status = RULE_LABELS[rule.state] || "规则状态未知";
      const suffix = rule.automationEnabled ? "" : " · 规则已保存，等待服务验证，当前不会自动建单";
      els.ruleStatus.textContent = `${rule.cinemaName || "影院"} · ${rule.movieName || "影片"} · ${rule.targetDate || ""} ${rule.templateTime || ""} · ${seats} · ${status}${suffix}`;
      setHidden(els.cancelRule, false);
      renderSelection();
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
        els.templateLabel.textContent = "场次";
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
      if (!els.date.value) updateTargetDateBounds();
      renderShowOptions();
    }

    // 目标日期有排期 → 第三项为「目标场次」(真实座位图); 无排期 → 「座位模板场次」(推断布局)
    function renderShowOptions() {
      const targetDateStr = els.date?.value || "";
      const movieTemplates = state.templates.filter((item) => item.movieId === state.movieId);
      const targetShows = movieTemplates.filter((item) => item.showDate === targetDateStr);
      els.template.innerHTML = "";
      if (targetShows.length) {
        state.showMode = "target";
        els.templateLabel.textContent = "目标场次";
        els.template.disabled = targetShows.every((item) => item.disabled);
        for (const item of targetShows) {
          const details = [item.tm, item.lang, item.tp, item.th].filter(Boolean).join(" · ");
          els.template.append(new Option(details, item.seqNo));
        }
        const current = targetShows.find((item) => item.seqNo === state.templateSeqNo) || targetShows[0];
        state.templateSeqNo = current.seqNo;
        state.seatMapIsTemplate = false;
        state.seatMapSource = `展示目标场次 ${targetDateStr} 的真实座位图`;
      } else {
        state.showMode = "template";
        els.templateLabel.textContent = "座位模板场次（推断布局）";
        state.seatMapSource = `${targetDateStr || "该日期"} 暂无场次，以下为模板场次的未来推断座位（全部可选，开售后按实际售卖为准）`;
        if (!movieTemplates.length) {
          els.template.append(new Option("暂无场次", ""));
          els.template.disabled = true;
          state.templateSeqNo = "";
        } else {
          els.template.disabled = false;
          for (const item of movieTemplates) {
            const details = [item.showDate, item.tm, item.lang, item.tp, item.th].filter(Boolean).join(" · ");
            const option = new Option(item.disabled ? `${details}（停售）` : details, item.seqNo);
            option.disabled = item.disabled;
            els.template.append(option);
          }
          const current = movieTemplates.find((item) => item.seqNo === state.templateSeqNo && !item.disabled);
          state.templateSeqNo = current ? current.seqNo : "";
        }
      }
      els.template.value = state.templateSeqNo;
      renderSeatSource();
      resetSeats();
    }

    function couplePartner(seat) {
      if (seat.type !== "L" && seat.type !== "R") return null;
      const opposite = seat.type === "L" ? "R" : "L";
      return (state.seatMap?.seats || []).find((candidate) =>
        candidate.type === opposite && String(candidate.rowId) === String(seat.rowId) &&
        Math.abs(Number(candidate.columnId) - Number(seat.columnId)) === 1) || null;
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
      const orderedRows = [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
      // 列号表头(与猫眼一致)
      const allCols = seats.map((seat) => Number(seat.columnId)).filter(Number.isFinite);
      if (allCols.length) {
        const header = document.createElement("div");
        header.className = "lock-seat-row";
        const headerLabel = document.createElement("span");
        headerLabel.className = "lock-row-label";
        const headerGrid = document.createElement("div");
        headerGrid.className = "lock-seat-grid";
        for (let col = Math.min(...allCols); col <= Math.max(...allCols); col++) {
          const cell = document.createElement("span");
          cell.className = "lock-col-label";
          cell.style.gridColumn = String(col);
          cell.textContent = String(col);
          headerGrid.append(cell);
        }
        header.append(headerLabel, headerGrid);
        els.seatGrid.append(header);
      }
      for (const [rowId, rowSeats] of orderedRows) {
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
          const available = seat.available;
          const loverClass = seat.type === "L" ? " lover-left" : seat.type === "R" ? " lover-right" : "";
          button.className = `lock-seat${available ? " available" : " unavailable"}${loverClass}`;
          button.style.gridColumn = String(Number(seat.columnId));
          button.textContent = String(seat.columnId);
          button.title = `${seatDisplayLabel(seat)}${loverClass ? " · 情侣座需成对选择" : ""}${available ? "" : "（不可选）"}`;
          button.disabled = !available;
          button.dataset.seatNo = String(seat.seatNo);
          button.classList.toggle("selected", state.selectedSeatNos.has(String(seat.seatNo)));
          if (available) {
            button.addEventListener("click", () => {
              // 情侣座成对选择: 点一个自动带上相邻的另一半
              const keys = [String(seat.seatNo)];
              const partner = couplePartner(seat);
              if (partner) keys.push(String(partner.seatNo));
              const allSelected = keys.every((key) => state.selectedSeatNos.has(key));
              for (const key of keys) {
                if (allSelected) state.selectedSeatNos.delete(key);
                else state.selectedSeatNos.add(key);
              }
              for (const el of grid.children) {
                if (el.dataset.seatNo) el.classList.toggle("selected", state.selectedSeatNos.has(el.dataset.seatNo));
              }
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

    function applyZoom() {
      if (els.seatGrid) els.seatGrid.style.transform = `scale(${state.zoom})`;
      if (els.zoomLabel) els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    function changeZoom(delta) {
      state.zoom = Math.min(2, Math.max(0.4, Math.round((state.zoom + delta) * 10) / 10));
      applyZoom();
    }

    function resetZoom() {
      state.zoom = 1;
      applyZoom();
    }

    async function loadSeats() {
      resetSeats();
      if (!state.templateSeqNo || !state.context?.cinemaId) return;
      els.seatGrid.innerHTML = loadingHtml("正在加载座位表...");
      try {
        renderSeatSource();
        const params = new URLSearchParams({ cinemaId: state.context.cinemaId, movieId: state.movieId, seqNo: state.templateSeqNo });
        const { seatMap } = await api(`/api/lock/template-seats?${params}`);
        if (state.seatMapIsTemplate && seatMap?.seats) {
          // 未来推断: 尚未开售, 模板座位全部视为可选
          seatMap.seats = seatMap.seats.map((seat) => ({ ...seat, available: true }));
        }
        state.seatMap = seatMap;
        renderSeatMap();
      } catch (error) {
        state.seatMap = null;
        els.seatGrid.innerHTML = '<div class="lock-empty">座位表加载失败，请确认猫眼会话后重试</div>';
        show(error.message || "座位表加载失败", "error");
      }
    }

    function updateTargetDateBounds() {
      state.dateBounds = chinaDateBounds();
      els.date.min = state.dateBounds.min;
      els.date.max = state.dateBounds.max;
      if (!els.date.value || els.date.value < state.dateBounds.min || els.date.value > state.dateBounds.max) {
        els.date.value = state.dateBounds.min;
      }
    }

    async function refreshRemoteState() {
      if (els.sessionStatus) els.sessionStatus.innerHTML = loadingHtml("正在加载锁座状态...");
      if (els.ruleStatus) els.ruleStatus.innerHTML = loadingHtml("正在加载锁座状态...");
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
      await buttonLoading(els.upload, "上传中...", async () => {
        let sessionText = "";
        try {
          sessionText = await file.text();
          const { session } = await api("/api/lock/session", { method: "POST", body: sessionText });
          state.session = session || { uploaded: false };
          renderSession();
          renderSelection();
          show("猫眼会话已加密保存", "success");
          onLog?.("ok", "猫眼会话已上传，用于锁座（Beta）");
        } catch (error) {
          show(error.message || "上传失败", "error");
        } finally {
          sessionText = "";
          els.file.value = "";
        }
      });
    }

    async function removeSession() {
      const confirmed = await root.showConfirm("删除后将不能查询座位或自动锁座，是否继续？", { title: "删除猫眼会话", okText: "删除", danger: true });
      if (!confirmed) return;
      await buttonLoading(els.removeSession, "删除中...", async () => {
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
      });
    }

    async function createRule() {
      const payload = {
        cinemaId: state.context.cinemaId, movieId: state.movieId, templateSeqNo: state.templateSeqNo,
        targetDate: els.date.value, seatNos: [...state.selectedSeatNos], riskAccepted: els.risk.checked
      };
      await buttonLoading(els.submit, "提交中...", async () => {
        try {
          const { rule } = await api("/api/lock/rule", { method: "POST", body: JSON.stringify(payload) });
          state.rule = rule || null;
          state.automationEnabled = Boolean(rule?.automationEnabled);
          renderRule();
          show(state.automationEnabled ? "自动锁座规则已启用" : "规则已保存，等待服务验证", "success");
          onLog?.("ok", "锁座（Beta）规则已保存");
        } catch (error) {
          show(error.message || "保存锁座规则失败", "error");
        }
      });
    }

    async function cancelRule() {
      const confirmed = await root.showConfirm("取消后不会影响已上传的猫眼会话，是否继续？", { title: "取消锁座规则", okText: "取消规则", danger: true });
      if (!confirmed) return;
      await buttonLoading(els.cancelRule, "取消中...", async () => {
        try {
          await api("/api/lock/rule/cancel", { method: "POST" });
          state.rule = null;
          state.automationEnabled = false;
          renderRule();
          show("锁座规则已取消", "success");
        } catch (error) {
          show(error.message || "取消失败", "error");
        }
      });
    }

    function close() {
      els.overlay.classList.add("hidden");
      document.removeEventListener("keydown", onKeydown);
    }

    function onKeydown(event) { if (event.key === "Escape") close(); }

    function syncAvailability() {
      const context = getContext();
      const available = isLockAvailable(context || {});
      els.button.disabled = !available;
      els.button.title = available ? "配置自动锁座" : "请先在影院设置中选择影院";
      return available;
    }

    async function open() {
      if (!syncAvailability()) return show("请先在影院设置中选择影院", "warn");
      state.context = getContext();
      els.cinema.value = state.context.cinemaName || `影院 ${state.context.cinemaId}`;
      els.risk.checked = false;
      renderTemplates();
      renderSelection();
      els.overlay.classList.remove("hidden");
      document.addEventListener("keydown", onKeydown);
      await Promise.allSettled([refreshRemoteState(), loadSeats()]);
    }

    els.button.addEventListener("click", open);
    els.close.addEventListener("click", close);
    els.cancel.addEventListener("click", close);
    els.overlay.addEventListener("click", (event) => { if (event.target === els.overlay) close(); });
    els.movie.addEventListener("change", () => { state.movieId = els.movie.value; state.templateSeqNo = ""; renderShowOptions(); });
    els.date.addEventListener("change", () => { renderShowOptions(); loadSeats(); });
    els.template.addEventListener("change", async () => { state.templateSeqNo = els.template.value; await loadSeats(); });
    els.risk.addEventListener("change", renderSelection);
    els.upload.addEventListener("click", uploadSession);
    els.removeSession.addEventListener("click", removeSession);
    els.submit.addEventListener("click", createRule);
    els.cancelRule.addEventListener("click", cancelRule);
    els.zoomIn.addEventListener("click", () => changeZoom(0.2));
    els.zoomOut.addEventListener("click", () => changeZoom(-0.2));
    els.zoomReset.addEventListener("click", resetZoom);
    // Ctrl/Cmd+滚轮缩放, 双指捏合缩放; 普通滚轮保持滚动
    const scrollEl = els.seatGrid.closest(".lock-seat-scroll");
    if (scrollEl) {
      scrollEl.addEventListener("wheel", (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
      }, { passive: false });
      let pinch = null;
      scrollEl.addEventListener("touchstart", (event) => {
        if (event.touches.length === 2) {
          pinch = {
            dist: Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY),
            zoom: state.zoom
          };
          event.preventDefault();
        }
      }, { passive: false });
      scrollEl.addEventListener("touchmove", (event) => {
        if (!pinch || event.touches.length !== 2) return;
        event.preventDefault();
        const dist = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
        if (pinch.dist > 0) {
          state.zoom = Math.min(2, Math.max(0.4, Math.round((pinch.zoom * dist) / pinch.dist * 10) / 10));
          applyZoom();
        }
      }, { passive: false });
      scrollEl.addEventListener("touchend", () => { pinch = null; });
    }
    resetSeats();

    return { syncAvailability, open, refreshTemplates: renderTemplates, close };
  }

  const exported = { createMaoyanLockController, lockUtils: { templatesFromMovies, chinaDateBounds, lockDateBounds, seatLabel, isReadyToSubmit, isLockAvailable } };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root?.document) root.createMaoyanLockController = createMaoyanLockController;
})(typeof window !== "undefined" ? window : globalThis);
