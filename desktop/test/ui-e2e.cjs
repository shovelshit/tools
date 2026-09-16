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

async function applyStatusSummary(page, status) {
  const handler = async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        lockServiceEnabled: true,
        cronMinutes: 5,
        cronText: "Every 5 minutes",
        cronMinuteStep: true,
        status,
      }),
    });
  };
  await page.route("**/api/status?view=summary", handler);
  try {
    const response = page.waitForResponse((item) => item.url().includes("/api/status?view=summary") && item.status() === 200);
    await page.locator("#btn-refresh").click();
    await response;
    const main = status.enabled === false ? "已停止" : (status.lastError ? "检查异常" : "监控中");
    const detailCount = status.enabled === false ? 1 : 2;
    await page.waitForFunction(({ main, detailCount }) => {
      const line = document.querySelector("#status-line");
      return line?.textContent.includes(main) && line.querySelectorAll(".status-detail").length >= detailCount;
    }, { main, detailCount });
  } finally {
    await page.unroute("**/api/status?view=summary", handler);
  }
}

async function assertStatusVisibleAndUnclipped(page) {
  const status = page.locator("#status-line");
  assert.equal(await status.locator("span").last().isVisible(), true);
  const unclipped = await status.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert.equal(unclipped, true);
}

async function assertSeatViewportFit(page, name) {
  const layout = await page.evaluate(() => {
    const stage = document.querySelector(".lock-seat-scroll");
    const grid = document.querySelector("#lock-seat-grid");
    const seats = [...document.querySelectorAll("#lock-seat-grid [data-availability]")];
    const box = stage?.getBoundingClientRect();
    const gridBox = grid?.getBoundingClientRect();
    return {
      stage: box && { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      grid: gridBox && { width: gridBox.width, height: gridBox.height },
      seats: seats.map((seat) => {
        const rect = seat.getBoundingClientRect();
        return { seatNo: seat.dataset.seatNo, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      })
    };
  });
  assert.ok(layout.stage?.width > 0 && layout.stage?.height >= 200, `${name}: collapsed seat stage ${JSON.stringify(layout)}`);
  assert.ok(layout.grid?.width > 0 && layout.grid?.height > 0, `${name}: collapsed seat map ${JSON.stringify(layout)}`);
  assert.ok(layout.seats.length > 0, `${name}: no seats rendered`);
  for (const seat of layout.seats) {
    assert.ok(seat.left >= layout.stage.left - 1 && seat.top >= layout.stage.top - 1
      && seat.right <= layout.stage.right + 1 && seat.bottom <= layout.stage.bottom + 1,
    `${name}: seat outside fitted viewport ${JSON.stringify({ seat, stage: layout.stage })}`);
  }
  return layout;
}

async function assertLockShell(page, name) {
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    return { header: box(".lock-dialog-header"), body: box(".lock-dialog-body"), stage: box(".lock-seat-scroll"), footer: box(".lock-dialog-footer") };
  });
  assert.ok(layout.header && layout.body && layout.stage && layout.footer, `${name}: missing lock shell region`);
  assert.ok(layout.header.bottom <= layout.body.y + 1, `${name}: dialog header overlaps body ${JSON.stringify(layout)}`);
  assert.ok(layout.body.bottom <= layout.footer.y + 1, `${name}: dialog body overlaps footer ${JSON.stringify(layout)}`);
}

