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
  // 顶栏
  statusLine: $("status-line"),
  btnLogout: $("btn-logout"),
  // 影院设置
  cityInput: $("city-input"),
  cityDropdown: $("city-dropdown"),
  cinemaSearch: $("cinema-search"),
  cinemaDropdown: $("cinema-dropdown"),
  btnSearchCinema: $("btn-search-cinema"),
  cinemaInput: $("cinema-input"),
  btnLoadCinema: $("btn-load-cinema"),
  cinemaName: $("cinema-name"),
  // 监控设置
  btnSave: $("btn-save"),
  btnCheck: $("btn-check"),
  btnTestBark: $("btn-test-bark"),
  btnToggleMonitor: $("btn-toggle-monitor"),
  intervalInput: $("interval-input"),
  barkInput: $("bark-input"),
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
let monitorEnabled = true;
let barkSaved = false; // 云端已存有 Bark Key(免令牌模式下接口不回显, 保存时避免误覆盖)

// 城市 / 影院搜索
let allCities = [];        // [{id, name, pinyin}]
let selectedCity = null;   // {id, name}
let selectedCinema = null; // {id, name}
let cinemaSearchTimer = null;

// 同域部署下 Worker 地址可留空(直接请求当前域名); 其他托管环境给出默认后端
const SAME_ORIGIN_HOSTS = ["ltools.asia", "www.ltools.asia", "tools-a65.pages.dev"];
const SAME_ORIGIN = SAME_ORIGIN_HOSTS.includes(location.hostname);
const DEFAULT_WORKER = SAME_ORIGIN ? "" : "https://ltools.asia";

