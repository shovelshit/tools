// 猫眼影院场次监控 - 云端版前端
// 与 Cloudflare Worker 的 /api/* 交互; Worker 地址和令牌存 localStorage
// 首次进入显示登录层, 连接成功后进入主页面

const $ = (id) => document.getElementById(id);
const els = {
  // 登录层
  loginOverlay: $("login-overlay"),
  mainPage: $("main-page"),
  workerUrl: $("worker-url"),
  token: $("token-input"),
  btnConnect: $("btn-connect"),
  loginError: $("login-error"),
  loginHint: $("login-hint"),
  // 顶栏
  statusLine: $("status-line"),
  btnLogout: $("btn-logout"),
  // 影院设置
  cityInput: $("city-input"),
  cityDropdown: $("city-dropdown"),
  cinemaSearch: $("cinema-search"),
  cinemaDropdown: $("cinema-dropdown"),
  btnSearchCinema: $("btn-search-cinema"),
  cinemaName: $("cinema-name"),
  // 监控设置
  btnCheck: $("btn-check"),
  btnTestPush: $("btn-test-push"),
  btnLockSeats: $("btn-lock-seats"),
  btnToggleMonitor: $("btn-toggle-monitor"),
  batchTip: $("batch-tip"),
  barkInput: $("bark-input"),
  serverChanInput: $("serverchan-input"),
  pushBarkRow: $("push-bark-row"),
  pushServerChanRow: $("push-serverchan-row"),
  pushChannelRow: $("push-channel-row"),
  pageSub: $("page-sub"),
  // 电影列表
  movieList: $("movie-list"),
  movieCount: $("movie-count"),
  btnToggleAll: $("btn-toggle-all"),
  // 日志
  btnRefresh: $("btn-refresh"),
  logPanel: $("log-panel"),
};

let cinemaMovies = []; // [{id, nm, showCount, checked}]
let connected = false;
let lockServiceEnabled = false;
let monitorEnabled = false; // 默认停止, 需显式「开始监控」
let monitorDdl = null; // 监控截止时间(ISO), 每次开始监控刷新 30 天
let pushSaved = false; // 云端已存有当前渠道的推送配置(接口不回显时, 保存时避免误覆盖)
let pushVerified = false; // 当前渠道 + 当前密钥已成功发送过测试推送

// 城市 / 影院搜索
let allCities = [];        // [{id, name, pinyin}]
let selectedCity = null;   // {id, name}
let selectedCinema = null; // {id, name}
let selectedCinemaId = ""; // 当前影院 ID(搜索选中/加载成功/云端恢复三处写入, 替代旧的手动输入框)
let cinemaSelected = false; // 影院已在影院设置中选择或加载(锁座入口门槛)
let cinemaSearchTimer = null;

// 同域部署下 Worker 地址可留空(直接请求当前域名); 其他托管环境给出默认后端
const SAME_ORIGIN_HOSTS = ["ltools.asia", "www.ltools.asia", "tools-a65.pages.dev"];
const SAME_ORIGIN = SAME_ORIGIN_HOSTS.includes(location.hostname);
const DEFAULT_WORKER = SAME_ORIGIN ? "" : "https://ltools.asia";

// ---------------- 基础 ----------------
// 安全: 令牌只通过 X-Token 请求头传递, 不再拼进 URL(避免进入日志/历史记录)
function apiPath(path, params = "") {
  const base = els.workerUrl.value.trim().replace(/\/+$/, "");
  return `${base}${path}${params}`;
}

