const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "admin.js"), "utf8");
const style = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");

test("failure diagnostics start collapsed and have a bounded scrolling area", () => {
  assert.match(html, /<details class="notification-diagnostics">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(style, /\.notification-diagnostics[^}]*max-height:\s*320px/s);
});

test("admin page manages lifecycle accounts instead of custom plaintext tokens", () => {
  assert.match(html, /id="account-tbody"/);
  assert.match(html, /id="capacity-max"/);
  assert.match(html, /id="default-valid-days"/);
  assert.match(html, /id="public-signup-enabled"/);
  assert.doesNotMatch(html, /id="new-token-value"/);
  assert.match(source, /\/api\/admin\/accounts/);
  assert.match(source, /\/api\/admin\/settings/);
  assert.doesNotMatch(source, /body\.token/);
});

test("admin mutations carry optimistic versions and never put the admin token in a URL", () => {
  assert.match(source, /expectedVersion: account\.accountVersion/);
  assert.match(source, /expectedVersion: currentSettings\.version/);
  assert.match(source, /\/api\/auth\/session/);
  assert.match(source, /data\.monitorSession/);
  assert.match(html, /id="btn-enter-monitor"/);
  assert.match(source, /btnEnterMonitor\.addEventListener/);
  assert.match(source, /secureSet\(`token:\$\{encodeURIComponent\(profile\)\}`/);
  assert.doesNotMatch(source, /searchParams\.set\([^,]+,\s*adminToken/);
  assert.doesNotMatch(source, /[?&](?:adminToken|token)=/);
});

test("one-time managed keys are shown only from the create response", () => {
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /created\.key/);
  assert.match(source, /copyText\(created\.key\)/);
  assert.match(source, /仅显示一次/);
});

test("resource summary is compact and refreshes only with explicit admin loads", () => {
  assert.match(html, /id="resource-cinemas"/);
  assert.match(html, /id="resource-admission"/);
  assert.match(source, /\/api\/admin\/resources/);
  assert.doesNotMatch(source, /setInterval/);
});

test("unmeasured resource usage permits enrollment while explicit exhaustion keeps it closed", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  const load = vm.runInContext("loadResources()", context);
  resolveJson(requests.at(-1), { resources: { admissionAllowed: true, usage: {} } });
  await load;
  assert.equal(elements.get("resource-admission").textContent, "可申请");
  assert.equal(elements.get("resource-note").textContent, "未配置用量指标不阻止申请；仅明确耗尽阻止申请");

  const exhausted = vm.runInContext("loadResources()", context);
  resolveJson(requests.at(-1), {
    resources: { admissionAllowed: false, usage: { workerRequests: { measured: true } } }
  });
  await exhausted;
  assert.equal(elements.get("resource-admission").textContent, "保持关闭");
});