// ---------------- 基础 ----------------
function apiPath(path, params = "") {
  const base = els.workerUrl.value.trim().replace(/\/+$/, "");
  const token = els.token.value.trim();
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}token=${encodeURIComponent(token)}${params}`;
}

async function api(path, options = {}) {
  const headers = { "X-Token": els.token.value.trim() };
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(apiPath(path), { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

function log(type, text) {
  const div = document.createElement("div");
  div.className = `log-entry log-${type}`;
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  div.textContent = `[${time}] ${text}`;
  els.logPanel.prepend(div);
}

function setStatus(text) {
  els.statusLine.textContent = "状态：" + text;
}

// ---------------- 登录 / 连接 ----------------
function showLoginError(msg) {
  els.loginError.textContent = msg;
  els.loginError.classList.remove("hidden");
}

function enterMainPage() {
  els.loginOverlay.classList.add("hidden");
  els.mainPage.classList.remove("hidden");
}

async function connect() {
  if (!els.workerUrl.value.trim() && !SAME_ORIGIN) return showLoginError("请填写 Worker 地址");
  localStorage.setItem("workerUrl", els.workerUrl.value.trim());
  localStorage.setItem("token", els.token.value.trim());
  els.btnConnect.disabled = true;
  els.btnConnect.textContent = "连接中...";
  els.loginError.classList.add("hidden");
  try {
    const st = await api("/api/status");
    connected = true;
    const openMode = st.authMode === "open";
    document.body.classList.toggle("open-mode", openMode);
    setStatus(`已连接，上次检查 ${st.status.lastCheck || "从未"}${openMode ? "（免令牌模式）" : ""}`);
    enterMainPage();
    log("ok", "云端连接成功");
    await Promise.all([loadCities(), restoreConfig()]);
    refreshChanges();
  } catch (e) {
    connected = false;
    setStatus("连接失败");
    // 令牌错误只做简短提示, 不暴露 Worker 名称与配置步骤(多人使用场景)
    let msg = e.message;
    if (msg.includes("访问令牌错误")) msg = "访问令牌无效，请检查令牌是否输入正确";
    showLoginError("连接失败：" + msg);
  } finally {
    els.btnConnect.disabled = false;
    els.btnConnect.textContent = "进入监控";
  }
}

els.btnConnect.addEventListener("click", connect);
els.token.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});

// 切换连接: 回到登录层, 保留上次填写的地址/令牌便于修改
els.btnLogout.addEventListener("click", () => {
  connected = false;
  setStatus("未连接");
  els.mainPage.classList.add("hidden");
  els.loginOverlay.classList.remove("hidden");
  els.loginError.classList.add("hidden");
});

async function restoreConfig() {
  const { config } = await api("/api/config");
  monitorEnabled = config.enabled !== false;
  updateMonitorBtn();
  if (config.cinemaId) els.cinemaInput.value = config.cinemaId;
  if (config.intervalMinutes) els.intervalInput.value = config.intervalMinutes;
  if (config.barkKey) { els.barkInput.value = config.barkKey; barkSaved = true; }
  else { barkSaved = Boolean(config.hasBark); if (barkSaved) log("info", "Bark 已配置（为防泄露不回显，保存配置不会覆盖它）"); }
  const prevSelected = new Set((config.selectedMovieIds || []).map(String));
  if (config.cinemaId) await loadCinema(config.cinemaId, prevSelected);
}

// ---------------- 监控启停 ----------------
function updateMonitorBtn() {
  els.btnToggleMonitor.textContent = monitorEnabled ? "停止监控" : "恢复监控";
  els.btnToggleMonitor.classList.toggle("danger", monitorEnabled);
  els.btnToggleMonitor.classList.toggle("success", !monitorEnabled);
  els.btnToggleMonitor.disabled = !connected;
}

els.btnToggleMonitor.addEventListener("click", async () => {
  if (!connected) return alert("请先连接云端");
  els.btnToggleMonitor.disabled = true;
  try {
    const target = !monitorEnabled;
    await api("/api/config", { method: "POST", body: JSON.stringify({ enabled: target }) });
    monitorEnabled = target;
    updateMonitorBtn();
    log(target ? "ok" : "info", target ? "监控已恢复，Workers 将继续按间隔检查" : "监控已停止，云端不再自动检查（配置已保留）");
    setStatus(`已连接${monitorEnabled ? "" : "（监控已停止）"}`);
  } catch (e) {
    alert("操作失败：" + e.message);
  } finally {
    updateMonitorBtn();
  }
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
    els.cinemaSearch.placeholder = "云端暂不支持影院搜索，请展开下方手动输入";
  }
}

function filterCities(kw) {
  if (!allCities.length) return [];
  const k = kw.trim().toLowerCase();
  if (!k) return allCities.slice(0, 20);
  const starts = [];
  const contains = [];
  for (const c of allCities) {
    if (c.name.startsWith(k) || c.pinyin.startsWith(k)) starts.push(c);
    else if (c.name.includes(k) || c.pinyin.includes(k)) contains.push(c);
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
      els.cinemaSearch.value = name;
      els.cinemaDropdown.classList.add("hidden");
      loadCinema(id);
    });
    els.cinemaDropdown.appendChild(item);
  }
  els.cinemaDropdown.classList.remove("hidden");
}

els.cinemaSearch.addEventListener("input", () => {
  selectedCinema = null;
  scheduleCinemaSearch();
});
els.cinemaSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    scheduleCinemaSearch(true);
  }
});
els.btnSearchCinema.addEventListener("click", () => scheduleCinemaSearch(true));

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

// ---------------- 影院(手动加载) ----------------
function parseCinemaInput(input) {
  const s = String(input || "").trim();
  let m = s.match(/cinema\/(\d+)/i);
  if (m) return m[1];
  m = s.match(/[?&]poi=(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  throw new Error("无法识别影院 ID");
}

els.btnLoadCinema.addEventListener("click", () => {
  try {
    const id = parseCinemaInput(els.cinemaInput.value);
    els.cinemaInput.value = id;
    loadCinema(id);
  } catch (e) {
    alert(e.message);
  }
});
els.cinemaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.btnLoadCinema.click();
});

async function loadCinema(cinemaId, prevSelected) {
  els.btnLoadCinema.disabled = true;
  els.btnLoadCinema.textContent = "加载中...";
  try {
    const res = await api("/api/shows?cinemaId=" + encodeURIComponent(cinemaId));
    els.cinemaName.textContent = `🎬 ${res.cinemaName}（ID: ${res.cinemaId}）`;
    els.cinemaName.classList.remove("hidden");
    const sel = prevSelected || new Set(getSelectedIds());
    cinemaMovies = res.movies.map((m) => ({ ...m, checked: sel.has(String(m.id)) }));
    renderMovies();
    log("ok", `加载影院成功: ${res.cinemaName}，在映影片 ${res.movies.length} 部`);
  } catch (e) {
    alert("加载失败：" + e.message);
    log("error", "加载影院失败: " + e.message);
  } finally {
    els.btnLoadCinema.disabled = false;
    els.btnLoadCinema.textContent = "加载";
  }
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
    cb.addEventListener("change", () => { m.checked = cb.checked; syncCount(); });
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
}

els.btnToggleAll.addEventListener("click", () => {
  if (!cinemaMovies.length) return;
  const all = getSelectedIds().length !== cinemaMovies.length;
  cinemaMovies.forEach((m) => (m.checked = all));
  renderMovies();
});

// ---------------- 保存 / 检查 / 测试 ----------------
els.btnSave.addEventListener("click", async () => {
  if (!connected) return alert("请先连接云端");
  if (!cinemaMovies.length) return alert("请先加载影院");
  const selectedMovieIds = getSelectedIds();
  if (!selectedMovieIds.length) return alert("请至少勾选一部电影");
  try {
    const body = {
      cinemaId: els.cinemaInput.value.trim(),
      selectedMovieIds,
      intervalMinutes: parseInt(els.intervalInput.value, 10) || 10,
      enabled: true, // 保存完整配置视为恢复监控
    };
    // Bark 输入留空时不发送, 保留云端已配置的 Key(免令牌模式下不回显)
    if (els.barkInput.value.trim()) body.barkKey = els.barkInput.value.trim();
    else if (barkSaved) log("info", "Bark 输入为空，保留云端已有的 Bark Key");
    await api("/api/config", { method: "POST", body: JSON.stringify(body) });
    monitorEnabled = true;
    updateMonitorBtn();
    log("ok", `配置已保存到云端（监控 ${selectedMovieIds.length} 部电影，间隔 ${els.intervalInput.value} 分钟）`);
    alert("配置已保存！Workers 将按间隔自动检查并推送 Bark。");
  } catch (e) {
    alert("保存失败：" + e.message);
  }
});

els.btnCheck.addEventListener("click", async () => {
  if (!connected) return alert("请先连接云端");
  els.btnCheck.disabled = true;
  els.btnCheck.textContent = "检查中...";
  try {
    const res = await api("/api/check", { method: "POST" });
    log(res.newTotal ? "new" : "ok", `检查完成: ${res.cinemaName || ""}，新增 ${res.newTotal ?? 0} 场`);
    await refreshChanges();
  } catch (e) {
    alert("检查失败：" + e.message);
  } finally {
    els.btnCheck.disabled = false;
    els.btnCheck.textContent = "立即检查";
  }
});

els.btnTestBark.addEventListener("click", async () => {
  if (!connected) return alert("请先连接云端");
  // 先保存 Bark 配置再测试
  if (els.barkInput.value.trim()) {
    await api("/api/config", { method: "POST", body: JSON.stringify({ barkKey: els.barkInput.value.trim() }) });
    barkSaved = true;
  }
  try {
    await api("/api/test-bark", { method: "POST" });
    alert("测试推送已发送，请查看 iPhone");
    log("ok", "Bark 测试推送已发送");
  } catch (e) {
    alert("测试失败：" + e.message);
  }
});

// ---------------- 变化记录 ----------------
async function refreshChanges() {
  try {
    const { status, changes } = await api("/api/status");
    const stopped = status.enabled === false;
    setStatus(`已连接，上次检查 ${status.lastCheck ? new Date(status.lastCheck).toLocaleString("zh-CN", { hour12: false }) : "从未"}${stopped ? "（监控已停止）" : ""}`);
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
    log("error", "获取变化记录失败: " + e.message);
  }
}

els.btnRefresh.addEventListener("click", refreshChanges);

// 每 60 秒自动刷新状态与记录
setInterval(() => { if (connected) refreshChanges(); }, 60000);

// ---------------- 初始化 ----------------
(async function init() {
  els.workerUrl.value = localStorage.getItem("workerUrl") ?? DEFAULT_WORKER;
  els.token.value = localStorage.getItem("token") || "";
  // 支持 URL 参数直达: ?worker=https://xxx.workers.dev&token=xxx
  const qs = new URLSearchParams(location.search);
  if (qs.get("worker")) els.workerUrl.value = qs.get("worker");
  if (qs.get("token")) els.token.value = qs.get("token");
  const explicit = qs.has("worker"); // 带参数打开视为明确意图, 免令牌模式也能自动连
  // 有保存的凭据时自动连接, 失败则停留在登录层展示错误
  if (els.workerUrl.value.trim() !== "" || SAME_ORIGIN) {
    if (els.token.value.trim() || explicit) {
      await connect();
    }
  }
})();