async function api(path, options = {}) {
  const headers = { "X-Token": els.token.value.trim() };
  if (options.body) headers["Content-Type"] = "application/json";
  startTopProgress();
  try {
    const res = await fetch(apiPath(path), { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  } finally {
    stopTopProgress();
  }
}

const lockController = window.createMaoyanLockController({
  api,
  getContext: () => ({
    connected,
    cinemaId: selectedCinemaId,
    cinemaName: selectedCinema?.name || els.cinemaName.textContent,
    cinemaSelected,
    lockServiceEnabled,
    cinemaLoaded: cinemaMovies.length > 0,
    movies: cinemaMovies.filter((movie) => movie.checked)
  }),
  onLog: log
});

function log(type, text) {
  const div = document.createElement("div");
  div.className = `log-entry log-${type}`;
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  div.textContent = `[${time}] ${text}`;
  els.logPanel.prepend(div);
}

function setStatus(text, state = "off") {
  if (!els.statusLine) return;
  // state: running(监控中, 绿) / stopped(已停止或连接失败, 红) / off(未连接, 灰)
  els.statusLine.className = `status-line st-${state}`;
  els.statusLine.innerHTML = '<span class="dot"></span><span></span>';
  els.statusLine.lastChild.textContent = text;
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
  return `下批次检查时间 ${crossDay}${hm}`;
}

// 组合状态文案: 非空片段用 " · " 连接, 避免词语粘连
function statusText(main, extra = []) {
  const parts = extra.filter(Boolean);
  return parts.length ? `${main} · ${parts.join(" · ")}` : main;
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
}

async function connect() {
  if (!els.workerUrl.value.trim() && !SAME_ORIGIN) return showLoginError("请填写服务地址");
  localStorage.setItem("workerUrl", els.workerUrl.value.trim());
  await secureSet("token", els.token.value.trim());
  els.loginError.classList.add("hidden");
  if (els.loginHint) els.loginHint.classList.add("hidden");
  try {
    await withButtonLoading(els.btnConnect, "连接中...", async () => {
      showBlockOverlay("正在连接云端...");
      try {
        const st = await api("/api/status");
        connected = true;
        lockServiceEnabled = st.lockServiceEnabled === true;
        const openMode = st.authMode === "open";
        document.body.classList.toggle("open-mode", openMode);
        // 免令牌模式下没有令牌可存, 记一个标记供刷新后自动重连
        if (openMode) localStorage.setItem("authMode", "open");
        else localStorage.removeItem("authMode");
        const lastTxt = st.status.lastCheck ? fmtClock(new Date(st.status.lastCheck).getTime()) : "从未";
        setStatus(statusText("监控中", [`上次检查 ${lastTxt}`, nextBatchText(), openMode && "免令牌模式"]), "running");
        enterMainPage();
        lockController.syncAvailability();
        log("ok", "云端连接成功");
        await Promise.all([loadCities(), restoreConfig()]);
        refreshChanges();
      } finally {
        hideBlockOverlay();
      }
    });
  } catch (e) {
    connected = false;
    setStatus("连接失败", "stopped");
    // 令牌错误只做简短提示, 不暴露 Worker 名称与配置步骤(多人使用场景)
    let msg = e.message;
    if (msg.includes("访问令牌错误")) msg = "访问令牌无效，请检查令牌是否输入正确";
    showLoginError("连接失败：" + msg);
  }
}

els.btnConnect.addEventListener("click", connect);
els.token.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});

// 切换连接: 仅清除当前工具的连接信息，不影响同域管理页等其他本地数据
els.btnLogout.addEventListener("click", async () => {
  connected = false;
  lockServiceEnabled = false;
  pushVerified = false;
  cinemaSelected = false;
  selectedCinemaId = "";
  selectedCinema = null;
  realKeys.bark = "";
  realKeys.serverchan = "";
  localStorage.removeItem("workerUrl");
  localStorage.removeItem("authMode");
  await secureSet("token", "");
  els.workerUrl.value = "";
  els.token.value = "";
  els.cinemaName.classList.add("hidden");
  els.cinemaName.textContent = "";
  cinemaMovies = [];
  setStatus("未连接");
  els.mainPage.classList.add("hidden");
  els.loginOverlay.classList.remove("hidden");
  els.loginError.classList.add("hidden");
  lockController.close?.();
  lockController.syncAvailability();
  els.btnLockSeats.disabled = true;
});

