const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, readdir, stat } = require('node:fs/promises');
const path = require('node:path');

const dist = path.resolve(__dirname, '../.vitepress/dist');
const routes = [
  ['/', 'Lynkco-push 配置教程'],
  ['/lynkco-plus', 'Lynkco-push 配置教程'],
];
const legacyRoutes = ['/lynkco', '/maoyan', '/store', '/ble'];
const screenshots = [
  ['01-appstore-install.webp', 'App Store 中的 ProxyPin 安装页面', '图 1 · 安装 ProxyPin'],
  ['02-certificate-entry.webp', 'ProxyPin 设置中的 HTTPS 证书入口', '图 2 · 打开证书设置'],
  ['03-download-profile.webp', 'ProxyPin 的下载证书描述文件页面', '图 3 · 下载证书描述文件'],
  ['04-install-profile.webp', 'iPhone 设置中的安装描述文件页面', '图 4 · 安装描述文件'],
  ['05-certificate-warning.webp', 'iPhone 安装根证书时的警告页面', '图 5 · 确认证书警告'],
  ['06-trust-certificate.webp', 'iPhone 设置中的根证书信任开关', '图 6 · 信任根证书'],
  ['07-start-capture.webp', 'ProxyPin 首页的开始抓包按钮', '图 7 · 开始抓包'],
  ['08-allow-vpn.webp', 'iPhone 的 VPN 配置授权提示', '图 8 · 允许 VPN 配置'],
  ['09-capture-running.webp', 'ProxyPin 正在抓包的页面', '图 9 · 查看抓包状态'],
  ['10-refresh-request.webp', 'ProxyPin 搜索 refresh 的请求列表', '图 10 · 查找 refresh 请求'],
  ['11-lynkco-post.webp', '领克 App 中的一条动态', '图 11 · 打开领克动态'],
  ['12-share-sheet.webp', '领克动态的分享菜单', '图 12 · 分享动态'],
  ['13-share-code-request.webp', 'ProxyPin 搜索 getShareCode 的请求列表', '图 13 · 查找 getShareCode 请求'],
  ['14-export-menu.webp', 'ProxyPin 请求列表的视图导出菜单', '图 14 · 打开视图导出'],
  ['15-export-har.webp', 'ProxyPin 视图导出的 HAR 选项', '图 15 · 选择 HAR'],
];

async function withSite(run) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const image = pathname.startsWith('/images/') && pathname.endsWith('.webp');
    const filename = image ? pathname.slice(1) : pathname === '/' ? 'index.html' : `${pathname.slice(1).replace(/\/$/, '')}.html`;
    try {
      const body = await readFile(path.join(dist, filename));
      res.writeHead(200, { 'content-type': image ? 'image/webp' : 'text/html; charset=utf-8' });
      res.end(body);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('built guide serves only the index and Lynkco-push tutorial', async () => {
  await withSite(async (origin) => {
    for (const [route, title] of routes) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), new RegExp(`<h1[^>]*>${title} <a class="header-anchor"`), route);
    }
    assert.equal((await fetch(origin + '/missing')).status, 404);
    assert.equal((await fetch(origin + '/readme')).status, 404);
    for (const route of legacyRoutes) assert.equal((await fetch(origin + route)).status, 404, route);
  });
});

test('built homepage links only to Lynkco-push and the toolbox', async () => {
  await withSite(async (origin) => {
    const html = await (await fetch(origin)).text();
    assert.match(html, /href="\/lynkco-plus"/);
    for (const route of legacyRoutes) assert.ok(!html.includes(`href="${route}"`), route);
    assert.match(html, /href="https:\/\/ltools\.asia\/"/);
    assert.match(html, /Lynkco-push 配置教程/);
  });
});

test('built 404 page offers a Chinese way back to the guide', async () => {
  const html = await readFile(path.join(dist, '404.html'), 'utf8');
  assert.match(html, /页面未找到/);
  assert.match(html, /返回教程首页/);
});

