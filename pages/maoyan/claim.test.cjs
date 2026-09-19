const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaimController } = require("./claim.js");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fakeElement() {
  const classes = new Set(["hidden"]);
  return {
    textContent: "", href: "", disabled: false,
    classList: {
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); }
    },
    addEventListener() {},
    append() {}
  };
}

async function loadClaimPage(config, { restorePending = async () => false, fetchError = null } = {}) {
  const elements = new Map();
  const turnstileScripts = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: () => fakeElement(),
    head: {
      append(script) {
        turnstileScripts.push(script);
        script.onload();
      }
    }
  };
  const window = {
    turnstile: { render() {} },
    createClaimController: () => ({ restorePending }),
    secureGet: async () => "", secureSet: async () => ""
  };
  const context = {
    window, document,
    location: { origin: "https://worker.test", href: "https://worker.test/maoyan/claim.html", reload() {} },
    fetch: async () => {
      if (fetchError) throw fetchError;
      return { ok: true, json: async () => config };
    },
    localStorage: { setItem() {} },
    URL, navigator: { clipboard: { writeText: async () => {} } }
  };
  const source = fs.readFileSync(path.join(__dirname, "claim-page.js"), "utf8");
  await vm.runInNewContext(source, context, { filename: "claim-page.js" });
  return { elements, turnstileScripts };
}

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

test("generic unavailable reserve responses stay in the unavailable state without recovery", async () => {
  let statusCalls = 0;
  const { controller, states } = fixture({
    api: async (path) => {
      if (path.endsWith("/reserve")) {
        const error = new Error("当前暂不可领取");
        error.code = "SERVICE_UNAVAILABLE";
        error.status = 503;
        throw error;
      }
      if (path.includes("/status?")) statusCalls += 1;
      throw new Error(`unexpected ${path}`);
    }
  });
  assert.equal(await controller.start("token"), null);
  assert.equal(states.at(-1).name, "unavailable");
  assert.equal(statusCalls, 0);
});

test("claim page stays compact and loads fingerprint code locally", () => {
  const html = fs.readFileSync(path.join(__dirname, "claim.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "claim.css"), "utf8");
  assert.match(html, /\/api\/assets\/thumbmark\.umd\.js\?v=1\.11\.0/);
  assert.doesNotMatch(html, /claim-downloads/);
  assert.doesNotMatch(html, /src="vendor\/thumbmark\.umd\.js/);
  assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg/);
  assert.match(css, /width:\s*min\(520px, calc\(100% - 32px\)\)/);
  assert.match(css, /@media \(pointer:\s*coarse\)[\s\S]*min-height:\s*44px/);
  assert.doesNotMatch(css, /font-size:\s*clamp\(/);
});

test("unclaimable enrollment never loads Turnstile and shows only the generic unavailable view", async () => {
  const page = await loadClaimPage({
    enabled: true, claimable: false, validDays: 15,
    capacity: { remaining: 1, maxUsers: 2 }, turnstileSiteKey: "site"
  });
  const html = fs.readFileSync(path.join(__dirname, "claim.html"), "utf8");
  assert.equal(page.turnstileScripts.length, 0);
  assert.equal(page.elements.get("claim-unavailable").classList.contains("hidden"), false);
  assert.match(html, /id="claim-unavailable"[\s\S]*当前暂不可领取/);
});

test("a pending reservation is not restored while pending confirmation is unavailable", async () => {
  let restoreCalls = 0;
  const page = await loadClaimPage({
    enabled: true, claimable: true, pendingConfirmable: false, validDays: 15,
    capacity: { remaining: 1, maxUsers: 2 }, turnstileSiteKey: "site"
  }, {
    restorePending: async () => { restoreCalls += 1; return false; }
  });
  assert.equal(restoreCalls, 0);
  assert.equal(page.turnstileScripts.length, 0);
  assert.equal(page.elements.get("claim-unavailable").classList.contains("hidden"), false);
});

test("claim failures never show database or component diagnostics to visitors", async () => {
  const page = await loadClaimPage(null, { fetchError: new Error("D1_ERROR: no such table: service_settings") });
  assert.equal(page.elements.get("claim-error-text").textContent, "当前暂不可领取，请稍后重试");
});
