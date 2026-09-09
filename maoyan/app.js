// 猫眼影院场次监控 - 云端版前端
// 与 Cloudflare Worker 的 /api/* 交互; Worker 地址和令牌存 localStorage

const $ = (id) => document.getElementById(id);
const els = {
  workerUrl: $("worker-url"),
  token: $("token-input"),
  btnConnect: $("btn-connect"),
  btnGenToken: $("btn-gen-token"),
  btnCopyToken: $("btn-copy-token"),
  tokenSyncTip: $("token-sync-tip"),
  cinemaInput: $("cinema-input"),
  btnLoadCinema: $("btn-load-cinema"),
  cinemaName: $("cinema-name"),
  btnSave: $("btn-save"),
  btnCheck: $("btn-check"),
  btnTestBark: $("btn-test-bark"),
  btnToggleMonitor: $("btn-toggle-monitor"),
  movieList: $("movie-list"),
  movieCount: $("movie-count"),
  btnToggleAll: $("btn-toggle-all"),
  intervalInput: $("interval-input"),
  barkInput: $("bark-input"),
  btnRefresh: $("btn-refresh"),
  logPanel: $("log-panel"),
  statusLine: $("status-line"),
};

let cinemaMovies = []; // [{id, nm, showCount, checked}]
let connected = false;
let monitorEnabled = true;
let barkSaved = false; // 云端已存有 Bark Key(免令牌模式下接口不回显, 保存时避免误覆盖)

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

// ---------------- 随机令牌 ----------------
els.btnGenToken.addEventListener("click", () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  els.token.value = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  els.btnCopyToken.classList.remove("hidden");
  els.tokenSyncTip.classList.remove("hidden");
  els.tokenSyncTip.innerHTML =
    "已生成新令牌（<b>先别急着点连接</b>，Worker 还不认识它）。同步任选其一：<br>" +
    "① 点「复制令牌」→ 电脑运行 <code>npx wrangler secret put ACCESS_TOKEN</code>，提示输入时粘贴。多人要保留旧令牌时填 <code>旧令牌,新令牌</code><br>" +
    "② 手机/电脑浏览器打开 dash.cloudflare.com → Workers &amp; Pages → maoyan-monitor → Settings → Variables and Secrets → 编辑 ACCESS_TOKEN。同步完成后再回来点「连接」";
  log("info", "已生成随机令牌，请先同步到 Worker（见上方提示），再点连接");
});

els.btnCopyToken.addEventListener("click", async () => {
  const token = els.token.value.trim();
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    log("ok", "令牌已复制到剪贴板");
  } catch (e) {
    // 非安全上下文(file://)回退方案
    els.token.select();
    document.execCommand("copy");
    log("ok", "令牌已复制（回退方式），如未复制成功请手动选择复制");
  }
});

// ---------------- 连接 ----------------
els.btnConnect.addEventListener("click", async () => {
  if (!els.workerUrl.value.trim()) return alert("请填写 Worker 地址");
  localStorage.setItem("workerUrl", els.workerUrl.value.trim());
  localStorage.setItem("token", els.token.value.trim());
  els.btnConnect.disabled = true;
  els.btnConnect.textContent = "连接中...";
  try {
    const st = await api("/api/status");
    connected = true;
    const openMode = st.authMode === "open";
    document.body.classList.toggle("open-mode", openMode);
    setStatus(`已连接，上次检查 ${st.status.lastCheck || "从未"}${openMode ? "（免令牌模式）" : ""}`);
    log("ok", "云端连接成功");
    await restoreConfig();
    await refreshChanges();
  } catch (e) {
    connected = false;
    setStatus("连接失败");
    let msg = e.message;
    if (msg.includes("访问令牌错误")) {
      msg += "\n\n常见原因：刚点了「🎲 随机生成令牌」，新令牌还没同步到 Worker。\n解决办法（任选其一）：\n1. 电脑上运行: npx wrangler secret put ACCESS_TOKEN\n   （多人则填 旧令牌,新令牌 逗号分隔）\n2. 浏览器登录 dash.cloudflare.com → Workers & Pages →\n   maoyan-monitor → Settings → Variables and Secrets →\n   编辑 ACCESS_TOKEN";
    }
    alert("连接失败：" + msg);
  } finally {
    els.btnConnect.disabled = false;
    els.btnConnect.textContent = "连接";
  }
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

// ---------------- 影院 ----------------
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
  const id = parseCinemaInput(els.cinemaInput.value);
  els.cinemaInput.value = id;
  loadCinema(id);
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
  els.workerUrl.value = localStorage.getItem("workerUrl") || "";
  els.token.value = localStorage.getItem("token") || "";
  // 支持 URL 参数直达: ?worker=https://xxx.workers.dev&token=xxx
  const qs = new URLSearchParams(location.search);
  if (qs.get("worker")) els.workerUrl.value = qs.get("worker");
  if (qs.get("token")) els.token.value = qs.get("token");
  const explicit = qs.has("worker"); // 带参数打开视为明确意图, 免令牌模式也能自动连
  if (els.workerUrl.value && (els.token.value || explicit)) {
    els.btnConnect.click();
  } else {
    setStatus("未连接");
  }
})();
