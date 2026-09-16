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
  const configured = process.env.MAOYAN_E2E_CHROME;
  const candidates = [
    configured,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "",
    process.platform === "linux" ? "/usr/bin/google-chrome" : "",
    process.platform === "linux" ? "/usr/bin/chromium" : "",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function assertDarkTheme(page, panelSelector) {
  const colors = await page.locator(panelSelector).evaluate((panel) => {
    const components = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const pageColor = components(getComputedStyle(document.body).backgroundColor);
    const panelColor = components(getComputedStyle(panel).backgroundColor);
    const textColor = components(getComputedStyle(panel).color);
    return {
      page: pageColor.slice(0, 3),
      panel: panelColor.slice(0, 3),
      panelAlpha: panelColor[3] ?? 1,
      text: textColor.slice(0, 3),
    };
  });
  assert.ok(Math.max(...colors.page) < 70, `page background is not dark: ${JSON.stringify(colors)}`);
  assert.ok(Math.max(...colors.panel) < 90, `panel background is not dark: ${JSON.stringify(colors)}`);
  assert.ok(colors.panelAlpha > 0.5, `panel background is too transparent: ${JSON.stringify(colors)}`);
  assert.ok(Math.min(...colors.text) > 190, `panel text is not light enough: ${JSON.stringify(colors)}`);
}

async function assertCinemaBackground(page) {
  const background = await page.locator(".ambient-cinema").evaluate((image) => ({
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    objectFit: getComputedStyle(image).objectFit,
    opacity: Number(getComputedStyle(image).opacity),
  }));
  assert.equal(background.complete, true, JSON.stringify(background));
  assert.ok(background.naturalWidth >= 1920, JSON.stringify(background));
  assert.equal(background.objectFit, "cover", JSON.stringify(background));
  assert.ok(background.opacity >= 0.5, JSON.stringify(background));
}

async function snapshotLayout(page, name, width, outputDirectory) {
  await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button:not(.hidden), input:not(.hidden), select:not(.hidden)")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => ({ id: element.id, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    const progress = document.querySelector(".workflow-progress")?.getBoundingClientRect();
    const panel = document.querySelector(".workflow-main")?.getBoundingClientRect();
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      progress: progress && { left: progress.left, right: progress.right, top: progress.top, bottom: progress.bottom },
      panel: panel && { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      controls,
    };
  });
  assert.ok(layout.documentWidth <= layout.viewport + 1, `${name} document overflow at ${width}: ${JSON.stringify(layout)}`);
  assert.ok(layout.bodyWidth <= layout.viewport + 1, `${name} body overflow at ${width}: ${JSON.stringify(layout)}`);
  const p = layout.progress;
  const m = layout.panel;
  const overlap = p && m && p.left < m.right && p.right > m.left && p.top < m.bottom && p.bottom > m.top;
  assert.equal(Boolean(overlap), false, `${name} progress overlaps panel at ${width}: ${JSON.stringify(layout)}`);
  for (const control of layout.controls) {
    assert.ok(control.width > 0 && control.height > 0, `${name} collapsed control ${control.id} at ${width}`);
  }
  await page.screenshot({ path: path.join(outputDirectory, `${name}-${width}.png`), fullPage: true });
  return layout;
}

