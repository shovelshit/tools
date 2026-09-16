const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "admin.js"), "utf8");

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
    createElement: () => fakeElement(),
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
