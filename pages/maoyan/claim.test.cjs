const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaimController } = require("./claim.js");
const fs = require("node:fs");
const path = require("node:path");

function fixture(overrides = {}) {
  const values = new Map();
  const calls = [];
  const states = [];
  const controller = createClaimController({
    workerUrl: "https://worker.test",
    collectFingerprint: async () => ({ fingerprint: "f".repeat(32), version: "thumbmark-1.11.0-v1" }),
    secureGet: async (key) => values.get(key) || "",
    secureSet: async (key, value) => { calls.push(value ? `save:${key}` : `delete:${key}`); value ? values.set(key, value) : values.delete(key); },
    api: async (path) => {
      calls.push(path);
      if (path.endsWith("/reserve")) return { key: "k".repeat(64), reservationId: "r", expiresAt: Date.now() + 300000 };
      if (path.endsWith("/confirm")) return { account: { userId: "u", accountStatus: "active", expiresAt: Date.now() + 1296000000 } };
      if (path === "/api/auth/session") return { account: null };
      throw new Error(`unexpected ${path}`);
    },
    onState: (state) => states.push(state),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
    ...overrides
  });
  return { controller, calls, states, values };
}

test("claim saves the received key before confirmation and removes pending last", async () => {
  const { controller, calls } = fixture();
  await controller.start("test-turnstile");
  const pendingSave = calls.findIndex((item) => item.startsWith("save:claim-pending:"));
  const confirm = calls.indexOf("/api/enrollment/confirm");
  const activeSave = calls.findIndex((item) => item.startsWith("save:token:"));
  const pendingDelete = calls.findIndex((item) => item.startsWith("delete:claim-pending:"));
  assert.ok(pendingSave >= 0 && pendingSave < confirm);
  assert.ok(confirm < activeSave && activeSave < pendingDelete);
});

test("double click shares one in-flight enrollment", async () => {
  let releases;
  let reserveCalls = 0;
  const wait = new Promise((resolve) => { releases = resolve; });
  const { controller } = fixture({
    api: async (path) => {
      if (path.endsWith("/reserve")) { reserveCalls += 1; await wait; return { key: "k".repeat(64), expiresAt: Date.now() + 300000 }; }
      if (path.endsWith("/confirm")) return { account: { accountStatus: "active" } };
      return { account: null };
    }
  });
  const first = controller.start("token");
  const second = controller.start("token");
  releases();
  await Promise.all([first, second]);
  assert.equal(reserveCalls, 1);
});

test("storage failure keeps the one-time key visible and still confirms", async () => {
  const states = [];
  const { controller } = fixture({
    secureGet: async () => "",
    secureSet: async () => { throw new Error("storage blocked"); },
    onState: (state) => states.push(state)
  });
  await controller.start("token");
  const active = states.at(-1);
  assert.equal(active.name, "active");
  assert.equal(active.ephemeral, true);
  assert.equal(active.key, "k".repeat(64));
});

test("refresh resumes a pending key without reserving another account", async () => {
  let reserveCalls = 0;
  const pending = JSON.stringify({ requestId: "123e4567-e89b-42d3-a456-426614174000", key: "k".repeat(64), reservationExpiresAt: Date.now() + 300000 });
  const { controller, states } = fixture({
    secureGet: async (key) => key.startsWith("claim-pending:") ? pending : "",
    api: async (path) => {
      if (path.endsWith("/reserve")) reserveCalls += 1;
      if (path.endsWith("/confirm")) return { account: { accountStatus: "active" } };
      return { account: null };
    }
  });
  await controller.restorePending();
  assert.equal(reserveCalls, 0);
  assert.equal(states.at(-1).name, "active");
});

test("an existing active profile key prevents accidental replacement", async () => {
  let reserveCalls = 0;
  const { controller, states } = fixture({
    secureGet: async (key) => key.startsWith("token:") ? "existing" : "",
    api: async (path, options) => {
      if (path === "/api/auth/session" && options.token === "existing") return { account: { accountStatus: "active" } };
      if (path.endsWith("/reserve")) reserveCalls += 1;
      throw new Error("unexpected");
    }
  });
  await controller.start("token");
  assert.equal(reserveCalls, 0);
  assert.equal(states.at(-1).existing, true);
});

test("claim page stays compact and loads fingerprint code locally", () => {
  const html = fs.readFileSync(path.join(__dirname, "claim.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "claim.css"), "utf8");
  assert.match(html, /vendor\/thumbmark\.umd\.js/);
  assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg/);
  assert.match(css, /width:\s*min\(520px, calc\(100% - 32px\)\)/);
  assert.match(css, /@media \(pointer:\s*coarse\)[\s\S]*min-height:\s*44px/);
  assert.doesNotMatch(css, /font-size:\s*clamp\(/);
});
