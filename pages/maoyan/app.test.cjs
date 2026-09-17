const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadRuntime() {
  const source = fs.readFileSync(path.join(__dirname, "runtime.js"), "utf8");
  const window = { window: null };
  window.window = window;
  require("node:vm").runInNewContext(source, { window }, { filename: "runtime.js" });
  return window;
}

function createAppStateFixture(initial = {}) {
  return {
    cinemaId: "",
    selectedMovies: [],
    lockOpen: true,
    profileKey: "https://first.example",
    ...initial
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 统一按 LF 读取: 源码在多平台检出时可能是 CRLF, 不能让行尾符决定测试结果
function readSource(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8").replace(/\r\n/g, "\n");
}

async function startWebApp({ savedWorker, requestedWorker, savedToken = "token-a", tokens = {} }) {
  const source = readSource("app.js");
  const entries = new Map(Object.entries(tokens));
  if (savedWorker !== undefined) entries.set("workerUrl", savedWorker);
  entries.set("token", savedToken);
  const requests = [];
  const opened = [];
  const links = ["https://apps.apple.com/cn/app/id1403753865", "https://sct.ftqq.com/sendkey"].map((href) => ({ href, addEventListener(event, callback) { this[event] = callback; } }));
  const els = { workerUrl: { value: "" }, token: { value: "" } };
  const location = { hostname: "page.example", origin: "https://page.example", protocol: "https:", search: requestedWorker ? `?worker=${encodeURIComponent(requestedWorker)}` : "" };
  const window = loadRuntime();
  const { webTokenKey } = require("./connection-profile.js");
  window.webTokenKey = webTokenKey;
  window.maoyanRuntime = window.createWebRuntime({
    getWorkerUrl: () => els.workerUrl.value, getToken: () => els.token.value,
    fetchImpl: async (url, options) => { requests.push({ url, token: options.headers["X-Token"] }); return { ok: true, json: async () => ({}) }; }
  });
  window.maoyanRuntime.openExternal = async (url) => { opened.push(url); return { opened: true }; };
  const context = {
    window, URL, URLSearchParams, location, els, DEFAULT_WORKER: "https://ltools.asia", SAME_ORIGIN: false,
    document: { querySelectorAll: () => links },
    runtimeInfo: { kind: "web" }, tokenProfileKey: "", updateBatchTip() {}, checkForDesktopUpdate() {}, showLoginHint() {},
    console: { warn() {} },
    localStorage: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) },
    secureGet: async (key) => entries.get(key) ?? "",
    secureSet: async (key, value) => value ? entries.set(key, value) : entries.delete(key)
  };
  const vm = require("node:vm");
  const helpers = source.slice(source.indexOf("function normalizedWorkerUrl("), source.indexOf("\nasync function api("));
  vm.runInNewContext(helpers, context);
  const bindingStart = source.indexOf("function bindSetupLinks(");
  if (bindingStart !== -1) vm.runInNewContext(source.slice(bindingStart, source.indexOf("\nfunction ", bindingStart + 1)), context);
  context.connect = () => window.maoyanRuntime.connectWorker({ workerUrl: context.normalizedWorkerUrl(), token: els.token.value });
  await vm.runInNewContext(source.slice(source.indexOf("(async function init()")), context);
  return { requests, entries, els, opened, links };
}

test("Web startup URL override never sends another Worker's global token", async () => {
  const app = await startWebApp({ savedWorker: "https://a.example", requestedWorker: "https://b.example" });
  assert.deepEqual(app.requests.map((request) => request.url), [
    "https://b.example/api/capabilities", "https://b.example/api/auth/session", "https://b.example/api/status"
  ]);
  assert.equal(app.requests.every((request) => request.token === ""), true);
  assert.equal(app.els.token.value, "");
});

