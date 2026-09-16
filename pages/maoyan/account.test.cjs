const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load() {
  const window = {};
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "account.js"), "utf8"), { window });
  return window.normalizeAccountConnection;
}

test("expired credentials remain available for renewal", () => {
  const normalize = load();
  const info = normalize({
    account: { userId: "u", role: "user", accountStatus: "expired", expiresAt: 1 },
    capabilities: { accountLifecycle: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(info)), {
    canRenew: true,
    shouldForgetKey: false,
    canMonitor: false
  });
});

test("revoked or unknown lifecycle identities are forgotten", () => {
  const normalize = load();
  assert.equal(normalize({ account: { role: "user", accountStatus: "revoked" }, capabilities: { accountLifecycle: true } }).shouldForgetKey, true);
  assert.equal(normalize({ account: null, capabilities: { accountLifecycle: true } }).shouldForgetKey, true);
});

test("legacy workers remain monitor-capable", () => {
  const normalize = load();
  assert.deepEqual(JSON.parse(JSON.stringify(normalize({ capabilities: { accountLifecycle: false } }))), {
    canRenew: false,
    shouldForgetKey: false,
    canMonitor: true
  });
});
