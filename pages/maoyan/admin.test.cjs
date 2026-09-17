const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "admin.js"), "utf8");
const style = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");

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
    select() {}, remove() {},
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); this.children = []; }
  };
}

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