test("admin UI scopes accounts and settings by an immutable business selection", () => {
  assert.match(html, /id="account-business-line"/);
  assert.match(html, /value="maoyan"/);
  assert.match(html, /value="store"/);
  assert.match(source, /businessLine/);
  assert.match(source, /params\.set\("businessLine"/);
  assert.match(source, /\/api\/admin\/settings\?businessLine=/);
  assert.match(source, /if \(account\.monitorState\)/);
  assert.match(source, /monitor\.textContent = "-"/);
  assert.doesNotMatch(source, /patch[^\n]+businessLine/);
});

test("account operation cells preserve table layout and render an empty-state placeholder", () => {
  const { context, elements } = loadAdminWithDeferredRequests();
  vm.runInContext(`accounts = [
    { userId: "active-1", remark: "Active", source: "manual", accountStatus: "active", accountVersion: 1, expiresAt: "2026-10-01T00:00:00Z" },
    { userId: "suspended-1", remark: "Suspended", source: "manual", accountStatus: "suspended", accountVersion: 1, expiresAt: "2026-10-01T00:00:00Z" },
    { userId: "expired-1", remark: "Expired", source: "manual", accountStatus: "expired", accountVersion: 1, expiresAt: "2026-09-01T00:00:00Z" },
    { userId: "revoked-1", remark: "Revoked", source: "manual", accountStatus: "revoked", accountVersion: 2, expiresAt: "2026-10-01T00:00:00Z" }
  ]; capacity = { used: 1, maxUsers: 20 }; renderAccounts();`, context);

  const rows = elements.get("account-tbody").children;
  assert.equal(rows.length, 4);
  const activeOperations = rows[0].children[5];
  assert.equal(rows[0].tagName, "TR");
  assert.equal(activeOperations.tagName, "TD");
  assert.equal(activeOperations.className, "");
  assert.equal(activeOperations.children.length, 1);
  assert.equal(activeOperations.children[0].tagName, "DIV");
  assert.equal(activeOperations.children[0].className, "account-actions-inner");
  assert.equal(activeOperations.children[0].children.length, 2);

  assert.equal(rows[1].children[5].children[0].children.length, 2);
  assert.equal(rows[2].children[5].children[0].children.length, 2);

  const revokedOperations = rows[3].children[5];
  assert.equal(revokedOperations.className, "");
  assert.equal(revokedOperations.children.length, 1);
  assert.equal(revokedOperations.children[0].tagName, "DIV");
  assert.equal(revokedOperations.children[0].className, "account-actions-inner");
  assert.equal(revokedOperations.children[0].textContent, "—");
});

test("mobile action cells provide enough room and wrap buttons without clipping", () => {
  assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.admin-page \.token-table th:nth-child\(1\),[\s\S]*?\.admin-page \.token-table td:nth-child\(1\) \{ width: 34%; \}/);
  assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.admin-page \.token-table th:nth-child\(2\),[\s\S]*?\.admin-page \.token-table td:nth-child\(2\) \{ width: 19%; \}/);
  assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.admin-page \.token-table th:nth-child\(4\),[\s\S]*?\.admin-page \.token-table td:nth-child\(4\) \{ width: 25%; \}/);
  assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.admin-page \.token-table th:nth-child\(6\),[\s\S]*?\.admin-page \.token-table td:nth-child\(6\) \{ width: 22%; \}/);
  const narrowRules = style.slice(style.indexOf("@media (max-width: 640px)"), style.indexOf("@media (max-width: 430px)"));
  assert.doesNotMatch(narrowRules, /\.admin-page \.token-table (?:th|td):nth-child\((?:1|2|4)\)/);
  assert.match(narrowRules, /\.admin-page \.account-actions-inner \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(narrowRules, /\.admin-page \.account-actions-inner \.link-btn \{[\s\S]*?min-width: 0;[\s\S]*?width: 100%;/);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("notification diagnostics render localized states and separate errors as safe text", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  const load = vm.runInContext("loadResources()", context);
  resolveJson(requests.at(-1), { resources: { usage: {}, notificationFailures: [
    { kind: "lock-terminal", state: "pending", attempts: 1, retryEligible: true, lastError: "<img onerror=alert(1)>", failureDetail: '{"status":403}' },
    { kind: "lock-terminal", state: "sending", attempts: 2, retryEligible: true },
    { kind: "lock-terminal", state: "sent", attempts: 3, retryEligible: false, failureDetail: "lock error" },
    { kind: "lock-terminal", state: "failed", attempts: 4, retryEligible: false, lastError: "delivery error" }
  ] } });
  await load;
  const details = elements.get("resource-failure-details");
  assert.match(details.textContent, /待发送/);
  assert.match(details.textContent, /发送中/);
  assert.match(details.textContent, /通知状态：已发送/);
  assert.match(details.textContent, /发送失败/);
  assert.match(details.textContent, /尝试 1 次/);
  assert.match(details.textContent, /可自动重试/);
  assert.match(details.textContent, /不再重试/);
  assert.match(details.textContent, /通知发送错误：<img onerror=alert\(1\)>/);
  assert.match(details.textContent, /锁座失败详情：/);
  assert.equal(details.innerHTML, "");
});

test("captured HTTP diagnostics show readable headers and body without executing markup", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  const load = vm.runInContext("loadResources()", context);
  resolveJson(requests.at(-1), { resources: { usage: {}, notificationFailures: [
    { kind: "new-shows", state: "sent", attempts: 1, failureDetail: JSON.stringify({
      httpStatus: 403, headers: { "content-type": "text/html", "cf-ray": "trace-1" },
      responseBody: "Access Denied\n<script>alert(1)</script>", bodyTruncated: true
    }) },
    { kind: "account-expiry", state: "failed", attempts: 1, failureDetail: "legacy failure" }
  ] } });
  await load;
  const details = elements.get("resource-failure-details");
  assert.match(details.textContent, /HTTP 状态：403/);
  assert.match(details.textContent, /content-type: text\/html\ncf-ray: trace-1/);
  assert.match(details.textContent, /响应体：\nAccess Denied\n<script>alert\(1\)<\/script>/);
  assert.match(details.textContent, /响应体已截断/);
  assert.match(details.textContent, /新场次通知/);
  assert.match(details.textContent, /账号到期通知/);
  assert.match(details.textContent, /legacy failure/);
  assert.equal(details.innerHTML, "");
});

