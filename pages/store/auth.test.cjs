const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function load(fetchImpl) {
  const events = [];
  const window = { fetch: fetchImpl };
  window.window = window;
  window.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => events.push(event);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "auth.js"), "utf8"), { window, globalThis: window });
  return { ...window.StoreAuth, events };
}

test("catalog starts only after Store login and logout invalidates in-flight work", async () => {
  const listing = deferred();
  let catalogRequests = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url === "/store/auth/session" && options.method === "POST") {
      return { ok: true, json: async () => ({ ok: true, account: { userId: "store-user", accountStatus: "active" } }) };
    }
    if (url === "/store/auth/logout") return { ok: true, json: async () => ({ ok: true }) };
    if (url === "/store/api/fs/list") { catalogRequests += 1; return listing.promise; }
    return { ok: false, status: 401, json: async () => ({ code: "UNAUTHORIZED" }) };
  };
  const auth = load(fetchImpl);
  const controller = auth.createController({ fetchImpl });

  assert.equal(catalogRequests, 0);
  await controller.login("store-key");
  assert.equal(controller.isAuthenticated(), true);
  const generation = controller.generation();
  const pending = fetchImpl("/store/api/fs/list").then(async (response) => {
    const data = await response.json();
    return controller.isCurrent(generation) ? data : null;
  });
  assert.equal(catalogRequests, 1);

  await controller.logout();
  listing.resolve({ ok: true, json: async () => ({ content: [{ name: "stale.apk" }] }) });
  assert.equal(await pending, null);
  assert.equal(controller.isAuthenticated(), false);
  assert.deepEqual(auth.events.map((event) => event.type), ["store:authenticated", "store:unauthenticated"]);
});

test("a stale login reply cannot restore a session after logout", async () => {
  const login = deferred();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "/store/auth/session") return login.promise;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const auth = load(fetchImpl);
  const controller = auth.createController({ fetchImpl });
  const pending = controller.login("store-key");
  const loggingOut = controller.logout();
  await Promise.resolve();
  assert.deepEqual(calls, ["/store/auth/session"]);
  login.resolve({ ok: true, json: async () => ({ ok: true, account: { accountStatus: "active" } }) });
  await Promise.all([pending, loggingOut]);
  assert.deepEqual(calls, ["/store/auth/session", "/store/auth/logout"]);
  assert.equal(controller.isAuthenticated(), false);
  assert.equal(auth.events.at(-1).type, "store:unauthenticated");
});

test("access failures invalidate missing sessions and restore expired account metadata", async () => {
  let session = { accountStatus: "active", version: 1 };
  const fetchImpl = async (url, options = {}) => {
    if (url === "/store/auth/session" && options.method === "POST") {
      return { ok: true, json: async () => ({ ok: true, account: session }) };
    }
    if (url === "/store/auth/session") {
      return { ok: true, json: async () => ({ ok: true, account: session }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const auth = load(fetchImpl);
  const controller = auth.createController({ fetchImpl });
  await controller.login("store-key");
  controller.handleAccessFailure(401);
  assert.equal(controller.isAuthenticated(), false);

  session = { accountStatus: "expired", version: 2 };
  await controller.handleAccessFailure(403);
  assert.equal(controller.isAuthenticated(), false);
  assert.equal(controller.account().accountStatus, "expired");
  assert.equal(auth.events.at(-1).detail.account.version, 2);
});
