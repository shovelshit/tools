const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { startMockWorker } = require("./support/worker.cjs");

async function main() {
  const packaged = process.argv.includes("--packaged");
  const desktop = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-smoke-"));
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
    assert.match(page.url(), /file:.*\/pages\/maoyan\/index\.html$/);
    if (packaged) assert.match(page.url(), /app\.asar\/pages\/maoyan\/index\.html$/);
    assert.deepEqual(await page.evaluate(() => ({ node: typeof require, process: typeof process, cookieApi: typeof window.maoyanElectron.cookies, tokenApi: typeof window.maoyanElectron.getToken })), { node: "undefined", process: "undefined", cookieApi: "undefined", tokenApi: "undefined" });
    await page.locator("#worker-url").fill(worker.url + "/one");
    await page.locator("#token-input").fill("one-token");
    await page.locator("#btn-connect").click();
    await page.waitForFunction((url) => document.querySelector("#worker-profile").textContent.includes(url), worker.url + "/one");
    await page.waitForFunction(() => document.querySelector("#block-overlay")?.classList.contains("hidden") ?? true);
    assert.equal(await page.locator("#main-page").isVisible(), true);
    assert.equal(await page.locator("#worker-security").textContent(), "本机 HTTP");
    assert.equal(await page.locator("#token-input").inputValue(), "");
    assert.ok(worker.requests.length >= 3);
    assert.ok(worker.requests.every(({ token }) => token === "one-token"));
    assert.equal(new URL(page.url()).protocol, "file:");
    assert.deepEqual(errors, []);
    const screenshot = path.join(desktop, "dist", `smoke-${process.platform}-${process.arch}${packaged ? "-packaged" : ""}.png`);
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
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
    console.log(`Electron smoke passed: ${page.url()}; Worker URL visible; token isolated; screenshot ${screenshot}`);
  } finally {
    await application?.close();
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