function fakeElement() {
  const listeners = new Map();
  const classes = new Set(["hidden"]);
  let html = "";
  return {
    tagName: "DIV",
    value: "", textContent: "", checked: false, disabled: false, children: [],
    className: "",
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
      contains: (name) => classes.has(name)
    },
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    dispatch(type) {
      return Promise.all((listeners.get(type) || []).map((listener) => listener({ preventDefault() {} })));
    },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChild(node, old) { this.children[this.children.indexOf(old)] = node; return old; },
    select() {}, remove() {},
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); this.children = []; }
  };
}

test("account updates replace only their row and retain filters and pagination", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  vm.runInContext(`accounts = [
    { userId: "one", remark: "First", businessLine: "maoyan", accountStatus: "active", accountVersion: 1 },
    { userId: "two", remark: "Second", businessLine: "maoyan", accountStatus: "active", accountVersion: 1 }
  ]; nextAfter = "next-page"; renderAccounts();`, context);
  elements.get("account-search").value = "First";
  elements.get("account-status-filter").value = "active";
  const otherRow = elements.get("account-tbody").children[1];
  const update = vm.runInContext('updateAccount(accounts[0], { state: "suspended" })', context);
  resolveJson(requests[0], { adminAccount: { userId: "one", remark: "First", businessLine: "maoyan", accountStatus: "suspended", accountVersion: 2 }, capacity: { used: 1, maxUsers: 20 } });
  await new Promise(setImmediate);
  assert.equal(requests.length, 1, "must not request a replacement list");
  await update;
  assert.equal(elements.get("account-tbody").children[1], otherRow);
  assert.equal(elements.get("account-tbody").children[0].children[1].children[0].textContent, "已暂停");
  assert.equal(vm.runInContext("nextAfter", context), "next-page");
  assert.equal(elements.get("account-search").value, "First");
  assert.equal(elements.get("account-status-filter").value, "active");
  assert.equal(elements.get("capacity-summary").textContent, "1 / 20");
});

test("remark editing trims, allows clearing, and rejects more than 50 characters", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  vm.runInContext('accounts = [{ userId: "abcdefgh-more", remark: "", accountStatus: "active", accountVersion: 1 }]; renderAccounts()', context);
  assert.match(elements.get("account-tbody").children[0].children[0].children[0].textContent, /自助申请.*abcdefgh/);
  context.prompt = () => "x".repeat(51);
  await vm.runInContext("editRemark(accounts[0])", context);
  assert.equal(requests.length, 0);
  context.prompt = () => null;
  await vm.runInContext("editRemark(accounts[0])", context);
  assert.equal(requests.length, 0);
  context.prompt = () => "   ";
  const edit = vm.runInContext("editRemark(accounts[0])", context);
  assert.equal(JSON.parse(requests[0].options.body).patch.remark, "");
  resolveJson(requests[0], { adminAccount: { userId: "abcdefgh-more", remark: "", accountStatus: "active", accountVersion: 2 }, capacity: { used: 1, maxUsers: 20 } });
  await edit;
});

test("version conflicts leave existing rows and pagination intact", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  vm.runInContext('accounts = [{ userId: "one", remark: "Name", accountStatus: "active", accountVersion: 1 }]; nextAfter = "cursor"; renderAccounts()', context);
  const row = elements.get("account-tbody").children[0];
  const update = vm.runInContext('updateAccount(accounts[0], { remark: "Changed" })', context);
  requests[0].pending.resolve({ ok: false, status: 409, json: async () => ({ code: "VERSION_CONFLICT", error: "账号状态已变化" }) });
  await update;
  assert.equal(requests.length, 1);
  assert.equal(elements.get("account-tbody").children[0], row);
  assert.equal(vm.runInContext("nextAfter", context), "cursor");
});

