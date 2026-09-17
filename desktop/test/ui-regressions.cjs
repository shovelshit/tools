const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { startMockWorker } = require("./support/worker.cjs");
const { startWebFixture } = require("./support/web.cjs");

async function main() {
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw new Error("Supply an absolute screenshot directory");
  await fs.mkdir(output, { recursive: true });
  const worker = await startMockWorker();
  const web = await startWebFixture({ workerUrl: worker.url });
  const browser = await chromium.launch({
    executablePath: process.env.MAOYAN_E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${web.url}/maoyan/`);
    await page.fill("#worker-url", `${web.url}/one`);
    await page.fill("#token-input", "one-admin");
    await page.click("#btn-connect");
    await page.waitForSelector("#main-page:not(.hidden)");
    await page.reload();
    await page.waitForSelector("#main-page:not(.hidden)");
    assert.ok(worker.requests.some((request) => request.path.endsWith("/api/auth/session") && request.token === "one-monitor-session"));
    console.log("PASS administrator refresh uses the scoped monitor session");

    await page.fill("#city-input", "上海");
    await page.locator("#city-dropdown .suggest-item").first().click();
    await page.fill("#cinema-search", "寰映");
    await page.click("#btn-search-cinema");
    await page.locator("#cinema-dropdown .suggest-item").first().click();
    await page.locator("#movie-list input[type=checkbox]").first().check();
    await page.click("#btn-step-movie-next");
    await page.fill("#bark-input", "mockkey1234567890");
    await page.click("#btn-test-push");
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor").disabled === false);
    await page.click("#btn-toggle-monitor");
    await page.waitForFunction(() => document.querySelector("#btn-toggle-monitor").textContent === "停止监控");
    const mask = await page.inputValue("#bark-input");
    await page.reload();
    await page.waitForSelector("#main-page:not(.hidden)");
    await page.locator('[data-workflow-step="4"]').click();
    assert.equal(await page.inputValue("#bark-input"), mask);
    assert.equal(mask, "mock••••••7890");
    const channel = await page.locator(".channel-opts").boundingBox();
    const key = await page.locator("#bark-input").boundingBox();
    assert.ok(channel.width < 400 && key.width <= 560 && Math.abs(channel.x - key.x) <= 1);
    console.log("PASS rapid save/start/refresh preserves movies and key mask; controls stay compact");
    await page.screenshot({ path: path.join(output, "push-fixed.png") });

    await page.click("#btn-lock-seats");
    await page.fill("#lock-target-date", "2026-09-21");
    await page.selectOption("#lock-template", "903");
    await page.waitForFunction(() => document.querySelectorAll("#lock-seat-grid .lock-seat").length === 319);
    const left = page.locator(".lover-left"), right = page.locator(".lover-right");
    assert.equal(await left.textContent(), "14");
    assert.equal(await right.textContent(), "13");
    assert.equal(await left.isEnabled(), true);
    await left.click();
    assert.equal(await page.locator(".lock-seat.is-selected").count(), 2);
    await right.click();
    assert.equal(await page.locator(".lock-seat.is-selected").count(), 0);
    await right.click();
    assert.equal(await page.locator(".lock-seat.is-selected").count(), 2);
    const l = await left.boundingBox(), r = await right.boundingBox();
    assert.ok(Math.abs(l.x + l.width - r.x) <= 1, JSON.stringify({ l, r }));
    console.log("PASS reverse-numbered 13/14 seats select together and are visually connected");
    await page.check("#lock-risk-accepted");
    await page.click("#btn-lock-submit");
    await page.waitForFunction(() => document.querySelector("#lock-rule-details").open && document.querySelector("#lock-rule-details").textContent.includes("14"));
    console.log("PASS saved rule details", await page.locator("#lock-rule-details").innerText());
    await page.screenshot({ path: path.join(output, "couple-rule-fixed.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const stage = document.querySelector(".lock-seat-scroll").getBoundingClientRect();
      return [...document.querySelectorAll("#lock-seat-grid .lock-seat")].every((seat) => {
        const box = seat.getBoundingClientRect();
        return box.left >= stage.left && box.right <= stage.right;
      });
    });
    await page.locator("#lock-rule-details").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "couple-rule-mobile.png"), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.fill("#lock-target-date", "2026-09-19");
    await page.waitForFunction(() => document.querySelector("#lock-section-risk").classList.contains("hidden"));
    await page.waitForResponse((response) => response.url().endsWith("/api/lock/rule") && response.request().method() === "GET", { timeout: 25000 });
    await page.waitForFunction(() => !document.querySelector("#lock-session-status .spinner"));
    assert.equal(await page.locator("#lock-section-risk").isVisible(), false);
    console.log("PASS real-seat risk remains hidden after the scheduled lock-state refresh");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await web.close();
    await worker.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
