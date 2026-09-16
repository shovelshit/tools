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
      window.__storeRaceController = window.StoreAuth.createController({ dispatch: () => {} });
      window.__storeRaceLogin = window.__storeRaceController.login("store-token");
    });
    await pendingLogin.started;
    await page.evaluate(() => {
      window.__storeRaceLogout = window.__storeRaceController.logout();
    });
    await page.waitForTimeout(50);
    pendingLogin.release();
    await page.evaluate(() => Promise.all([window.__storeRaceLogin, window.__storeRaceLogout]));
    assert.equal((await context.cookies(`${web.url}/store/`)).some((cookie) => cookie.name === "store_session"), false);
    assert.equal(await page.evaluate(() => fetch("/store/auth/session").then((response) => response.status)), 401);

    const pendingLogout = worker.deferNextStoreLogout();
    await page.evaluate(() => {
      window.__storeReverseRaceController = window.StoreAuth.createController({ dispatch: () => {} });
      window.__storeReverseRaceLogout = window.__storeReverseRaceController.logout();
    });
    await pendingLogout.started;
    await page.evaluate(() => {
      window.__storeReverseRaceLogin = window.__storeReverseRaceController.login("store-token");
    });
    await page.waitForTimeout(50);
    pendingLogout.release();
    await page.evaluate(() => Promise.all([window.__storeReverseRaceLogout, window.__storeReverseRaceLogin]));
    assert.equal((await context.cookies(`${web.url}/store/`)).some((cookie) => cookie.name === "store_session"), true);
    assert.equal(await page.evaluate(() => fetch("/store/auth/session").then((response) => response.status)), 200);

    const staleInitial = worker.deferNextStoreList();
    const beforeStaleInitial = worker.store.catalogRequests;
    await login(page, "store-token");
    await staleInitial.started;
    await page.locator("#store-header-logout").evaluate((button) => button.click());
    await page.locator("#store-login-form").waitFor({ state: "visible" });
    await login(page, "store-token");
    await page.locator("#store-app").waitFor({ state: "visible" });
    await page.waitForTimeout(50);
    assert.equal(worker.store.catalogRequests, beforeStaleInitial + 3);
    staleInitial.release();
    await page.locator(".file-card").waitFor();
    await page.waitForTimeout(50);
    assert.equal(worker.store.catalogRequests, beforeStaleInitial + 3);

    await page.locator("#store-header-logout").click();
    await page.locator("#store-login-form").waitFor({ state: "visible" });
    const stalePreload = worker.deferNextStoreList({ path: "/CarMax/实用工具", total: 99 });
    await login(page, "store-token");
    await stalePreload.started;
    await page.evaluate(() => openLightbox("http://appstore.cnmlynk.org/stale.png", "stale caption"));
    await page.locator("#store-header-logout").evaluate((button) => button.click());
    await page.locator("#store-login-form").waitFor({ state: "visible" });
    assert.deepEqual(await page.locator(".menu-badge").allTextContents(), ["", ""]);
    assert.equal(await page.locator("#lightbox").getAttribute("class"), "lightbox");
    assert.equal(await page.locator("#lightboxImg").getAttribute("src"), null);
    assert.equal(await page.locator("#lightboxImg").getAttribute("alt"), "");
    assert.equal(await page.locator("#lightboxCaption").textContent(), "");
    await login(page, "store-token");
    await page.locator(".file-card").waitFor();
    await page.waitForFunction(() => document.querySelector("#badge-1").textContent === "1");
    stalePreload.release();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#badge-1").textContent(), "1");
    await page.locator("#store-header-logout").click();
    await page.locator("#store-login-form").waitFor({ state: "visible" });

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

    const staleAuthFailure = worker.deferNextStoreDetailAuthFailure();
    await page.evaluate(() => {
      window.__staleAuthDetail = openDetail("/CarMax/stale-auth.apk", false);
    });
    await staleAuthFailure.started;
    await page.locator("#store-header-logout").evaluate((button) => button.click());
    await page.locator("#store-login-form").waitFor({ state: "visible" });
    await login(page, "store-token");
    await page.locator(".file-card").waitFor();
    await page.evaluate(() => openDetail("/CarMax/fresh-auth.apk", false));
    await page.locator(".download-btn").waitFor();
    assert.match(await page.locator(".download-btn").getAttribute("href"), /fresh-auth\.apk/);
    const staleFailureResponse = page.waitForResponse((response) =>
      response.url().includes("/store/api/fs/get") && response.status() === 401
    );
    staleAuthFailure.release();
    await staleFailureResponse;
    await page.evaluate(() => window.__staleAuthDetail);
    assert.equal(await page.locator("#store-app").isVisible(), true);
    assert.equal(await page.locator("#store-auth").isVisible(), false);
    assert.equal(await page.evaluate(() => fetch("/store/auth/session").then((response) => response.status)), 200);
    assert.match(await page.locator(".download-btn").getAttribute("href"), /fresh-auth\.apk/);

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