test('tutorial begins with the capture chapter and authorization warning', async () => {
  await withSite(async (origin) => {
    const html = await (await fetch(origin + '/lynkco-plus')).text();
    assert.match(html, /<h2[^>]*>1、抓包 <a class="header-anchor"/);
    assert.match(html, /根证书/);
    assert.match(html, /VPN/);
    assert.match(html, /自己的设备/);
    assert.match(html, /已获授权/);
  });
});

test('four chapters keep capture, refresh, sharing and HAR export separate', async () => {
  const html = await readFile(path.join(dist, 'lynkco-plus.html'), 'utf8');
  const headings = [...html.matchAll(/<h2[^>]*>([^<]+) <a class="header-anchor"/g)];
  assert.deepEqual(headings.map((match) => match[1]), [
    '1、抓包', '2、验证 refresh', '3、获取分享请求', '4、导出 HAR',
  ]);
  const sections = headings.map((match, index) => html.slice(
    match.index,
    headings[index + 1]?.index ?? html.length,
  ));
  assert.match(sections[0], /09-capture-running\.webp/);
  assert.doesNotMatch(sections[0], /refresh|10-refresh-request\.webp/);
  assert.match(sections[1], /refresh/);
  assert.match(sections[1], /10-refresh-request\.webp/);
  assert.doesNotMatch(sections[1], /getShareCode/);
  assert.match(sections[2], /getShareCode/);
  assert.match(sections[2], /13-share-code-request\.webp/);
  assert.match(sections[3], /视图导出/);
  assert.match(sections[3], /HAR/);
  assert.match(sections[3], /14-export-menu\.webp/);
  assert.match(sections[3], /15-export-har\.webp/);
  assert.match(html, /Cookie/);
  assert.match(html, /未经检查/);
});

test('fifteen ordered tutorial figures have labels and load WebP images', async () => {
  await withSite(async (origin) => {
    const html = await (await fetch(origin + '/lynkco-plus')).text();
    let previous = -1;
    for (const [filename, alt, caption] of screenshots) {
      const image = html.indexOf(`src="/images/lynkco-plus/${filename}"`);
      assert.ok(image > previous, `${filename} appears in order`);
      previous = image;
      assert.ok(html.includes(`alt="${alt}"`), `${filename} has alternative text`);
      assert.ok(html.includes(caption), `${filename} has a caption`);
      const response = await fetch(`${origin}/images/lynkco-plus/${filename}`);
      assert.equal(response.status, 200, filename);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.ok((await response.arrayBuffer()).byteLength > 0, filename);
    }
    assert.equal((html.match(/class="guide-figure"/g) || []).length, 15);
  });
});

test('only reviewed images are published, with no legacy pages or assets', async () => {
  const pages = (await readdir(dist)).filter((filename) => filename.endsWith('.html')).sort();
  assert.deepEqual(pages, ['404.html', 'index.html', 'lynkco-plus.html']);
  const images = await readdir(path.join(dist, 'images'));
  assert.deepEqual(images, ['lynkco-plus']);
  assert.deepEqual((await readdir(path.join(dist, 'images/lynkco-plus'))).sort(), screenshots.map(([name]) => name));
  const published = await readdir(path.join(dist, 'images/lynkco-plus'));
  assert.ok(published.every((name) => name.endsWith('.webp')), 'no raw PNG or HAR files');
  await withSite(async (origin) => {
    for (const filename of ['maoyan-connect.webp', 'store-login.webp']) {
      assert.equal((await fetch(`${origin}/images/${filename}`)).status, 404);
    }
  });
});

test('built guide includes theme assets but no private docs or sample secrets', async () => {
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  const asset = html.match(/(?:src|href)="(\/assets\/[^" ]+\.(?:js|css))"/);
  assert.ok(asset, 'bundled JS or CSS asset');
  assert.ok((await stat(path.join(dist, asset[1]))).size > 0);
  for (const [route] of routes.slice(1)) {
    const page = await readFile(path.join(dist, `${route.slice(1)}.html`), 'utf8');
    assert.doesNotMatch(page, /session\.json|\.dev\.vars|local\/|docs\/superpowers\/|SCT[a-zA-Z0-9]{20,}/);
  }
});
