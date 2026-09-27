const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../desktop/node_modules/playwright-core');

test('toolbox directory keeps tool destinations and exposes the guide', async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    const links = await page.locator('main a[href]').evaluateAll((elements) =>
      elements.map((element) => ({ href: element.getAttribute('href'), text: element.textContent.trim() }))
    );
    for (const href of [
      'maoyan/',
      'store/',
      'https://github.com/shovelshit/LynkCoHelper',
      'https://github.com/shovelshit/BLE-debug',
    ]) {
      assert.ok(links.some((link) => link.href === href), `Missing tool destination: ${href}`);
    }
    assert.ok(links.some((link) => link.href === 'https://guide.ltools.asia/' && link.text.includes('使用教程')));
    assert.equal(await page.locator('h1').textContent().then((text) => text.trim()), '工具箱');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  } finally {
    await browser.close();
  }
});
