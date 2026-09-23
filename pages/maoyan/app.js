// 猫眼影院场次监控 - 云端版前端
// 与 Cloudflare Worker 的 /api/* 交互; 传输与凭据由运行时适配器管理
// 首次进入显示登录层, 连接成功后进入主页面

const $ = (id) => document.getElementById(id);
const els = {
  // 登录层
  loginOverlay: $("login-overlay"),
  mainPage: $("main-page"),
  lockOverlay: $("lock-overlay"),
  workerUrl: $("worker-url"),
  token: $("token-input"),
  btnConnect: $("btn-connect"),
  loginError: $("login-error"),
  loginHint: $("login-hint"),
  // 顶栏
  statusLine: $("status-line"),
  workerProfile: $("worker-profile"),
  workerSecurity: $("worker-security"),
  updateStatus: $("update-status"),
  updateText: $("update-text"),
  btnOpenUpdate: $("btn-open-update"),
  btnRenewAccount: $("btn-renew-account"),
  btnLogout: $("btn-logout"),
  // 影院设置
  cityInput: $("city-input"),
  cityDropdown: $("city-dropdown"),
  cinemaSearch: $("cinema-search"),
  cinemaDropdown: $("cinema-dropdown"),
  btnSearchCinema: $("btn-search-cinema"),
  cinemaName: $("cinema-name"),
  btnStepConnectionNext: $("btn-step-connection-next"),
  btnStepCinemaNext: $("btn-step-cinema-next"),
  btnStepMovieBack: $("btn-step-movie-back"),
  btnStepMovieNext: $("btn-step-movie-next"),
  btnStepNotifyBack: $("btn-step-notify-back"),
  workflowReadyState: $("workflow-ready-state"),
  // 监控设置
  btnCheck: $("btn-check"),
  btnTestPush: $("btn-test-push"),
  btnTestPushServerChan: $("btn-test-push-serverchan"),
  btnLockSeats: $("btn-lock-seats"),
  btnToggleMonitor: $("btn-toggle-monitor"),
  batchTip: $("batch-tip"),
  barkInput: $("bark-input"),
  serverChanInput: $("serverchan-input"),
  pushBarkRow: $("push-bark-row"),
  pushServerChanRow: $("push-serverchan-row"),
  pushChannelRow: $("push-channel-row"),
  pushPlatformAdvice: $("push-platform-advice"),
  accountNotice: $("account-notice"),
  accountNoticeText: $("account-notice-text"),
  btnAccountSession: $("btn-account-session"),
  btnAccountNotification: $("btn-account-notification"),
  pageSub: $("page-sub"),
  // 电影列表
  movieList: $("movie-list"),
  movieCount: $("movie-count"),
  btnToggleAll: $("btn-toggle-all"),
  // 日志
  btnRefresh: $("btn-refresh"),
  logPanel: $("log-panel"),
};

function setRuntimeDataset(kind) {
  if (typeof document === "undefined" || !document.documentElement) return;
  document.documentElement.dataset.runtime = kind === "electron" ? "electron" : "web";
}

function renderRuntimeVersion(info) {
  const target = $("app-version");
  const headerTarget = $("header-app-version");
  const text = info?.version ? `v${info.version}` : "";
  if (target) target.textContent = text;
  if (headerTarget) headerTarget.textContent = text;
}

let cinemaMovies = []; // [{id, nm, showCount, checked}]
let connected = false;
const profileGeneration = window.createProfileGeneration();
let activeProfileKey = "";
let runtimeInfo = { kind: window.maoyanRuntime?.kind || "web", canLoginMaoyan: false, persistentTokenStorage: false };
setRuntimeDataset(runtimeInfo.kind);
let tokenProfileKey = "";
let currentAccount = null;
let lockServiceEnabled = false;
let monitorEnabled = false; // 默认停止, 需显式「开始监控」
let pushSaved = false; // 云端已存有当前渠道的推送配置(接口不回显时, 保存时避免误覆盖)
let pushVerified = false; // 当前渠道 + 当前密钥已成功发送过测试推送
let configVersion = 0;
const clientPlatform = window.detectPlatform ? window.detectPlatform({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints,
  userAgentData: navigator.userAgentData
}) : { os: "unknown", arch: "unknown" };
let pollingController = null;
let lockPollingState = { open: false, active: false, ruleSummary: null };
let renderedChanges = [];

// 城市 / 影院搜索
let allCities = [];        // [{id, name, pinyin}]
let selectedCity = null;   // {id, name}
let selectedCinema = null; // {id, name}
let selectedCinemaId = ""; // 当前影院 ID(搜索选中/加载成功/云端恢复三处写入, 替代旧的手动输入框)
let cinemaSelected = false; // 影院已在影院设置中选择或加载(锁座入口门槛)
let cinemaSearchTimer = null;
let workflowStep = null;
const workflowTransition = window.maoyanWorkflow.createWorkflowTransition({
  root: document,
  matchMedia: (query) => window.matchMedia?.(query),
  animate: (element, keyframes, options) => element.animate?.(keyframes, options)
});

// 同域部署下 Worker 地址可留空(直接请求当前域名); 其他托管环境给出默认后端
const SAME_ORIGIN_HOSTS = ["ltools.asia", "www.ltools.asia", "tools-a65.pages.dev"];
const SAME_ORIGIN = SAME_ORIGIN_HOSTS.includes(location.hostname);
const DEFAULT_WORKER = SAME_ORIGIN ? "" : "https://ltools.asia";

function syncWorkflowUi(requestedStep = workflowStep, options = {}) {
  const state = window.maoyanWorkflow.deriveWorkflowState({
    connected,
    cinemaSelected,
    selectedMovieCount: getSelectedIds().length,
    pushVerified,
    monitorEnabled,
    requestedStep,
  });
  workflowStep = state.activeStep;
  workflowTransition.render(state, options);
  if (els.btnStepCinemaNext) els.btnStepCinemaNext.disabled = !state.steps[1].complete;
  if (els.btnStepMovieNext) els.btnStepMovieNext.disabled = !state.steps[2].complete;
  if (els.workflowReadyState) {
    els.workflowReadyState.textContent = monitorEnabled
      ? "监控已启动"
      : (pushVerified ? "推送已验证" : "请先测试推送");
  }
  syncPollingState();
}

function syncPollingState() {
  pollingController?.update({
    connected,
    step: workflowStep,
    monitorEnabled,
    lockOpen: lockPollingState.open,
    lockActive: lockPollingState.active,
    profileKey: activeProfileKey
  });
}

function renderAccountNotice(resume = null) {
  if (!els.accountNotice || !window.accountStatusPresentation) return;
  const view = window.accountStatusPresentation({ account: currentAccount, resume });
  els.accountNotice.classList.toggle("hidden", !view.visible);
  els.accountNotice.classList.toggle("is-warning", view.tone === "warning");
  els.accountNotice.classList.toggle("is-success", view.tone === "success");
  els.accountNoticeText.textContent = view.text;
  els.btnAccountSession?.classList.toggle("hidden", view.action !== "session");
  els.btnAccountNotification?.classList.toggle("hidden", view.action !== "notification");
}

function navigateWorkflow(step) {
  workflowStep = step;
  syncWorkflowUi(workflowStep, { userInitiated: true });
}

document.querySelectorAll("[data-workflow-step]").forEach((button) => {
  button.addEventListener("click", () => navigateWorkflow(Number(button.dataset.workflowStep)));
});
els.btnStepConnectionNext?.addEventListener("click", () => navigateWorkflow(2));
els.btnStepCinemaNext?.addEventListener("click", () => navigateWorkflow(3));
els.btnStepMovieBack?.addEventListener("click", () => navigateWorkflow(2));
els.btnStepMovieNext?.addEventListener("click", () => navigateWorkflow(4));
els.btnStepNotifyBack?.addEventListener("click", () => navigateWorkflow(3));
els.btnAccountSession?.addEventListener("click", () => els.btnLockSeats?.click());
els.btnAccountNotification?.addEventListener("click", () => navigateWorkflow(4));
window.maoyanWorkflow.bindAmbientMotion({ window, document });

