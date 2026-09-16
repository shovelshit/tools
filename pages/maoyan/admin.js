const $ = (id) => document.getElementById(id);
const els = {
  loginOverlay: $("admin-login"), adminMain: $("admin-main"), workerUrl: $("admin-worker-url"),
  adminToken: $("admin-token-input"), btnLogin: $("btn-admin-login"), loginError: $("admin-login-error"),
  tbody: $("account-tbody"), summary: $("account-summary"), capacitySummary: $("capacity-summary"),
  capacityMax: $("capacity-max"), validDays: $("default-valid-days"), publicSignup: $("public-signup-enabled"),
  btnSaveSettings: $("btn-save-settings"), remark: $("new-account-remark"), btnAdd: $("btn-add-account"),
  search: $("account-search"), statusFilter: $("account-status-filter"), btnRefresh: $("btn-refresh-accounts"),
  btnLoadMore: $("btn-load-more"), btnLogout: $("btn-admin-logout"),
  btnEnterMonitor: $("btn-enter-monitor")
};

const SAME_ORIGIN_HOSTS = ["ltools.asia", "www.ltools.asia", "tools-a65.pages.dev"];
const SAME_ORIGIN = SAME_ORIGIN_HOSTS.includes(location.hostname);
const DEFAULT_WORKER = SAME_ORIGIN ? "" : "https://ltools.asia";
const STATUS_LABEL = { active: "有效", expired: "已到期", suspended: "已暂停", revoked: "已撤销" };
let baseUrl = "";
let adminToken = "";
let accounts = [];
let capacity = null;
let settings = null;
let nextAfter = null;

async function adminApi(path, options = {}) {
  const headers = { "X-Admin-Token": adminToken };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.code = data.code || "";
    throw error;
  }
  return data;
}

function showLoginError(message) {
  els.loginError.textContent = message;
  els.loginError.classList.remove("hidden");
}

async function login() {
  baseUrl = els.workerUrl.value.trim().replace(/\/+$/, "");
  adminToken = els.adminToken.value.trim();
  if (!baseUrl && !SAME_ORIGIN) return showLoginError("请填写服务地址");
  if (!adminToken) return showLoginError("请填写管理令牌");
  els.btnLogin.disabled = true;
  els.btnLogin.textContent = "验证中...";
  els.loginError.classList.add("hidden");
  try {
    await Promise.all([refreshAccounts({ reset: true }), loadSettings()]);
    localStorage.setItem("adminWorkerUrl", baseUrl);
    await secureSet("adminToken", adminToken);
    els.adminToken.value = "";
    els.loginOverlay.classList.add("hidden");
    els.adminMain.classList.remove("hidden");
  } catch (error) {
    showLoginError(`连接失败：${error.message}`);
  } finally {
    els.btnLogin.disabled = false;
    els.btnLogin.textContent = "进入管理";
  }
}

function queryPath(after = "") {
  const params = new URLSearchParams({ limit: "20" });
  if (els.search.value.trim()) params.set("q", els.search.value.trim());
  if (els.statusFilter.value) params.set("status", els.statusFilter.value);
  if (after) params.set("after", after);
  return `/api/admin/accounts?${params}`;
}

async function refreshAccounts({ reset = true } = {}) {
  if (reset) renderMessage("加载中...");
  const data = await adminApi(queryPath(reset ? "" : nextAfter || ""));
  accounts = reset ? data.accounts : accounts.concat(data.accounts || []);
  capacity = data.capacity;
  nextAfter = data.nextAfter || null;
  renderAccounts();
}

async function loadSettings() {
  const data = await adminApi("/api/admin/settings");
  settings = data.settings;
  els.capacityMax.value = settings.maxUsers;
  els.validDays.value = settings.defaultValidDays;
  els.publicSignup.checked = settings.publicSignupEnabled === true;
}

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function badge(text, state) {
  const element = document.createElement("span");
  element.className = `badge account-${state}`;
  element.textContent = text;
  return element;
}

function actionButton(text, className, handler) {
  const button = document.createElement("button");
  button.className = `link-btn ${className || ""}`.trim();
  button.textContent = text;
  button.addEventListener("click", handler);
  return button;
}

function renderAccounts() {
  const used = Number(capacity?.used || 0);
  const max = Number(capacity?.maxUsers || 0);
  els.capacitySummary.textContent = `${used} / ${max}`;
  els.summary.textContent = `当前显示 ${accounts.length} 个账号`;
  els.btnLoadMore.classList.toggle("hidden", !nextAfter);
  els.tbody.innerHTML = "";
  if (!accounts.length) return renderMessage("没有符合条件的账号");

  for (const account of accounts) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent = account.remark || "未命名账号";
    const hint = document.createElement("small");
    hint.className = "muted account-hint";
    hint.textContent = `${account.keyHint || ""} · ${account.source || "-"}`;
    identity.append(title, hint);

    const qualification = document.createElement("td");
    qualification.appendChild(badge(STATUS_LABEL[account.accountStatus] || account.accountStatus, account.accountStatus));
    const monitor = document.createElement("td");
    monitor.appendChild(badge(account.monitorState === "monitoring" ? "监控中" : "已停止", account.monitorState));
    const expiry = document.createElement("td");
    expiry.textContent = fmtTime(account.expiresAt);
    const activity = document.createElement("td");
    activity.textContent = fmtTime(account.lastActivityAt);
    const operations = document.createElement("td");
    operations.className = "account-actions";

    if (account.accountStatus === "active") {
      operations.appendChild(actionButton("暂停", "", () => updateAccount(account, { state: "suspended" })));
    } else if (account.accountStatus === "suspended") {
      operations.appendChild(actionButton("恢复", "", () => updateAccount(account, { state: "active" })));
    } else if (account.accountStatus === "expired") {
      operations.appendChild(actionButton("续 15 天", "", () => updateAccount(account, { expiresAt: Date.now() + 15 * 86400000 })));
    }
    if (account.accountStatus !== "revoked") {
      operations.appendChild(actionButton("撤销", "danger", () => revokeAccount(account)));
    }
    row.append(identity, qualification, monitor, expiry, activity, operations);
    els.tbody.appendChild(row);
  }
}

