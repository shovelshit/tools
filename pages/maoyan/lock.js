// 猫眼锁座 Beta 配置弹窗。会话文件仅在一次上传请求中存在于浏览器内存。
(function (root) {
  const seatLayout = root.MaoyanSeatLayout;
  if (!seatLayout) throw new Error("座位布局模块未加载");
  const { seatSegmentOf, seatPosition, seatDisplayLabel } = seatLayout;

  const RULE_LABELS = {
    waiting_schedule: "等待目标场次",
    matching: "正在锁座",
    locked: "已锁座，等待支付",
    failed: "锁座失败",
    expired: "目标日期已过期",
    unknown: "锁座失败"
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

  function lockDateBounds(now = new Date()) {
    const min = addChinaDays(now, 0);
    const max = addChinaDays(now, 30);
    return { min, max, valid: min <= max };
  }

  function fitSeatViewport({ contentWidth, contentHeight, viewportWidth, viewportHeight, padding = 12 } = {}) {
    const contentW = Number(contentWidth);
    const contentH = Number(contentHeight);
    const viewportW = Number(viewportWidth);
    const viewportH = Number(viewportHeight);
    const inset = Number(padding);
    if (![contentW, contentH, viewportW, viewportH, inset].every(Number.isFinite)
      || contentW <= 0 || contentH <= 0 || viewportW <= 0 || viewportH <= 0 || inset < 0) return null;
    const availableW = viewportW - inset * 2;
    const availableH = viewportH - inset * 2;
    if (availableW <= 0 || availableH <= 0) return null;
    const zoom = Math.min(1, availableW / contentW, availableH / contentH);
    return {
      zoom,
      panX: (viewportW - contentW * zoom) / 2,
      panY: (viewportH - contentH * zoom) / 2
    };
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

  // 情侣座按排内物理位置配对。columnId/票面座号在不同影院既可能递增也可能递减，
  // orderIndex 才是猫眼 DOM 中包含过道后的真实左右顺序。
  function couplePartnerOf(seats, seat) {
    if (!seat || (seat.type !== "L" && seat.type !== "R") || !Array.isArray(seats)) return null;
    const orderIndex = Number(seat.orderIndex);
    if (!Number.isInteger(orderIndex) || orderIndex <= 0) return null;
    const expected = seat.type === "L" ? orderIndex + 1 : orderIndex - 1;
    const opposite = seat.type === "L" ? "R" : "L";
    const atPosition = (position) => seats.filter((candidate) =>
      String(candidate.rowId) === String(seat.rowId) && Number(candidate.orderIndex) === position);
    const partners = atPosition(expected);
    return atPosition(orderIndex).length === 1 && partners.length === 1 && partners[0].type === opposite
      ? partners[0] : null;
  }

  function seatVisualState(seat, { selected = false, isTemplate = false } = {}) {
    if (selected) return "selected";
    if (isTemplate) return "available";
    const availability = String(seat?.availability || "");
    if (["available", "sold", "unavailable", "unknown"].includes(availability)) return availability;
    return seat?.available === true ? "available" : "unknown";
  }

  function isActiveLockRule(rule) {
    return rule?.state === "waiting_schedule" || rule?.state === "matching";
  }

  function isReadyToSubmit({ session, templateSeqNo, selectedSeatNos, targetDate, riskAccepted, dateBounds, rule }) {
    const boundsValid = !dateBounds || (dateBounds.valid && targetDate >= dateBounds.min && targetDate <= dateBounds.max);
    return Boolean(session?.uploaded && templateSeqNo && selectedSeatNos?.size && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && riskAccepted && boundsValid && !isActiveLockRule(rule));
  }

  function isLockAvailable({ connected, cinemaId, cinemaSelected, lockServiceEnabled, monitorEnabled }) {
    // 锁座是监控的附属能力: 监控停止后入口一并禁用(monitorEnabled 缺省视为可用, 兼容旧调用方)
    return Boolean(connected && cinemaId && cinemaSelected && lockServiceEnabled && monitorEnabled !== false);
  }

  function lockAction(showMode) {
    return showMode === "target"
      ? { buttonText: "立即锁座", loadingText: "锁座中...", successText: "已创建待支付订单" }
      : { buttonText: "保存自动锁座规则", loadingText: "保存中...", successText: "自动锁座规则已启用" };
  }

  function parseTimeTolerance(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const minutes = Number(raw);
    return Number.isInteger(minutes) && minutes >= 0 && minutes <= 180 ? minutes : null;
  }

  function validTemplateTime(value) {
    if (!/^\d{2}:\d{2}$/.test(String(value || ""))) return false;
    const [hour, minute] = value.split(":").map(Number);
    return hour <= 23 && minute <= 59;
  }

  function matchingTimeWindow(templateTime, tolerance) {
    if (!validTemplateTime(templateTime)) return null;
    const [hour, minute] = String(templateTime).split(":").map(Number);
    const center = hour * 60 + minute;
    const format = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    return `${format(Math.max(0, center - tolerance))}-${format(Math.min(1439, center + tolerance))}`;
  }

  async function changeMovieSelection({ state, movieId, renderShowOptions, loadSeats }) {
    state.movieId = movieId;
    state.templateSeqNo = "";
    renderShowOptions();
    await loadSeats();
  }

  function preferredTargetShow(shows, selectedSeqNo) {
    return shows.find((item) => item.seqNo === selectedSeqNo && !item.disabled)
      || shows.find((item) => !item.disabled)
      || null;
  }

  function clearSeatSelection(state, { clearSource = false } = {}) {
    state.seatMap = null;
    state.selectedSeatNos.clear();
    if (clearSource) {
      state.seatMapSource = "";
      state.seatMapIsTemplate = false;
    }
  }

  function publicSession(session) {
    if (!session?.uploaded) return { uploaded: false };
    const result = { uploaded: true };
    for (const key of ["uidMasked", "sourceSavedAt", "uploadedAt"]) {
      if (typeof session[key] === "string") result[key] = session[key];
    }
    return result;
  }

  function detailOpenState(session, rule) {
    const uploaded = session?.uploaded === true;
    return { session: !uploaded, rule: Boolean(rule) };
  }

  function createMaoyanLockController({
    api, runtime, getContext, onLog, onPollingState, getProfileGeneration, isProfileGenerationCurrent
  }) {
    const seatViewportPadding = 12;
    const $ = (id) => document.getElementById(id);
    const els = {
      button: $("btn-lock-seats"), overlay: $("lock-overlay"), close: $("btn-lock-close"),
      cinema: $("lock-cinema"), movie: $("lock-movie"), template: $("lock-template"), date: $("lock-target-date"),
      timeTolerance: $("lock-time-tolerance"), inferenceWarning: $("lock-inference-warning"),
      file: $("lock-session-file"), login: $("btn-lock-login"), upload: $("btn-lock-upload"), removeSession: $("btn-lock-remove-session"),
      sessionStatus: $("lock-session-status"), seatGrid: $("lock-seat-grid"), seatCount: $("lock-seat-count"),
      risk: $("lock-risk-accepted"), ruleStatus: $("lock-rule-status"), cancelRule: $("btn-lock-cancel-rule"),
      templateLabel: $("lock-template-label"),
      seatSource: $("lock-seat-source"),
      seatFeedback: $("btn-lock-seat-feedback"),
      officialToggle: $("lock-official-toggle"),
      officialWrap: $("lock-official-wrap"), officialFrame: $("lock-official-frame"),
      officialZoomIn: $("btn-official-zoom-in"), officialZoomOut: $("btn-official-zoom-out"),
      officialZoomReset: $("btn-official-zoom-reset"), officialZoomLabel: $("official-zoom-label"),
      officialGesture: $("lock-official-gesture"),
      gateHint: $("lock-gate-hint"),
      sessionDetails: $("lock-session-details"), sessionSummary: $("lock-session-summary"),
      ruleDetails: $("lock-rule-details"), ruleSummary: $("lock-rule-summary"),
      sectionSchedule: $("lock-section-schedule"),
      sectionSeats: $("lock-section-seats"),
      sectionRisk: $("lock-section-risk"),
      sectionRules: $("lock-section-rules"),
      cancel: $("btn-lock-cancel"), submit: $("btn-lock-submit"),
      zoomIn: $("btn-lock-zoom-in"), zoomOut: $("btn-lock-zoom-out"), zoomReset: $("btn-lock-zoom-reset"), zoomLabel: $("lock-zoom-label")
    };
    // 官方对比区视图状态: fit=onload 适应缩放, zoom=用户缩放(1=适应), 视觉缩放=fit*zoom
    const officialView = { fit: 1, zoom: 1, panX: 0, panY: 0, w: 0, h: 0 };
    let officialLoadSeq = 0;
    let officialAbort = null;
    if (els.officialFrame) { bindOfficialAutoScale(els.officialFrame); bindOfficialZoom(); }
    const state = {
      context: null, session: { uploaded: false }, movieId: "", templateSeqNo: "", seatMap: null,
      selectedSeatNos: new Set(), rule: null, automationEnabled: false, templates: [], dateBounds: lockDateBounds(),
      seatSeg: 2, zoom: 1, panX: 0, panY: 0, viewMode: "fit", seatFeedback: { seqNo: "", at: 0 },
      runtimeInfo: { kind: "web", canLoginMaoyan: false }, sessionActionBusy: false
    };
    let seatFitFrame = null;
    let seatResizeObserver = null;

    function show(message, type = "info") {
      if (typeof root.showToast === "function") root.showToast(message, type);
    }

    function emitPollingState() {
      const active = Boolean(state.rule && ["waiting_schedule", "matching"].includes(state.rule.state));
      onPollingState?.({ open: !els.overlay.classList.contains("hidden"), active, ruleSummary: getPanelSummary() });
    }

    function showNativeSessionResult(result, fallback, type) {
      // Native IPC has already projected these messages; never display raw result fields.
      const message = result?.ok === false && typeof result.message === "string" && result.message.trim()
        ? result.message.slice(0, 1000) : fallback;
      const warnings = Array.isArray(result?.warnings) ? result.warnings
        .filter((warning) => warning?.code === "cleanup" && typeof warning.message === "string")
        .slice(0, 1).map((warning) => warning.message.slice(0, 1000)) : [];
      show([message, ...warnings].join("\n"), warnings.length && type !== "error" ? "warn" : type);
    }

    function buttonLoading(btn, text, task) {
      if (typeof root.withButtonLoading === "function") return root.withButtonLoading(btn, text, task);
      return task();
    }

    function capturedProfileGeneration() {
      return typeof getProfileGeneration === "function" ? getProfileGeneration() : null;
    }

    function isCurrentProfileGeneration(generation) {
      return generation === null || typeof isProfileGenerationCurrent !== "function" || isProfileGenerationCurrent(generation);
    }

    function loadingHtml(text) {
      return `<span class="spinner"></span>${text}`;
    }

    function setHidden(el, hidden) { el?.classList.toggle("hidden", hidden); }

    function setDetailsOpen(details, open) {
      if (!details) return;
      const active = root.document?.activeElement;
      const focusInside = active && typeof details.contains === "function" && details.contains(active);
      if (open || !focusInside) details.open = Boolean(open);
    }

    function renderSessionActions() {
      const info = state.runtimeInfo || { kind: "web", canLoginMaoyan: false };
      const isElectron = info.kind === "electron";
      const context = state.context || getContext?.() || {};
      const loginAvailable = isElectron && info.canLoginMaoyan === true && context.connected && context.cinemaId && context.cinemaSelected;
      if (els.login) {
        els.login.textContent = isElectron
          ? (info.canLoginMaoyan ? "一键登录猫眼" : "桌面端暂不支持一键登录")
          : "Web端不支持一键登录";
        els.login.disabled = !loginAvailable || state.sessionActionBusy;
        els.login.title = loginAvailable ? "在桌面端登录猫眼" : (isElectron ? "请先连接 Worker 并选择影院" : "Web端不支持一键登录");
      }
      if (els.upload) {
        els.upload.textContent = "手动上传登录态";
        els.upload.disabled = state.sessionActionBusy;
      }
      if (els.file) setHidden(els.file, isElectron);
    }

    async function refreshRuntimeInfo() {
      const generation = capturedProfileGeneration();
      try {
        const info = await runtime?.getRuntimeInfo?.();
        if (!isCurrentProfileGeneration(generation)) return;
        state.runtimeInfo = {
          kind: info?.kind === "electron" ? "electron" : "web",
          canLoginMaoyan: info?.canLoginMaoyan === true
        };
      } catch {
        if (!isCurrentProfileGeneration(generation)) return;
        state.runtimeInfo = { kind: "web", canLoginMaoyan: false };
      }
      renderSessionActions();
    }

    function setSessionActionBusy(busy) {
      state.sessionActionBusy = busy;
      renderSessionActions();
    }

    function templateForCurrent() {
      return state.templates.find((item) => item.seqNo === state.templateSeqNo && item.movieId === state.movieId) || null;
    }

    function resetSeats(options) {
      clearSeatSelection(state, options);
      renderSeatSource();
      if (els.seatGrid) els.seatGrid.innerHTML = '<div class="lock-empty">选择可售场次后加载座位表</div>';
      renderSelection();
    }

    // 座位图来源提示: 目标场次真实座位图 / 无场次时的未来推断提醒
    function renderSeatSource() {
      renderInferenceControls();
      if (!els.seatSource) return;
      if (!state.seatMapSource) {
        els.seatSource.classList.add("hidden");
        return;
      }
      els.seatSource.textContent = state.seatMapSource;
      els.seatSource.classList.toggle("warn", state.seatMapIsTemplate === true);
      els.seatSource.classList.remove("hidden");
    }

    function selectedTimeTolerance() {
      return parseTimeTolerance(els.timeTolerance?.value);
    }

    function savedTimeToleranceLabel(value) {
      if (value === undefined || value === null) return "匹配范围未提供";
      if (Number.isInteger(value) && value >= 0 && value <= 180) return `±${value}分钟`;
      return `匹配范围异常（${String(value)}）`;
    }

    // 推断控件与风险提示只在未来日期无真实场次时显示，更新范围不会影响已选座位。
    function renderInferenceControls() {
      const inferred = state.seatMapIsTemplate === true && state.showMode === "template" && (els.date?.value || "") > chinaDate(new Date());
      setHidden(els.sectionRisk, !state.session?.uploaded || !inferred);
      if (!inferred || !els.inferenceWarning) return;
      const templateTime = templateForCurrent()?.tm || "";
      const tolerance = selectedTimeTolerance();
      els.timeTolerance?.setAttribute("aria-invalid", String(tolerance === null));
      let range;
      if (tolerance === null) range = "匹配范围需为 0 至 180 的整数。";
      else if (!validTemplateTime(templateTime)) range = "模板场次时间无效，请重新选择场次。";
      else range = `将以模板场次 ${templateTime} 为基准，在目标日期前后 ${tolerance} 分钟内推断匹配（目标日期 ${matchingTimeWindow(templateTime, tolerance)}）。`;
      els.inferenceWarning.textContent = `目标场次尚未确定。${range}仅当影片与具体影厅均与模板一致且场次可售时，才会自动锁座；如有多个同等接近的场次，将优先选择较早场次。实际影厅、座位布局和售卖状态仍可能变化，锁座成功后仅生成待支付订单，请在有效时间内自行支付。`;
    }

    function seatLabelMap() {
      const map = new Map();
      for (const seat of state.seatMap?.seats || []) {
        map.set(String(seat.seatNo), seatDisplayLabel(seat, state.seatSeg));
      }
      return map;
    }

    function getPanelSummary() {
      const rule = state.rule;
      if (!rule) return { exists: false, cinema: "", movie: "", rule: "暂无锁座规则", active: false };
      const labels = seatLabelMap();
      const seats = (rule.seats || [])
        .map((seat) => seat?.label || labels.get(String(seat?.seatNo ?? seat)) || seatDisplayLabel(seat, state.seatSeg))
        .filter(Boolean)
        .join("、") || "未选择座位";
      const target = [rule.targetDate, rule.templateTime].filter(Boolean).join(" ");
      const hall = rule.hall || "";
      const tolerance = savedTimeToleranceLabel(rule.timeToleranceMinutes);
      const status = RULE_LABELS[rule.state] || "规则状态未知";
      return {
        exists: true,
        cinema: rule.cinemaName || "影院",
        movie: rule.movieName || "影片",
        rule: [target, hall, tolerance, seats, status].filter(Boolean).join(" · "),
        active: isActiveLockRule(rule)
      };
    }

    // 提交按钮的置灰原因(展示在按钮 title 上)
    function submitBlockReason() {
      if (!state.session?.uploaded) return "请先上传猫眼会话";
      if (!state.templateSeqNo) return "请选择场次";
      if (state.seatMapIsTemplate && !validTemplateTime(templateForCurrent()?.tm)) return "模板场次时间无效，请重新选择场次";
      if (!state.selectedSeatNos.size) return "请先选择座位";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(els.date?.value || "")) return "请选择目标日期";
      if (state.seatMapIsTemplate && selectedTimeTolerance() === null) return "匹配范围需为 0 至 180 的整数";
      // 风险确认仅针对推断座位(真实座位图无推断风险, 无需勾选)
      if (state.seatMapIsTemplate && !els.risk?.checked) return "请先勾选风险提示";
      if (state.dateBounds && ((els.date.value || "") < state.dateBounds.min || (els.date.value || "") > state.dateBounds.max)) {
        return "目标日期超出 30 天范围";
      }
      if (isActiveLockRule(state.rule)) return "已有进行中的规则，请先取消";
      return "";
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
      const reason = submitBlockReason();
      if (els.submit) {
        els.submit.textContent = lockAction(state.showMode).buttonText;
        els.submit.disabled = Boolean(reason);
        els.submit.title = reason;
      }
    }

    // 门控: 无猫眼会话时只保留「猫眼会话」上传区并给出引导, 其余区块隐藏;
    // 上传成功(或本来就有会话)才展示完整界面
    function renderGate(gated) {
      setHidden(els.gateHint, !gated);
      for (const el of [els.sectionSchedule, els.sectionSeats, els.sectionRules]) {
        setHidden(el, gated);
      }
      renderInferenceControls();
    }

    function renderSession() {
      const session = state.session || { uploaded: false };
      if (!els.sessionStatus) return;
      renderSessionActions();
      const gated = !session.uploaded;
      renderGate(gated);
      const detailState = detailOpenState(session, state.rule);
      setDetailsOpen(els.sessionDetails, detailState.session);
      if (gated) {
        els.sessionStatus.textContent = "尚未上传猫眼会话";
        if (els.sessionSummary) els.sessionSummary.textContent = "尚未上传";
        setHidden(els.removeSession, true);
        return;
      }
      const parts = [session.uidMasked, session.sourceSavedAt && `来源 ${session.sourceSavedAt}`, session.uploadedAt && `上传 ${session.uploadedAt}`].filter(Boolean);
      els.sessionStatus.textContent = parts.join(" · ");
      if (els.sessionSummary) els.sessionSummary.textContent = session.uidMasked || "已上传";
      setHidden(els.removeSession, false);
    }

    function renderRule() {
      if (!els.ruleStatus) return;
      const rule = state.rule;
      if (!rule) {
        els.ruleStatus.textContent = "暂无已保存的锁座规则";
        if (els.ruleSummary) els.ruleSummary.textContent = "暂无";
        setDetailsOpen(els.ruleDetails, false);
        setHidden(els.cancelRule, true);
        renderSelection();
        emitPollingState();
        return;
      }
      // 规则里存的是内部座位标识(seatNo), 展示统一换成「几排几座」(排号=rowId); 影厅名一并展示。
      // 优先用创建时服务端持久化的 label(全图普查定段); 旧规则回退本地展示换算
      const labels = seatLabelMap();
      const seats = (rule.seats || [])
        .map((seat) => seat?.label || labels.get(String(seat?.seatNo ?? seat)) || seatDisplayLabel(seat, state.seatSeg))
        .join("、");
      const status = RULE_LABELS[rule.state] || "规则状态未知";
      const suffix = rule.state === "waiting_schedule" && !rule.automationEnabled
          ? " · 锁座服务当前已停用"
          : "";
      const hall = rule.hall ? ` · ${rule.hall}` : "";
      const tolerance = ` · ${savedTimeToleranceLabel(rule.timeToleranceMinutes)}`;
      els.ruleStatus.textContent = `${rule.cinemaName || "影院"} · ${rule.movieName || "影片"}${hall} · ${rule.targetDate || ""} ${rule.templateTime || ""}${tolerance} · ${seats} · ${status}${suffix}`;
      if (els.ruleSummary) els.ruleSummary.textContent = status;
      setDetailsOpen(els.ruleDetails, detailOpenState(state.session, rule).rule);
      setHidden(els.cancelRule, false);
      renderSelection();
      emitPollingState();
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
        resetSeats({ clearSource: true });
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

    // 目标日期有排期 → 「目标场次」(真实座位图, 立即锁座); 未来日期无排期 → 「座位模板场次」(推断布局, 保存等待规则);
    // 今天/已过日期无排期 → 列出其他日期的真实场次, 选中即把目标日期切到该场次日期, 按真实场次「立即锁座」
    function renderShowOptions() {
      if (!els.date.value) els.date.value = chinaDate(new Date());
      const targetDateStr = els.date.value;
      const movieTemplates = state.templates.filter((item) => item.movieId === state.movieId);
      const targetShows = movieTemplates.filter((item) => item.showDate === targetDateStr);
      els.template.innerHTML = "";
      if (targetShows.length) {
        state.showMode = "target";
        els.templateLabel.textContent = "目标场次";
        els.template.disabled = targetShows.every((item) => item.disabled);
        for (const item of targetShows) {
          const details = [item.tm, item.lang, item.tp, item.th].filter(Boolean).join(" · ");
          const option = new Option(item.disabled ? `${details}（停售）` : details, item.seqNo);
          option.disabled = item.disabled;
          els.template.append(option);
        }
        const current = preferredTargetShow(targetShows, state.templateSeqNo);
        state.templateSeqNo = current?.seqNo || "";
        state.seatMapIsTemplate = false;
        state.seatMapSource = `展示目标场次 ${targetDateStr} 的真实座位图`;
      } else {
        // 黄色推断提示只在选了未来日期且该日期无场次时展示
        const isFuture = targetDateStr > chinaDate(new Date());
        if (!movieTemplates.length) {
          state.showMode = "template";
          state.seatMapIsTemplate = true;
          els.templateLabel.textContent = "座位模板场次（推断布局）";
          state.seatMapSource = isFuture
            ? `${targetDateStr} 暂无场次，以下为模板场次的未来推断座位（全部可选，开售后按实际售卖为准）`
            : `${targetDateStr} 暂无场次，以下为模板场次的推断座位（全部可选）`;
          els.template.append(new Option("暂无场次", ""));
          els.template.disabled = true;
          state.templateSeqNo = "";
        } else if (!isFuture) {
          // 今天/已过日期无场次: 推断等待无意义, 列出的其他日期场次都是真实场次。
          // 占位选中项不产生任何规则; 用户选定后由 change 监听按 jumpDate 切换目标日期,
          // 重新进入「目标场次」真实模式(真实座位图 + 立即锁座), 不再走推断/保存规则路径。
          state.showMode = "target";
          state.seatMapIsTemplate = false;
          state.seatMapSource = `${targetDateStr} 已无场次，可选择其他日期的真实场次直接锁定`;
          els.templateLabel.textContent = "其他日期场次（真实可锁）";
          els.template.disabled = false;
          els.template.append(new Option("请选择场次（选中后锁定该真实场次）", ""));
          const sorted = movieTemplates.slice().sort((a, b) => a.showDate.localeCompare(b.showDate) || a.tm.localeCompare(b.tm));
          for (const item of sorted) {
            const details = [item.showDate, item.tm, item.lang, item.tp, item.th].filter(Boolean).join(" · ");
            // 已过日期的场次不可锁(目标日期限制为今天起 30 天), 一律置灰
            const option = new Option(item.disabled ? `${details}（停售）` : details, item.seqNo);
            option.disabled = item.disabled || item.showDate < targetDateStr;
            option.dataset.jumpDate = item.showDate;
            els.template.append(option);
          }
          state.templateSeqNo = "";
        } else {
          state.showMode = "template";
          state.seatMapIsTemplate = true;
          els.templateLabel.textContent = "座位模板场次（推断布局）";
          els.template.disabled = false;
          // 推断模板收敛到「最后一个有真实场次的日期」: 越接近目标日期的排片形态越可能延续;
          // 跨日期全量列出会让默认模板落在最早一天的旧布局上(用户报障: 选 9.21 却用 9.14 早场做模板)
          const lastDate = movieTemplates.reduce((acc, item) => (item.showDate > acc ? item.showDate : acc), "");
          const lastDayShows = movieTemplates.filter((item) => item.showDate === lastDate);
          for (const item of lastDayShows) {
            const details = [item.showDate, item.tm, item.lang, item.tp, item.th].filter(Boolean).join(" · ");
            const option = new Option(item.disabled ? `${details}（停售）` : details, item.seqNo);
            option.disabled = item.disabled;
            els.template.append(option);
          }
          // 默认选该日末班(最后一场可售); 用户此前已选中该日的场次则保留其选择
          const preferred = lastDayShows.find((item) => item.seqNo === state.templateSeqNo && !item.disabled)
            || lastDayShows.filter((item) => !item.disabled).sort((a, b) => b.tm.localeCompare(a.tm))[0]
            || null;
          state.templateSeqNo = preferred ? preferred.seqNo : "";
          state.seatMapSource = `${targetDateStr} 暂无场次，以 ${lastDate} 末班场次为模板推断未来座位（全部可选，开售后按实际售卖为准）`;
        }
      }
      els.template.value = state.templateSeqNo;
      renderSeatSource();
      resetSeats();
    }

    function couplePartner(seat) {
      return couplePartnerOf(state.seatMap?.seats, seat);
    }

    function renderSeatMap() {
      els.seatGrid.innerHTML = "";
      const seats = state.seatMap?.seats || [];
      if (!seats.length) {
        els.seatGrid.innerHTML = '<div class="lock-empty">该场次暂无可用座位图</div>';
        return;
      }
      // 布局口径(主站同款): orderIndex=座位在排内的物理位次(含过道占位), cols=每排物理格总数。
      // 猫眼每排按 DOM 顺序铺满 data-cols 格, 过道由空占位符占据 → 居中/孤立座/等宽排。
      // 旧数据(无 orderIndex)回落票面座号布局: 座号当格位, 有跳号时同样能留出缺口。
      const hasOrder = seats.some((seat) => Number(seat?.orderIndex) > 0);
      const gridWidth = hasOrder
        ? Math.max(
            Number(state.seatMap?.cols) || 0,
            ...seats.map((seat) => Number(seat?.orderIndex) || 0)
          )
        : 0;
      const rows = new Map();
      for (const seat of seats) {
        const position = seatPosition(seat, state.seatSeg);
        if (!position) continue;
        const key = String(position.rowNumber);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(seat);
      }
      // 上游 DOM 顺序就是影厅从前到后的官方排序；字母排号不能再做 Number 排序。
      const orderedRows = [...rows.entries()];
      // 列号表头: 与猫眼一致用票面座号。物理格模式下跨排过道错位会让同一格位座号不同
      // (如排10 的孤立座), 取该格位上出现最多的票面号, 过道格留空
      const allCols = seats.map((seat) => seatPosition(seat, state.seatSeg)?.seatNumber).filter(Number.isFinite);
      if (allCols.length) {
        const header = document.createElement("div");
        header.className = "lock-seat-row";
        const headerLabel = document.createElement("span");
        headerLabel.className = "lock-row-label";
        const headerGrid = document.createElement("div");
        headerGrid.className = "lock-seat-grid";
        if (hasOrder) {
          headerGrid.style.gridTemplateColumns = `repeat(${gridWidth}, 28px)`;
          const tally = new Map();
          for (const seat of seats) {
            const cell = Number(seat?.orderIndex) || 0;
            const position = seatPosition(seat, state.seatSeg);
            if (cell <= 0 || !position) continue;
            if (!tally.has(cell)) tally.set(cell, new Map());
            const counts = tally.get(cell);
            counts.set(position.seatNumber, (counts.get(position.seatNumber) || 0) + 1);
          }
          for (let col = 1; col <= gridWidth; col++) {
            const cell = document.createElement("span");
            cell.className = "lock-col-label";
            cell.style.gridColumn = String(col);
            let bestCount = 0;
            let bestNumber = "";
            for (const [number, count] of tally.get(col) || []) {
              if (count > bestCount) { bestCount = count; bestNumber = number; }
            }
            cell.textContent = bestNumber ? String(bestNumber) : "";
            headerGrid.append(cell);
          }
        } else {
          for (let col = Math.min(...allCols); col <= Math.max(...allCols); col++) {
            const cell = document.createElement("span");
            cell.className = "lock-col-label";
            cell.style.gridColumn = String(col);
            cell.textContent = String(col);
            headerGrid.append(cell);
          }
        }
        header.append(headerLabel, headerGrid);
        els.seatGrid.append(header);
      }
      for (const [rowNumber, rowSeats] of orderedRows) {
        const row = document.createElement("div");
        row.className = "lock-seat-row";
        const label = document.createElement("span");
        label.className = "lock-row-label";
        label.textContent = `${rowNumber}排`;
        const grid = document.createElement("div");
        grid.className = "lock-seat-grid";
        // 物理格模式: 每排显式等宽(占位格无元素也要撑位), 否则座位少的排右端会参差
        if (hasOrder) grid.style.gridTemplateColumns = `repeat(${gridWidth}, 28px)`;
        for (const seat of rowSeats) {
          const button = document.createElement("button");
          button.type = "button";
          const partner = couplePartner(seat);
          const isLover = seat.type === "L" || seat.type === "R";
          const loverClass = partner ? (seat.type === "L" ? " lover-left" : " lover-right") : "";
          // 情侣座另一半不可用(或缺失)时整格置灰: 半对无法单独下单
          const seatState = seatVisualState(seat, { isTemplate: state.seatMapIsTemplate });
          const partnerState = partner ? seatVisualState(partner, { isTemplate: state.seatMapIsTemplate }) : "unknown";
          const selectable = seatState === "available" && (!isLover || partnerState === "available");
          const pairHint = isLover
            ? (partnerState === "available" ? " · 情侣座需成对选择" : " · 情侣座另一半不可用，无法单独购买")
            : "";
          const selected = state.selectedSeatNos.has(String(seat.seatNo));
          button.className = `lock-seat ${seatState}${selected ? " is-selected" : ""}${loverClass}`;
          button.dataset.availability = seatState;
          // 格位: 物理格模式用 orderIndex(与主站 DOM 位次一致, 过道留空); 回落模式用票面座号。
          // 文字一律票面座号, 用户凭「X排Y座」对号入座
          const seatNumber = seatPosition(seat, state.seatSeg)?.seatNumber ?? Number(seat.columnId);
          const cellIndex = hasOrder && Number(seat.orderIndex) > 0 ? Number(seat.orderIndex) : seatNumber;
          button.style.gridColumn = String(cellIndex);
          button.textContent = String(seatNumber);
          const stateHint = state.seatMapIsTemplate ? " · 布局参考"
            : seatState === "sold" ? " · 已售"
              : seatState === "available" ? ""
                : ` · ${seat.disabledReason || (seatState === "unknown" ? "状态未知" : "不可用")}`;
          button.title = `${seatDisplayLabel(seat, state.seatSeg)}${pairHint}${stateHint}${selectable ? "" : "（不可选）"}`;
          button.setAttribute("aria-label", button.title);
          button.setAttribute("aria-pressed", String(selected));
          button.disabled = !selectable;
          button.dataset.seatNo = String(seat.seatNo);
          if (selectable) {
            button.addEventListener("click", () => {
              // 情侣座以「对」为单位整体选中/取消: 点一个自动带上相邻的另一半
              const keys = [String(seat.seatNo)];
              if (partnerState === "available") keys.push(String(partner.seatNo));
              const allSelected = keys.every((key) => state.selectedSeatNos.has(key));
              for (const key of keys) {
                if (allSelected) state.selectedSeatNos.delete(key);
                else state.selectedSeatNos.add(key);
              }
              for (const el of grid.children) {
                if (el.dataset.seatNo) {
                  const isSelected = state.selectedSeatNos.has(el.dataset.seatNo);
                  el.classList.toggle("is-selected", isSelected);
                  el.setAttribute("aria-pressed", String(isSelected));
                }
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
      scheduleSeatFit();
    }

    function applyTransform() {
      if (els.seatGrid) els.seatGrid.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
      if (els.zoomLabel) els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    function seatViewportSize() {
      const box = els.seatGrid?.closest(".lock-seat-scroll");
      if (!box || !els.seatGrid) return null;
      return {
        contentWidth: els.seatGrid.offsetWidth,
        contentHeight: els.seatGrid.offsetHeight,
        viewportWidth: box.clientWidth,
        viewportHeight: box.clientHeight
      };
    }

    function fitSeatMap() {
      if (state.viewMode !== "fit") return false;
      const fitted = fitSeatViewport({ ...seatViewportSize(), padding: seatViewportPadding });
      if (!fitted) return false;
      state.zoom = fitted.zoom;
      state.panX = fitted.panX;
      state.panY = fitted.panY;
      applyTransform();
      return true;
    }

    // 座位、行标与列标统一按实际内容边界测量。零尺寸由 ResizeObserver 的下一次布局回调重试。
    function scheduleSeatFit() {
      if (state.viewMode !== "fit" || seatFitFrame !== null) return;
      const run = () => {
        seatFitFrame = null;
        fitSeatMap();
      };
      if (typeof root.requestAnimationFrame === "function") {
        seatFitFrame = root.requestAnimationFrame(run);
      } else {
        run();
      }
    }

    // 平移边界与自动适应使用相同内边距: 小图居中，大图至少保留一侧可见边缘。
    function clampPan() {
      const size = seatViewportSize();
      if (!size) return;
      const w = size.contentWidth * state.zoom;
      const h = size.contentHeight * state.zoom;
      const availableW = size.viewportWidth - seatViewportPadding * 2;
      const availableH = size.viewportHeight - seatViewportPadding * 2;
      state.panX = w <= availableW ? (size.viewportWidth - w) / 2
        : Math.min(seatViewportPadding, Math.max(size.viewportWidth - seatViewportPadding - w, state.panX));
      state.panY = h <= availableH ? (size.viewportHeight - h) / 2
        : Math.min(seatViewportPadding, Math.max(size.viewportHeight - seatViewportPadding - h, state.panY));
    }

    function applyZoom() {
      clampPan();
      applyTransform();
    }

    // 以容器可视区坐标 (px,py) 为锚点缩放, 保持锚点下的内容位置不动
    function zoomAt(newZoom, px, py) {
      const previous = state.zoom;
      state.zoom = Math.min(2, Math.max(0.1, Math.round(newZoom * 100) / 100));
      if (state.zoom === previous) return;
      state.viewMode = "manual";
      const ratio = state.zoom / previous;
      state.panX = px - (px - state.panX) * ratio;
      state.panY = py - (py - state.panY) * ratio;
      applyZoom();
    }

    function changeZoom(delta) {
      const box = els.seatGrid?.closest(".lock-seat-scroll");
      zoomAt(state.zoom + delta, box ? box.clientWidth / 2 : 0, box ? box.clientHeight / 2 : 0);
    }

    function resetZoom() {
      state.viewMode = "fit";
      scheduleSeatFit();
    }

    // 官方座位图对比(1:1 复刻): seatMap.officialHtml 是 worker 从猫眼原页提取的 seats-block
    // 片段(已剥脚本/埋点属性), 放进无脚本沙箱 iframe 配官方 CSS 副本(pages/maoyan/maoyan-seat.css)
    // 还原主站渲染。CSS 副本随官方改版可能失效, 失效时 iframe 仍显示原始 DOM(近似样式),
    // 只影响对比观感, 不影响工具座位图与下单链路。iframe 高度按排数估算(沙箱无脚本无法自适应)。
    function renderOfficialCompare(seatMap) {
      if (!els.officialWrap || !els.officialFrame) return;
      officialView.w = 0; // 新片段待 onload 重新测量, 期间手势不生效
      const html = String(seatMap?.officialHtml || "");
      if (!html) {
        els.officialWrap.classList.add("hidden");
        els.officialFrame.removeAttribute("srcdoc");
        return;
      }
      const rowIds = new Set((seatMap?.seats || []).map((seat) => String(seat.rowId)));
      const frameHeight = 100 + rowIds.size * 44 + 40;
      els.officialFrame.style.height = `${frameHeight}px`;
      els.officialFrame.srcdoc = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">`
        + `<link rel="stylesheet" href="maoyan-seat.css?v=20260914c">`
        // html/body 双 overflow:hidden: transform 只改视觉不改布局, body 布局宽仍超视口,
        // 不禁用会出现横向滚动条且吃掉一排高度(线上用户截图实锤)
        + `<style>*{box-sizing:border-box}html{overflow:hidden}body{margin:0;background:#fff;overflow:hidden}`
        // 银幕水平居中基线: 官方主站由 JS 运行时给 .screen-container 写 left/width,
        // 服务端原始片段没有(抓取发生在执行前), 沙箱零脚本不会定位 -> 银幕落在静态位置(最左缘)。
        // 基线让银幕容器撑满 seats-container、550px 银幕 margin auto 居中(缩放态下容器宽=座位区宽, 已居中)。
        + `.seats-block .screen-container{left:0;right:0}`
        + `.seats-block .screen-container .screen{margin-left:auto;margin-right:auto}</style>`
        + `</head><body>${html}</body></html>`;
      els.officialWrap.classList.remove("hidden");
      els.officialWrap.open = true;
    }

    function clearOfficialCompare({ resetToggle = false } = {}) {
      officialLoadSeq += 1;
      officialAbort?.abort?.();
      officialAbort = null;
      renderOfficialCompare(null);
      if (resetToggle && els.officialToggle) els.officialToggle.checked = false;
    }

    async function loadOfficialCompare() {
      if (!els.officialToggle?.checked || !state.seatMap || !state.context?.cinemaId || !state.movieId || !state.templateSeqNo) return;
      const loadSeq = ++officialLoadSeq;
      officialAbort?.abort?.();
      officialAbort = typeof AbortController === "function" ? new AbortController() : null;
      const generation = capturedProfileGeneration();
      const expectedSeqNo = String(state.templateSeqNo);
      const params = new URLSearchParams({ cinemaId: state.context.cinemaId, movieId: state.movieId, seqNo: expectedSeqNo });
      try {
        const result = await api(`/api/lock/official-seats?${params}`, officialAbort ? { signal: officialAbort.signal } : {});
        if (loadSeq !== officialLoadSeq || !els.officialToggle.checked || !isCurrentProfileGeneration(generation) ||
          String(state.templateSeqNo) !== expectedSeqNo || String(result.seqNo) !== expectedSeqNo) return;
        renderOfficialCompare({ ...state.seatMap, officialHtml: result.officialHtml });
      } catch (error) {
        if (loadSeq !== officialLoadSeq || error?.name === "AbortError" || !isCurrentProfileGeneration(generation)) return;
        renderOfficialCompare(null);
        show("官方座位图暂时不可用，工具座位选择不受影响", "warn");
      } finally {
        if (loadSeq === officialLoadSeq) officialAbort = null;
      }
    }

    // 官方片段自适应缩放: 主站选座页由 JS 把座位图缩到约 0.4 适配容器(座位格基准 40px, 37 格内容约 1520px),
    // 无脚本沙箱内不会自动缩, 这里在父页面 onload 后测量并注入纯 CSS transform(iframe 内仍然零脚本运行)。
    // 注意 .seats-block 自带 overflow:hidden, body.scrollWidth 不含被裁内容, 须先用 width:max-content 撑开测真实宽。
    function bindOfficialAutoScale(frame) {
      frame.onload = () => {
        try {
          const body = frame.contentDocument && frame.contentDocument.body;
          if (!body || !body.firstChild) return; // 清空 srcdoc 时的 about:blank, 跳过
          const wrapW = (frame.parentElement && frame.parentElement.clientWidth) || 0;
          if (!wrapW) return;
          body.style.width = "max-content";
          const w = body.scrollWidth;
          const h = body.scrollHeight;
          if (!w || !h) return;
          officialView.fit = Math.min(1, wrapW / w);
          officialView.w = w;
          officialView.h = h;
          officialView.zoom = 1; // 换场次重置用户缩放
          officialView.panX = 0;
          officialView.panY = 0;
          // 银幕精确对中: 按最宽排(seats-wrapper)居中银幕容器, 兜住 fit=1 的小厅
          // (此时容器比座位区宽, 仅靠 CSS 基线会偏向容器中心)。
          const sCont = body.querySelector(".screen-container");
          const sWrap = body.querySelector(".seats-wrapper");
          if (sCont && sWrap) {
            const sEl = sCont.querySelector(".screen");
            const sw = sEl ? sEl.offsetWidth : 0;
            if (sw) {
              sCont.style.width = `${sw}px`;
              sCont.style.left = `${Math.max(0, Math.round((sWrap.offsetWidth - sw) / 2))}px`;
            }
          }
          body.style.width = `${w}px`; // 定宽保证平移钳制几何稳定(transform 不改布局)
          body.style.transformOrigin = "0 0";
          frame.style.height = `${Math.ceil(h * officialView.fit) + 2}px`;
          applyOfficialView();
        } catch (e) {
          officialView.w = 0; // 测量失败: 手势不生效, 内容以原生尺寸展示
        }
      };
    }

    // 官方对比区视图: 视觉缩放 = fit*zoom, 平移钳制(内容小于视口时居中, 大于时限制拖动范围)
    function applyOfficialView() {
      const frame = els.officialFrame;
      const body = frame && frame.contentDocument && frame.contentDocument.body;
      if (!frame || !body || !officialView.w) return;
      const eff = officialView.fit * officialView.zoom;
      const boxW = frame.clientWidth;
      const boxH = frame.clientHeight;
      const cw = officialView.w * eff;
      const ch = officialView.h * eff;
      officialView.panX = cw <= boxW ? (boxW - cw) / 2 : Math.min(0, Math.max(boxW - cw, officialView.panX));
      officialView.panY = ch <= boxH ? (boxH - ch) / 2 : Math.min(0, Math.max(boxH - ch, officialView.panY));
      body.style.transform = `translate(${officialView.panX}px, ${officialView.panY}px) scale(${eff})`;
      if (els.officialZoomLabel) els.officialZoomLabel.textContent = `${Math.round(eff * 100)}%`;
    }

    // 以视区坐标 (px,py) 为锚点缩放官方图, 保持锚点下的内容位置不动
    function officialZoomAt(newZoom, px, py) {
      if (!officialView.w) return;
      const prevEff = officialView.fit * officialView.zoom;
      officialView.zoom = Math.min(6, Math.max(1, Math.round(newZoom * 100) / 100));
      const eff = officialView.fit * officialView.zoom;
      if (eff !== prevEff) {
        const ratio = eff / prevEff;
        officialView.panX = px - (px - officialView.panX) * ratio;
        officialView.panY = py - (py - officialView.panY) * ratio;
      }
      applyOfficialView();
    }

    function resetOfficialZoom() {
      officialView.zoom = 1;
      officialView.panX = 0;
      officialView.panY = 0;
      applyOfficialView();
    }

    // 官方图缩放交互: iframe 上盖一层透明手势层接管滚轮/拖动/捏合(iframe 内零脚本、仍只读),
    // 与工具座位图缩放交互一致。
    function bindOfficialZoom() {
      const gest = els.officialGesture;
      if (!gest || gest.dataset.zoomBound) return;
      gest.dataset.zoomBound = "1";
      const centerAnchor = () => {
        const frame = els.officialFrame;
        return frame ? [frame.clientWidth / 2, frame.clientHeight / 2] : [0, 0];
      };
      els.officialZoomIn?.addEventListener("click", () => { const [x, y] = centerAnchor(); officialZoomAt(officialView.zoom + 0.25, x, y); });
      els.officialZoomOut?.addEventListener("click", () => { const [x, y] = centerAnchor(); officialZoomAt(officialView.zoom - 0.25, x, y); });
      els.officialZoomReset?.addEventListener("click", resetOfficialZoom);
      gest.addEventListener("wheel", (event) => {
        event.preventDefault();
        const rect = gest.getBoundingClientRect();
        officialZoomAt(officialView.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - rect.left, event.clientY - rect.top);
      }, { passive: false });
      let pinch = null;
      gest.addEventListener("touchstart", (event) => {
        if (event.touches.length === 2) {
          pinch = {
            dist: Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY),
            zoom: officialView.zoom
          };
          event.preventDefault();
        }
      }, { passive: false });
      gest.addEventListener("touchmove", (event) => {
        if (!pinch || event.touches.length !== 2) return;
        event.preventDefault();
        const dist = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
        if (pinch.dist > 0) {
          const rect = gest.getBoundingClientRect();
          const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left;
          const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top;
          officialZoomAt((pinch.zoom * dist) / pinch.dist, midX, midY);
        }
      }, { passive: false });
      gest.addEventListener("touchend", () => { pinch = null; });
      let drag = null;
      gest.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        drag = { x: event.clientX, y: event.clientY, panX: officialView.panX, panY: officialView.panY };
        try { gest.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
      });
      gest.addEventListener("pointermove", (event) => {
        if (!drag) return;
        officialView.panX = drag.panX + event.clientX - drag.x;
        officialView.panY = drag.panY + event.clientY - drag.y;
        gest.classList.add("dragging");
        applyOfficialView();
      });
      const endDrag = () => {
        drag = null;
        gest.classList.remove("dragging");
      };
      gest.addEventListener("pointerup", endDrag);
      gest.addEventListener("pointercancel", endDrag);
    }

    // 座位图加载序号: 快速切换日期/场次时, 先发慢回的过期响应会覆盖新场次渲染
    // (症状: 选 9.19 却显示 9.17 的座位图; 与 app.js loadCinema 的 cinemaLoadSeq 同款防护)
    let seatLoadSeq = 0;
    async function loadSeats() {
      const loadSeq = ++seatLoadSeq;
      const generation = capturedProfileGeneration();
      state.viewMode = "fit";
      resetSeats();
      clearOfficialCompare();
      if (!state.templateSeqNo || !state.context?.cinemaId) return;
      if (!state.session?.uploaded) {
        // 门控期不发请求: 无会话必然失败, 只提示先上传
        els.seatGrid.innerHTML = '<div class="lock-empty">上传猫眼会话后加载座位表</div>';
        return;
      }
      els.seatGrid.innerHTML = loadingHtml("正在加载座位表...");
      try {
        renderSeatSource();
        const params = new URLSearchParams({ cinemaId: state.context.cinemaId, movieId: state.movieId, seqNo: state.templateSeqNo });
        const { seatMap } = await api(`/api/lock/template-seats?${params}`);
        // 过期响应: 用户已切到其他场次, 丢弃, 不覆盖新渲染
        if (loadSeq !== seatLoadSeq || !isCurrentProfileGeneration(generation)) return;
        // 座号段判别: 两种影厅口径(区-座-排 / 区-排-座)自动适配, 布局与文案保持票面语义
        state.seatSeg = seatMap?.layout || seatSegmentOf(seatMap?.seats);
        state.seatMap = seatMap;
        renderSeatMap();
        if (els.officialToggle?.checked) void loadOfficialCompare();
        els.seatFeedback?.classList.remove("attention");
      } catch (error) {
        // 失败的也可能是过期请求: 不让旧报错覆盖新场次的渲染
        if (loadSeq !== seatLoadSeq || !isCurrentProfileGeneration(generation)) return;
        state.seatMap = null;
        clearOfficialCompare();
        els.seatGrid.innerHTML = '<div class="lock-empty">座位表加载失败，请确认猫眼会话后重试</div>';
        // 加载失败红显反馈按钮, 引导用户上报场次标识供管理员排查
        els.seatFeedback?.classList.add("attention");
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

    // 座位解析失败反馈: 只上报当前影院/影片/场次标识, 服务端写 KV 供管理员排查(不要求已上传会话)
    async function sendSeatFeedback() {
      const generation = capturedProfileGeneration();
      if (!state.context?.cinemaId) return show("请先选择影院", "warn");
      const seqNo = state.templateSeqNo || "";
      const key = seqNo || "na";
      const now = Date.now();
      // 同场次 60s 内不重复上报
      if (state.seatFeedback.seqNo === key && now - state.seatFeedback.at < 60000) {
        show("该场次刚刚已反馈过，管理员会尽快处理", "info");
        return;
      }
      await buttonLoading(els.seatFeedback, "反馈中...", async () => {
        try {
          await api("/api/lock/seat-feedback", {
            method: "POST",
            body: JSON.stringify({ cinemaId: state.context.cinemaId, movieId: state.movieId, seqNo })
          });
          if (!isCurrentProfileGeneration(generation)) return;
          state.seatFeedback = { seqNo: key, at: now };
          els.seatFeedback?.classList.remove("attention");
          show("已收到反馈，管理员会尽快处理", "success");
          onLog?.("ok", "座位问题已反馈（影院/影片/场次标识已记录）");
        } catch (error) {
          if (!isCurrentProfileGeneration(generation)) return;
          show(error.message || "反馈失败", "error");
        }
      });
    }

    async function refreshRemoteState() {
      const generation = capturedProfileGeneration();
      if (els.sessionStatus) els.sessionStatus.innerHTML = loadingHtml("正在加载锁座状态...");
      if (els.ruleStatus) els.ruleStatus.innerHTML = loadingHtml("正在加载锁座状态...");
      const [sessionResult, ruleResult] = await Promise.allSettled([
        api("/api/lock/session/status"), api("/api/lock/rule")
      ]);
      if (!isCurrentProfileGeneration(generation)) return;
      state.session = sessionResult.status === "fulfilled" ? publicSession(sessionResult.value.session) : { uploaded: false };
      state.rule = ruleResult.status === "fulfilled" ? (ruleResult.value.rule || null) : null;
      state.automationEnabled = Boolean(state.rule?.automationEnabled);
      renderSession();
      renderRule();
    }

    async function uploadSession() {
      const generation = capturedProfileGeneration();
      if (state.sessionActionBusy) return;
      if (state.runtimeInfo.kind === "electron") return uploadElectronSession(generation);
      const file = els.file.files?.[0];
      if (!file) return show("请选择猫眼会话文件", "warn");
      if (file.size > 256 * 1024) {
        els.file.value = "";
        return show("会话文件不能超过 256KiB", "error");
      }
      await buttonLoading(els.upload, "上传中...", async () => {
        let sessionText = "";
        setSessionActionBusy(true);
        try {
          sessionText = await file.text();
          if (!isCurrentProfileGeneration(generation)) return;
          const { session } = await api("/api/lock/session", { method: "POST", body: sessionText });
          if (!isCurrentProfileGeneration(generation)) return;
          state.session = publicSession(session);
          renderSession();
          renderSelection();
          show("猫眼会话已加密保存", "success");
          onLog?.("ok", "猫眼会话已上传，用于锁座（Beta）");
          await loadSeats(); // 门控解除后立即加载座位表, 免去手动刷新
        } catch (error) {
          if (!isCurrentProfileGeneration(generation)) return;
          show(error.message || "上传失败", "error");
        } finally {
          sessionText = "";
          els.file.value = "";
          if (isCurrentProfileGeneration(generation)) setSessionActionBusy(false);
        }
      });
    }

    async function uploadElectronSession(generation = capturedProfileGeneration()) {
      await buttonLoading(els.upload, "上传中...", async () => {
        setSessionActionBusy(true);
        try {
          const result = await runtime?.uploadSessionFile?.();
          if (!isCurrentProfileGeneration(generation)) return;
          if (result?.cancelled) {
            showNativeSessionResult(result, "已取消选择登录态文件", "info");
            return;
          }
          if (result?.ok === false || !result?.session) {
            showNativeSessionResult(result, "上传登录态失败", "error");
            return;
          }
          state.session = publicSession(result.session);
          renderSession();
          renderSelection();
          showNativeSessionResult(result, "猫眼会话已加密保存", "success");
          onLog?.("ok", "猫眼会话已上传，用于锁座（Beta）");
          await refreshRemoteState();
          if (!isCurrentProfileGeneration(generation)) return;
          await loadSeats();
        } catch {
          if (!isCurrentProfileGeneration(generation)) return;
          show("上传登录态失败", "error");
        } finally {
          if (isCurrentProfileGeneration(generation)) setSessionActionBusy(false);
        }
      });
    }

    async function loginMaoyan() {
      const generation = capturedProfileGeneration();
      if (state.sessionActionBusy) return;
      const context = state.context || getContext?.() || {};
      if (state.runtimeInfo.kind !== "electron" || state.runtimeInfo.canLoginMaoyan !== true || !context.connected || !context.cinemaId || !context.cinemaSelected) {
        return;
      }
      await buttonLoading(els.login, "登录中...", async () => {
        setSessionActionBusy(true);
        try {
          const result = await runtime?.loginMaoyan?.(context.cinemaId);
          if (!isCurrentProfileGeneration(generation)) return;
          if (result?.cancelled) {
            showNativeSessionResult(result, "已取消猫眼登录", "info");
            return;
          }
          if (result?.ok === false || !result?.session) {
            showNativeSessionResult(result, "猫眼登录失败", "error");
            return;
          }
          state.session = publicSession(result.session);
          renderSession();
          renderSelection();
          showNativeSessionResult(result, "猫眼登录态已保存", "success");
          onLog?.("ok", "猫眼一键登录已完成，用于锁座（Beta）");
          await refreshRemoteState();
          if (!isCurrentProfileGeneration(generation)) return;
          await loadSeats();
        } catch {
          if (!isCurrentProfileGeneration(generation)) return;
          show("猫眼登录失败", "error");
        } finally {
          if (isCurrentProfileGeneration(generation)) setSessionActionBusy(false);
        }
      });
    }

    async function removeSession() {
      const generation = capturedProfileGeneration();
      const confirmed = await root.showConfirm("删除后将不能查询座位或自动锁座，是否继续？", { title: "删除猫眼会话", okText: "删除", danger: true });
      if (!confirmed) return;
      if (!isCurrentProfileGeneration(generation)) return;
      await buttonLoading(els.removeSession, "删除中...", async () => {
        try {
          await api("/api/lock/session/remove", { method: "POST" });
          if (!isCurrentProfileGeneration(generation)) return;
          state.session = { uploaded: false };
          state.rule = null;
          state.automationEnabled = false;
          resetSeats({ clearSource: true });
          renderSession();
          renderRule();
          show("猫眼会话已删除", "success");
        } catch (error) {
          if (!isCurrentProfileGeneration(generation)) return;
          show(error.message || "删除失败", "error");
        }
      });
    }

    async function createRule() {
      const generation = capturedProfileGeneration();
      const action = lockAction(state.showMode);
      const inferred = state.showMode === "template";
      const timeToleranceMinutes = inferred ? selectedTimeTolerance() : null;
      if (inferred && timeToleranceMinutes === null) {
        renderInferenceControls();
        renderSelection();
        return;
      }
      if (inferred && !validTemplateTime(templateForCurrent()?.tm)) {
        renderInferenceControls();
        renderSelection();
        return;
      }
      const payload = {
        cinemaId: state.context.cinemaId, movieId: state.movieId, templateSeqNo: state.templateSeqNo,
        targetDate: els.date.value, seatNos: [...state.selectedSeatNos], riskAccepted: els.risk.checked,
        ...(inferred ? { timeToleranceMinutes } : {})
      };
      if (inferred) {
        const template = templateForCurrent();
        const templateDetails = [template?.showDate, template?.tm, template?.th || "影厅未提供"].filter(Boolean).join(" · ");
        const labels = seatLabelMap();
        const seats = payload.seatNos.map((seatNo) => labels.get(seatNo) || seatNo).join("、");
        const targetDate = payload.targetDate;
        const details = [
          `目标日期：${targetDate}`,
          `影院：${state.context.cinemaName || `影院 ${state.context.cinemaId}`}`,
          `影片：${template?.movieName || "影片"}`,
          `模板场次：${[template?.showDate, template?.tm].filter(Boolean).join(" ")} · ${template?.th || "影厅未提供"}`,
          `匹配范围：±${timeToleranceMinutes} 分钟（${targetDate} ${matchingTimeWindow(template?.tm, timeToleranceMinutes)}）`,
          `座位：${seats}`
        ];
        const confirmed = await root.showConfirm(
          `${details.join("\n")}\n\n目标场次尚未确定，实际影厅、座位布局和售卖状态可能变化。匹配成功后仅创建待支付订单，需自行支付。`,
          { title: "确认保存自动锁座规则", okText: "确认保存", danger: true }
        );
        if (!confirmed || !isCurrentProfileGeneration(generation)) return;
        const currentTemplate = templateForCurrent();
        if (selectedTimeTolerance() !== timeToleranceMinutes || els.date.value !== targetDate || state.showMode !== "template"
          || state.movieId !== payload.movieId || state.templateSeqNo !== payload.templateSeqNo
          || state.context?.cinemaId !== payload.cinemaId || !state.session?.uploaded
          || [currentTemplate?.showDate, currentTemplate?.tm, currentTemplate?.th || "影厅未提供"].filter(Boolean).join(" · ") !== templateDetails
          || [...state.selectedSeatNos].join("\0") !== payload.seatNos.join("\0") || !els.risk.checked) {
          renderSelection();
          return;
        }
      }
      if (state.showMode === "target") {
        const template = templateForCurrent();
        const labels = seatLabelMap();
        const seats = [...state.selectedSeatNos].map((seatNo) => labels.get(seatNo) || seatNo).join("、");
        const details = [
          state.context.cinemaName || `影院 ${state.context.cinemaId}`,
          template?.movieName || "影片",
          `${els.date.value} ${template?.tm || ""}`.trim(),
          template?.th,
          `座位：${seats}`
        ].filter(Boolean).join(" · ");
        const confirmed = await root.showConfirm(
          `${details}。确认后将立即创建待支付订单，但不会支付。`,
          { title: "确认立即锁座", okText: "立即锁座", danger: true }
        );
        if (!confirmed) return;
        if (!isCurrentProfileGeneration(generation)) return;
      }
      try {
        await buttonLoading(els.submit, action.loadingText, async () => {
          try {
            const { rule } = await api("/api/lock/rule", { method: "POST", body: JSON.stringify(payload) });
            if (!isCurrentProfileGeneration(generation)) return;
            state.rule = rule || null;
            state.automationEnabled = Boolean(rule?.automationEnabled);
            renderRule();
            if (rule?.state === "unknown" || rule?.state === "failed") {
              show("锁座失败，未获得有效订单", "error");
              onLog?.("error", "锁座失败");
            } else {
              show(action.successText, "success");
              onLog?.("ok", state.showMode === "target" ? "锁座（Beta）已提交" : "锁座（Beta）规则已保存");
            }
          } catch (error) {
            if (!isCurrentProfileGeneration(generation)) return;
            show(error.message || "保存锁座规则失败", "error");
          }
        });
      } finally {
        if (isCurrentProfileGeneration(generation)) renderSelection();
      }
    }

    async function cancelRule() {
      const generation = capturedProfileGeneration();
      const confirmed = await root.showConfirm("取消后不会影响已上传的猫眼会话，是否继续？", { title: "取消锁座规则", okText: "取消规则", danger: true });
      if (!confirmed) return;
      if (!isCurrentProfileGeneration(generation)) return;
      await buttonLoading(els.cancelRule, "取消中...", async () => {
        try {
          await api("/api/lock/rule/cancel", { method: "POST" });
          if (!isCurrentProfileGeneration(generation)) return;
          state.rule = null;
          state.automationEnabled = false;
          renderRule();
          show("锁座规则已取消", "success");
        } catch (error) {
          if (!isCurrentProfileGeneration(generation)) return;
          show(error.message || "取消失败", "error");
        }
      });
    }

    function close() {
      clearOfficialCompare();
      els.overlay.classList.add("hidden");
      document.removeEventListener("keydown", onKeydown);
      emitPollingState();
    }

    function dispose() {
      if (seatFitFrame !== null && typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(seatFitFrame);
      seatFitFrame = null;
      seatResizeObserver?.disconnect();
      seatResizeObserver = null;
      close();
    }

    function reset() {
      close();
      state.context = null;
      state.session = { uploaded: false };
      state.sessionActionBusy = false;
      state.movieId = "";
      state.templateSeqNo = "";
      state.rule = null;
      state.automationEnabled = false;
      state.templates = [];
      resetSeats({ clearSource: true });
      state.seatSeg = 2;
      state.seatFeedback = { seqNo: "", at: 0 };
      if (els.file) els.file.value = "";
      if (els.cinema) els.cinema.value = "";
      if (els.risk) els.risk.checked = false;
      if (els.timeTolerance) els.timeTolerance.value = "30";
      renderTemplates();
      renderSession();
      renderRule();
      clearOfficialCompare({ resetToggle: true });
    }

    function onKeydown(event) { if (event.key === "Escape") close(); }

    function syncAvailability() {
      const context = getContext();
      const available = isLockAvailable(context || {});
      els.button.disabled = !available;
      els.button.title = available
        ? "配置锁座"
        : context?.lockServiceEnabled === false
          ? "锁座服务暂不可用"
          : context?.monitorEnabled === false
            ? "监控已停止，开始监控后才能锁座"
            : "请先在影院设置中选择影院";
      renderSessionActions();
      return available;
    }

    async function open() {
      const generation = capturedProfileGeneration();
      if (!syncAvailability()) return show("请先在影院设置中选择影院", "warn");
      state.context = getContext();
      await refreshRuntimeInfo();
      if (!isCurrentProfileGeneration(generation)) return;
      els.cinema.value = state.context.cinemaName || `影院 ${state.context.cinemaId}`;
      els.risk.checked = false;
      if (els.timeTolerance) els.timeTolerance.value = "30";
      renderTemplates();
      renderSelection();
      els.overlay.classList.remove("hidden");
      document.addEventListener("keydown", onKeydown);
      emitPollingState();
      // 串行: 座位加载依赖最新会话状态, 并发会读到过期的 uploaded:false 误入门控(首次打开不加载座位的根因)
      await refreshRemoteState();
      if (!isCurrentProfileGeneration(generation)) return;
      await loadSeats();
    }

    els.button.addEventListener("click", open);
    els.close.addEventListener("click", close);
    els.cancel.addEventListener("click", close);
    els.overlay.addEventListener("click", (event) => { if (event.target === els.overlay) close(); });
    els.movie.addEventListener("change", async () => {
      await changeMovieSelection({ state, movieId: els.movie.value, renderShowOptions, loadSeats });
    });
    els.date.addEventListener("change", () => { renderShowOptions(); loadSeats(); });
    els.template.addEventListener("change", async () => {
      // 今天/已过日期无场次时列出的其他日期真实场次: 选中即把目标日期切到该场次日期,
      // 重新渲染进入「目标场次」真实模式(真实座位图 + 立即锁座), 不产生推断规则
      const jumpDate = els.template.selectedOptions?.[0]?.dataset?.jumpDate;
      if (jumpDate) {
        els.date.value = jumpDate;
        renderShowOptions();
        await loadSeats();
        return;
      }
      state.templateSeqNo = els.template.value;
      await loadSeats();
    });
    els.risk.addEventListener("change", renderSelection);
    els.timeTolerance?.addEventListener("input", () => { renderInferenceControls(); renderSelection(); });
    els.login?.addEventListener("click", loginMaoyan);
    els.upload.addEventListener("click", uploadSession);
    els.removeSession.addEventListener("click", removeSession);
    els.submit.addEventListener("click", createRule);
    els.cancelRule.addEventListener("click", cancelRule);
    els.seatFeedback?.addEventListener("click", () => { sendSeatFeedback(); });
    els.officialToggle?.addEventListener("change", () => {
      if (els.officialToggle.checked) void loadOfficialCompare();
      else clearOfficialCompare();
    });
    els.zoomIn.addEventListener("click", () => changeZoom(0.2));
    els.zoomOut.addEventListener("click", () => changeZoom(-0.2));
    els.zoomReset.addEventListener("click", resetZoom);
    // 滚轮缩放(以光标为锚), 双指捏合缩放(以中点为锚), 按住拖动平移
    const scrollEl = els.seatGrid.closest(".lock-seat-scroll");
    if (scrollEl) {
      if (typeof root.ResizeObserver === "function") {
        seatResizeObserver = new root.ResizeObserver(() => scheduleSeatFit());
        seatResizeObserver.observe(scrollEl);
        seatResizeObserver.observe(els.seatGrid);
      }
      scrollEl.addEventListener("wheel", (event) => {
        event.preventDefault();
        const rect = scrollEl.getBoundingClientRect();
        zoomAt(state.zoom + (event.deltaY < 0 ? 0.1 : -0.1), event.clientX - rect.left, event.clientY - rect.top);
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
          const rect = scrollEl.getBoundingClientRect();
          const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left;
          const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top;
          zoomAt((pinch.zoom * dist) / pinch.dist, midX, midY);
        }
      }, { passive: false });
      scrollEl.addEventListener("touchend", () => { pinch = null; });
      // 鼠标/单指拖动平移; 移动超过阈值才算拖动, 松手后吞掉那次 click 以免误选座位
      let drag = null;
      let suppressClick = false;
      scrollEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        drag = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: false };
      });
      scrollEl.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        state.viewMode = "manual";
        scrollEl.classList.add("dragging");
        state.panX = drag.panX + dx;
        state.panY = drag.panY + dy;
        applyZoom();
      });
      const endDrag = () => {
        if (!drag) return;
        suppressClick = drag.moved;
        drag = null;
        scrollEl.classList.remove("dragging");
      };
      scrollEl.addEventListener("pointerup", endDrag);
      scrollEl.addEventListener("pointercancel", endDrag);
      scrollEl.addEventListener("click", (event) => {
        if (!suppressClick) return;
        suppressClick = false;
        event.stopPropagation();
        event.preventDefault();
      }, true);
    }
    resetSeats({ clearSource: true });
    renderSessionActions();
    void refreshRuntimeInfo();

    return {
      syncAvailability, open, refreshTemplates: renderTemplates, close, reset,
      refreshRemoteState, loginMaoyan, uploadSession, dispose, getSession: () => publicSession(state.session), getPanelSummary
    };
  }

  const exported = {
    createMaoyanLockController,
    lockUtils: {
      templatesFromMovies, chinaDateBounds, lockDateBounds, fitSeatViewport, seatPosition, seatDisplayLabel, seatSegmentOf, couplePartnerOf,
      seatVisualState, isReadyToSubmit, isLockAvailable, lockAction, parseTimeTolerance, changeMovieSelection, preferredTargetShow, clearSeatSelection, publicSession, detailOpenState
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root?.document) root.createMaoyanLockController = createMaoyanLockController;
})(typeof window !== "undefined" ? window : globalThis);
