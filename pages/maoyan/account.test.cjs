const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load() {
  const window = {};
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "account.js"), "utf8"), { window });
  return window;
}

test("expired credentials remain available for renewal", () => {
  const { normalizeAccountConnection: normalize } = load();
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
  const { normalizeAccountConnection: normalize } = load();
  assert.equal(normalize({ account: { role: "user", accountStatus: "revoked" }, capabilities: { accountLifecycle: true } }).shouldForgetKey, true);
  assert.equal(normalize({ account: null, capabilities: { accountLifecycle: true } }).shouldForgetKey, true);
});

test("legacy workers remain monitor-capable", () => {
  const { normalizeAccountConnection: normalize } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(normalize({ capabilities: { accountLifecycle: false } }))), {
    canRenew: false,
    shouldForgetKey: false,
    canMonitor: true
  });
});

test("account status presentation distinguishes expiry, suspension and partial resume", () => {
  const { accountStatusPresentation: present } = load();
  assert.equal(present({ account: { accountStatus: "expired" } }).action, "renew");
  assert.match(present({ account: { accountStatus: "suspended" } }).text, /暂停/);
  assert.deepEqual(JSON.parse(JSON.stringify(present({
    resume: { monitor: true, lock: false, reasons: ["session_unavailable"] }
  }))), {
    visible: true,
    tone: "warning",
    text: "账号已续期，监控已恢复；锁座仍需重新登录猫眼。",
    action: "session"
  });
});