async function main() {
  const outputDirectory = path.resolve(argument("--output") || "");
  if (!argument("--output") || !path.isAbsolute(argument("--output"))) throw new Error("--output must be an absolute directory outside the repository");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error("Chrome/Chromium not found; set MAOYAN_E2E_CHROME to an executable path");

  const worker = await startMockWorker();
  const web = await startWebFixture({ workerUrl: worker.url });
  const browser = await chromium.launch({ executablePath, headless: true });
  const results = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${web.url}/maoyan/index.html`);
    await page.locator("#worker-url").fill(`${web.url}/one`);
    await page.locator("#token-input").fill("one-token");
    await page.locator("#btn-connect").click();
    try {
      await page.waitForFunction(() => !document.querySelector("#main-page")?.classList.contains("hidden"), null, { timeout: 8000 });
    } catch {
      const diagnostics = await page.evaluate(() => ({
        loginError: document.querySelector("#login-error")?.textContent,
        loginHint: document.querySelector("#login-hint")?.textContent,
        worker: document.querySelector("#worker-url")?.value,
        connectDisabled: document.querySelector("#btn-connect")?.disabled,
      }));
      throw new Error(`Web connection did not complete: ${JSON.stringify({ diagnostics, errors })}`);
    }
    await page.waitForFunction(() => document.querySelector('[data-workflow-panel="2"]')?.getAttribute("aria-hidden") === "false");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await assertDarkTheme(page, ".workflow-main");
    await assertCinemaBackground(page);

    for (const width of [1440, 1200, 1024, 768, 390, 320]) {
      results.push(await snapshotLayout(page, "monitor", width, outputDirectory));
    }

    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator("#city-input").fill("上海");
    await page.locator("#city-dropdown .suggest-item").filter({ hasText: "上海" }).click();
    await page.locator("#cinema-search").fill("寰映");
    await page.locator("#btn-search-cinema").click();
    await page.locator("#cinema-dropdown .suggest-item").filter({ hasText: "寰映影城" }).click();
    await page.locator("#movie-list input[type=checkbox]").first().check();
    await page.locator("#btn-step-movie-next").click();
    await page.locator("#push-channel-row label").filter({ hasText: "Server酱" }).click();
    await page.locator("#serverchan-input").fill("SCTmockkey");
    await page.locator("#btn-test-push").click();
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor")?.disabled === false);
    await page.locator("#btn-toggle-monitor").click();
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor")?.textContent === "停止监控");
    await page.locator("#btn-lock-seats").click();
    await page.waitForFunction(() => !document.querySelector("#lock-overlay")?.classList.contains("hidden"));
    await page.locator("#lock-target-date").fill("2026-09-19");
    await page.waitForFunction(() => document.querySelector("#lock-template")?.value === "900");
    try {
      await page.waitForFunction(() => document.querySelectorAll("#lock-seat-grid [data-availability]").length > 0, null, { timeout: 8000 });
    } catch {
      const lockDiagnostics = await page.evaluate(() => ({
        grid: document.querySelector("#lock-seat-grid")?.textContent,
        source: document.querySelector("#lock-seat-source")?.textContent,
        session: document.querySelector("#lock-session-state")?.textContent,
        movie: document.querySelector("#lock-movie")?.value,
        template: document.querySelector("#lock-template")?.value,
        date: document.querySelector("#lock-target-date")?.value,
      }));
      throw new Error(`Seat map did not load: ${JSON.stringify({ lockDiagnostics, requests: worker.requests })}`);
    }
    await page.locator("#lock-official-toggle").check();
    await page.waitForFunction(() => document.querySelector("#lock-official-frame")?.hasAttribute("srcdoc"));
    assert.match(await page.locator("#lock-official-frame").getAttribute("srcdoc"), /seats-block/);
    await page.screenshot({ path: path.join(outputDirectory, "lock-official-desktop.png"), fullPage: true });
    await page.locator("#lock-official-toggle").uncheck();
    assert.equal(await page.locator("#lock-official-frame").getAttribute("srcdoc"), null);
    await page.screenshot({ path: path.join(outputDirectory, "lock-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const lockOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(lockOverflow <= 1, `lock dialog overflow: ${lockOverflow}`);
    await page.screenshot({ path: path.join(outputDirectory, "lock-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();

    const claim = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await claim.goto(`${web.url}/maoyan/claim.html`);
    await claim.waitForFunction(() => !document.querySelector("#claim-full")?.classList.contains("hidden"));
    await assertDarkTheme(claim, ".claim-panel");
    const claimOverflow = await claim.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(claimOverflow <= 1, `claim page overflow: ${claimOverflow}`);
    await claim.screenshot({ path: path.join(outputDirectory, "claim-mobile.png"), fullPage: true });
    await claim.close();

    const admin = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await admin.goto(`${web.url}/maoyan/admin.html`);
    await assertDarkTheme(admin, ".login-card");
    await admin.screenshot({ path: path.join(outputDirectory, "admin-login-desktop.png"), fullPage: true });
    await admin.close();

    fs.writeFileSync(path.join(outputDirectory, "results.json"), JSON.stringify({ ok: true, executablePath, viewports: results.map(({ viewport }) => viewport) }, null, 2));
    console.log(`UI E2E passed with ${executablePath}; screenshots: ${outputDirectory}`);
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
