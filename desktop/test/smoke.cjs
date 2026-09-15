const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { _electron: electron } = require("playwright-core");
const { startMockWorker } = require("./support/worker.cjs");

async function main() {
  const packaged = process.argv.includes("--packaged");
  const desktop = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-smoke-"));
  const screenshotDirectory = path.join(desktop, "dist");
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const worker = await startMockWorker();
  let application;
  try {
    let executablePath;
    if (packaged) {
      executablePath = process.platform === "darwin"
        ? path.join(desktop, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Maoyan Monitor.app", "Contents", "MacOS", "Maoyan Monitor")
        : path.join(desktop, "dist", "win-unpacked", "Maoyan Monitor.exe");
      assert.ok(fs.existsSync(executablePath), `Packaged executable missing: ${executablePath}`);
    } else executablePath = require("electron");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath, args: [...(packaged ? [] : [desktop]), `--user-data-dir=${directory}`], env, timeout: 60000 });
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => window.maoyanRuntime?.kind === "electron");
    const mainPageUrl = page.url();
    assert.match(page.url(), /file:.*\/pages\/maoyan\/index\.html$/);
    if (packaged) assert.match(page.url(), /app\.asar\/pages\/maoyan\/index\.html$/);
    assert.deepEqual(await page.evaluate(() => ({ node: typeof require, process: typeof process, cookieApi: typeof window.maoyanElectron.cookies, tokenApi: typeof window.maoyanElectron.getToken })), { node: "undefined", process: "undefined", cookieApi: "undefined", tokenApi: "undefined" });
    await page.locator("#worker-url").fill(worker.url + "/one");
    await page.locator("#token-input").fill("one-token");
    await page.locator("#btn-connect").click();
    await page.waitForFunction((url) => document.querySelector("#worker-profile").textContent.includes(url), worker.url + "/one");
    await page.waitForFunction(() => document.querySelector("#block-overlay")?.classList.contains("hidden") ?? true);
    assert.equal(await page.locator("#main-page").isVisible(), true);
    assert.equal(await page.locator("#ambient-background").count(), 1);
    assert.equal(await page.locator("[data-workflow-step]").count(), 4);
    assert.equal(await page.locator(".workflow-shell > .glass-panel").count(), 2);
    await page.locator('[data-workflow-step="1"]').click();
    assert.equal(await page.locator("#main-page").isVisible(), true);
    assert.equal(await page.locator('[data-workflow-panel="1"]').getAttribute("aria-hidden"), "false");
    await page.locator("#btn-step-connection-next").click();
    const desktopLayout = await page.evaluate(() => {
      const workspace = document.querySelector(".app-workspace").getBoundingClientRect();
      const progress = document.querySelector(".workflow-progress").getBoundingClientRect();
      const main = document.querySelector(".workflow-main").getBoundingClientRect();
      const sceneBar = document.querySelector(".scene-bar").getBoundingClientRect();
      const plate = getComputedStyle(document.querySelector(".ambient-plate"));
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        workspace: { left: workspace.left, right: workspace.right, width: workspace.width, height: workspace.height },
        sceneBarHeight: sceneBar.height,
        progress: { left: progress.left, right: progress.right },
        main: { left: main.left, right: main.right },
        animationName: plate.animationName,
        animationDuration: plate.animationDuration,
      };
    });
    assert.ok(desktopLayout.workspace.width <= desktopLayout.viewportWidth * 0.72);
    assert.ok(desktopLayout.workspace.height <= desktopLayout.viewportHeight * 0.8);
    assert.ok(desktopLayout.sceneBarHeight <= 50);
    assert.ok(Math.abs(desktopLayout.workspace.left - (desktopLayout.viewportWidth - desktopLayout.workspace.right)) < 2);
    assert.ok(desktopLayout.progress.right < desktopLayout.main.left);
    assert.notEqual(desktopLayout.animationName, "none");
    assert.match(desktopLayout.animationDuration, /1[4-9]s/);

    await page.evaluate(() => document.documentElement.classList.remove("motion-paused"));
    const motionBefore = await page.evaluate(() => ({
      plate: getComputedStyle(document.querySelector(".ambient-plate")).transform,
      main: document.querySelector(".workflow-main").getBoundingClientRect().toJSON(),
    }));
    await page.waitForTimeout(700);
    const motionAfter = await page.evaluate(() => ({
      plate: getComputedStyle(document.querySelector(".ambient-plate")).transform,
      main: document.querySelector(".workflow-main").getBoundingClientRect().toJSON(),
    }));
    assert.notEqual(motionBefore.plate, motionAfter.plate);
    assert.deepEqual(motionBefore.main, motionAfter.main);
    await page.evaluate(() => document.documentElement.classList.add("motion-paused"));
    assert.equal(await page.locator(".ambient-plate").first().evaluate((element) => getComputedStyle(element).animationPlayState), "paused");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".ambient-plate").first().evaluate((element) => getComputedStyle(element).animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => document.documentElement.classList.remove("motion-paused"));

    for (const viewport of [{ width: 1024, height: 720 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(viewport);
      await page.locator("#worker-security").evaluate((element) => element.classList.add("http-risk"));
      assert.equal(await page.locator("#worker-security").isVisible(), true, JSON.stringify(viewport));
      await page.locator("#worker-security").evaluate((element) => element.classList.remove("http-risk"));
      const layout = await page.evaluate(() => {
        const progress = document.querySelector(".workflow-progress").getBoundingClientRect();
        const main = document.querySelector(".workflow-main").getBoundingClientRect();
        return {
          separated: progress.right <= main.left || progress.bottom <= main.top,
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.equal(layout.separated, true, JSON.stringify({ viewport, layout }));
      assert.ok(layout.horizontalOverflow <= 1, JSON.stringify({ viewport, layout }));
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => {
      const progress = document.querySelector(".workflow-progress").getBoundingClientRect();
      const main = document.querySelector(".workflow-main").getBoundingClientRect();
      const input = document.querySelector("#city-input").getBoundingClientRect();
      const button = document.querySelector("#btn-search-cinema").getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        activePanel: document.querySelector(".workflow-view.is-active")?.dataset.workflowPanel || null,
        workflowCount: document.querySelector("#workflow-count")?.textContent || null,
        mainPageHidden: document.querySelector("#main-page")?.classList.contains("hidden"),
        progressBottom: progress.bottom,
        mainTop: main.top,
        inputHeight: input.height,
        buttonHeight: button.height,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.deepEqual(errors, []);
    assert.ok(mobileLayout.progressBottom <= mobileLayout.mainTop, JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.inputHeight >= 40, JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.buttonHeight >= 40, JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.horizontalOverflow <= 1, JSON.stringify(mobileLayout));
    await page.screenshot({ path: path.join(screenshotDirectory, "ui-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1200, height: 800 });
    assert.equal(await page.locator('[data-workflow-step="2"]').getAttribute("aria-current"), "step");
    await page.locator("#city-input").fill("上海");
    await page.locator("#city-dropdown .suggest-item").filter({ hasText: "上海" }).click();
    await page.locator("#cinema-search").fill("寰映");
    await page.locator("#btn-search-cinema").click();
    await page.locator("#cinema-dropdown .suggest-item").filter({ hasText: "寰映影城" }).click();
    await page.waitForFunction(() => document.querySelector('[data-workflow-panel="3"]')?.classList.contains("is-active"));
    await page.locator("#movie-list input[type=checkbox]").first().check();
    await page.locator("#btn-step-movie-next").click();
    await page.waitForFunction(() => document.querySelector('[data-workflow-panel="4"]')?.classList.contains("is-active"));
    assert.equal(await page.locator('[data-workflow-step="4"]').getAttribute("aria-current"), "step");
    await page.locator('[data-workflow-step="2"]').click();
    assert.equal(await page.locator('[data-workflow-panel="2"]').getAttribute("aria-hidden"), "false");
    await page.locator('[data-workflow-step="4"]').click();
    assert.equal(await page.locator('[data-workflow-panel="4"]').getAttribute("aria-hidden"), "false");
    assert.equal(await page.locator("#worker-security").textContent(), "本机 HTTP");
    assert.equal(await page.locator("#token-input").inputValue(), "");
    assert.ok(worker.requests.length >= 3);
    assert.ok(worker.requests.every(({ token }) => token === "one-token"));
    assert.equal(new URL(page.url()).protocol, "file:");
    await application.evaluate(({ shell }) => {
      globalThis.smokeOpenedUrls = [];
      shell.openExternal = async (url) => { globalThis.smokeOpenedUrls.push(url); };
    });
    const setupLinks = ["https://apps.apple.com/cn/app/id1403753865", "https://sct.ftqq.com/sendkey"];
    await page.locator(`a[href="${setupLinks[0]}"]`).click();
    await page.locator("#push-channel-row label").filter({ hasText: "Server酱" }).click();
    await page.locator(`a[href="${setupLinks[1]}"]`).click();
    await page.waitForFunction(() => document.querySelector("#push-serverchan-row").classList.contains("hidden") === false);
    assert.deepEqual(await application.evaluate(() => globalThis.smokeOpenedUrls), setupLinks);
    await page.locator("#push-channel-row label").filter({ hasText: "Bark" }).click();
    await page.locator("#bark-input").fill("smoke-bark-key");
    await page.locator("#btn-test-push").click();
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor")?.disabled === false);
    await page.locator("#btn-toggle-monitor").click();
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor")?.textContent === "停止监控");
    await page.locator("#btn-lock-seats").click();
    await page.waitForFunction(() => !document.querySelector("#lock-overlay")?.classList.contains("hidden"));
    const lockLayout = await page.evaluate(() => {
      const dialog = document.querySelector(".lock-dialog").getBoundingClientRect();
      return { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom, width: dialog.width, height: dialog.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(lockLayout.left >= 0 && lockLayout.right <= lockLayout.viewportWidth, JSON.stringify(lockLayout));
    assert.ok(lockLayout.top >= 0 && lockLayout.bottom <= lockLayout.viewportHeight, JSON.stringify(lockLayout));
    await page.screenshot({ path: path.join(screenshotDirectory, "ui-lock.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLockLayout = await page.evaluate(() => {
      const dialog = document.querySelector(".lock-dialog").getBoundingClientRect();
      const submit = document.querySelector("#btn-lock-submit").getBoundingClientRect();
      const title = document.querySelector("#lock-dialog-title").getBoundingClientRect();
      const toast = document.querySelector(".toast.show")?.getBoundingClientRect();
      const toastOverlapsTitle = toast
        ? toast.left < title.right && toast.right > title.left && toast.top < title.bottom && toast.bottom > title.top
        : false;
      return { width: dialog.width, right: dialog.right, submitHeight: submit.height, toastOverlapsTitle, viewportWidth: innerWidth };
    });
    assert.ok(mobileLockLayout.width <= mobileLockLayout.viewportWidth, JSON.stringify(mobileLockLayout));
    assert.ok(mobileLockLayout.right <= mobileLockLayout.viewportWidth, JSON.stringify(mobileLockLayout));
    assert.ok(mobileLockLayout.submitHeight >= 40, JSON.stringify(mobileLockLayout));
    assert.equal(mobileLockLayout.toastOverlapsTitle, false, JSON.stringify(mobileLockLayout));
    await page.screenshot({ path: path.join(screenshotDirectory, "ui-lock-mobile.png") });
    await page.locator("#btn-lock-close").click();
    await page.locator('[data-workflow-step="3"]').click();
    await page.locator("#movie-list input[type=checkbox]").first().uncheck();
    assert.equal(await page.locator('[data-workflow-step="4"]').isEnabled(), true);
    await page.locator('[data-workflow-step="4"]').click();
    assert.equal(await page.locator("#btn-toggle-monitor").isVisible(), true);
    assert.equal(await page.locator("#btn-toggle-monitor").isEnabled(), true);
    assert.equal(application.windows().length, 1);
    assert.equal(new URL(page.url()).protocol, "file:");
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(screenshotDirectory, "ui-desktop.png") });
    const screenshot = path.join(screenshotDirectory, `smoke-${process.platform}-${process.arch}${packaged ? "-packaged" : ""}.png`);
    await page.screenshot({ path: screenshot });
    if (!packaged) {
      await page.goto(pathToFileURL(path.resolve(desktop, "../pages/maoyan/admin.html")).href);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#admin-login").evaluate((element) => element.classList.add("hidden"));
      await page.locator("#admin-main").evaluate((element) => element.classList.remove("hidden"));
      await page.locator("#token-tbody").evaluate((element) => {
        element.innerHTML = '<tr><td class="token-cell">0123456789abcdef0123456789abcdef</td><td>手机端测试账号</td><td><span class="badge in-use">使用中</span></td><td>2026-09-15 23:30</td><td><button class="link-btn danger">删除</button></td></tr>';
      });
      const adminLayout = await page.evaluate(() => ({
        viewportWidth: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        mainRight: document.querySelector("#admin-main").getBoundingClientRect().right,
        deleteRight: document.querySelector("#token-tbody .danger").getBoundingClientRect().right,
      }));
      assert.ok(adminLayout.scrollWidth <= adminLayout.viewportWidth, JSON.stringify(adminLayout));
      assert.ok(adminLayout.mainRight <= adminLayout.viewportWidth, JSON.stringify(adminLayout));
      assert.ok(adminLayout.deleteRight <= adminLayout.viewportWidth, JSON.stringify(adminLayout));
    }
    if (packaged) {
      const entries = await application.evaluate(({ app }) => {
        const fs = process.getBuiltinModule("node:fs");
        const path = process.getBuiltinModule("node:path");
        const root = app.getAppPath();
        const visit = (relative = "") => fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
          const name = path.posix.join(relative, entry.name);
          return entry.isDirectory() ? visit(name) : [name];
        });
        return visit();
      });
      assert.ok(entries.includes("desktop/main/index.js"));
      assert.ok(entries.includes("desktop/preload/index.js"));
      assert.ok(entries.includes("pages/maoyan/index.html"));
      for (const entry of entries) assert.match(entry, /^(package\.json|desktop\/(main|preload)\/[\w-]+\.js|pages\/maoyan\/(index\.html|[\w-]+\.(js|css)))$/);
      console.log(`Packaged asar allowlist verified: ${entries.length} files`);
    }
    console.log(`Electron smoke passed: ${mainPageUrl}; Worker URL visible; token isolated; screenshot ${screenshot}`);
  } finally {
    await application?.close();
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