test("Web startup restores only profile-scoped credentials and ignores the global token", async () => {
  const equivalent = await startWebApp({ savedWorker: "HTTPS://A.EXAMPLE:443/", requestedWorker: "https://a.example" });
  assert.deepEqual(equivalent.requests.map((request) => request.url), [
    "https://a.example/api/capabilities", "https://a.example/api/auth/session", "https://a.example/api/status"
  ]);
  assert.equal(equivalent.requests.every((request) => request.token === ""), true);
  assert.equal(equivalent.entries.has("token:https%3A%2F%2Fa.example"), false);
  assert.equal(equivalent.entries.get("token"), "token-a");
  const another = await startWebApp({ savedWorker: "https://a.example", requestedWorker: "https://b.example", tokens: { "token:https%3A%2F%2Fb.example": "token-b" } });
  assert.equal(another.requests.every((request) => request.token === "token-b"), true);
  assert.equal(another.entries.has("token:https%3A%2F%2Fa.example"), false);
  const unbound = await startWebApp({ requestedWorker: "https://b.example" });
  assert.equal(unbound.requests[0].token, "");
  assert.equal(unbound.entries.get("token"), "token-a");
});

test("setup link clicks use runtime external navigation and suppress window creation", async () => {
  const app = await startWebApp({ savedWorker: "https://a.example" });
  for (const link of app.links) {
    assert.equal(typeof link.click, "function");
    let prevented = false;
    await link.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(app.opened, ["https://apps.apple.com/cn/app/id1403753865", "https://sct.ftqq.com/sendkey"]);
});

test("login markup exposes the Worker URL input", () => {
  const indexHtml = readSource("index.html");
  assert.doesNotMatch(indexHtml, /id="worker-url"[^>]*class="hidden"/);
});

test("connection security distinguishes HTTPS, loopback HTTP, and remote HTTP", () => {
  const source = readSource("app.js");
  const start = source.indexOf("function setConnectionState(");
  const end = source.indexOf("\nfunction ", start + 1);
  const security = { textContent: "", classList: { toggle(_name, enabled) { security.risk = enabled; } } };
  const context = { URL, els: { workerProfile: {}, workerSecurity: security } };
  require("node:vm").runInNewContext(source.slice(start, end), context);
  for (const [workerUrl, httpRisk, label, risk] of [
    ["https://worker.example", false, "HTTPS", false],
    ["http://localhost:8787", false, "本机 HTTP", false],
    ["http://127.0.0.1:8787", false, "本机 HTTP", false],
    ["http://[::1]:8787", false, "本机 HTTP", false],
    ["http://worker.example", true, "不安全 HTTP 连接", true],
    ["http://localhost.evil.example", false, "不安全 HTTP 连接", true],
    ["", false, "未连接", false]
  ]) {
    context.setConnectionState({ profileKey: "profile-id", workerUrl, httpRisk });
    assert.equal(security.textContent, label, workerUrl);
    assert.equal(security.risk, risk, workerUrl);
  }
});

test("switching profiles clears cinema and lock state before reconnect", async () => {
  const { switchWorkerProfile } = loadRuntime();
  const state = createAppStateFixture({ cinemaId: "25428", selectedMovies: ["1"] });

  await switchWorkerProfile(state, "https://second.example");

  assert.equal(state.cinemaId, "");
  assert.deepEqual(state.selectedMovies, []);
  assert.equal(state.lockOpen, false);
  assert.equal(state.profileKey, "https://second.example");
});

test("switching connections clears only the Maoyan user connection", () => {
  const source = readSource("app.js");
  assert.equal(source.includes("localStorage.clear()"), false);
  assert.match(source, /localStorage\.removeItem\("workerUrl"\)/);
  assert.match(source, /localStorage\.removeItem\("authMode"\)/);
  assert.match(source, /secureSet\("token", ""\)/);
});

test("logout resets Worker-scoped UI before another profile can connect", () => {
  const source = readSource("app.js");
  assert.match(source, /els\.btnLogout\.addEventListener\("click", async \(\) => \{\s*resetProfileUi\(""\);/);
  assert.match(source, /function resetProfileUi[\s\S]*?selectedCity = null;/);
  assert.match(source, /function resetProfileUi[\s\S]*?allCities = \[\];/);
  assert.match(source, /function resetProfileUi[\s\S]*?monitorEnabled = false;/);
  assert.match(source, /function resetProfileUi[\s\S]*?lockController\.reset\?\.\(\);/);
});

test("Electron clears a typed token even when Worker connection fails", () => {
  const source = readSource("app.js");
  assert.match(source, /if \(runtimeInfo\.kind === "electron"\) els\.token\.value = "";[\s\S]{0,300}?await window\.maoyanRuntime\.connectWorker\(connection\)/);
});

test("old config, cinema search, and change responses do not update a reset profile", async () => {
  const { createProfileGeneration } = loadRuntime();
  const generation = createProfileGeneration();
  const oldGeneration = generation.current();
  const config = deferred();
  const search = deferred();
  const changes = deferred();
  const state = {};

  const operations = [
    generation.run(oldGeneration, config.promise, (value) => { state.config = value; }),
    generation.run(oldGeneration, search.promise, (value) => { state.search = value; }),
    generation.run(oldGeneration, changes.promise, (value) => { state.changes = value; })
  ];
  generation.invalidate();
  config.resolve({ cinemaId: "25428" });
  search.resolve([{ id: "old-cinema" }]);
  changes.resolve([{ text: "old change" }]);

  assert.deepEqual(await Promise.all(operations), [false, false, false]);
  assert.deepEqual(state, {});
});

test("lock submission restores disabled state after the loading button resets", () => {
  const source = readSource("lock.js");
  assert.match(source, /await buttonLoading\(els\.submit,[\s\S]*?finally \{\s*if \(isCurrentProfileGeneration\(generation\)\) renderSelection\(\);\s*}/);
});

test("monitor start stays disabled until the current push configuration is tested", () => {
  const source = readSource("app.js");
  assert.match(source, /let pushVerified = false/);
  assert.match(source, /!monitorEnabled && !pushVerified/);
  assert.match(source, /pushVerified = config\.notifyVerified === true/);
  assert.match(source, /pushVerified = res\.config\?\.notifyVerified === true/);
  assert.match(source, /pushVerified = true;[\s\S]*?updateMonitorBtn\(\)/);
});

test("monitor status no longer uses the retired independent deadline", () => {
  const source = readSource("app.js");
  assert.doesNotMatch(source, /monitorDdl/);
  assert.match(source, /const main = stopped \? "已停止"/);
  assert.match(source, /await refreshChanges\(\);/);
});

test("next monitoring batch is labelled as an estimate", () => {
  const source = readSource("app.js");
  const start = source.indexOf("function nextBatchText()");
  const end = source.indexOf("\nfunction ", start + 1);
  const RealDate = Date;
  function FixedDate(...args) {
    return new RealDate(...(args.length ? args : ["2026-09-17T10:03:00+08:00"]));
  }
  FixedDate.prototype = RealDate.prototype;
  const context = { Date: FixedDate, cronMinuteStep: true, cronMinutes: 5 };
  require("node:vm").runInNewContext(source.slice(start, end), context);

  assert.match(context.nextBatchText(), /^预计下批次 /);
});

test("status polling uses incremental endpoints and has no fixed one-minute interval", () => {
  const source = readSource("app.js");
  const html = readSource("index.html");
  assert.match(html, /<script src="polling\.js(?:\?[^\"]*)?"><\/script>/);
  assert.match(source, /\/api\/status\?view=summary/);
  assert.match(source, /\/api\/changes\?limit=20/);
  assert.doesNotMatch(source, /setInterval\([\s\S]*?refreshChanges/);
});

test("expired accounts expose self-service renewal with optimistic versioning", () => {
  const source = readSource("app.js");
  const html = readSource("index.html");
  assert.match(html, /id="btn-renew-account"/);
  assert.match(source, /accountConnection\.canRenew/);
  assert.match(source, /\/api\/account\/renew/);
  assert.match(source, /expectedVersion: currentAccount\.accountVersion/);
});

test("config writes carry and refresh the optimistic config version", () => {
  const source = readSource("app.js");
  assert.match(source, /configVersion = Number\(config\.version\) \|\| 0/);
  assert.match(source, /expectedVersion: configVersion/);
  assert.match(source, /configVersion = Number\(res\.config\?\.version\) \|\| configVersion/);
  assert.match(source, /配置已在其他设备更新/);
});

test("cinema selection no longer depends on the removed manual input", () => {
  const source = readSource("app.js");
  const html = readSource("index.html");
  assert.equal(html.includes("manual-cinema"), false);
  assert.equal(html.includes("cinema-input"), false);
  assert.equal(source.includes("cinemaInput"), false);
  // 影院 ID 的三个写入点: 搜索选中 / 加载成功 / 云端恢复
  assert.match(source, /selectedCinemaId = id;/);
  assert.match(source, /selectedCinemaId = String\(res\.cinemaId\)/);
  assert.match(source, /if \(config\.cinemaId\) selectedCinemaId = String\(config\.cinemaId\);/);
});

test("runtime marker is applied before and after asynchronous runtime detection", () => {
  const source = readSource("app.js");
  assert.match(source, /document\.documentElement\.dataset\.runtime/);
  assert.match(source, /runtimeInfo = \{ kind: window\.maoyanRuntime\?\.kind \|\| "web"/);
  assert.match(source, /runtimeInfo = await window\.maoyanRuntime\.getRuntimeInfo\(\);[\s\S]{0,260}?setRuntimeDataset\(runtimeInfo\.kind\)/);
  assert.match(source, /catch \{[\s\S]{0,180}?setRuntimeDataset\(runtimeInfo\.kind\)/);
});

test("larger workspace metrics are scoped to Web Maoyan desktop only", () => {
  const css = readSource("style.css");
  assert.match(css, /@media\s*\(min-width:\s*1200px\)[\s\S]*html\[data-runtime="web"\] #main-page \.app-workspace/);
  assert.match(css, /html\[data-runtime="web"\] #main-page \.app-workspace[\s\S]*max-width:\s*1400px/);
  assert.match(css, /html\[data-runtime="web"\] #main-page \.app-workspace[\s\S]*max-height:\s*775px/);
  assert.match(css, /html\[data-runtime="web"\] #main-page \.title-block h1[\s\S]*font-size:\s*17px/);
  assert.match(css, /html\[data-runtime="web"\] #main-page \.status-line[\s\S]*font-size:\s*14px/);
  assert.match(css, /html\[data-runtime="web"\] #main-page input\[type="text"\][\s\S]*height:\s*40px/);
  assert.doesNotMatch(css, /html\[data-runtime="web"\][\s\S]*\bzoom\s*:/);
  assert.doesNotMatch(css, /html\[data-runtime="web"\][\s\S]*transform:\s*scale/);
});

test("push key is masked after save and read from memory, not the masked input", () => {
  const source = readSource("app.js");
  assert.match(source, /function maskKey/);
  assert.match(source, /const realKeys = \{ bark: "", serverchan: "" \};/);
  // 保存体与测试推送都从内存取真实密钥, 不能把掩码当密钥提交
  assert.equal(source.includes("currentKeyInput().value.trim()"), false);
  assert.match(source, /const key = currentRealKey\(\);/);
});

test("stored key shows placeholder mask after refresh (cloud hasBark, no plaintext in memory)", () => {
  const source = readSource("app.js");
  // 刷新后内存无明文但云端已存: 输入框回显固定占位掩码, 不再一片空白
  assert.match(source, /const KEY_STORED_MASK = "••••••••";/);
  assert.match(source, /const keyStored = \{ bark: false, serverchan: false \};/);
  assert.match(source, /keyStored\.bark = config\.hasBark === true;/);
  assert.match(source, /keyStored\.serverchan = config\.hasServerChan === true;/);
  assert.match(source, /else if \(keyStored\[getChannel\(\)\]\) \{\s*\n\s*input\.value = KEY_STORED_MASK;/);
  // 占位掩码不当作密钥提交: 失焦保存与聚焦还原都跳过它
  assert.match(source, /typed !== KEY_STORED_MASK/);
  assert.match(source, /input\.value === KEY_STORED_MASK\) input\.select\(\);/);
  // 按渠道独立记录, 只配置过 Bark 时切到 Server酱 不应显示已存掩码
  assert.doesNotMatch(source, /pushSaved = keyStored\.bark \|\| keyStored\.serverchan;\s*\n\s*keyStored/);
});

test("lock dialog gates everything behind maoyan session upload", () => {
  const source = readSource("lock.js");
  const html = readSource("index.html");
  assert.match(source, /function renderGate/);
  assert.match(source, /els\.sectionSchedule, els\.sectionSeats, els\.sectionRisk, els\.sectionRules/);
  assert.match(source, /await loadSeats\(\); \/\/ 门控解除后立即加载座位表/);
  assert.match(html, /id="lock-section-session"/);
  assert.match(html, /id="lock-gate-hint"/);
  assert.match(html, /保存并测试/);
});

test("seat feedback: button exists in DOM, handler defined, wired and highlighted on load failure", () => {
  // 7673d81 曾因并行编辑把 sendSeatFeedback 函数体与 attention 联动整体丢失(按钮点击 ReferenceError)
  const source = readSource("lock.js");
  const html = readSource("index.html");
  assert.match(html, /id="btn-lock-seat-feedback"/);
  assert.match(source, /async function sendSeatFeedback\(\)/);
  assert.match(source, /api\("\/api\/lock\/seat-feedback", \{/);
  assert.match(source, /state\.seatFeedback\.seqNo === key && now - state\.seatFeedback\.at < 60000/);
  assert.match(source, /els\.seatFeedback\?\.addEventListener\("click", \(\) => \{ sendSeatFeedback\(\); \}\);/);
  assert.match(source, /els\.seatFeedback\?\.classList\.remove\("attention"\);/);
  assert.match(source, /els\.seatFeedback\?\.classList\.add\("attention"\);/);
});

test("seat map fits, pans by drag, zooms at cursor; risk box only for inferred seats", () => {
  const source = readSource("lock.js");
  const html = readSource("index.html");
  // 平移/缩放/适应: translate+scale 变换，按实测边界适应，拖动吞 click 防误选
  assert.match(source, /translate\(\$\{state\.panX\}px, \$\{state\.panY\}px\) scale\(\$\{state\.zoom\}\)/);
  assert.match(source, /function clampPan/);
  assert.match(source, /function fitSeatMap/);
  assert.match(source, /function scheduleSeatFit/);
  assert.match(source, /scheduleSeatFit\(\);/);
  assert.match(source, /viewMode: "fit"/);
  assert.match(source, /suppressClick/);
  // 推断标记必须在模板分支被置真(此前从未置真, warn 与推断座位全可选逻辑均不生效)
  assert.match(source, /state\.showMode = "template";\n          state\.seatMapIsTemplate = true;/);
  // 风险区: 仅推断座位展示, 门控期隐藏; 勾选仅在推断模式下必填
  assert.match(source, /setHidden\(els\.sectionRisk, !state\.session\?\.uploaded \|\| state\.seatMapIsTemplate !== true\)/);
  assert.match(source, /if \(state\.seatMapIsTemplate && !els\.risk\?\.checked\) return "请先勾选风险提示";/);
  // 风险框必须保持独立的边框、底色和文字色，具体设计 token 可随主题调整
  const riskRule = readSource("style.css").match(/\.lock-risk\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(riskRule, /border:/);
  assert.match(riskRule, /background:/);
  assert.match(riskRule, /color:/);
  // 画布式容器: 滚轮缩放/拖动平移通过无障碍名称和原生 tooltip 提示
  assert.match(html, /class="lock-seat-scroll" title="滚轮缩放，按住拖动，双指捏合"/);
  assert.match(html, /class="lock-zoom-bar" aria-label="座位图缩放和拖动操作"/);
  const seatScrollRule = readSource("style.css").match(/\.lock-seat-scroll\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(seatScrollRule, /overflow:\s*hidden/);
  assert.match(seatScrollRule, /height:/);
  assert.match(seatScrollRule, /cursor:\s*grab/);
});

test("official seat comparison is opt-in, cancellable, and does not rewrite template inventory", () => {
  const source = readSource("lock.js");
  const html = readSource("index.html");
  assert.match(html, /id="lock-official-toggle" type="checkbox"/);
  assert.doesNotMatch(html, /id="lock-official-toggle"[^>]*checked/);
  assert.match(source, /\/api\/lock\/official-seats\?/);
  assert.match(source, /officialAbort\?\.abort/);
  assert.match(source, /loadSeq !== officialLoadSeq/);
  assert.doesNotMatch(source, /seatMap\.seats\s*=\s*seatMap\.seats\.map\(\(seat\)\s*=>\s*\(\{\s*\.\.\.seat,\s*available:\s*true/);
});

test("seat map auto-detects swapped seatNo segment order (Dolby vs laser IMAX halls)", () => {
  const source = readSource("lock.js");
  // 真实缺陷: 寰映IMAX厅 data-no=区-排-座, 固定把第二段当座号 → 同排座位挤进同一列(竖条)。
  // 座号段判别 + 加载座位表后写入 state, 布局/表头/文案统一走判别后的段位。
  // 判别已升级为行内特征优先(同排恒定段=排号、逐座变化段=座号), 启发式仅兜底。
  assert.match(source, /function seatSegmentOf\(seats\)/);
  assert.match(source, /if \(vary2 > 0 && vary3 === 0\) return 2;/);
  assert.match(source, /if \(vary3 > 0 && vary2 === 0\) return 3;/);
  assert.match(source, /seatPosition\(seat, state\.seatSeg\)/);
  assert.match(source, /state\.seatSeg = seatSegmentOf\(seatMap\?\.seats\)/);
  assert.match(source, /seatDisplayLabel\(seat, state\.seatSeg\)/);
});

test("empty today/past target date lists other-date real sessions and locks them as real shows", () => {
  const source = readSource("lock.js");
  // 今天/已过日期无场次: 不再走推断逻辑, 选中即按 jumpDate 切换目标日期进入真实场次模式
  assert.match(source, /else if \(!isFuture\) \{\n          \/\/ 今天\/已过日期无场次/);
  assert.match(source, /els\.templateLabel\.textContent = "其他日期场次（真实可锁）"/);
  assert.match(source, /option\.dataset\.jumpDate = item\.showDate;/);
  assert.match(source, /const jumpDate = els\.template\.selectedOptions\?\.\[0\]\?\.dataset\?\.jumpDate;/);
  assert.match(source, /els\.date\.value = jumpDate;/);
  // 该分支不产生推断座位, 风险框保持隐藏
  assert.match(source, /state\.showMode = "target";\n          state\.seatMapIsTemplate = false;/);
  // 未来日期无场次的推断路径保持不变
  assert.match(source, /以下为模板场次的未来推断座位/);
});

test("lock entry follows the monitor switch and explains a paused lock rule", () => {
  const source = readSource("app.js");
  // getContext 携带监控状态; 监控开关切换后即时刷新锁座入口可用性
  assert.match(source, /monitorEnabled, \/\/ 锁座随监控启停/);
  assert.match(source, /lockController\.syncAvailability\(\);\s*[\s\S]{0,400}?\/\/ 停止监控时若挂着进行中的自动锁座规则/);
  assert.match(source, /已随监控暂停，重新开始监控后自动继续/);
});

test("Electron shows an official update affordance and keeps the HTTP warning visible", () => {
  const source = readSource("app.js");
  const html = readSource("index.html");
  assert.match(html, /id="update-status"/);
  assert.match(html, /id="btn-open-update"/);
  assert.match(source, /async function checkForDesktopUpdate\(\)/);
  assert.match(source, /window\.maoyanRuntime\.checkForUpdates\(\)/);
  assert.match(source, /未经签名验证/);
  assert.match(source, /window\.maoyanRuntime\.openExternal\(releaseUrl\)/);
  assert.match(source, /不安全 HTTP 连接/);
});