// ---------------- 基础 ----------------
function normalizedWorkerUrl() {
  return normalizeWorkerProfile(els.workerUrl.value);
}

function normalizeWorkerProfile(value) {
  try {
    const url = new URL(String(value ?? "").trim() || (SAME_ORIGIN ? location.origin : ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

function profileTokenStorageKey(profileKey) {
  return window.webTokenKey ? window.webTokenKey(profileKey) : `token:${encodeURIComponent(profileKey)}`;
}

async function restoreWebToken(savedWorker, requestedWorker) {
  return requestedWorker ? (await secureGet(profileTokenStorageKey(requestedWorker))) || "" : "";
}

async function api(path, options = {}) {
  const generation = profileGeneration.current();
  startTopProgress();
  try {
    const result = await window.maoyanRuntime.requestWorker(path, options);
    if (!profileGeneration.isCurrent(generation)) throw staleProfileError();
    return result;
  } catch (error) {
    if (!profileGeneration.isCurrent(generation)) throw staleProfileError();
    throw error;
  } finally {
    stopTopProgress();
  }
}

function staleProfileError() {
  const error = new Error("连接已切换");
  error.staleProfile = true;
  return error;
}

function isStaleProfileError(error) {
  return error?.staleProfile === true;
}

const lockController = window.createMaoyanLockController({
  api,
  runtime: window.maoyanRuntime,
  getProfileGeneration: () => profileGeneration.current(),
  isProfileGenerationCurrent: (generation) => profileGeneration.isCurrent(generation),
  getContext: () => ({
    connected,
    cinemaId: selectedCinemaId,
    cinemaName: selectedCinema?.name || els.cinemaName.textContent,
    cinemaSelected,
    lockServiceEnabled,
    monitorEnabled, // 锁座随监控启停: 停止监控后锁座入口禁用
    cinemaLoaded: cinemaMovies.length > 0,
    movies: cinemaMovies.filter((movie) => movie.checked)
  }),
  onLog: log,
  onPollingState: (next) => {
    lockPollingState = next;
    renderNotifyMonitorSummary();
    syncPollingState();
  }
});

function log(type, text) {
  const div = document.createElement("div");
  div.className = `log-entry log-${type}`;
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  div.textContent = `[${time}] ${text}`;
  els.logPanel.prepend(div);
}

function setStatus(text, state = "off", details = [], error = "") {
  if (!els.statusLine) return;
  // state: running(监控中, 绿) / stopped(已停止或连接失败, 红) / off(未连接, 灰)
  els.statusLine.className = `status-line st-${state}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  const main = document.createElement("span");
  main.className = "status-main";
  main.textContent = text;
  const detailItems = details.filter(Boolean).map((detail) => {
    const item = document.createElement("span");
    item.className = "status-detail";
    item.textContent = detail;
    return item;
  });
  const nodes = [dot, main, ...detailItems];
  if (error) {
    const errorItem = document.createElement("span");
    errorItem.className = "status-error";
    errorItem.textContent = `失败原因：${error}`;
    nodes.push(errorItem);
  }
  els.statusLine.replaceChildren(...nodes);
  renderNotifyMonitorSummary();
}

function renderNotifyMonitorSummary() {
  const title = $("notify-monitor-title");
  if (!title) return;
  const titleText = monitorEnabled
    ? ["监控中", nextBatchText()].filter(Boolean).join(" · ")
    : (connected ? "已停止" : "未连接");
  const titleState = monitorEnabled ? "running" : (connected ? "stopped" : "off");
  const dot = document.createElement("span");
  dot.className = "notify-monitor-dot";
  const text = document.createElement("span");
  text.textContent = titleText;
  title.className = `notify-monitor-title st-${titleState}`;
  title.replaceChildren(dot, text);

  const cinema = selectedCinema?.name || String(els.cinemaName?.textContent || "")
    .replace(/（ID:.*?）$/, "").trim() || "未选择影院";
  const movies = cinemaMovies.filter((movie) => movie.checked)
    .map((movie) => movie.nm || movie.name).filter(Boolean);
  const ruleSummary = lockPollingState.ruleSummary;
  const cinemaEl = $("notify-monitor-cinema");
  const movieEl = $("notify-monitor-movie");
  const ruleEl = $("notify-monitor-rule");
  if (cinemaEl) cinemaEl.textContent = cinema;
  if (movieEl) movieEl.textContent = movies.length ? movies.join("、") : "未选择影片";
  if (ruleEl) ruleEl.textContent = ruleSummary?.exists ? ruleSummary.rule : "暂无锁座规则";
}

function setConnectionState({ profileKey = "", workerUrl = "" } = {}) {
  if (els.workerProfile) els.workerProfile.textContent = profileKey ? `配置：${profileKey}` : "配置：未连接";
  if (els.workerSecurity) {
    let label = "未连接";
    let httpRisk = false;
    try {
      const url = new URL(workerUrl);
      if (url.protocol === "https:") label = "HTTPS";
      if (url.protocol === "http:") {
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
        httpRisk = !loopback;
        label = loopback ? "本机 HTTP" : "不安全 HTTP 连接";
      }
    } catch { /* No connection metadata is available yet. */ }
    els.workerSecurity.textContent = label;
    els.workerSecurity.classList.toggle("http-risk", httpRisk);
  }
}

function renderDesktopUpdate(update) {
  const supported = window.maoyanRuntime.capabilities?.updates === true;
  const available = update?.available === true && typeof update.releaseUrl === "string";
  for (const [panelId, textId, buttonId] of [
    ["update-status", "update-text", "btn-open-update"],
    ["login-update-status", "login-update-text", "btn-login-check-update"]
  ]) {
    const panel = $(panelId), label = $(textId), button = $(buttonId);
    if (!panel || !label || !button) continue;
    panel.classList.toggle("hidden", !supported);
    label.textContent = available ? `发现新版本 v${update.version}` : update?.error
      ? "检查失败，请稍后重试" : update?.skipped ? "可手动检查更新" : "已是最新版本";
    button.textContent = available ? "下载更新" : update?.error ? "前往下载页" : "检查更新";
    if (available || update?.error) button.dataset.download = "true";
    else delete button.dataset.download;
  }
}

let updateCheckInFlight = false;
async function checkForDesktopUpdate(manual = false) {
  if (!window.maoyanRuntime.capabilities?.updates || updateCheckInFlight) return;
  updateCheckInFlight = true;
  const buttons = [$("btn-open-update"), $("btn-login-check-update")].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; });
  try {
    renderDesktopUpdate(await window.maoyanRuntime.checkForUpdates({ manual }));
  } catch {
    renderDesktopUpdate({ available: false, error: "unavailable" });
  } finally {
    updateCheckInFlight = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function onUpdateClick(event) {
  if (!window.maoyanRuntime.capabilities?.updates) return;
  if (event.currentTarget.dataset.download !== "true") return checkForDesktopUpdate(true);
  try {
    const result = await window.maoyanRuntime.openExternal("https://ltools.asia/maoyan/download");
    if (result?.opened === false) showToast("无法打开下载页面", "error");
  } catch { showToast("无法打开下载页面", "error"); }
}
els.btnOpenUpdate?.addEventListener("click", onUpdateClick);
$("btn-login-check-update")?.addEventListener("click", onUpdateClick);

function bindSetupLinks() {
  document.querySelectorAll("a.enrollment-link").forEach((link) => {
    link.addEventListener("click", async (event) => {
      if (typeof window.maoyanRuntime.openEnrollment !== "function") return;
      event.preventDefault();
      try {
        const result = await window.maoyanRuntime.openEnrollment();
        if (result?.opened === false) showToast("无法打开领取页面", "error");
      } catch { showToast("无法打开领取页面", "error"); }
    });
  });
  document.querySelectorAll("a[data-external-link]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        const result = await window.maoyanRuntime.openExternal(link.href);
        if (result?.opened === false) showToast("无法打开外部链接", "error");
      } catch { showToast("无法打开外部链接", "error"); }
    });
  });
}

function resetProfileUi(nextProfileKey) {
  profileGeneration.invalidate();
  window.switchWorkerProfile({
    cinemaId: selectedCinemaId,
    selectedMovies: getSelectedIds(),
    lockOpen: !els.lockOverlay.classList.contains("hidden"),
    profileKey: activeProfileKey
  }, nextProfileKey);
  connected = false;
  currentAccount = null;
  renderAccountNotice();
  els.btnRenewAccount?.classList.add("hidden");
  lockServiceEnabled = false;
  monitorEnabled = false;
  pushSaved = false;
  pushVerified = false;
  configVersion = 0;
  realKeys.bark = "";
  realKeys.serverchan = "";
  keyStored.bark = false;
  keyStored.serverchan = false;
  keyHints.bark = "";
  keyHints.serverchan = "";
  cinemaSelected = false;
  selectedCity = null;
  selectedCinema = null;
  selectedCinemaId = "";
  cinemaMovies = [];
  renderedChanges = [];
  cinemaLoadSeq += 1;
  clearTimeout(cinemaSearchTimer);
  cinemaSearchTimer = null;
  clearTimeout(movieSaveTimer);
  movieSaveTimer = null;
  lastSavedSig = "";
  saving = false;
  savePending = false;
  settleAutoSaveWaiters();
  restoring = false;
  workflowStep = 1;
  allCities = [];
  els.cityInput.value = "";
  els.cityInput.disabled = false;
  els.cinemaSearch.value = "";
  els.cinemaSearch.disabled = false;
  els.btnSearchCinema.disabled = false;
  els.cityDropdown.innerHTML = "";
  els.cityDropdown.classList.add("hidden");
  els.cinemaDropdown.innerHTML = "";
  els.cinemaDropdown.classList.add("hidden");
  els.cinemaName.textContent = "";
  els.cinemaName.classList.add("hidden");
  els.barkInput.value = "";
  els.serverChanInput.value = "";
  setChannel("bark");
  els.movieList.innerHTML = '<div class="muted empty-tip">连接云端后显示该影院在映影片</div>';
  els.movieCount.textContent = "连接后自动加载影片";
  els.logPanel.innerHTML = "";
  setStatus("未连接");
  lockController.reset?.();
  lockController.syncAvailability();
  updateMonitorBtn();
  syncWorkflowUi();
}

function connectionErrorMessage(error, workerUrl) {
  if (runtimeInfo.kind === "web" && location.protocol === "https:" && /^http:/i.test(workerUrl)) {
    return "浏览器阻止 HTTPS 页面连接 HTTP Worker，请改用 HTTPS Worker 或使用 Electron 客户端";
  }
  return error.message;
}

function fmtClock(ts) {
  return new Date(ts).toLocaleString("zh-CN", {
    hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// 分钟步进型 cron 可精确推算下一批触发时间; 其他形式不显示
// 跨天时标注「明天」, 避免和当天时间混淆
function nextBatchText() {
  if (!cronMinuteStep || cronMinutes >= 60) return "";
  const now = new Date();
  const add = cronMinutes - (now.getMinutes() % cronMinutes);
  const t = new Date(now.getTime() + add * 60000);
  const hm = t.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const crossDay = t.getDate() !== now.getDate() ? "明天 " : "";
  return `预计下批次 ${crossDay}${hm}`;
}

// ---------------- 登录 / 连接 ----------------
function showLoginError(msg) {
  els.loginError.textContent = msg;
  els.loginError.classList.remove("hidden");
}

// 登录页中性提示(存储/环境类问题), 不用报错红色
function showLoginHint(msg) {
  if (!els.loginHint) return;
  els.loginHint.textContent = "💡 " + msg;
  els.loginHint.classList.remove("hidden");
}

function enterMainPage() {
  els.loginOverlay.classList.add("hidden");
  els.mainPage.classList.remove("hidden");
  workflowStep = null;
  syncWorkflowUi();
}

async function connect() {
  const workerUrl = normalizedWorkerUrl();
  if (!workerUrl) return showLoginError("请填写服务地址");
  const profileChanged = Boolean(activeProfileKey && activeProfileKey !== workerUrl);
  if (profileChanged) {
    resetProfileUi(workerUrl);
  }
  if (tokenProfileKey && tokenProfileKey !== workerUrl) els.token.value = "";
  const generation = profileGeneration.current();
  els.loginError.classList.add("hidden");
  if (els.loginHint) els.loginHint.classList.add("hidden");
  try {
    await withButtonLoading(els.btnConnect, "连接中...", async () => {
      showBlockOverlay("正在连接云端...");
      try {
        const httpRiskConfirmed = runtimeInfo.kind === "electron" || !/^http:/i.test(workerUrl) || window.confirm("HTTP 服务连接可能泄露访问令牌，是否继续？");
        const connection = { workerUrl, httpRiskConfirmed };
        const typedToken = els.token.value.trim();
        if (typedToken) connection.token = typedToken;
        if (runtimeInfo.kind === "electron") els.token.value = "";
        const connectionResult = await window.maoyanRuntime.connectWorker(connection);
        const { status: st, profile, account, capabilities } = connectionResult;
        if (!profileGeneration.isCurrent(generation)) return;
        const accountConnection = window.normalizeAccountConnection({ account, capabilities });
        currentAccount = account || null;
        renderAccountNotice();
        els.btnRenewAccount?.classList.toggle("hidden", !accountConnection.canRenew);
        connected = true;
        activeProfileKey = workerUrl;
        tokenProfileKey = workerUrl;
        localStorage.setItem("workerUrl", els.workerUrl.value.trim());
        if (runtimeInfo.kind === "web") {
          await secureSet(profileTokenStorageKey(workerUrl), connectionResult.credentialToPersist || "");
          els.token.value = "";
        }
        else els.token.value = "";
        setConnectionState({ profileKey: profile?.id || profile?.baseUrl || workerUrl, workerUrl });
        lockServiceEnabled = st.lockServiceEnabled === true;
        const openMode = st.authMode === "open";
        document.body.classList.toggle("open-mode", openMode);
        // 免令牌模式下没有令牌可存, 记一个标记供刷新后自动重连
        if (openMode) localStorage.setItem("authMode", "open");
        else localStorage.removeItem("authMode");
        const stopped = st.status.enabled === false;
        const lastAt = st.status.lastCheck || st.status.lastCheckTs;
        const lastTxt = lastAt ? fmtClock(new Date(lastAt).getTime()) : "从未";
        const monitorMain = stopped ? "已停止" : st.status.lastError ? "检查异常" : "监控中";
        const restrictedText = account?.accountStatus === "expired" ? "账号已到期，可续期后恢复"
          : account?.accountStatus === "suspended" ? "账号已暂停"
            : "账号当前不可监控";
        setStatus(
          accountConnection.canMonitor
            ? monitorMain
            : restrictedText,
          accountConnection.canMonitor ? (monitorMain === "监控中" ? "running" : "stopped") : "stopped",
          accountConnection.canMonitor ? [`上次检查 ${lastTxt}`, !stopped && nextBatchText(), openMode && "免令牌模式"] : [],
          accountConnection.canMonitor && !stopped ? st.status.lastError : ""
        );
        enterMainPage();
        lockController.syncAvailability();
        log("ok", "云端连接成功");
        if (!accountConnection.canMonitor) {
          log("warn", restrictedText);
          return;
        }
        await Promise.all([loadCities(), restoreConfig()]);
        if (!profileGeneration.isCurrent(generation)) return;
        refreshChanges();
      } finally {
        if (profileGeneration.isCurrent(generation)) hideBlockOverlay();
      }
    });
  } catch (e) {
    if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
    connected = false;
    setStatus("连接失败", "stopped");
    // 令牌错误只做简短提示, 不暴露 Worker 名称与配置步骤(多人使用场景)
    let msg = connectionErrorMessage(e, workerUrl);
    if (msg.includes("访问令牌错误")) msg = "访问令牌无效，请检查令牌是否输入正确";
    showLoginError("连接失败：" + msg);
  }
}

els.btnConnect.addEventListener("click", connect);
els.token.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});
els.token.addEventListener("input", () => { tokenProfileKey = normalizedWorkerUrl(); });

els.btnRenewAccount?.addEventListener("click", async () => {
  if (!currentAccount || currentAccount.role !== "user" || currentAccount.accountStatus !== "expired") return;
  const generation = profileGeneration.current();
  await withButtonLoading(els.btnRenewAccount, "续期中...", async () => {
    try {
      const result = await api("/api/account/renew", {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: currentAccount.accountVersion })
      });
      if (!profileGeneration.isCurrent(generation)) return;
      currentAccount = result.account;
      renderAccountNotice(result.resume);
      els.btnRenewAccount.classList.add("hidden");
      setStatus("账号已续期，正在恢复配置", "running");
      showToast("账号已续期 15 天", "success");
      await Promise.all([loadCities(), restoreConfig()]);
      if (profileGeneration.isCurrent(generation)) refreshChanges();
    } catch (error) {
      if (!profileGeneration.isCurrent(generation) || isStaleProfileError(error)) return;
      showToast("续期失败：" + error.message, "error");
    }
  });
});

// 切换连接: 仅清除当前工具的连接信息，不影响同域管理页等其他本地数据
els.btnLogout.addEventListener("click", async () => {
  resetProfileUi("");
  const previousProfileKey = tokenProfileKey;
  realKeys.bark = "";
  realKeys.serverchan = "";
  localStorage.removeItem("workerUrl");
  localStorage.removeItem("authMode");
  if (runtimeInfo.kind === "web") {
    if (previousProfileKey) await secureSet(profileTokenStorageKey(previousProfileKey), "");
    await secureSet("token", "");
  }
  els.workerUrl.value = "";
  els.token.value = "";
  activeProfileKey = "";
  tokenProfileKey = "";
  setConnectionState();
  els.mainPage.classList.add("hidden");
  els.loginOverlay.classList.remove("hidden");
  els.loginError.classList.add("hidden");
  els.btnLockSeats.disabled = true;
});

async function restoreConfig() {
  const generation = profileGeneration.current();
  restoring = true; // 恢复期间自动保存全部跳过, 避免每次连接都冗余写 KV
  let cloudConfig = null;
  let restoredOk = false;
  try {
    const { config } = await api("/api/config");
    cloudConfig = config;
    configVersion = Number(config.version) || 0;
    monitorEnabled = config.enabled === true; // 默认停止, 需显式「开始监控」
    updateMonitorBtn();
    if (config.cinemaId) selectedCinemaId = String(config.cinemaId);
    // 批次信息以服务端 cron 为准
    syncCronInfo(config);
    applyPushConfig(config);
    const prevSelected = new Set((config.selectedMovieIds || []).map(String));
    if (selectedCinemaId) {
      // 恢复加载成功才视为已选择(失败保持未选, 锁座禁用待重试)
      restoredOk = (await loadCinema(selectedCinemaId, prevSelected, { restore: true })) === true;
      if (!profileGeneration.isCurrent(generation)) return;
      cinemaSelected = restoredOk;
    }
    lockController.syncAvailability();
    // 主页面摘要需要已保存的规则，不能依赖首次打开锁座弹窗才加载。
    if (lockServiceEnabled) await lockController.refreshRemoteState();
  } finally {
    if (!profileGeneration.isCurrent(generation)) return;
    // 恢复完成: 记录当前状态签名, 与云端一致的内容不再重复写入。
    // 恢复加载失败时以云端原值为基线 — 否则后续任何其他字段的保存都会把影院勾选清空
    const baseline = restoredOk || !cloudConfig
      ? { cinemaId: selectedCinemaId, selectedMovieIds: getSelectedIds() }
      : { cinemaId: String(cloudConfig.cinemaId || ""), selectedMovieIds: (cloudConfig.selectedMovieIds || []).map(String) };
    lastSavedSig = JSON.stringify(pushConfigBody(baseline));
    restoring = false;
    workflowStep = null;
    syncWorkflowUi();
  }
}

// ---------------- 推送渠道 ----------------
const CHANNEL_LABELS = { bark: "Bark", serverchan: "Server酱" };

function getChannel() {
  const checked = document.querySelector('input[name="push-channel"]:checked');
  return checked ? checked.value : "bark";
}

function setChannel(ch) {
  const radio =
    document.querySelector(`input[name="push-channel"][value="${ch}"]`) ||
    document.querySelector('input[name="push-channel"][value="bark"]');
  radio.checked = true;
  renderChannel();
}

function renderChannel() {
  const ch = getChannel();
  if (els.pushBarkRow) els.pushBarkRow.classList.toggle("hidden", ch !== "bark");
  if (els.pushServerChanRow) els.pushServerChanRow.classList.toggle("hidden", ch !== "serverchan");
  renderKeyInput(); // 切换渠道后另一输入框同样按掩码/占位渲染
  renderChannelAdvice();
}

function renderChannelAdvice() {
  if (!els.pushPlatformAdvice || !window.notificationAdvice) return;
  const advice = window.notificationAdvice({ platform: clientPlatform, channel: getChannel() });
  els.pushPlatformAdvice.textContent = advice.message || "";
  els.pushPlatformAdvice.classList.toggle("hidden", !advice.message);
}

// 当前渠道对应的输入框与配置字段名
function currentKeyInput() {
  return getChannel() === "serverchan" ? els.serverChanInput : els.barkInput;
}
function currentKeyField() {
  return getChannel() === "serverchan" ? "serverChanKey" : "barkKey";
}

// 推送密钥: 真实值只存内存, 输入框在保存后显示掩码(后端本就不回显, 避免旁观/截屏泄露)
const realKeys = { bark: "", serverchan: "" };
// 刷新后仅恢复云端返回的脱敏提示，不恢复明文。
const KEY_STORED_MASK = "••••••••";
const keyStored = { bark: false, serverchan: false };
const keyHints = { bark: "", serverchan: "" };
const KEY_PLACEHOLDERS = {
  bark: "Bark Key 或 URL，如 https://api.day.app/xxxxx",
  serverchan: "SCT 开头的 SendKey"
};

function maskKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return s.slice(0, 1) + "•".repeat(Math.max(s.length - 2, 3)) + s.slice(-1);
  return s.slice(0, 4) + "•".repeat(6) + s.slice(-4);
}

function currentRealKey() {
  return realKeys[getChannel()] || "";
}

function currentStoredMask() {
  return keyHints[getChannel()] || KEY_STORED_MASK;
}

// 按内存真实值渲染输入框: 有密钥显掩码, 云端已存显固定占位掩码, 都没有显占位提示
function renderKeyInput() {
  const input = currentKeyInput();
  if (!input) return;
  const real = currentRealKey();
  if (real) {
    input.value = maskKey(real);
    input.placeholder = "已配置（不回显，点此可更换）";
  } else if (keyStored[getChannel()]) {
    input.value = currentStoredMask();
    input.placeholder = "已在云端保存（不回显），输入新值可更换";
  } else {
    input.value = "";
    input.placeholder = KEY_PLACEHOLDERS[getChannel()];
  }
}

function applyPushConfig(config) {
  setChannel(config.notifyChannel || (clientPlatform.os === "android" ? "serverchan" : "bark"));
  keyStored.bark = config.hasBark === true;
  keyStored.serverchan = config.hasServerChan === true;
  keyHints.bark = keyStored.bark ? String(config.barkKeyHint || KEY_STORED_MASK) : "";
  keyHints.serverchan = keyStored.serverchan ? String(config.serverChanKeyHint || KEY_STORED_MASK) : "";
  pushSaved = keyStored.bark || keyStored.serverchan;
  pushVerified = config.notifyVerified === true;
  renderKeyInput();
  updateMonitorBtn();
  if (pushSaved && !currentRealKey()) {
    log("info", `${CHANNEL_LABELS[getChannel()]} 已配置（为防泄露不回显，留空保存不会覆盖）`);
  }
}

// 保存当前渠道的推送配置(内存中无密钥则不提交, 保留云端已存值)
function pushConfigBody(extra = {}) {
  const key = currentRealKey();
  const body = { notifyChannel: getChannel(), ...extra };
  if (key) body[currentKeyField()] = key;
  return body;
}

// ---------------- 自动保存 ----------------
// 改动即保存, 不再需要"保存配置"按钮
// 写入频率控制: 签名去重(与云端一致不写) + 恢复期间不写 + 并发合并(只写最新状态)
let lastSavedSig = "";
let movieSaveTimer = null;
let saving = false;
let savePending = false;
let restoring = false;
const saveIdleWaiters = [];

function waitForAutoSave() {
  if (movieSaveTimer !== null) {
    clearTimeout(movieSaveTimer);
    movieSaveTimer = null;
    void autoSaveConfig({ selectedMovieIds: getSelectedIds(), cinemaId: selectedCinemaId }, { silent: true });
  }
  if (!saving && !savePending) return Promise.resolve();
  return new Promise((resolve) => saveIdleWaiters.push(resolve));
}

function settleAutoSaveWaiters() {
  if (saving || savePending) return;
  while (saveIdleWaiters.length) saveIdleWaiters.shift()();
}

function finishConfigSave() {
  saving = false;
  if (savePending) {
    savePending = false;
    void autoSaveConfig({ selectedMovieIds: getSelectedIds(), cinemaId: selectedCinemaId }, { silent: true });
  }
  settleAutoSaveWaiters();
}

async function autoSaveConfig(extra = {}, { msg = "配置已自动保存", silent = false } = {}) {
  const generation = profileGeneration.current();
  if (restoring) return; // 恢复配置期间不写
  const body = pushConfigBody(extra);
  const sig = JSON.stringify(body);
  if (sig === lastSavedSig) return;
  if (saving) { savePending = true; return; } // 上一次还在写: 完成后按最新状态补写一次
  saving = true;
  lastSavedSig = sig;
  try {
    const res = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ ...body, ...(configVersion ? { expectedVersion: configVersion } : {}) })
    });
    configVersion = Number(res.config?.version) || configVersion;
    pushVerified = res.config?.notifyVerified === true;
    // 服务端可能因推送渠道不可用而自动停止监控: 同步真实状态, 避免界面仍显示"监控中"
    if (res.config && typeof res.config.enabled === "boolean") monitorEnabled = res.config.enabled;
    updateMonitorBtn();
    if (res.notice) {
      await refreshChanges(); // 拉取服务端刚写入的告警与最新状态
      if (!profileGeneration.isCurrent(generation)) return;
      log("warn", res.notice);
      return;
    }
    if (!silent) log("ok", msg);
  } catch (e) {
    if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
    lastSavedSig = ""; // 失败允许重试
    if (/配置已在其他设备更新/.test(String(e.message || ""))) {
      await restoreConfig();
    }
    showToast("自动保存失败：" + e.message, "error");
  } finally {
    if (!profileGeneration.isCurrent(generation)) return;
    finishConfigSave();
  }
}

// 影片勾选变化较密集, 防抖后合并保存
function scheduleMovieSave() {
  clearTimeout(movieSaveTimer);
  movieSaveTimer = setTimeout(() => {
    movieSaveTimer = null;
    autoSaveConfig(
      { selectedMovieIds: getSelectedIds(), cinemaId: selectedCinemaId },
      { msg: "影片勾选已自动保存", silent: true }
    );
  }, 800);
}

// change 事件兜底: 部分移动浏览器点击 label 内的 radio 不派发 change
document.addEventListener("change", (e) => {
  if (e.target && e.target.name === "push-channel") {
    renderChannel();
    pushVerified = false;
    updateMonitorBtn();
    autoSaveConfig({}, { msg: `推送渠道已切换为 ${CHANNEL_LABELS[getChannel()]}` });
  }
});
if (els.pushChannelRow) {
  els.pushChannelRow.addEventListener("click", (e) => {
    const radio = e.target.closest('input[name="push-channel"]');
    const label = e.target.closest("label");
    const target = radio || (label && label.querySelector('input[name="push-channel"]'));
    if (!target) return;
    target.checked = true;
    renderChannel();
    pushVerified = false;
    updateMonitorBtn();
    autoSaveConfig({}, { msg: `推送渠道已切换为 ${CHANNEL_LABELS[getChannel()]}` });
  });
}
// 推送密钥: 聚焦时用真实值替换掩码便于编辑; 失焦时有改动则保存, 并一律回显掩码
function keyInputFocused() {
  const input = currentKeyInput();
  const real = currentRealKey();
  if (real && input.value === maskKey(real)) input.value = real;
  // 云端已存但本会话无明文: 全选占位掩码, 直接输入即可整体替换
  else if (!real && input.value === currentStoredMask()) input.select();
}

function keyInputBlurred() {
  const input = currentKeyInput();
  const real = currentRealKey();
  const typed = input.value.trim();
  // 占位掩码视为"未改动"(不代表云端密钥, 不回传不覆盖); 输入新值才保存
  if (typed && typed !== real && typed !== maskKey(real) && typed !== currentStoredMask()) {
    realKeys[getChannel()] = typed;
    pushVerified = false;
    updateMonitorBtn();
    autoSaveConfig({}, { msg: "推送配置已保存" });
  }
  renderKeyInput();
}
els.barkInput.addEventListener("focus", keyInputFocused);
els.barkInput.addEventListener("blur", keyInputBlurred);
els.serverChanInput.addEventListener("focus", keyInputFocused);
els.serverChanInput.addEventListener("blur", keyInputBlurred);

// ---------------- 监控启停 ----------------
function updateMonitorBtn() {
  els.btnToggleMonitor.textContent = monitorEnabled ? "停止监控" : "开始监控";
  els.btnToggleMonitor.classList.toggle("danger", monitorEnabled);
  els.btnToggleMonitor.classList.toggle("ghost", monitorEnabled);
  els.btnToggleMonitor.classList.toggle("primary", !monitorEnabled);
  els.btnToggleMonitor.classList.remove("success");
  const requiresPushTest = !monitorEnabled && !pushVerified;
  els.btnToggleMonitor.disabled = !connected || requiresPushTest;
  els.btnToggleMonitor.title = requiresPushTest ? "请先配置推送渠道，填好推送密钥并「保存并测试」" : "";
  renderNotifyMonitorSummary();
  syncWorkflowUi();
}

els.btnToggleMonitor.addEventListener("click", async () => {
  if (!connected) return showToast("请先连接云端", "warn");
  const generation = profileGeneration.current();
  await withButtonLoading(els.btnToggleMonitor, "处理中...", async () => {
    try {
      await waitForAutoSave();
      if (!profileGeneration.isCurrent(generation)) return;
      const target = !monitorEnabled;
      const res = await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ enabled: target, ...(configVersion ? { expectedVersion: configVersion } : {}) })
      });
      if (!profileGeneration.isCurrent(generation)) return;
      monitorEnabled = target;
      configVersion = Number(res.config?.version) || configVersion;
      pushVerified = res.config?.notifyVerified === true;
      log(
        target ? "ok" : "info",
        target
          ? "监控已开始"
          : "监控已停止，云端不再自动检查（配置已保留）"
      );
      setStatus(
        monitorEnabled ? "监控中" : "已停止",
        monitorEnabled ? "running" : "stopped",
        [
          monitorEnabled && nextBatchText(),
        ]
      );
      // 锁座入口与监控联动: 即时刷新可用状态
      lockController.syncAvailability();
      // 停止监控时若挂着进行中的自动锁座规则, 明确告知「暂停而非取消」
      if (!target) {
        try {
          const { rule } = await api("/api/lock/rule");
          if (rule && ["waiting_schedule", "matching"].includes(rule.state)) {
            log("info", `自动锁座规则（${rule.movieName || "已选影片"} ${rule.targetDate || ""} ${rule.templateTime || ""}）已随监控暂停，重新开始监控后自动继续`);
          }
        } catch {}
      }
    } catch (e) {
      if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
      showToast("操作失败：" + e.message, "error");
    }
  });
  updateMonitorBtn(); // 按钮文案还原后再按最新状态刷新
});

// ---------------- 城市选择 ----------------
async function loadCities() {
  const generation = profileGeneration.current();
  try {
    const res = await api("/api/cities");
    allCities = (res.cities || []).map((c) => ({
      id: String(c.id),
      name: c.name,
      pinyin: String(c.pinyin || "").toLowerCase(),
    }));
  } catch (e) {
    if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
    // 云端暂不支持城市/影院搜索接口, 降级为仅手动输入
    allCities = [];
    selectedCity = null;
    els.cityInput.disabled = true;
    els.cityInput.placeholder = "城市列表加载失败（云端暂不支持）";
    els.cinemaSearch.disabled = true;
    els.btnSearchCinema.disabled = true;
    els.cinemaSearch.placeholder = "影院搜索暂不可用，请稍后重试";
  }
}

function filterCities(kw) {
  if (!allCities.length) return [];
  const k = kw.trim().toLowerCase();
  if (!k) return allCities.slice(0, 20);
  const starts = [];
  const contains = [];
  for (const c of allCities) {
    const py = c.pinyin || "";
    if (c.name.startsWith(k) || (py && py.startsWith(k))) starts.push(c);
    else if (c.name.includes(k) || (py && py.includes(k))) contains.push(c);
  }
  return [...starts, ...contains].slice(0, 30);
}

function renderCityDropdown() {
  const list = filterCities(els.cityInput.value);
  els.cityDropdown.innerHTML = "";
  if (!list.length) {
    appendSuggestMsg(els.cityDropdown, "未找到城市");
  } else {
    const showPinyin = /^[a-z]+$/i.test(els.cityInput.value.trim());
    for (const c of list) {
      const item = document.createElement("div");
      item.className = "suggest-item";
      const name = document.createElement("span");
      name.className = "s-name";
      name.textContent = c.name;
      item.appendChild(name);
      if (showPinyin && c.pinyin) {
        const meta = document.createElement("span");
        meta.className = "s-addr";
        meta.textContent = c.pinyin;
        item.appendChild(meta);
      }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); chooseCity(c); });
      els.cityDropdown.appendChild(item);
    }
  }
  els.cityDropdown.classList.remove("hidden");
}

function chooseCity(c) {
  selectedCity = c;
  els.cityInput.value = c.name;
  els.cityDropdown.classList.add("hidden");
  // 切换城市后重置影院搜索
  selectedCinema = null;
  cinemaSelected = false;
  lockController.syncAvailability();
  syncWorkflowUi();
  els.cinemaSearch.value = "";
  els.cinemaSearch.disabled = false;
  els.btnSearchCinema.disabled = false;
  els.cinemaSearch.placeholder = `在${c.name}搜索影院（模糊匹配）`;
  els.cinemaSearch.focus();
}

els.cityInput.addEventListener("focus", () => {
  if (allCities.length) renderCityDropdown();
});
els.cityInput.addEventListener("input", () => {
  selectedCity = null;
  renderCityDropdown();
});

// ---------------- 影院模糊搜索 ----------------
function appendSuggestMsg(dropdown, text) {
  const div = document.createElement("div");
  div.className = "suggest-empty";
  div.textContent = text;
  dropdown.appendChild(div);
}

function scheduleCinemaSearch(immediate = false) {
  clearTimeout(cinemaSearchTimer);
  if (immediate) return searchCinemas();
  cinemaSearchTimer = setTimeout(searchCinemas, 350);
}

async function searchCinemas() {
  const generation = profileGeneration.current();
  if (!allCities.length) return; // 城市接口不可用时整体禁用
  if (!selectedCity) {
    els.cinemaDropdown.innerHTML = "";
    appendSuggestMsg(els.cinemaDropdown, "请先在上方选择城市");
    els.cinemaDropdown.classList.remove("hidden");
    return;
  }
  const kw = els.cinemaSearch.value.trim();
  if (!kw) {
    els.cinemaDropdown.classList.add("hidden");
    return;
  }
  els.cinemaDropdown.innerHTML = "";
  appendSuggestMsg(els.cinemaDropdown, "搜索中...");
  els.cinemaDropdown.classList.remove("hidden");
  try {
    const res = await api(
      `/api/cinemas?cityId=${encodeURIComponent(selectedCity.id)}&kw=${encodeURIComponent(kw)}`
    );
    if (!profileGeneration.isCurrent(generation)) return;
    renderCinemaResults(res.cinemas || []);
  } catch (e) {
    if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
    els.cinemaDropdown.innerHTML = "";
    appendSuggestMsg(els.cinemaDropdown, "搜索失败：" + e.message);
    els.cinemaDropdown.classList.remove("hidden");
  }
}

function renderCinemaResults(list) {
  els.cinemaDropdown.innerHTML = "";
  if (!list.length) {
    appendSuggestMsg(els.cinemaDropdown, "未找到匹配的影院，换个关键词试试");
    els.cinemaDropdown.classList.remove("hidden");
    return;
  }
  for (const c of list.slice(0, 20)) {
    const id = String(c.id);
    const name = c.nm || c.name || `影院 ${id}`;
    const addr = c.addr || c.address || "";
    const item = document.createElement("div");
    item.className = "suggest-item";
    const nameEl = document.createElement("span");
    nameEl.className = "s-name";
    nameEl.textContent = name;
    item.appendChild(nameEl);
    if (addr) {
      const addrEl = document.createElement("span");
      addrEl.className = "s-addr";
      addrEl.textContent = addr;
      item.appendChild(addrEl);
    }
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectedCinema = { id, name };
      selectedCinemaId = id; // 锁座可用性与云端保存都以此为准(修复首次会话锁座按钮误禁用)
      cinemaSelected = true;
      els.cinemaSearch.value = name;
      els.cinemaDropdown.classList.add("hidden");
      lockController.syncAvailability();
      loadCinema(id);
    });
    els.cinemaDropdown.appendChild(item);
  }
  els.cinemaDropdown.classList.remove("hidden");
}

els.cinemaSearch.addEventListener("input", () => {
  selectedCinema = null;
  cinemaSelected = false;
  lockController.syncAvailability();
  syncWorkflowUi();
  scheduleCinemaSearch();
});
els.cinemaSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    scheduleCinemaSearch(true);
  }
});
els.btnSearchCinema.addEventListener("click", () =>
  withButtonLoading(els.btnSearchCinema, "搜索中...", () => scheduleCinemaSearch(true))
);

// 点击下拉外部时收起
document.addEventListener("click", (e) => {
  if (!e.target.closest("#city-input") && !e.target.closest("#city-dropdown")) {
    els.cityDropdown.classList.add("hidden");
  }
  if (
    !e.target.closest("#cinema-search") &&
    !e.target.closest("#cinema-dropdown") &&
    !e.target.closest("#btn-search-cinema")
  ) {
    els.cinemaDropdown.classList.add("hidden");
  }
});

// ---------------- 影院加载 ----------------
// 拉取影院排期, 自动重试 2 次(猫眼接口偶发失败)
async function fetchShowsWithRetry(cinemaId) {
  const generation = profileGeneration.current();
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (!profileGeneration.isCurrent(generation)) throw staleProfileError();
    try {
      return await api("/api/shows?cinemaId=" + encodeURIComponent(cinemaId));
    } catch (e) {
      if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) throw staleProfileError();
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// 请求序号: 快速连续切换影院时, 慢响应后到会覆盖新选择(界面/云端回退到旧影院) — 过期响应一律丢弃
let cinemaLoadSeq = 0;

async function loadCinema(cinemaId, prevSelected, { restore = false } = {}) {
  const generation = profileGeneration.current();
  const seq = ++cinemaLoadSeq;
  setPanelLoading(els.movieList, "正在加载影院影片...");
  return await withButtonLoading(null, "加载中...", async () => {
    try {
      const res = await fetchShowsWithRetry(cinemaId);
      if (!profileGeneration.isCurrent(generation) || seq !== cinemaLoadSeq) return true; // 过期响应: 已有更新的选择在加载, 丢弃本次结果(不更新界面/不保存云端)
      selectedCinemaId = String(res.cinemaId); // 以接口返回为准, 搜索与恢复两条路径在此汇合
      cinemaSelected = true;
      els.cinemaName.textContent = `${res.cinemaName}（ID: ${res.cinemaId}）`;
      els.cinemaName.classList.remove("hidden");
      const sel = prevSelected || new Set(getSelectedIds());
      cinemaMovies = res.movies.map((m) => ({ ...m, checked: sel.has(String(m.id)) }));
      renderMovies();
      log("ok", `加载影院成功: ${res.cinemaName}，在映影片 ${res.movies.length} 部`);
      // 锁座弹窗打开时同步影片列表
      if (!document.getElementById("lock-overlay")?.classList.contains("hidden")) {
        lockController.refreshTemplates?.();
      }
      autoSaveConfig(
        { cinemaId: String(res.cinemaId), selectedMovieIds: getSelectedIds() },
        { msg: `影院已保存到云端：${res.cinemaName}` }
      );
      workflowStep = restore ? null : 3;
      syncWorkflowUi();
      return true;
    } catch (e) {
      if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e) || seq !== cinemaLoadSeq) return true; // 过期请求的失败不提示、不回滚新选择的状态
      // 加载失败: 影院选择视为未完成(排期未就绪不可锁座), 待重新搜索/刷新后恢复
      cinemaSelected = false;
      selectedCinema = null;
      if (restore) {
        // 恢复配置时拉取失败: 影院 ID 仍在, 提示重试方式
        log("warn", `影院影片自动加载失败（${e.message}），重新搜索该影院或刷新页面可重试`);
        els.movieList.innerHTML = '<div class="muted empty-tip">影院影片加载失败，重新搜索影院或刷新页面重试</div>';
      } else {
        showToast("加载失败：" + e.message, "error");
        log("error", "加载影院失败: " + e.message);
        els.movieList.innerHTML = '<div class="muted empty-tip">加载失败，请重试</div>';
      }
      syncWorkflowUi();
      return false;
    } finally {
      lockController.syncAvailability();
    }
  });
}

// ---------------- 影片列表 ----------------
function getSelectedIds() {
  return cinemaMovies.filter((m) => m.checked).map((m) => String(m.id));
}

function renderMovies() {
  els.movieList.innerHTML = "";
  for (const m of cinemaMovies) {
    const wrap = document.createElement("div");
    wrap.className = "movie-wrap";

    const item = document.createElement("div");
    item.className = "movie-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = m.checked;
    cb.addEventListener("change", () => { m.checked = cb.checked; syncCount(); scheduleMovieSave(); });
    const name = document.createElement("span");
    name.className = "movie-name";
    name.textContent = m.nm;
    const meta = document.createElement("span");
    meta.className = "movie-meta";
    meta.textContent = `${m.showCount} 场`;
    const arrow = document.createElement("span");
    arrow.className = "movie-arrow";
    arrow.textContent = "▸";
    item.append(cb, name, meta, arrow);

    const detail = document.createElement("div");
    detail.className = "movie-detail hidden";

    item.addEventListener("click", (e) => {
      if (e.target === cb) return; // 勾选框单独处理
      m.expanded = !m.expanded;
      arrow.textContent = m.expanded ? "▾" : "▸";
      detail.classList.toggle("hidden", !m.expanded);
      if (m.expanded && !detail.dataset.ready) {
        renderShowtimes(m, detail);
        detail.dataset.ready = "1";
      }
    });

    wrap.append(item, detail);
    els.movieList.appendChild(wrap);
  }
  syncCount();
}

// 按日期分组渲染某部电影的场次
function renderShowtimes(m, box) {
  box.innerHTML = "";
  let total = 0;
  for (const day of m.shows || []) {
    const plist = (day.plist || []).filter(Boolean);
    if (!plist.length) continue;
    total += plist.length;
    const dayBox = document.createElement("div");
    dayBox.className = "show-day";
    const dateEl = document.createElement("div");
    dateEl.className = "show-date";
    dateEl.textContent = day.showDate;
    const chips = document.createElement("div");
    chips.className = "show-chips";
    for (const p of plist) {
      const chip = document.createElement("span");
      const soldout = p.ticketStatus !== 0;
      chip.className = "show-chip" + (soldout ? " soldout" : "");
      chip.textContent =
        [p.tm, p.lang, p.tp, p.th, p.vipPrice ? `¥${p.vipPrice}${p.vipPriceSuffix || ""}` : ""]
          .filter(Boolean).join(" · ") + (soldout ? "（停售）" : "");
      chips.appendChild(chip);
    }
    dayBox.append(dateEl, chips);
    box.appendChild(dayBox);
  }
  if (!total) box.innerHTML = '<div class="muted" style="padding:2px 0 6px">暂无排期</div>';
}

function syncCount() {
  els.movieCount.textContent = `共 ${cinemaMovies.length} 部在映影片，已勾选 ${getSelectedIds().length} 部`;
  renderNotifyMonitorSummary();
  lockController.syncAvailability();
  syncWorkflowUi();
}

els.btnToggleAll.addEventListener("click", () => {
  if (!cinemaMovies.length) return;
  const all = getSelectedIds().length !== cinemaMovies.length;
  cinemaMovies.forEach((m) => (m.checked = all));
  renderMovies();
  scheduleMovieSave();
});

// ---------------- 检查 / 测试 ----------------
els.btnCheck.addEventListener("click", async () => {
  if (!connected) return showToast("请先连接云端", "warn");
  const generation = profileGeneration.current();
  await withButtonLoading(els.btnCheck, "检查中...", async () => {
    try {
      const res = await api("/api/check", { method: "POST" });
      if (!profileGeneration.isCurrent(generation)) return;
      log(res.newTotal ? "new" : "ok", `检查完成: ${res.cinemaName || ""}，新增 ${res.newTotal ?? 0} 场`);
      await refreshChanges();
    } catch (e) {
      if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
      showToast("检查失败：" + e.message, "error");
    }
  });
});

async function testPush(button) {
  if (!connected) return showToast("请先连接云端", "warn");
  const generation = profileGeneration.current();
  let ownsSave = false;
  await withButtonLoading(button, "发送中...", async () => {
    try {
      // 点击会先触发输入框 blur 自动保存；测试必须等待保存完成，避免并发版本冲突。
      await waitForAutoSave();
      if (!profileGeneration.isCurrent(generation)) return;
      saving = true;
      ownsSave = true;
      const saved = await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ ...pushConfigBody(), ...(configVersion ? { expectedVersion: configVersion } : {}) })
      });
      configVersion = Number(saved.config?.version) || configVersion;
      const res = await api("/api/test-push", { method: "POST" });
      if (!profileGeneration.isCurrent(generation)) return;
      configVersion = Number(res.config?.version) || configVersion;
      if (res.config) applyPushConfig(res.config);
      const label = res.label || CHANNEL_LABELS[getChannel()];
      pushVerified = true;
      updateMonitorBtn();
      showToast(`测试推送已发送（${label}），请查收`, "success");
      log("ok", `${label} 测试推送已发送`);
    } catch (e) {
      if (!profileGeneration.isCurrent(generation) || isStaleProfileError(e)) return;
      showToast("测试失败：" + e.message, "error");
    } finally {
      if (ownsSave && profileGeneration.isCurrent(generation)) finishConfigSave();
    }
  });
}

els.btnTestPush.addEventListener("click", () => testPush(els.btnTestPush));
els.btnTestPushServerChan?.addEventListener("click", () => testPush(els.btnTestPushServerChan));

// ---------------- 变化记录 ----------------
function applyStatusSummary(data) {
  const { status = {} } = data;
  currentAccount = data.account || currentAccount;
  lockServiceEnabled = data.lockServiceEnabled === true;
  syncCronInfo(data);
  const stopped = status.enabled === false;
  const lastAt = status.lastCheck || status.lastCheckTs;
  const lastTxt = lastAt ? fmtClock(new Date(lastAt).getTime()) : "从未";
  const main = stopped ? "已停止" : status.lastError ? "检查异常" : "监控中";
  setStatus(main, main === "监控中" ? "running" : "stopped", [
    `上次检查 ${lastTxt}`,
    !stopped && nextBatchText(),
  ], !stopped ? status.lastError : "");
  if (stopped !== !monitorEnabled) {
    monitorEnabled = !stopped;
    updateMonitorBtn();
  } else {
    syncPollingState();
  }
  lockController.syncAvailability();
}

function renderChangePage(page, { reset = false } = {}) {
  if (reset) renderedChanges = [];
  const byId = new Map(renderedChanges.map((item) => [item.id, item]));
  for (const item of page.items || []) byId.set(item.id, item);
  renderedChanges = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 100);
  els.logPanel.innerHTML = "";
  for (const change of renderedChanges) {
    const div = document.createElement("div");
    div.className = `log-entry log-${change.type || "info"}`;
    div.textContent = `[${new Date(change.time).toLocaleString("zh-CN", { hour12: false })}] ${change.text}`;
    els.logPanel.append(div);
  }
  if (!renderedChanges.length) {
    els.logPanel.innerHTML = '<div class="log-entry log-info">暂无变化记录，点「立即检查」试试</div>';
  }
}

pollingController = window.createMaoyanPollingController({
  document,
  requestStatus: () => api("/api/status?view=summary"),
  requestChanges: (afterId) => api(`/api/changes?limit=20${afterId == null ? "" : `&after_id=${afterId}`}`),
  requestLock: () => lockController.refreshRemoteState(),
  onStatus: applyStatusSummary,
  onChanges: renderChangePage
});
syncPollingState();

// showLoading: 手动刷新时显示面板占位，自动轮询不显示，避免闪烁。
async function refreshChanges(showLoading = false) {
  const generation = profileGeneration.current();
  try {
    if (showLoading) setPanelLoading(els.logPanel, "正在加载变化记录...");
    await pollingController.refresh({ forceChanges: showLoading });
  } catch (error) {
    if (!profileGeneration.isCurrent(generation) || isStaleProfileError(error)) return;
    if (showLoading) els.logPanel.innerHTML = '<div class="log-entry log-error">加载失败，请重试</div>';
    log("error", "获取变化记录失败: " + error.message);
  }
}

els.btnRefresh.addEventListener("click", () =>
  withButtonLoading(els.btnRefresh, "刷新中...", () => refreshChanges(true))
);

// ---------------- 初始化 ----------------
let cronMinutes = 10; // 云端 cron 批次(分钟), 连接后以服务端下发为准
let cronText = "每 3 分钟一批"; // 连接后按服务端当前策略显示监控时段
let cronMinuteStep = true; // 是否分钟步进型 cron(可推算下一批时间)

// 批次提示: 检查频率完全跟随 worker 的 cron, 界面不再提供间隔设置
function updateBatchTip() {
  if (!els.batchTip) return;
  els.batchTip.textContent =
    `云端按定时批次自动检查（${cronText}）。停止监控不会丢失配置，可随时恢复`;
  // 页面副标题同步展示实际批次与推送渠道
  if (els.pageSub) {
    els.pageSub.textContent = "监控配置";
  }
}

// 从接口响应同步批次信息
function syncCronInfo(data) {
  if (data.cronMinutes && data.cronMinutes !== cronMinutes) cronMinutes = data.cronMinutes;
  if (data.cronText) cronText = data.cronText;
  if (typeof data.cronMinuteStep === "boolean") cronMinuteStep = data.cronMinuteStep;
  updateBatchTip();
}

(async function init() {
  updateBatchTip();
  try {
    runtimeInfo = await window.maoyanRuntime.getRuntimeInfo();
    renderRuntimeVersion(runtimeInfo);
    if (typeof setRuntimeDataset === "function") setRuntimeDataset(runtimeInfo.kind);
  } catch {
    runtimeInfo = { kind: window.maoyanRuntime?.kind || "web", canLoginMaoyan: false, persistentTokenStorage: false };
    if (typeof setRuntimeDataset === "function") setRuntimeDataset(runtimeInfo.kind);
  }
  bindSetupLinks();
  document.querySelectorAll("[data-runtime-capability]").forEach(element => {
    element.classList.toggle("hidden", window.maoyanRuntime.capabilities?.[element.dataset.runtimeCapability] !== true);
  });
  renderDesktopUpdate({ skipped: true });
  void checkForDesktopUpdate();
  // 排查"刷新后回到登录页": 本机存储 / WebCrypto / 安全上下文 是否可用
  function probeEnv() {
    let storageOk = true;
    try {
      localStorage.setItem("_probe", "1");
      localStorage.removeItem("_probe");
    } catch (e) {
      storageOk = false;
    }
    return {
      storageOk,
      cryptoOk: Boolean(window.crypto && window.crypto.subtle),
      secureContext: Boolean(window.isSecureContext),
    };
  }

  const env = probeEnv();
  const openMode = localStorage.getItem("authMode") === "open";
  const savedWorker = localStorage.getItem("workerUrl");
  els.workerUrl.value = savedWorker ?? DEFAULT_WORKER;
  // 令牌不接受 URL 参数，以免泄露到历史记录或日志。
  const qs = new URLSearchParams(location.search);
  if (qs.get("worker")) els.workerUrl.value = qs.get("worker");
  tokenProfileKey = normalizedWorkerUrl();
  let savedToken = "";
  if (runtimeInfo.kind === "web") {
    try {
      savedToken = await restoreWebToken(savedWorker, tokenProfileKey);
    } catch (e) {
      savedToken = "";
    }
  }
  // 令牌指纹: 与 worker 端 KV 键名 u:<指纹>:config 中的段一致, 便于核对是哪份配置
  function tokenFingerprint(t) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  els.token.value = savedToken;
  const explicit = qs.has("worker"); // 带参数打开视为明确意图, 免令牌模式也能自动连
  const canAutoConnect = Boolean(els.token.value.trim() || explicit || openMode);
  console.warn("[maoyan init]", {
    ...env,
    hasSavedToken: Boolean(savedToken),
    openMode,
    canAutoConnect,
    tokenFingerprint: tokenFingerprint(els.token.value.trim() || "anonymous"),
    host: location.hostname,
  });
  if (canAutoConnect && (els.workerUrl.value.trim() !== "" || SAME_ORIGIN)) {
    await connect();
    return;
  }
  // 没能自动连接: 给出可读的原因, 便于判断是存储被清还是环境不支持
  if (!env.storageOk) {
    showLoginHint("本机浏览器存储不可用（隐私模式 / 存储被限制），令牌无法保存，每次刷新都要重新填写");
  } else if (!env.cryptoOk) {
    showLoginHint(`当前环境不支持 WebCrypto（需 HTTPS，当前 ${location.protocol}），已保存的令牌无法解密读取`);
  } else if (!savedToken && !openMode) {
    showLoginHint("本机没有找到保存的令牌，可能被浏览器清理，请重新填写");
  }
})();