function renderMessage(text) {
  els.tbody.innerHTML = "";
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 6;
  cell.className = "muted empty-tip";
  cell.textContent = text;
  row.appendChild(cell);
  els.tbody.appendChild(row);
}

async function updateAccount(account, patch) {
  try {
    await adminApi("/api/admin/accounts/update", {
      method: "POST",
      body: JSON.stringify({ id: account.userId, expectedVersion: account.accountVersion, patch })
    });
    await refreshAccounts({ reset: true });
  } catch (error) {
    showToast(`操作失败：${error.message}`, "error");
    if (error.code === "VERSION_CONFLICT") await refreshAccounts({ reset: true });
  }
}

async function revokeAccount(account) {
  const ok = await showConfirm(`确定撤销「${account.remark || account.userId}」？撤销后不能恢复。`, {
    title: "撤销账号", danger: true, okText: "撤销"
  });
  if (ok) await updateAccount(account, { state: "revoked" });
}

async function openMonitor() {
  try {
    const response = await fetch(baseUrl + "/api/auth/session", {
      method: "POST",
      headers: { "X-Token": adminToken }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.monitorSession) throw new Error(data.error || "无法创建管理员监控会话");
    const profile = (baseUrl || location.origin).replace(/\/$/, "");
    await secureSet(`token:${encodeURIComponent(profile)}`, data.monitorSession);
    localStorage.setItem("workerUrl", baseUrl);
    const target = new URL("index.html", location.href);
    if (baseUrl) target.searchParams.set("worker", baseUrl);
    location.href = target.toString();
  } catch (error) {
    showToast(`进入监控失败：${error.message}`, "error");
  }
}

els.btnAdd.addEventListener("click", async () => {
  els.btnAdd.disabled = true;
  try {
    const created = await adminApi("/api/admin/accounts/create", {
      method: "POST",
      body: JSON.stringify({ remark: els.remark.value.trim(), requestId: crypto.randomUUID() })
    });
    if (!created.key) throw new Error("账号已创建，但访问密钥仅在首次响应显示");
    try { await copyText(created.key); } catch {}
    await showDialog(`访问密钥已复制，仅显示一次：\n\n${created.key}`, { title: "账号已创建", type: "success" });
    els.remark.value = "";
    await refreshAccounts({ reset: true });
  } catch (error) {
    showToast(`新增失败：${error.message}`, "error");
  } finally {
    els.btnAdd.disabled = false;
  }
});

els.btnSaveSettings.addEventListener("click", async () => {
  if (!settings) return;
  try {
    const data = await adminApi("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: settings.version,
        maxUsers: Number(els.capacityMax.value),
        defaultValidDays: Number(els.validDays.value),
        publicSignupEnabled: els.publicSignup.checked
      })
    });
    settings = data.settings;
    showToast("账号设置已保存", "success");
    await refreshAccounts({ reset: true });
  } catch (error) {
    showToast(`保存失败：${error.message}`, "error");
    await loadSettings().catch(() => {});
  }
});

let searchTimer;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshAccounts({ reset: true }).catch((error) => showToast(error.message, "error")), 250);
});
els.statusFilter.addEventListener("change", () => refreshAccounts({ reset: true }).catch((error) => showToast(error.message, "error")));
els.btnRefresh.addEventListener("click", () => Promise.all([refreshAccounts({ reset: true }), loadSettings()]));
els.btnLoadMore.addEventListener("click", () => refreshAccounts({ reset: false }));
els.btnEnterMonitor.addEventListener("click", (event) => {
  event.preventDefault();
  void openMonitor();
});
els.btnLogin.addEventListener("click", login);
els.adminToken.addEventListener("keydown", (event) => { if (event.key === "Enter") login(); });
els.btnLogout.addEventListener("click", () => {
  adminToken = "";
  void secureSet("adminToken", "");
  els.adminMain.classList.add("hidden");
  els.loginOverlay.classList.remove("hidden");
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

(async function init() {
  const query = new URLSearchParams(location.search);
  els.workerUrl.value = query.get("worker") || (localStorage.getItem("adminWorkerUrl") ?? DEFAULT_WORKER);
  els.adminToken.value = (await secureGet("adminToken")) || "";
  if (els.adminToken.value.trim()) await login();
})();