async function restoreConfig() {
  restoring = true; // 恢复期间自动保存全部跳过, 避免每次连接都冗余写 KV
  try {
    const { config } = await api("/api/config");
    monitorEnabled = config.enabled === true; // 默认停止, 需显式「开始监控」
    monitorDdl = config.monitorDdl || null;
    updateMonitorBtn();
    if (config.cinemaId) selectedCinemaId = String(config.cinemaId);
    // 批次信息以服务端 cron 为准
    syncCronInfo(config);
    applyPushConfig(config);
    const prevSelected = new Set((config.selectedMovieIds || []).map(String));
    if (selectedCinemaId) {
      await loadCinema(selectedCinemaId, prevSelected, { restore: true });
      cinemaSelected = true; // 自动恢复的影院同样视为已选择
    }
    lockController.syncAvailability();
  } finally {
    // 恢复完成: 记录当前状态签名, 与云端一致的内容不再重复写入
    lastSavedSig = JSON.stringify(
      pushConfigBody({ cinemaId: selectedCinemaId, selectedMovieIds: getSelectedIds() })
    );
    restoring = false;
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
// 云端已存密钥但本会话无明文(如刷新后): 用固定掩码占位标识"已保存", 明文只在云端
const KEY_STORED_MASK = "••••••••";
const keyStored = { bark: false, serverchan: false };
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

// 按内存真实值渲染输入框: 有密钥显掩码, 云端已存显固定占位掩码, 都没有显占位提示
function renderKeyInput() {
  const input = currentKeyInput();
  if (!input) return;
  const real = currentRealKey();
  if (real) {
    input.value = maskKey(real);
    input.placeholder = "已配置（不回显，点此可更换）";
  } else if (keyStored[getChannel()]) {
    input.value = KEY_STORED_MASK;
    input.placeholder = "已在云端保存（不回显），输入新值可更换";
  } else {
    input.value = "";
    input.placeholder = KEY_PLACEHOLDERS[getChannel()];
  }
}

function applyPushConfig(config) {
  setChannel(config.notifyChannel || "bark");
  keyStored.bark = config.hasBark === true;
  keyStored.serverchan = config.hasServerChan === true;
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

async function autoSaveConfig(extra = {}, { msg = "配置已自动保存", silent = false } = {}) {
  if (restoring) return; // 恢复配置期间不写
  const body = pushConfigBody(extra);
  const sig = JSON.stringify(body);
  if (sig === lastSavedSig) return;
  if (saving) { savePending = true; return; } // 上一次还在写: 完成后按最新状态补写一次
  saving = true;
  lastSavedSig = sig;
  try {
    const res = await api("/api/config", { method: "POST", body: sig });
    pushVerified = res.config?.notifyVerified === true;
    // 服务端可能因推送渠道不可用而自动停止监控: 同步真实状态, 避免界面仍显示"监控中"
    if (res.config && typeof res.config.enabled === "boolean") monitorEnabled = res.config.enabled;
    if (res.config && res.config.monitorDdl !== void 0) monitorDdl = res.config.monitorDdl || null;
    updateMonitorBtn();
    if (res.notice) {
      await refreshChanges(); // 拉取服务端刚写入的告警与最新状态
      log("warn", res.notice);
      return;
    }
    if (!silent) log("ok", msg);
  } catch (e) {
    lastSavedSig = ""; // 失败允许重试
    showToast("自动保存失败：" + e.message, "error");
  } finally {
    saving = false;
    if (savePending) {
      savePending = false;
      autoSaveConfig(
        { selectedMovieIds: getSelectedIds(), cinemaId: selectedCinemaId },
        { silent: true }
      );
    }
  }
}

// 影片勾选变化较密集, 防抖后合并保存
function scheduleMovieSave() {
  clearTimeout(movieSaveTimer);
  movieSaveTimer = setTimeout(() => {
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
  else if (!real && input.value === KEY_STORED_MASK) input.select();
}

function keyInputBlurred() {
  const input = currentKeyInput();
  const real = currentRealKey();
  const typed = input.value.trim();
  // 占位掩码视为"未改动"(不代表云端密钥, 不回传不覆盖); 输入新值才保存
  if (typed && typed !== real && typed !== maskKey(real) && typed !== KEY_STORED_MASK) {
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
function fmtDate(ts) {
  return new Date(ts).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function updateMonitorBtn() {
  els.btnToggleMonitor.textContent = monitorEnabled ? "停止监控" : "开始监控";
  els.btnToggleMonitor.classList.toggle("danger", monitorEnabled);
  els.btnToggleMonitor.classList.toggle("success", !monitorEnabled);
  const requiresPushTest = !monitorEnabled && !pushVerified;
  els.btnToggleMonitor.disabled = !connected || requiresPushTest;
  els.btnToggleMonitor.title = requiresPushTest ? "请先配置推送渠道，填好推送密钥并「保存并测试」" : "";
}

els.btnToggleMonitor.addEventListener("click", async () => {
  if (!connected) return showToast("请先连接云端", "warn");
  await withButtonLoading(els.btnToggleMonitor, "处理中...", async () => {
    try {
      const target = !monitorEnabled;
      const res = await api("/api/config", { method: "POST", body: JSON.stringify({ enabled: target }) });
      monitorEnabled = target;
      pushVerified = res.config?.notifyVerified === true;
      if (res.config) monitorDdl = res.config.monitorDdl || monitorDdl;
      log(
        target ? "ok" : "info",
        target
          ? statusText("监控已开始", [monitorDdl && `截止 ${fmtDate(Date.parse(monitorDdl))}，到期前再次开始可续期`])
          : "监控已停止，云端不再自动检查（配置已保留）"
      );
      setStatus(
        statusText(monitorEnabled ? "监控中" : "已停止", [
          monitorEnabled && monitorDdl && `截止 ${fmtDate(Date.parse(monitorDdl))}`,
          monitorEnabled && nextBatchText(),
        ]),
        monitorEnabled ? "running" : "stopped"
      );
    } catch (e) {
      showToast("操作失败：" + e.message, "error");
    }
  });
  updateMonitorBtn(); // 按钮文案还原后再按最新状态刷新
});

// ---------------- 城市选择 ----------------
async function loadCities() {
  try {
    const res = await api("/api/cities");
    allCities = (res.cities || []).map((c) => ({
      id: String(c.id),
      name: c.name,
      pinyin: String(c.pinyin || "").toLowerCase(),
    }));
  } catch (e) {
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
    renderCinemaResults(res.cinemas || []);
  } catch (e) {
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
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await api("/api/shows?cinemaId=" + encodeURIComponent(cinemaId));
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function loadCinema(cinemaId, prevSelected, { restore = false } = {}) {
  setPanelLoading(els.movieList, "正在加载影院影片...");
  await withButtonLoading(null, "加载中...", async () => {
    try {
      const res = await fetchShowsWithRetry(cinemaId);
      selectedCinemaId = String(res.cinemaId); // 以接口返回为准, 搜索与恢复两条路径在此汇合
      cinemaSelected = true;
      els.cinemaName.textContent = `🎬 ${res.cinemaName}（ID: ${res.cinemaId}）`;
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
    } catch (e) {
      if (restore) {
        // 恢复配置时拉取失败: 影院 ID 仍在, 提示重试方式
        log("warn", `影院影片自动加载失败（${e.message}），重新搜索该影院或刷新页面可重试`);
        els.movieList.innerHTML = '<div class="muted empty-tip">影院影片加载失败，重新搜索影院或刷新页面重试</div>';
      } else {
        showToast("加载失败：" + e.message, "error");
        log("error", "加载影院失败: " + e.message);
        els.movieList.innerHTML = '<div class="muted empty-tip">加载失败，请重试</div>';
      }
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
  lockController.syncAvailability();
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
  await withButtonLoading(els.btnCheck, "检查中...", async () => {
    try {
      const res = await api("/api/check", { method: "POST" });
      log(res.newTotal ? "new" : "ok", `检查完成: ${res.cinemaName || ""}，新增 ${res.newTotal ?? 0} 场`);
      await refreshChanges();
    } catch (e) {
      showToast("检查失败：" + e.message, "error");
    }
  });
});

els.btnTestPush.addEventListener("click", async () => {
  if (!connected) return showToast("请先连接云端", "warn");
  await withButtonLoading(els.btnTestPush, "发送中...", async () => {
    try {
      // 先保存当前渠道的推送配置再测试(密钥从内存取, 输入框里是掩码)
      const key = currentRealKey();
      if (key) {
        await api("/api/config", { method: "POST", body: JSON.stringify(pushConfigBody()) });
        pushSaved = true;
      }
      const res = await api("/api/test-push", { method: "POST" });
      const label = res.label || CHANNEL_LABELS[getChannel()];
      pushVerified = true;
      updateMonitorBtn();
      showToast(`测试推送已发送（${label}），请查收`, "success");
      log("ok", `${label} 测试推送已发送`);
    } catch (e) {
      showToast("测试失败：" + e.message, "error");
    }
  });
});

// ---------------- 变化记录 ----------------
// showLoading: 手动刷新时显示面板占位, 自动轮询不显示(避免闪烁)
async function refreshChanges(showLoading = false) {
  try {
    if (showLoading) setPanelLoading(els.logPanel, "正在加载变化记录...");
    const data = await api("/api/status");
    const { status, changes } = data;
    lockServiceEnabled = data.lockServiceEnabled === true;
    lockController.syncAvailability();
    syncCronInfo(data); // 批次描述保持与服务端一致
    if (status.monitorDdl !== void 0) monitorDdl = status.monitorDdl;
    const stopped = status.enabled === false;
    // 已到期 = 被自动停止 且 截止时间确实已过; 手动停止后服务端仍保留未来的截止时间, 不能据此判定到期
    const expired = Boolean(stopped && monitorDdl && Date.now() > Date.parse(monitorDdl));
    const lastTxt = status.lastCheck ? fmtClock(new Date(status.lastCheck).getTime()) : "从未";
    const main = stopped ? (expired ? "已到期" : "已停止") : status.lastError ? "检查异常" : "监控中";
    // 停止状态下不再展示"截止 xxx"(那是下次续期用的未来时间, 与"未在监控"矛盾); 到期时保留以便说明原因
    const showDdl = Boolean(monitorDdl) && (!stopped || expired);
    const segments = [
      showDdl && `截止 ${fmtDate(Date.parse(monitorDdl))}`,
      `上次检查 ${lastTxt}`,
      !stopped && nextBatchText(),
      !stopped && status.lastError && `失败原因: ${status.lastError}`,
    ];
    setStatus(statusText(main, segments), main === "监控中" ? "running" : "stopped");
    if (stopped !== !monitorEnabled) {
      monitorEnabled = !stopped;
      updateMonitorBtn();
    }
    els.logPanel.innerHTML = "";
    for (const c of [...changes].reverse()) {
      const div = document.createElement("div");
      div.className = `log-entry log-${c.type || "info"}`;
      div.textContent = `[${new Date(c.time).toLocaleString("zh-CN", { hour12: false })}] ${c.text}`;
      els.logPanel.prepend(div);
    }
    if (!changes.length) {
      els.logPanel.innerHTML = '<div class="log-entry log-info">暂无变化记录，点「立即检查」试试</div>';
    }
  } catch (e) {
    if (showLoading) els.logPanel.innerHTML = '<div class="log-entry log-error">加载失败，请重试</div>';
    log("error", "获取变化记录失败: " + e.message);
  }
}

els.btnRefresh.addEventListener("click", () =>
  withButtonLoading(els.btnRefresh, "刷新中...", () => refreshChanges(true))
);

// 每 60 秒自动刷新状态与记录
setInterval(() => { if (connected) refreshChanges(); }, 60000);

// ---------------- 初始化 ----------------
let cronMinutes = 10; // 云端 cron 批次(分钟), 连接后以服务端下发为准
let cronText = "每 10 分钟一批"; // cron 的人话描述(简单表达式)或原始表达式(复杂)
let cronMinuteStep = true; // 是否分钟步进型 cron(可推算下一批时间)

// 批次提示: 检查频率完全跟随 worker 的 cron, 界面不再提供间隔设置
function updateBatchTip() {
  if (!els.batchTip) return;
  els.batchTip.textContent =
    `云端按定时批次自动检查（${cronText}）。停止监控不会丢失配置，可随时恢复`;
  // 页面副标题同步展示实际批次与推送渠道
  if (els.pageSub) {
    els.pageSub.textContent = `云端定时检查新增场次（${cronText}）· Bark / Server酱 推送到手机`;
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
  let savedToken = "";
  try {
    savedToken = (await secureGet("token")) || "";
  } catch (e) {
    savedToken = "";
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

  els.workerUrl.value = localStorage.getItem("workerUrl") ?? DEFAULT_WORKER;
  els.token.value = savedToken;
  // 仅支持通过 URL 指定 Worker 地址，令牌不接受 URL 参数以免泄露到历史记录或日志。
  const qs = new URLSearchParams(location.search);
  if (qs.get("worker")) els.workerUrl.value = qs.get("worker");
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
