const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { startMockWorker } = require("./support/worker.cjs");
const { startWebFixture } = require("./support/web.cjs");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function chromeExecutable() {
  const candidates = [
    process.env.MAOYAN_E2E_CHROME,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "",
    process.platform === "linux" ? "/usr/bin/google-chrome" : "",
    process.platform === "linux" ? "/usr/bin/chromium" : "",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function screenshot(page, directory, name, width, height) {
  await page.setViewportSize({ width, height });
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `${name} overflows: ${JSON.stringify(dimensions)}`);
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

async function assertCatalogClearsHeader(page) {
  const bounds = await page.evaluate(() => ({
    headerBottom: document.querySelector(".header").getBoundingClientRect().bottom,
    accountBottom: document.querySelector("#store-account").getBoundingClientRect().bottom,
    catalogTop: document.querySelector(".layout").getBoundingClientRect().top,
  }));
  assert.ok(bounds.accountBottom <= bounds.headerBottom, `account controls overflow header: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.catalogTop >= bounds.headerBottom, `catalog overlaps header: ${JSON.stringify(bounds)}`);
}

async function login(page, key) {
  await page.locator("#store-key").fill(key);
  await page.locator("#store-login-submit").click();
}

async function main() {
  const requestedOutput = argument("--output");
  if (!requestedOutput || !path.isAbsolute(requestedOutput)) throw new Error("--output must be an absolute directory outside the repository");
  const output = path.resolve(requestedOutput);
  fs.mkdirSync(output, { recursive: true });
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error("Chrome/Chromium not found; set MAOYAN_E2E_CHROME to an executable path");

  const worker = await startMockWorker();
  const web = await startWebFixture({ workerUrl: worker.url });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${web.url}/store/`);
    await page.evaluate(() => localStorage.setItem("workerUrl", "maoyan-profile"));
    assert.equal(worker.store.catalogRequests, 0);
    await screenshot(page, output, "store-login-desktop", 1200, 900);
    await screenshot(page, output, "store-login-mobile", 390, 844);

    const pendingLogin = worker.deferNextStoreLogin();
    await page.evaluate(() => {
      window.__storeRaceController = window.StoreAuth.createController();
      window.__storeRaceLogin = window.__storeRaceController.login("store-token");
    });
    await pendingLogin.started;
    await page.evaluate(() => {
      window.__storeRaceLogout = window.__storeRaceController.logout();
    });
    await page.waitForTimeout(50);
    pendingLogin.release();
    await page.evaluate(() => Promise.all([window.__storeRaceLogin, window.__storeRaceLogout]));
    assert.equal((await context.cookies(web.url)).some((cookie) => cookie.name === "store_session"), false);
    assert.equal(await page.evaluate(() => fetch("/store/auth/session").then((response) => response.status)), 401);

    await login(page, "expired-store-token");
    await page.locator("#store-renew").waitFor({ state: "visible" });
    await screenshot(page, output, "store-expired", 390, 844);
    await page.locator("#store-renew").click();
    await page.locator(".file-card").waitFor();
    assert.ok(worker.store.catalogRequests >= 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("workerUrl")), "maoyan-profile");
    await screenshot(page, output, "store-catalog-desktop", 1200, 900);
    await screenshot(page, output, "store-catalog-mobile", 390, 844);
    await assertCatalogClearsHeader(page);

    const staleDetail = worker.deferNextStoreDetail();
    await page.evaluate(() => openDetail("/CarMax/stale.apk", false));
    await staleDetail.started;
    await page.locator("#store-header-logout").evaluate((button) => button.click());
    await page.locator("#store-login-form").waitFor({ state: "visible" });
    await login(page, "store-token");
    await page.locator(".file-card").waitFor();
    await page.evaluate(() => openDetail("/CarMax/fresh.apk", false));
    await page.locator(".download-btn").waitFor();
    assert.match(await page.locator(".download-btn").getAttribute("href"), /fresh\.apk/);
    staleDetail.release();
    await page.waitForTimeout(50);
    assert.match(await page.locator(".download-btn").getAttribute("href"), /fresh\.apk/);

    await page.evaluate(() => openDetail("/CarMax/first.txt", false));
    await page.locator(".preview-btn").waitFor();
    const stalePreview = worker.deferNextStoreFile();
    await page.locator(".preview-btn").click();
    await stalePreview.started;
    await page.evaluate(() => loadPreview("txt", "http://appstore.cnmlynk.org/second.txt"));
    await page.evaluate(() => loadPreview("txt", "http://appstore.cnmlynk.org/second.txt"));
    await page.locator(".preview-txt").waitFor();
    assert.match(await page.locator(".preview-txt").textContent(), /second\.txt preview/);
    stalePreview.release();
    await page.waitForTimeout(50);
    assert.match(await page.locator(".preview-txt").textContent(), /second\.txt preview/);
    await page.evaluate(() => closeModal());

    worker.setStoreMode("empty");
    await page.locator("#refreshBtn").click();
    await page.locator(".empty-state").waitFor();
    await screenshot(page, output, "store-empty", 1200, 900);

    worker.setStoreMode("error");
    await page.locator("#refreshBtn").click();
    await page.locator(".error-banner").waitFor();
    await screenshot(page, output, "store-error", 1200, 900);

    worker.setStoreMode("normal");
    const pending = worker.deferNextStoreList();
    const before = worker.store.catalogRequests;
    await page.locator("#refreshBtn").click();
    await page.waitForFunction((count) => window.__unused === undefined && document.querySelector("#refreshBtn").classList.contains("loading"), before);
    assert.equal(worker.store.catalogRequests, before + 1);
    await page.locator("#store-header-logout").click();
    pending.release();
    await page.locator("#store-login-form").waitFor({ state: "visible" });
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#fileGrid").textContent(), "");
    assert.equal(worker.store.account, null);
    assert.deepEqual(errors, []);
    await context.close();

    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({
      ok: true,
      executablePath,
      catalogRequests: worker.store.catalogRequests,
      screenshots: fs.readdirSync(output).filter((name) => name.endsWith(".png")).sort()
    }, null, 2));
    console.log(`Store UI E2E passed with ${executablePath}; screenshots: ${output}`);
  } finally {
    await browser.close();
    await web.close();
    await worker.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
