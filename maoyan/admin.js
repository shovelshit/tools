// 猫眼场次监控 - 访问令牌管理页
// 与 Cloudflare Worker 的 /api/admin/tokens 交互; 管理令牌(ADMIN_TOKEN)存 localStorage
// 依赖的 Worker 接口:
//   GET    /api/admin/tokens                       -> { tokens: [{token, remark, inUse, createdAt, lastUsedAt}] }
//   POST   /api/admin/tokens  body {token?, remark} -> { ok, token }
//   DELETE /api/admin/tokens?token=xxx             -> { ok }
// 鉴权: 请求头 X-Admin-Token
// 注意: 同域部署(Pages)下 Worker 地址可留空, 直接请求当前域名

const $ = (id) => document.getElementById(id);
const els = {
  loginOverlay: $("admin-login"),
  adminMain: $("admin-main"),
  workerUrl: $("admin-worker-url"),
  adminToken: $("admin-token-input"),
  btnLogin: $("btn-admin-login"),
  loginError: $("admin-login-error"),
  tbody: $("token-tbody"),
  summary: $("token-summary"),
  remark: $("new-token-remark"),
  tokenValue: $("new-token-value"),
  btnAdd: $("btn-add-token"),
  btnRefresh: $("btn-refresh-tokens"),
  btnLogout: $("btn-admin-logout"),
};

// 同域部署下 API 地址可留空(直接请求当前域名)
const SAME_ORIGIN_HOSTS = ["ltools.asia", "www.ltools.asia", "tools-a65.pages.dev"];
const SAME_ORIGIN = SAME_ORIGIN_HOSTS.includes(location.hostname);
const DEFAULT_WORKER = SAME_ORIGIN ? "" : "https://ltools.asia";

let baseUrl = "";
let adminToken = "";
let tokens = [];

// ---------------- 请求 ----------------
async function adminApi(path, options = {}) {
  const headers = { "X-Admin-Token": adminToken };
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(baseUrl + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

// ---------------- 登录 ----------------
function showLoginError(msg) {
  els.loginError.textContent = msg;
  els.loginError.classList.remove("hidden");
}

async function login() {
  baseUrl = els.workerUrl.value.trim().replace(/\/+$/, "");
  adminToken = els.adminToken.value.trim();
  if (!baseUrl && !SAME_ORIGIN) return showLoginError("请填写 Worker 地址");
  if (!adminToken) return showLoginError("请填写管理令牌");
  els.btnLogin.disabled = true;
  els.btnLogin.textContent = "验证中...";
  els.loginError.classList.add("hidden");
  try {
    const res = await adminApi("/api/admin/tokens");
    tokens = res.tokens || [];
    localStorage.setItem("adminWorkerUrl", baseUrl);
    localStorage.setItem("adminToken", adminToken);
    renderTokens();
    els.loginOverlay.classList.add("hidden");
    els.adminMain.classList.remove("hidden");
  } catch (e) {
    let msg = e.message;
    if (/HTTP 40[13]/.test(msg)) {
      msg = `管理令牌错误或无权限（${msg}）`;
    } else if (msg.includes("HTTP 404") || msg.includes("Unknown API")) {
      msg = "Worker 暂不支持令牌管理接口（/api/admin/tokens），请先更新 Worker 部署";
    }
    showLoginError("连接失败：" + msg);
  } finally {
    els.btnLogin.disabled = false;
    els.btnLogin.textContent = "进入管理";
  }
}

els.btnLogin.addEventListener("click", login);
els.adminToken.addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});

els.btnLogout.addEventListener("click", () => {
  els.adminMain.classList.add("hidden");
  els.loginOverlay.classList.remove("hidden");
  els.loginError.classList.add("hidden");
});

// ---------------- 令牌列表 ----------------
async function refreshTokens() {
  els.btnRefresh.disabled = true;
  renderMsgRow("加载中...");
  try {
    const res = await adminApi("/api/admin/tokens");
    tokens = res.tokens || [];
    renderTokens();
  } catch (e) {
    renderMsgRow("加载失败：" + e.message);
  } finally {
    els.btnRefresh.disabled = false;
  }
}