test("account update responses cannot overwrite a different business list", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  vm.runInContext('accounts = [{ userId: "one", businessLine: "maoyan", accountStatus: "active", accountVersion: 1 }]; renderAccounts()', context);
  const update = vm.runInContext('updateAccount(accounts[0], { state: "suspended" })', context);
  elements.get("account-business-line").value = "store";
  vm.runInContext('businessGeneration += 1; accounts = [{ userId: "store-one", businessLine: "store", remark: "Store", accountStatus: "active", accountVersion: 1 }]; renderAccounts()', context);
  const row = elements.get("account-tbody").children[0];
  resolveJson(requests[0], { adminAccount: { userId: "one", businessLine: "maoyan", accountStatus: "suspended", accountVersion: 2 }, capacity: { used: 0, maxUsers: 20 } });
  await update;
  assert.equal(elements.get("account-tbody").children[0], row);
  assert.equal(vm.runInContext("accounts[0].userId", context), "store-one");
});

function loadAdminWithDeferredRequests() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: (tagName) => Object.assign(fakeElement(), { tagName: String(tagName).toUpperCase() }),
    execCommand: () => true,
    body: fakeElement()
  };
  document.getElementById("account-business-line").value = "maoyan";
  const requests = [];
  const context = vm.createContext({
    document,
    location: { hostname: "ltools.asia", origin: "https://ltools.asia", href: "https://ltools.asia/maoyan/admin.html" },
    localStorage: { getItem: () => "", setItem() {} },
    navigator: {},
    fetch(url, options = {}) {
      const pending = deferred();
      requests.push({ url: String(url), options, pending });
      return pending.promise;
    },
    URL, URLSearchParams, crypto, setTimeout, clearTimeout,
    secureGet: async () => "", secureSet: async () => {},
    showToast() {}, showDialog: async () => {}, showConfirm: async () => true
  });
  vm.runInContext(source, context);
  return { context, elements, requests };
}

function resolveJson(request, data) {
  request.pending.resolve({ ok: true, status: 200, json: async () => data });
}

test("rapid business switching rejects stale account and settings responses", async () => {
  const { context, elements, requests } = loadAdminWithDeferredRequests();
  const maoyanAccounts = vm.runInContext("refreshAccounts({ reset: true })", context);
  const maoyanSettings = vm.runInContext("loadSettings()", context);

  const selector = elements.get("account-business-line");
  selector.value = "store";
  await selector.dispatch("change");
  assert.equal(requests.length, 4);

  const find = (kind, line) => requests.find(({ url }) =>
    url.includes(kind) && url.includes(`businessLine=${line}`));
  resolveJson(find("/accounts?", "store"), {
    accounts: [{ userId: "store-1", remark: "Apps", businessLine: "store", accountStatus: "active", accountVersion: 1 }],
    capacity: { used: 1, maxUsers: 20 }, nextAfter: null
  });
  resolveJson(find("/settings?", "store"), {
    settings: { version: 20, maxUsers: 20, defaultValidDays: 15, publicSignupEnabled: false }
  });
  await new Promise((resolve) => setImmediate(resolve));

  resolveJson(find("/accounts?", "maoyan"), {
    accounts: [{ userId: "cinema-1", remark: "Cinema", businessLine: "maoyan", accountStatus: "active", accountVersion: 1 }],
    capacity: { used: 9, maxUsers: 10 }, nextAfter: null
  });
  resolveJson(find("/settings?", "maoyan"), {
    settings: { version: 10, maxUsers: 10, defaultValidDays: 30, publicSignupEnabled: true }
  });
  await Promise.all([maoyanAccounts, maoyanSettings]);
  await new Promise((resolve) => setImmediate(resolve));

  const state = JSON.parse(vm.runInContext("JSON.stringify({ accounts, capacity, settings })", context));
  assert.deepEqual(state.accounts.map(({ businessLine, remark }) => ({ businessLine, remark })), [
    { businessLine: "store", remark: "Apps" }
  ]);
  assert.deepEqual(state.capacity, { used: 1, maxUsers: 20 });
  assert.equal(state.settings.version, 20);
  assert.equal(elements.get("capacity-max").value, 20);

  const requestCount = requests.length;
  await vm.runInContext(`updateAccount({
    userId: "cinema-1", businessLine: "maoyan", accountStatus: "active", accountVersion: 1
  }, { state: "suspended" })`, context);
  assert.equal(requests.length, requestCount);
});
