const $ = (id) => document.getElementById(id);
const els = {
  loginOverlay: $("admin-login"), adminMain: $("admin-main"), workerUrl: $("admin-worker-url"),
  adminToken: $("admin-token-input"), btnLogin: $("btn-admin-login"), loginError: $("admin-login-error"),
  tbody: $("account-tbody"), summary: $("account-summary"), capacitySummary: $("capacity-summary"),
  businessLine: $("account-business-line"), capacityLabel: $("capacity-label"),
  capacityMax: $("capacity-max"), validDays: $("default-valid-days"), publicSignup: $("public-signup-enabled"),
  btnSaveSettings: $("btn-save-settings"), remark: $("new-account-remark"), btnAdd: $("btn-add-account"),
  search: $("account-search"), statusFilter: $("account-status-filter"), btnRefresh: $("btn-refresh-accounts"),
  btnLoadMore: $("btn-load-more"), btnLogout: $("btn-admin-logout"),
  btnEnterMonitor: $("btn-enter-monitor"),
  resourceCinemas: $("resource-cinemas"), resourcePending: $("resource-pending"),
  resourceFailed: $("resource-failed"), resourceAdmission: $("resource-admission"), resourceNote: $("resource-note"),
  resourceFailureDetails: $("resource-failure-details"),
  resourceSummary: $("maoyan-resource-summary")
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
let businessGeneration = 0;

function captureBusinessScope() {
  return { businessLine: els.businessLine.value, generation: businessGeneration };
}

function isCurrentBusinessScope(scope) {
  return scope.generation === businessGeneration && scope.businessLine === els.businessLine.value;
}

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
    await Promise.all([refreshAccounts({ reset: true }), loadSettings(), loadResources()]);
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

function queryPath(after = "", businessLine = els.businessLine.value) {
  const params = new URLSearchParams({ limit: "20" });
  params.set("businessLine", businessLine);
  if (els.search.value.trim()) params.set("q", els.search.value.trim());
  if (els.statusFilter.value) params.set("status", els.statusFilter.value);
  if (after) params.set("after", after);
  return `/api/admin/accounts?${params}`;
}

async function refreshAccounts({ reset = true, scope = captureBusinessScope() } = {}) {
  if (!isCurrentBusinessScope(scope)) return false;
  if (reset) renderMessage("加载中...");
  const after = reset ? "" : nextAfter || "";
  const data = await adminApi(queryPath(after, scope.businessLine));
  if (!isCurrentBusinessScope(scope)) return false;
  accounts = reset ? data.accounts : accounts.concat(data.accounts || []);
  capacity = data.capacity;
  nextAfter = data.nextAfter || null;
  renderAccounts();
  return true;
}

async function loadSettings(scope = captureBusinessScope()) {
  if (!isCurrentBusinessScope(scope)) return false;
  const businessLine = encodeURIComponent(scope.businessLine);
  const data = await adminApi(`/api/admin/settings?businessLine=${businessLine}`);
  if (!isCurrentBusinessScope(scope)) return false;
  settings = data.settings;
  els.capacityMax.value = settings.maxUsers;
  els.validDays.value = settings.defaultValidDays;
  els.publicSignup.checked = settings.publicSignupEnabled === true;
  return true;
}

function formatFailureDetail(value) {
  const raw = String(value);
  try {
    const detail = JSON.parse(raw);
    if (!detail || typeof detail !== "object" || Array.isArray(detail) ||
      !Number.isInteger(detail.httpStatus) || typeof detail.responseBody !== "string" ||
      !detail.headers || typeof detail.headers !== "object" || Array.isArray(detail.headers)) return raw;
    const headers = Object.entries(detail.headers)
      .filter(([, content]) => typeof content === "string")
      .map(([name, content]) => `${name}: ${content}`).join("\n");
    return `HTTP 状态：${detail.httpStatus}\n响应头：\n${headers || "（无）"}\n响应体：\n${detail.responseBody}` +
      (detail.bodyTruncated === true ? "\n（响应体已截断）" : "");
  } catch {
    return raw;
  }
}

async function loadResources() {
  const { resources } = await adminApi("/api/admin/resources");
  els.resourceCinemas.textContent = String(resources.activeCinemas ?? "--");
  els.resourcePending.textContent = String(resources.notificationPending ?? "--");
  els.resourceFailed.textContent = String(resources.notificationFailed ?? "--");
  const failures = resources.notificationFailures || [];
  els.resourceFailureDetails.textContent = failures.length
    ? failures.map((item) => {
      const state = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败" }[item.state] || "未知状态";
      const kind = { "lock-terminal": "锁座结果", "monitor-diff": "监控变更", "new-shows": "新场次通知", "account-expiry": "账号到期通知" }[item.kind] || item.kind;
      return `${kind} · 通知状态：${state} · 尝试 ${item.attempts} 次 · ${item.retryEligible ? "可自动重试" : "不再重试"}` +
        (item.lastError ? `\n通知发送错误：${item.lastError}` : "") +
        (item.failureDetail ? `\n锁座失败详情：\n${formatFailureDetail(item.failureDetail)}` : "");
    }).join("\n\n")
    : "暂无通知失败详情";
  els.resourceAdmission.textContent = resources.admissionAllowed ? "可申请" : "保持关闭";
  const measured = Object.values(resources.usage || {}).filter((item) => item.measured).length;
  els.resourceNote.textContent = measured
    ? `${measured} 项平台指标已测量，其余为估算或未知`
    : "未配置用量指标不阻止申请；仅明确耗尽阻止申请";
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

function renderAccountSummary() {
  const used = Number(capacity?.used || 0);
  const max = Number(capacity?.maxUsers || 0);
  els.capacitySummary.textContent = `${used} / ${max}`;
  els.capacityLabel.textContent = els.businessLine.value === "store" ? "应用商店账号" : "猫眼账号";
  els.resourceSummary.classList.toggle("hidden", els.businessLine.value !== "maoyan");
  els.btnEnterMonitor.classList.toggle("hidden", els.businessLine.value !== "maoyan");
  els.summary.textContent = `当前显示 ${accounts.length} 个账号`;
  els.btnLoadMore.classList.toggle("hidden", !nextAfter);
}

function renderAccounts() {
  renderAccountSummary();
  els.tbody.innerHTML = "";
  if (!accounts.length) return renderMessage("没有符合条件的账号");

  for (const account of accounts) {
    els.tbody.appendChild(renderAccountRow(account));
  }
}

function renderAccountRow(account) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent = account.remark || `自助申请 · ${account.userId.slice(0, 8)}`;
    const hint = document.createElement("small");
    hint.className = "muted account-hint";
    hint.textContent = `${account.keyHint || ""} · ${account.source || "-"}`;
    identity.append(title, hint, actionButton("编辑备注", "", () => editRemark(account)));

    const qualification = document.createElement("td");
    qualification.appendChild(badge(STATUS_LABEL[account.accountStatus] || account.accountStatus, account.accountStatus));
    const monitor = document.createElement("td");
    if (account.monitorState) {
      monitor.appendChild(badge(account.monitorState === "monitoring" ? "监控中" : "已停止", account.monitorState));
    } else {
      monitor.textContent = "-";
    }
    const expiry = document.createElement("td");
    expiry.textContent = fmtTime(account.expiresAt);
    const activity = document.createElement("td");
    activity.textContent = fmtTime(account.lastActivityAt);
    const operations = document.createElement("td");
    const operationsInner = document.createElement("div");
    operationsInner.className = "account-actions-inner";

    if (account.accountStatus === "active") {
      operationsInner.appendChild(actionButton("暂停", "", () => updateAccount(account, { state: "suspended" })));
    } else if (account.accountStatus === "suspended") {
      operationsInner.appendChild(actionButton("恢复", "", () => updateAccount(account, { state: "active" })));
    } else if (account.accountStatus === "expired") {
      operationsInner.appendChild(actionButton("续 15 天", "", () => updateAccount(account, { expiresAt: Date.now() + 15 * 86400000 })));
    }
    if (account.accountStatus !== "revoked") {
      operationsInner.appendChild(actionButton("撤销", "danger", () => revokeAccount(account)));
    }
    if (!operationsInner.children.length) operationsInner.textContent = "—";
    operations.appendChild(operationsInner);
    row.append(identity, qualification, monitor, expiry, activity, operations);
    return row;
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

async function updateAccount(account, patch, scope = captureBusinessScope()) {
  if (!isCurrentBusinessScope(scope) || (account.businessLine && account.businessLine !== scope.businessLine)) return;
  try {
    const data = await adminApi("/api/admin/accounts/update", {
      method: "POST",
      body: JSON.stringify({ id: account.userId, expectedVersion: account.accountVersion, patch })
    });
    if (!isCurrentBusinessScope(scope)) return;
    const index = accounts.findIndex((item) => item.userId === account.userId);
    if (index < 0 || !data.adminAccount) return;
    if (accounts[index].accountVersion > data.adminAccount.accountVersion) return;
    accounts[index] = data.adminAccount;
    capacity = data.capacity;
    els.tbody.replaceChild(renderAccountRow(data.adminAccount), els.tbody.children[index]);
    renderAccountSummary();
  } catch (error) {
    if (!isCurrentBusinessScope(scope)) return;
    showToast(`操作失败：${error.message}`, "error");
  }
}

async function editRemark(account) {
  const scope = captureBusinessScope();
  const value = prompt("编辑账号备注（最多 50 字，可留空）", account.remark || "");
  if (value === null) return;
  const remark = value.trim();
  if (remark.length > 50) return showToast("备注最多 50 字", "error");
  await updateAccount(account, { remark }, scope);
}

async function revokeAccount(account) {
  const scope = captureBusinessScope();
  const ok = await showConfirm(`确定撤销「${account.remark || account.userId}」？撤销后不能恢复。`, {
    title: "撤销账号", danger: true, okText: "撤销"
  });
  if (ok && isCurrentBusinessScope(scope)) await updateAccount(account, { state: "revoked" }, scope);
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
  const scope = captureBusinessScope();
  els.btnAdd.disabled = true;
  try {
    const created = await adminApi("/api/admin/accounts/create", {
      method: "POST",
      body: JSON.stringify({
        remark: els.remark.value.trim(),
        requestId: crypto.randomUUID(),
        businessLine: scope.businessLine
      })
    });
    if (!created.key) throw new Error("账号已创建，但访问密钥仅在首次响应显示");
    try { await copyText(created.key); } catch {}
    await showDialog(`访问密钥已复制，仅显示一次：\n\n${created.key}`, { title: "账号已创建", type: "success" });
    els.remark.value = "";
    if (isCurrentBusinessScope(scope)) await refreshAccounts({ reset: true, scope });
  } catch (error) {
    showToast(`新增失败：${error.message}`, "error");
  } finally {
    els.btnAdd.disabled = false;
  }
});

els.btnSaveSettings.addEventListener("click", async () => {
  if (!settings) return;
  const scope = captureBusinessScope();
  const currentSettings = settings;
  try {
    const data = await adminApi(`/api/admin/settings?businessLine=${encodeURIComponent(scope.businessLine)}`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: currentSettings.version,
        businessLine: scope.businessLine,
        maxUsers: Number(els.capacityMax.value),
        defaultValidDays: Number(els.validDays.value),
        publicSignupEnabled: els.publicSignup.checked
      })
    });
    if (!isCurrentBusinessScope(scope)) return;
    settings = data.settings;
    showToast("账号设置已保存", "success");
    await refreshAccounts({ reset: true, scope });
  } catch (error) {
    if (!isCurrentBusinessScope(scope)) return;
    showToast(`保存失败：${error.message}`, "error");
    await loadSettings(scope).catch(() => {});
  }
});

let searchTimer;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshAccounts({ reset: true }).catch((error) => showToast(error.message, "error")), 250);
});
els.statusFilter.addEventListener("change", () => refreshAccounts({ reset: true }).catch((error) => showToast(error.message, "error")));
els.businessLine.addEventListener("change", () => {
  businessGeneration += 1;
  const scope = captureBusinessScope();
  accounts = [];
  capacity = null;
  settings = null;
  nextAfter = null;
  Promise.all([refreshAccounts({ reset: true, scope }), loadSettings(scope)])
    .catch((error) => showToast(error.message, "error"));
});
els.btnRefresh.addEventListener("click", () => Promise.all([refreshAccounts({ reset: true }), loadSettings(), loadResources()]));
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