function maskToken(t) {
  t = String(t || "");
  return t.length <= 10 ? t : t.slice(0, 4) + " •••• " + t.slice(-4);
}

function fmtTime(v) {
  if (!v) return "-";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN", { hour12: false });
}

function renderTokens() {
  const inUse = tokens.filter((t) => t.inUse).length;
  els.summary.textContent = `共 ${tokens.length} 个令牌 · ${inUse} 个使用中`;
  els.tbody.innerHTML = "";
  if (!tokens.length) {
    renderMsgRow("还没有令牌，请在上方新增");
    return;
  }
  for (const t of tokens) {
    const tr = document.createElement("tr");

    const tdToken = document.createElement("td");
    tdToken.className = "token-cell";
    tdToken.textContent = maskToken(t.token);

    const tdRemark = document.createElement("td");
    tdRemark.textContent = t.remark || "-";

    const tdStatus = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + (t.inUse ? "in-use" : "idle");
    badge.textContent = t.inUse ? "使用中" : "未使用";
    tdStatus.appendChild(badge);

    const tdCreated = document.createElement("td");
    tdCreated.textContent = fmtTime(t.createdAt);

    const tdUsed = document.createElement("td");
    tdUsed.textContent = fmtTime(t.lastUsedAt);

    const tdOps = document.createElement("td");
    const btnCopy = document.createElement("button");
    btnCopy.className = "link-btn";
    btnCopy.textContent = "复制";
    btnCopy.addEventListener("click", async () => {
      await copyText(t.token);
      btnCopy.textContent = "已复制";
      setTimeout(() => (btnCopy.textContent = "复制"), 1500);
    });
    const btnDel = document.createElement("button");
    btnDel.className = "link-btn danger";
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", () => deleteToken(t));
    tdOps.append(btnCopy, btnDel);

    tr.append(tdToken, tdRemark, tdStatus, tdCreated, tdUsed, tdOps);
    els.tbody.appendChild(tr);
  }
}

function renderMsgRow(text) {
  els.tbody.innerHTML = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 6;
  td.className = "muted empty-tip";
  td.textContent = text;
  tr.appendChild(td);
  els.tbody.appendChild(tr);
}

// ---------------- 新增 / 删除 ----------------
els.btnAdd.addEventListener("click", async () => {
  const remark = els.remark.value.trim();
  const token = els.tokenValue.value.trim();
  const body = { remark };
  if (token) body.token = token;
  els.btnAdd.disabled = true;
  els.btnAdd.textContent = "新增中...";
  try {
    const res = await adminApi("/api/admin/tokens", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const newToken = res.token || token;
    try { await copyText(newToken); } catch (e) { /* 复制失败不阻断 */ }
    alert(`令牌已创建并复制到剪贴板：\n\n${newToken}\n\n请发给使用者在监控页登录时填写。`);
    els.remark.value = "";
    els.tokenValue.value = "";
    await refreshTokens();
  } catch (e) {
    alert("新增失败：" + e.message);
  } finally {
    els.btnAdd.disabled = false;
    els.btnAdd.textContent = "新增";
  }
});

async function deleteToken(t) {
  const label = t.remark ? `「${t.remark}」` : "";
  if (!confirm(`确定删除令牌 ${maskToken(t.token)} ${label}？\n删除后使用者将无法再连接云端。`)) return;
  try {
    await adminApi("/api/admin/tokens?token=" + encodeURIComponent(t.token), { method: "DELETE" });
    tokens = tokens.filter((x) => x.token !== t.token);
    renderTokens();
  } catch (e) {
    alert("删除失败：" + e.message);
  }
}

// ---------------- 工具 ----------------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 非安全上下文(file://)回退方案
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------- 初始化 ----------------
(async function init() {
  // 支持 URL 参数直达: ?worker=https://xxx.workers.dev&adminToken=xxx
  const qs = new URLSearchParams(location.search);
  els.workerUrl.value = qs.get("worker") || (localStorage.getItem("adminWorkerUrl") ?? DEFAULT_WORKER);
  els.adminToken.value = qs.get("adminToken") || localStorage.getItem("adminToken") || "";
  if (els.adminToken.value.trim()) {
    await login();
  }
})();
