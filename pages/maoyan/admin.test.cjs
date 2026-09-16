const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
  assert.match(source, /expectedVersion: settings\.version/);
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
