const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const { createAccountEnv } = await import("../../worker/test/account-fixtures.js");
  const { handleEnrollmentApi } = await import("../../worker/src/maoyan/enrollment-api.js");
  const { default: worker } = await import("../../worker/src/index.js");
  const env = await createAccountEnv({ maxUsers: 2 });
  const assets = path.resolve(__dirname, "../../worker/public");
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw new Error("Supply an absolute screenshot directory");
  await fs.mkdir(output, { recursive: true });
  let origin, verification = true, edgeIp = "192.0.2.10", blockConfirm = false;
  const reserves = [];
  env.TURNSTILE_SITE_KEY = "local-integration-site";
  env.TURNSTILE_SECRET_KEY = "local-integration-secret";
  await env.DB.prepare("UPDATE service_settings SET public_signup_enabled=1 WHERE id=1").run();
  env.ASSETS = { async fetch(request) {
    let pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/")) pathname += "index.html";
    if (pathname === "/maoyan/claim") pathname += ".html";
    const file = path.resolve(assets, `.${pathname}`);
    if (!file.startsWith(assets + path.sep)) return new Response("Not found", { status: 404 });
    try {
      const bytes = await fs.readFile(file);
      const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".webp": "image/webp" }[path.extname(file)];
      return new Response(bytes, { headers: { "Content-Type": type || "application/octet-stream" } });
    } catch { return new Response("Not found", { status: 404 }); }
  } };
  const handler = async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const request = new Request(url, { method: req.method, headers: { ...req.headers, "CF-Connecting-IP": edgeIp }, ...(body.length ? { body } : {}) });
      if (url.pathname.endsWith("/reserve")) reserves.push(JSON.parse(body));
      let response;
      if (url.pathname === "/api/enrollment/confirm" && blockConfirm) response = Response.json({ error: "test unavailable" }, { status: 503 });
      else if (url.pathname === "/api/releases") response = Response.json({ assets: [] });
      else response = await handleEnrollmentApi(request, env, url, { fetchImpl: async () => Response.json({
        success: verification, hostname: "127.0.0.1", action: "enroll", challenge_ts: new Date().toISOString()
      }) }) || await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  };
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  env.ENROLLMENT_ORIGIN = origin;
  env.ENROLLMENT_HOSTNAME = "127.0.0.1";
  env.PUBLIC_WEB_URL = `${origin}/maoyan/`;
  const browser = await chromium.launch({ executablePath: process.env.MAOYAN_E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const failures = [];
  async function claimPage() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    // Only the external challenge is substituted; fingerprint, APIs and SQL remain real.
    await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", (route) => route.fulfill({ contentType: "text/javascript", body:
      'window.turnstile={render(selector,options){window.testChallenge=options; options.callback("integration-token")}};'
    }));
    await page.goto(`${origin}/maoyan/claim`);
    return page;
  }
  const count = async () => Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='user'").first()).n);
  try {
    const page = await claimPage();
    await page.locator("#btn-claim:enabled").waitFor();
    await page.evaluate(() => window.testChallenge["expired-callback"]());
    assert.equal(await page.locator("#btn-claim").isDisabled(), true);
    await page.evaluate(() => window.testChallenge.callback("integration-token"));
    verification = false;
    await page.click("#btn-claim");
    await page.locator("#claim-error:not(.hidden)").waitFor();
    assert.equal(await count(), 0);
    assert.equal(await page.locator("#claim-error-text").innerText(), "当前暂不可领取，请稍后重试");
    console.log("PASS expired challenge disables claim; rejected verification creates no account and hides details");

    verification = true;
    await page.click("#btn-claim-retry");
    await page.locator("#btn-claim:enabled").waitFor();
    blockConfirm = true;
    await page.click("#btn-claim");
    await page.locator("#claim-error:not(.hidden)").waitFor();
    assert.equal(await count(), 0);
    blockConfirm = false;
    await page.reload();
    await page.locator("#claim-active:not(.hidden)").waitFor();
    const key = await page.locator("#claim-key").innerText();
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(await count(), 1);
    const account = await env.DB.prepare("SELECT created_at,expires_at FROM users WHERE role='user'").first();
    assert.equal(account.expires_at - account.created_at, 15 * 86400000);
    assert.equal(await page.evaluate((secret) => JSON.stringify(localStorage).includes(secret), key), false);
    await page.screenshot({ path: path.join(output, "claim-success.png") });
    console.log("PASS reservation survives failed confirmation and refresh; account activated for 15 days; key stored encrypted");

    const identity = reserves.at(-1);
    const duplicate = await page.evaluate(async (input) => {
      const response = await fetch("/api/enrollment/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId: crypto.randomUUID() }) });
      return { status: response.status, body: await response.json() };
    }, identity);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "FINGERPRINT_IN_USE");
    assert.equal(await count(), 1);
    edgeIp = "198.51.100.20";
    await page.click("#btn-enter-web");
    await page.locator("#main-page:not(.hidden)").waitFor();
    await page.reload();
    await page.locator("#main-page:not(.hidden)").waitFor();
    console.log("PASS duplicate fingerprint denied; claimed key logs into monitor after IP change and refresh");

    const otherWorker = http.createServer(handler);
    await new Promise((resolve) => otherWorker.listen(0, "127.0.0.1", resolve));
    try {
      const otherOrigin = `http://127.0.0.1:${otherWorker.address().port}`;
      const crossContext = await browser.newContext();
      const crossPage = await crossContext.newPage();
      crossPage.on("dialog", (dialog) => dialog.accept());
      await crossPage.goto(`${origin}/maoyan/`);
      await crossPage.fill("#worker-url", otherOrigin);
      await crossPage.fill("#token-input", key);
      await crossPage.click("#btn-connect");
      await crossPage.locator("#main-page:not(.hidden)").waitFor();
      await crossPage.reload();
      await crossPage.locator("#main-page:not(.hidden)").waitFor();
      assert.equal(await crossPage.evaluate(() => localStorage.getItem("workerUrl")), otherOrigin);
      await crossContext.close();
      console.log("PASS separate-origin custom Worker login and refresh with production CORS/CSP");
    } finally {
      await new Promise((resolve) => { otherWorker.close(resolve); otherWorker.closeAllConnections(); });
    }

    const pending = await page.evaluate(async () => Promise.all(["a", "b", "c"].map(async (seed) => {
      const requestId = crypto.randomUUID();
      const response = await fetch("/api/enrollment/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, fingerprint: seed.repeat(32), version: "thumbmark-1.11.0-v1", turnstileToken: "integration-token" }) });
      return { requestId, status: response.status, body: await response.json() };
    })));
    assert.equal(pending.filter((r) => r.status === 201).length, 1);
    assert.equal(pending.filter((r) => r.status === 503).length, 2);
    const winner = pending.find((r) => r.status === 201);
    const full = await claimPage();
    await full.locator("#claim-unavailable:not(.hidden)").waitFor();
    assert.equal(await full.locator("#btn-claim").isVisible(), false);
    const confirm = await page.evaluate(async (w) => {
      const response = await fetch("/api/enrollment/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Token": w.body.key }, body: JSON.stringify({ requestId: w.requestId }) });
      return response.status;
    }, winner);
    assert.equal(confirm, 200);
    assert.equal(await count(), 2);
    console.log("PASS three concurrent claims for final slot yield one winner; full page is disabled; final reservation can confirm");
    if (process.argv.includes("--live-turnstile")) {
      await env.DB.prepare("UPDATE service_settings SET max_users=3 WHERE id=1").run();
      env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
      const liveContext = await browser.newContext();
      const livePage = await liveContext.newPage();
      await livePage.goto(`${origin}/maoyan/claim`);
      await livePage.locator("#btn-claim:enabled").waitFor({ timeout: 45000 });
      const token = await livePage.evaluate(() => window.turnstile.getResponse());
      assert.equal(token, "XXXX.DUMMY.TOKEN.XXXX");
      await livePage.screenshot({ path: path.join(output, "claim-official-turnstile.png") });
      console.log("PASS official Turnstile test widget enables claim and supplies sandbox token in Chrome");
    }
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    env.DB.sqlite.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
