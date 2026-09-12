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

  function lockDateBounds(now = new Date()) {
    const min = addChinaDays(now, 0);
    const max = addChinaDays(now, 30);
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

  // 猫眼座位口径: 票面排号 = seat.rowId (影厅内 1..N 连续)。
  // 但 seatNo 段语义存在两种影厅口径(均以真实座位页锚定):
  //   杜比厅(万达天和广场): seatNo=区-座号-物理排 (订单 1-1-10/rowId=9 票面「9排1座」)
  //   激光IMAX厅(寰映大融城): seatNo=区-排号-座号 (页面 33-1-29/rowId=1 为「1排29座」)
  // 座号取"唯一值更多的段"(排号取值数 ≤ 排数, 必然少于座号取值数);
  // 保守起见仅当第三段唯一值同时大于第二段和排数时才切换, 否则维持旧口径(第二段=座号)。
  function seatSegmentOf(seats) {
    const uniques = (index) => {
      const values = new Set();
      for (const seat of seats || []) {
        const parts = String(seat?.seatNo || "").split("-");
        if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) values.add(parts[index]);
      }
      return values.size;
    };
    const seg2 = uniques(1);
    const seg3 = uniques(2);
    const rows = new Set((seats || []).map((seat) => String(seat?.rowId ?? ""))).size;
    return seg3 > seg2 && seg3 > rows ? 3 : 2;
  }

  function seatPosition(seat, seatSegment) {
    const source = seat && typeof seat === "object" ? seat.seatNo : seat;
    const row = seat && typeof seat === "object" ? Number(seat.rowId) : NaN;
    const parts = String(source || "").split("-");
    const valid = parts.length === 3 && parts.every((part) => /^\d+$/.test(part));
    const seatNumber = valid ? Number(parts[seatSegment === 3 ? 2 : 1]) : NaN;
    if (!Number.isInteger(row) || row <= 0 || !Number.isInteger(seatNumber)) return null;
    return { rowNumber: row, seatNumber };
  }

  function seatDisplayLabel(seat, seatSegment) {
    const position = seatPosition(seat, seatSegment);
    const source = seat && typeof seat === "object" ? seat.seatNo : seat;
    return position ? `${position.rowNumber}排${position.seatNumber}座` : String(source || "");
  }

  // 情侣座配对以 data-st 的 L/R 属性为准: L 是双座左半、R 是右半, 同排内 L 的另一半
  // 在 columnId+1、R 的另一半在 columnId-1(方向配对)。不能用「相邻就配」: 该影厅
  // L/R 严格交替, L 座两侧都是 R 座, 取第一个相邻会把 (21,22)、(23,24) 两对拆散
  // (真实缺陷: 点 24 连 23 正确, 再点 23 会误连 22, 选出 22+23+24 的非法组合)。
  // 真实数据锚定: 万达影城天和广场 2号杜比巨幕厅 19:35 场 11排 (1,2),(3,4)...(23,24)...
  function couplePartnerOf(seats, seat) {
    if (!seat || (seat.type !== "L" && seat.type !== "R")) return null;
    const expected = seat.type === "L"
      ? Number(seat.columnId) + 1
      : Number(seat.columnId) - 1;
    const opposite = seat.type === "L" ? "R" : "L";
    return (seats || []).find((candidate) =>
      candidate.type === opposite && String(candidate.rowId) === String(seat.rowId) &&
      Number(candidate.columnId) === expected) || null;
  }

  function isActiveLockRule(rule) {
    return rule?.state === "waiting_schedule" || rule?.state === "matching" || rule?.state === "unknown";
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
      gateHint: $("lock-gate-hint"),
      sectionSchedule: $("lock-section-schedule"),
      sectionSeats: $("lock-section-seats"),
      sectionRisk: $("lock-section-risk"),
      sectionRules: $("lock-section-rules"),
      cancel: $("btn-lock-cancel"), submit: $("btn-lock-submit"),
      zoomIn: $("btn-lock-zoom-in"), zoomOut: $("btn-lock-zoom-out"), zoomReset: $("btn-lock-zoom-reset"), zoomLabel: $("lock-zoom-label")
    };
    const state = {
      context: null, session: { uploaded: false }, movieId: "", templateSeqNo: "", seatMap: null,
      selectedSeatNos: new Set(), rule: null, automationEnabled: false, templates: [], dateBounds: lockDateBounds(),
      seatSeg: 2, zoom: 1, panX: 0, panY: 0
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

    function resetSeats(options) {
      clearSeatSelection(state, options);
      renderSeatSource();
      if (els.seatGrid) els.seatGrid.innerHTML = '<div class="lock-empty">选择可售场次后加载座位表</div>';
      renderSelection();
    }

    // 座位图来源提示: 目标场次真实座位图 / 无场次时的未来推断提醒
    function renderSeatSource() {
      renderRiskSection();
      if (!els.seatSource) return;
      if (!state.seatMapSource) {
        els.seatSource.classList.add("hidden");
        return;
      }
      els.seatSource.textContent = state.seatMapSource;
      els.seatSource.classList.toggle("warn", state.seatMapIsTemplate === true);
      els.seatSource.classList.remove("hidden");
    }

    // Beta 推断风险提示只在「未来日期无场次 → 推断座位」时展示;
    // 目标场次是真实座位图无推断风险(待支付说明在弹窗副标题里已有); 门控期(未上传会话)一律隐藏
    function renderRiskSection() {
      setHidden(els.sectionRisk, !state.session?.uploaded || state.seatMapIsTemplate !== true);
    }

    function seatLabelMap() {
      const map = new Map();
      for (const seat of state.seatMap?.seats || []) {
        map.set(String(seat.seatNo), seatDisplayLabel(seat, state.seatSeg));
      }
      return map;
    }

    // 提交按钮的置灰原因(展示在按钮 title 上)
    function submitBlockReason() {
      if (!state.session?.uploaded) return "请先上传猫眼会话";
      if (!state.templateSeqNo) return "请选择场次";
      if (!state.selectedSeatNos.size) return "请先选择座位";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(els.date?.value || "")) return "请选择目标日期";
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
      for (const el of [els.sectionSchedule, els.sectionSeats, els.sectionRisk, els.sectionRules]) {
        setHidden(el, gated);
      }
    }

    function renderSession() {
      const session = state.session || { uploaded: false };
      if (!els.sessionStatus) return;
      const gated = !session.uploaded;
      renderGate(gated);
      if (gated) {
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
      // 规则里存的是内部座位标识(seatNo), 展示统一换成「几排几座」(排号=rowId); 影厅名一并展示
      const labels = seatLabelMap();
      const seats = (rule.seats || [])
        .map((seat) => labels.get(String(seat?.seatNo ?? seat)) || seatDisplayLabel(seat, state.seatSeg))
        .join("、");
      const status = RULE_LABELS[rule.state] || "规则状态未知";
      const suffix = rule.state === "unknown"
        ? " · 可能已经创建订单，请先检查猫眼订单，确认前不可再次提交"
        : rule.state === "waiting_schedule" && !rule.automationEnabled
          ? " · 锁座服务当前已停用"
          : "";
      const hall = rule.hall ? ` · ${rule.hall}` : "";
      els.ruleStatus.textContent = `${rule.cinemaName || "影院"} · ${rule.movieName || "影片"}${hall} · ${rule.targetDate || ""} ${rule.templateTime || ""} · ${seats} · ${status}${suffix}`;
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
          state.seatMapSource = `${targetDateStr} 暂无场次，以下为模板场次的未来推断座位（全部可选，开售后按实际售卖为准）`;
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
      return couplePartnerOf(state.seatMap?.seats, seat);
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
        const position = seatPosition(seat, state.seatSeg);
        if (!position) continue;
        const key = String(position.rowNumber);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(seat);
      }
      const orderedRows = [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
      // 列号表头: 与猫眼一致, 用票面座号(会跳过过道空位)
      const allCols = seats.map((seat) => seatPosition(seat, state.seatSeg)?.seatNumber).filter(Number.isFinite);
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
      for (const [rowNumber, rowSeats] of orderedRows) {
        const row = document.createElement("div");
        row.className = "lock-seat-row";
        const label = document.createElement("span");
        label.className = "lock-row-label";
        label.textContent = `${rowNumber}排`;
        const grid = document.createElement("div");
        grid.className = "lock-seat-grid";
        for (const seat of rowSeats) {
          const button = document.createElement("button");
          button.type = "button";
          const partner = couplePartner(seat);
          const isLover = seat.type === "L" || seat.type === "R";
          const loverClass = seat.type === "L" ? " lover-left" : seat.type === "R" ? " lover-right" : "";
          // 情侣座另一半已售(或缺失)时整格置灰: 半对无法单独下单
          const selectable = Boolean(seat.available) && (!isLover || Boolean(partner?.available));
          const pairHint = isLover
            ? (partner?.available ? " · 情侣座需成对选择" : " · 情侣座另一半已售，无法单独购买")
            : "";
          button.className = `lock-seat${selectable ? " available" : " unavailable"}${loverClass}`;
          // 格位与文字都用票面座号, 这样过道空位会和猫眼一样留出缺口
          const seatNumber = seatPosition(seat, state.seatSeg)?.seatNumber ?? Number(seat.columnId);
          button.style.gridColumn = String(seatNumber);
          button.textContent = String(seatNumber);
          button.title = `${seatDisplayLabel(seat, state.seatSeg)}${pairHint}${selectable ? "" : "（不可选）"}`;
          button.disabled = !selectable;
          button.dataset.seatNo = String(seat.seatNo);
          button.classList.toggle("selected", state.selectedSeatNos.has(String(seat.seatNo)));
          if (selectable) {
            button.addEventListener("click", () => {
              // 情侣座以「对」为单位整体选中/取消: 点一个自动带上相邻的另一半
              const keys = [String(seat.seatNo)];
              if (partner?.available) keys.push(String(partner.seatNo));
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
      centerSeatMap();
    }

    function applyTransform() {
      if (els.seatGrid) els.seatGrid.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
      if (els.zoomLabel) els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    // 平移边界: 内容不大于容器时固定居中; 超出容器时限制拖动范围, 不允许把内容整个拖出视野
    function clampPan() {
      const box = els.seatGrid?.closest(".lock-seat-scroll");
      if (!box || !els.seatGrid) return;
      const w = els.seatGrid.offsetWidth * state.zoom;
      const h = els.seatGrid.offsetHeight * state.zoom;
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      state.panX = w <= bw ? (bw - w) / 2 : Math.min(0, Math.max(bw - w, state.panX));
      state.panY = h <= bh ? (bh - h) / 2 : Math.min(0, Math.max(bh - h, state.panY));
    }

    function applyZoom() {
      clampPan();
      applyTransform();
    }

    // 渲染后把座位图放到容器正中
    function centerSeatMap() {
      applyZoom();
    }

    // 以容器可视区坐标 (px,py) 为锚点缩放, 保持锚点下的内容位置不动
    function zoomAt(newZoom, px, py) {
      const previous = state.zoom;
      state.zoom = Math.min(2, Math.max(0.4, Math.round(newZoom * 10) / 10));
      if (state.zoom === previous) return;
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
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyZoom();
    }

    async function loadSeats() {
      resetSeats();
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
        // 座号段判别: 两种影厅口径(区-座-排 / 区-排-座)自动适配, 布局与文案保持票面语义
        state.seatSeg = seatSegmentOf(seatMap?.seats);
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
          await loadSeats(); // 门控解除后立即加载座位表, 免去手动刷新
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
          resetSeats({ clearSource: true });
          renderSession();
          renderRule();
          show("猫眼会话已删除", "success");
        } catch (error) {
          show(error.message || "删除失败", "error");
        }
      });
    }

    async function createRule() {
      const action = lockAction(state.showMode);
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
      }
      const payload = {
        cinemaId: state.context.cinemaId, movieId: state.movieId, templateSeqNo: state.templateSeqNo,
        targetDate: els.date.value, seatNos: [...state.selectedSeatNos], riskAccepted: els.risk.checked
      };
      try {
        await buttonLoading(els.submit, action.loadingText, async () => {
          try {
            const { rule } = await api("/api/lock/rule", { method: "POST", body: JSON.stringify(payload) });
            state.rule = rule || null;
            state.automationEnabled = Boolean(rule?.automationEnabled);
            renderRule();
            if (rule?.state === "unknown") {
              show("订单结果不确定，请先检查猫眼订单，确认前不可再次提交", "warn");
            } else {
              show(action.successText, "success");
            }
            onLog?.("ok", state.showMode === "target" ? "锁座（Beta）已提交" : "锁座（Beta）规则已保存");
          } catch (error) {
            show(error.message || "保存锁座规则失败", "error");
          }
        });
      } finally {
        renderSelection();
      }
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
      els.button.title = available
        ? "配置锁座"
        : context?.lockServiceEnabled === false
          ? "锁座服务暂不可用"
          : context?.monitorEnabled === false
            ? "监控已停止，开始监控后才能锁座"
            : "请先在影院设置中选择影院";
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
    els.upload.addEventListener("click", uploadSession);
    els.removeSession.addEventListener("click", removeSession);
    els.submit.addEventListener("click", createRule);
    els.cancelRule.addEventListener("click", cancelRule);
    els.zoomIn.addEventListener("click", () => changeZoom(0.2));
    els.zoomOut.addEventListener("click", () => changeZoom(-0.2));
    els.zoomReset.addEventListener("click", resetZoom);
    // 滚轮缩放(以光标为锚), 双指捏合缩放(以中点为锚), 按住拖动平移
    const scrollEl = els.seatGrid.closest(".lock-seat-scroll");
    if (scrollEl) {
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

    return { syncAvailability, open, refreshTemplates: renderTemplates, close };
  }

  const exported = {
    createMaoyanLockController,
    lockUtils: {
      templatesFromMovies, chinaDateBounds, lockDateBounds, seatPosition, seatDisplayLabel, seatSegmentOf, couplePartnerOf,
      isReadyToSubmit, isLockAvailable, lockAction, changeMovieSelection, preferredTargetShow, clearSeatSelection
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root?.document) root.createMaoyanLockController = createMaoyanLockController;
})(typeof window !== "undefined" ? window : globalThis);