async function assertLockReachableAfterScroll(page, name) {
  const body = page.locator(".lock-dialog-body");
  for (const target of [".lock-seat-scroll", "#lock-section-risk", "#lock-risk-accepted", "#btn-lock-submit", "#btn-lock-cancel"]) {
    await page.locator(target).scrollIntoViewIfNeeded();
    const layout = await page.evaluate((selector) => {
      const get = (value) => {
        const rect = document.querySelector(value)?.getBoundingClientRect();
        return rect && { x: rect.x, left: rect.left, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const body = get(".lock-dialog-body");
      const target = get(selector);
      const footer = get(".lock-dialog-footer");
      const visible = (rect) => Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight);
      const inside = (rect, parent) => Boolean(rect && parent && rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1 && rect.left >= parent.left - 1 && rect.right <= parent.right + 1);
      return { body, target, footer, visible: visible(target), insideBody: inside(target, body), footerVisible: visible(footer), submitVisible: visible(get("#btn-lock-submit")) };
    }, target);
    assert.ok(layout.visible, `${name}: ${target} is not visible after scrolling ${JSON.stringify(layout)}`);
    assert.ok(layout.insideBody || target === "#btn-lock-submit" || target === "#btn-lock-cancel", `${name}: ${target} escaped the body viewport ${JSON.stringify(layout)}`);
    if (target === ".lock-seat-scroll") {
      assert.ok(layout.target.bottom <= layout.footer.y + 1, `${name}: seat viewport overlaps dialog footer after scrolling ${JSON.stringify(layout)}`);
    }
    assert.ok(layout.footerVisible && layout.submitVisible, `${name}: footer/submit not reachable while checking ${target} ${JSON.stringify(layout)}`);
  }
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

    await page.setViewportSize({ width: 1920, height: 1080 });
    const webWorkspace = await page.evaluate(() => {
      const workspace = document.querySelector(".app-workspace");
      const main = document.querySelector(".workflow-main");
      const footer = document.querySelector("[data-workflow-panel=\"2\"] .panel-actions");
      const title = document.querySelector(".title-block h1");
      const status = document.querySelector("#status-line");
      const form = document.querySelector("[data-workflow-panel=\"2\"] .panel-content");
      const fields = [...document.querySelectorAll("[data-workflow-panel=\"2\"] input, [data-workflow-panel=\"2\"] select")];
      const box = (element) => element?.getBoundingClientRect();
      const within = (child, parent) => {
        const childBox = box(child);
        const parentBox = box(parent);
        return Boolean(childBox && parentBox && childBox.left >= parentBox.left - 1 && childBox.right <= parentBox.right + 1
          && childBox.top >= parentBox.top - 1 && childBox.bottom <= parentBox.bottom + 1);
      };
      return {
        runtime: document.documentElement.dataset.runtime,
        workspace: box(workspace),
        transform: getComputedStyle(workspace).transform,
        titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
        statusSize: Number.parseFloat(getComputedStyle(status).fontSize),
        fieldHeights: fields.map((field) => Number.parseFloat(getComputedStyle(field).height)),
        footerInside: within(footer, main),
        fieldsInside: fields.every((field) => within(field, form)),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.equal(webWorkspace.runtime, "web");
    assert.ok(webWorkspace.workspace.width > 1120 && webWorkspace.workspace.width <= 1400, JSON.stringify(webWorkspace));
    assert.ok(webWorkspace.workspace.height > 620 && webWorkspace.workspace.height <= 775, JSON.stringify(webWorkspace));
    assert.equal(webWorkspace.transform, "none");
    assert.equal(webWorkspace.titleSize, 17);
    assert.equal(webWorkspace.statusSize, 14);
    assert.ok(webWorkspace.fieldHeights.every((height) => height === 40), JSON.stringify(webWorkspace));
    assert.equal(webWorkspace.footerInside, true, JSON.stringify(webWorkspace));
    assert.equal(webWorkspace.fieldsInside, true, JSON.stringify(webWorkspace));
    assert.ok(webWorkspace.overflow <= 1, JSON.stringify(webWorkspace));

    await page.setViewportSize({ width: 1200, height: 700 });
    const compactWeb = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      bodyOverflow: document.body.scrollWidth - innerWidth,
      workspaceHeight: document.querySelector(".app-workspace")?.getBoundingClientRect().height || 0,
    }));
    assert.ok(compactWeb.overflow <= 1 && compactWeb.bodyOverflow <= 1, JSON.stringify(compactWeb));
    assert.ok(compactWeb.workspaceHeight > 0 && compactWeb.workspaceHeight <= 652, JSON.stringify(compactWeb));

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
    const channel = await page.locator(".channel-opts").boundingBox();
    const key = await page.locator("#serverchan-input").boundingBox();
    assert.ok(Math.abs(channel.x - key.x) <= 1, "channel and key left edges differ");
    await page.locator("#serverchan-input").fill("SCTmockkey");
    await page.locator("#btn-test-push").click();
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor")?.disabled === false);
    await page.locator("#btn-toggle-monitor").click();
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor")?.textContent === "停止监控");
    await applyStatusSummary(page, { enabled: true, lastCheck: "2026-09-17T10:00:00.000Z", lastError: null });
    assert.match(await page.locator("#status-line").textContent(), /预计下批次/);
    assert.equal(await page.locator("#status-line .status-main").count(), 1);
    assert.ok(await page.locator("#status-line .status-detail").count() >= 2);
    await assertStatusVisibleAndUnclipped(page);
    const longError = "通知服务返回了超长错误信息，必须完整换行显示，<strong>不能生成元素</strong>，不能被顶栏操作按钮挤掉或截断";
    await applyStatusSummary(page, { enabled: true, lastCheck: "2026-09-17T10:00:00.000Z", lastError: longError });
    assert.match(await page.locator("#status-line").textContent(), new RegExp(longError));
    assert.equal(await page.locator("#status-line .status-error").count(), 1);
    assert.equal(await page.locator("#status-line strong").count(), 0);
    await assertStatusVisibleAndUnclipped(page);
    await applyStatusSummary(page, { enabled: false, lastCheck: null, lastError: null });
    const stoppedStatus = await page.locator("#status-line").textContent();
    assert.match(stoppedStatus, /已停止.*上次检查 从未/);
    assert.doesNotMatch(stoppedStatus, /预计下批次/);
    await assertStatusVisibleAndUnclipped(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await applyStatusSummary(page, { enabled: true, lastCheck: "2026-09-17T10:00:00.000Z", lastError: longError });
    await assertStatusVisibleAndUnclipped(page);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(mobileOverflow <= 1, `monitor status overflows at 320px: ${mobileOverflow}`);
    await page.screenshot({ path: path.join(outputDirectory, "monitor-status-error-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator("#btn-lock-seats").click();
    await page.waitForFunction(() => !document.querySelector("#lock-overlay")?.classList.contains("hidden"));
    await assertLockShell(page, "lock shell before loading");
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
    const initialSeatStage = await assertSeatViewportFit(page, "wide hall initial fit");
    const initialZoom = await page.locator("#lock-zoom-label").textContent();
    assert.ok(Number.parseInt(initialZoom, 10) < 40, `wide hall retained the old 40% floor: ${initialZoom}`);
    await page.locator("#lock-template").selectOption("901");
    await page.waitForFunction(() => document.querySelectorAll("#lock-seat-grid [data-availability]").length === 150);
    await assertSeatViewportFit(page, "tall hall show change");
    await page.locator("#lock-template").selectOption("902");
    await page.waitForFunction(() => document.querySelectorAll("#lock-seat-grid [data-availability]").length === 7);
    const sparseStage = await assertSeatViewportFit(page, "sparse hall show change");
    const sparseOffsets = await page.evaluate(() => {
      const first = document.querySelector('[data-seat-no="1-7-16"]')?.getBoundingClientRect();
      const last = document.querySelector('[data-seat-no="1-30-16"]')?.getBoundingClientRect();
      return { first: first && { left: first.left, top: first.top }, last: last && { left: last.left, top: last.top } };
    });
    assert.ok(sparseOffsets.last.left > sparseOffsets.first.left, `sparse physical offsets collapsed: ${JSON.stringify(sparseOffsets)}`);
    assert.equal(sparseStage.stage.height, initialSeatStage.stage.height, "seat stage height changed across maps");
    await page.locator("#btn-lock-zoom-in").click();
    const manualZoom = await page.locator("#lock-zoom-label").textContent();
    assert.notEqual(manualZoom, initialZoom);
    await page.evaluate(() => document.querySelector('[data-seat-no="1-1-1"]')?.click());
    await page.evaluate(() => document.querySelector("#btn-refresh")?.click());
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#lock-zoom-label").textContent(), manualZoom, "manual zoom reset after seat selection or status refresh");
    await page.setViewportSize({ width: 1024, height: 760 });
    assert.equal(await page.locator("#lock-zoom-label").textContent(), manualZoom, "manual zoom reset on resize");
    await page.locator("#btn-lock-zoom-reset").click();
    await page.waitForTimeout(50);
    await assertSeatViewportFit(page, "explicit fit command");
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator("#lock-template").selectOption("900");
    await page.waitForFunction(() => document.querySelectorAll("#lock-seat-grid [data-availability]").length === 360);
    await assertSeatViewportFit(page, "wide hall fit after resize");
    await page.locator("#lock-official-toggle").check();
    await page.waitForFunction(() => document.querySelector("#lock-official-frame")?.hasAttribute("srcdoc"));
    assert.match(await page.locator("#lock-official-frame").getAttribute("srcdoc"), /seats-block/);
    await page.screenshot({ path: path.join(outputDirectory, "lock-official-desktop.png"), fullPage: true });
    await page.locator("#lock-official-toggle").uncheck();
    assert.equal(await page.locator("#lock-official-frame").getAttribute("srcdoc"), null);
    await page.screenshot({ path: path.join(outputDirectory, "lock-desktop.png"), fullPage: true });
    // Hold a seat request open and assert the loading state before resolving it.
    let resolveLoadingRequest;
    let loadingRequestStarted;
    const loadingStarted = new Promise((resolve) => { loadingRequestStarted = resolve; });
    const loadingRelease = new Promise((resolve) => { resolveLoadingRequest = resolve; });
    await page.route("**/api/lock/template-seats?*", async (route) => {
      loadingRequestStarted();
      await loadingRelease;
      await route.continue();
    });
    await page.locator("#lock-template").selectOption("901");
    await loadingStarted;
    await page.waitForFunction(() => /正在加载座位表/.test(document.querySelector("#lock-seat-grid")?.textContent || "")
      && document.querySelector("#lock-seat-grid .spinner"));
    assert.equal(await page.locator("#lock-seat-grid .spinner").isVisible(), true, "seat loading spinner is not visible");
    resolveLoadingRequest();
    await page.waitForFunction(() => document.querySelectorAll("#lock-seat-grid [data-availability]").length === 150);
    await page.unroute("**/api/lock/template-seats?*");
    await page.setViewportSize({ width: 390, height: 844 });
    const lockOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(lockOverflow <= 1, `lock dialog overflow: ${lockOverflow}`);
    await page.screenshot({ path: path.join(outputDirectory, "lock-mobile.png"), fullPage: true });
    // Exercise the inferred-seat risk/error state with a deterministic failed seat request.
    await page.locator("#lock-target-date").fill("2026-09-30");
    await page.waitForFunction(() => document.querySelector("#lock-section-risk")?.offsetParent !== null);
    await page.route("**/api/lock/template-seats?*", (route) => route.abort());
    await page.locator("#lock-template").selectOption("900");
    await page.waitForFunction(() => /座位表加载失败/.test(document.querySelector("#lock-seat-grid")?.textContent || ""));
    await page.unroute("**/api/lock/template-seats?*");
    for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
      await page.setViewportSize(viewport);
      const lockHidden = await page.locator("#lock-overlay").evaluate((element) => element.classList.contains("hidden"));
      if (lockHidden) {
        await page.locator("#btn-lock-seats").click();
        await page.waitForFunction(() => !document.querySelector("#lock-overlay")?.classList.contains("hidden"));
      }
      await page.locator("#lock-target-date").fill("2026-09-30");
      await page.waitForFunction(() => document.querySelector("#lock-section-risk")?.offsetParent !== null);
      const label = `lock reachability ${viewport.width}x${viewport.height}`;
      await assertLockShell(page, label);
      await assertLockReachableAfterScroll(page, label);
      await page.screenshot({ path: path.join(outputDirectory, `lock-reachability-${viewport.width}x${viewport.height}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.screenshot({ path: path.join(outputDirectory, "lock-short-1024x600.png"), fullPage: true });
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
