# 猫眼 Electron 桌面端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不复制业务页面的前提下，为猫眼监控与锁座工具增加 macOS/Windows Electron 客户端、原生猫眼登录态捕获、Worker profile 隔离和未签名版本检查。

**Architecture:** `pages/maoyan` 继续作为 Web 与 Electron 唯一业务前端，通过新增 runtime 适配层选择浏览器 `fetch` 或 Electron preload IPC。Electron 主进程负责 Worker 请求、系统安全存储、临时猫眼 Session、文件读取和更新检查；Worker 继续使用现有锁座 API 与加密会话存储。

**Tech Stack:** Electron、Node.js `node:test`、现有原生 HTML/CSS/JavaScript、Electron `safeStorage`、Electron `session`/`webContents`、electron-builder、GitHub Actions。

## Global Constraints

- 仅支持 macOS Apple Silicon、macOS Intel 和 Windows x64；不支持 Linux、iOS、Android。
- `pages/maoyan` 是 Web 与 Electron 的唯一业务前端源码，Electron 不复制页面文件。
- Worker 地址只作为 API 基地址，不能作为 Electron 页面导航地址。
- Worker 地址只接受 `http://` 和 `https://`；拒绝用户名、密码、查询参数和 fragment。
- 非本机 HTTP Worker 在首次连接和上传猫眼登录态前分别阻断确认；`localhost`、`127.0.0.1`、`[::1]` 只显示轻量提示。
- Token 使用 Electron 系统安全存储；不可用时只保存在当前进程内存，不写明文文件。
- 猫眼登录使用随机、非持久化 Session；登录态明文不得进入 renderer、磁盘或日志。
- 登录窗口顶层导航只允许 `https://maoyan.com` 及其子域名，超时为 10 分钟。
- Electron 主窗口必须使用 `nodeIntegration: false`、`contextIsolation: true` 和 renderer sandbox。
- `requestWorker` 只接受相对 `/api/` 路径、受支持 HTTP 方法和受限 JSON body，renderer 不能提供任意 Header 或绝对 URL。
- 现有 Worker `/api/status`、`/api/lock/session`、`/api/lock/session/status` 和其他业务接口保持兼容，不新增桌面专用 Worker API。
- Web 保留手动 JSON 上传；Web 的“登录猫眼”按钮显示禁用状态并说明不支持。
- 首版只检查 GitHub Releases 并打开发布页手动安装，不静默下载、替换或绕过系统安全提示。

---

## 文件与模块边界

实施前固定以下文件职责，避免在已有大文件中继续混入 Electron 细节：

- `pages/maoyan/runtime.js`：共享运行时接口；Web 实现直接调用 `fetch`，Electron 实现调用 `window.maoyanElectron`。
- `pages/maoyan/app.js`：入口连接、Worker profile 切换、页面状态清理和业务 API 调用，全部经 runtime。
- `pages/maoyan/lock.js`：锁座弹窗；根据 runtime 能力渲染“登录猫眼”和“手动上传登录态”。
- `pages/maoyan/index.html`、`pages/maoyan/style.css`：入口 Worker 地址、HTTP 风险状态和锁座会话控件。
- `desktop/main/index.js`：Electron 生命周期、主窗口、IPC handler 注册、导航和新窗口拦截。
- `desktop/main/worker-client.js`：Worker URL 规范化、profile 隔离、请求白名单和 HTTP 风险状态。
- `desktop/main/credential-store.js`：按 profile 存取 Token；只使用 `safeStorage` 或进程内存。
- `desktop/main/maoyan-login.js`：临时 Session、顶层导航策略、请求 Header 捕获、会话校验、上传和清理。
- `desktop/main/updates.js`：固定 GitHub Releases 地址的版本查询、比较和脱敏错误转换。
- `desktop/preload/index.js`：最小、固定签名的 contextBridge API。
- `desktop/test/*.test.cjs`：主进程模块单测和 IPC/登录流程集成测试；测试不使用真实账号。
- `.github/workflows/electron.yml`：Worker 回归、Electron 单测和 macOS/Windows unsigned 构建。

---

### Task 1: 建立 Electron 壳和共享 Runtime 合约

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/main/index.js`
- Create: `desktop/preload/index.js`
- Create: `desktop/test/main.test.cjs`
- Create: `pages/maoyan/runtime.js`
- Create: `pages/maoyan/runtime.test.cjs`
- Modify: `pages/maoyan/index.html`

**Interfaces:**
- `runtime.js` exports `window.maoyanRuntime` with `{ kind, getRuntimeInfo, connectWorker, requestWorker, loginMaoyan, cancelMaoyanLogin, uploadSessionFile, checkForUpdates, openExternal }`.
- `connectWorker({ workerUrl, token, httpRiskConfirmed })` resolves to `{ status, profile, httpRisk }` or rejects with a user-safe error.
- `requestWorker(path, { method = "GET", body })` resolves parsed JSON and rejects on non-2xx responses.
- `preload/index.js` exposes only `window.maoyanElectron`, never raw `ipcRenderer`.

- [ ] **Step 1: Write the failing runtime contract tests.**

```js
// pages/maoyan/runtime.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");

test("web runtime sends relative API requests with the token header", async () => {
  const requests = [];
  const runtime = createWebRuntime({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    getWorkerUrl: () => "https://worker.example",
    getToken: () => "token-a"
  });
  await runtime.requestWorker("/api/status");
  assert.equal(requests[0].url, "https://worker.example/api/status");
  assert.equal(requests[0].options.headers["X-Token"], "token-a");
});

test("electron runtime delegates login to the fixed bridge", async () => {
  let calledWith;
  const runtime = createElectronRuntime({
    bridge: { loginMaoyan: async (cinemaId) => { calledWith = cinemaId; return { ok: true }; } }
  });
  await runtime.loginMaoyan("25428");
  assert.equal(calledWith, "25428");
});
```

- [ ] **Step 2: Run the focused test to verify the contract is absent.**

Run: `node --test pages/maoyan/runtime.test.cjs`

Expected: FAIL because `runtime.js` does not yet export the two factory functions.

- [ ] **Step 3: Implement the two runtime adapters and load them before the business scripts.**

```js
// pages/maoyan/runtime.js
(function (root) {
  function createWebRuntime({ fetchImpl = root.fetch, getWorkerUrl, getToken } = {}) {
    return {
      kind: "web",
      getRuntimeInfo: async () => ({ kind: "web", canLoginMaoyan: false }),
      async requestWorker(path, options = {}) {
        if (!/^\/api\//.test(path) || /^https?:/i.test(path)) throw new Error("API 路径无效");
        const headers = { "X-Token": getToken() };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetchImpl(getWorkerUrl() + path, { ...options, headers });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      },
      connectWorker: async ({ workerUrl, token }) => ({ workerUrl, token }),
      loginMaoyan: async () => ({ ok: false, code: "unsupported" }),
      cancelMaoyanLogin: async () => ({ ok: true }),
      uploadSessionFile: async () => ({ ok: false, code: "use-file-input" }),
      checkForUpdates: async () => ({ available: false }),
      openExternal: (url) => root.open(url, "_blank", "noopener")
    };
  }

  function createElectronRuntime({ bridge = root.maoyanElectron } = {}) {
    if (!bridge) throw new Error("Electron bridge unavailable");
    return { kind: "electron", ...bridge };
  }

  function bridgeRuntime(scope) {
    const bridge = scope.maoyanElectron;
    const methods = ["getRuntimeInfo", "connectWorker", "requestWorker", "loginMaoyan", "uploadSessionFile"];
    if (bridge && methods.every((name) => typeof bridge[name] === "function")) {
      return createElectronRuntime({ bridge });
    }
    return createWebRuntime({
      getWorkerUrl: () => scope.document.getElementById("worker-url")?.value.trim().replace(/\/+$/, "") || location.origin,
      getToken: () => scope.document.getElementById("token-input")?.value.trim() || ""
    });
  }

  root.createWebRuntime = createWebRuntime;
  root.createElectronRuntime = createElectronRuntime;
  root.maoyanRuntime = bridgeRuntime(root);
})(window);
```

The implementation must select Electron only when the preload bridge reports the expected fixed methods; otherwise it must select Web. Add `<script src="runtime.js?...">` before `secure-store.js`, `lock.js`, and `app.js`.

Set the initial `desktop/package.json` script to `"test": "node --test test/*.test.cjs"` and keep the package private; Task 7 adds the start and packaging scripts without changing the test command.

- [ ] **Step 4: Implement the minimal preload and safe main window defaults.**

```js
// desktop/preload/index.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("maoyanElectron", {
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:get-info"),
  connectWorker: (input) => ipcRenderer.invoke("worker:connect", input),
  requestWorker: (path, options) => ipcRenderer.invoke("worker:request", { path, options }),
  loginMaoyan: (cinemaId) => ipcRenderer.invoke("maoyan:login", { cinemaId }),
  cancelMaoyanLogin: () => ipcRenderer.invoke("maoyan:cancel"),
  uploadSessionFile: () => ipcRenderer.invoke("maoyan:upload-file"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openExternal: (url) => ipcRenderer.invoke("external:open", { url })
});
```

`desktop/main/index.js` must load `pages/maoyan/index.html` from the packaged app, set `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and reject main-window navigation away from the local file URL. Register IPC handlers as stubs returning structured `not-ready` responses until Tasks 2-5 replace them; no handler may accept a channel name from renderer.

- [ ] **Step 5: Run the runtime and desktop smoke tests.**

Run: `node --test pages/maoyan/runtime.test.cjs desktop/test/main.test.cjs`

Expected: PASS, including an assertion that the BrowserWindow options contain `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.

- [ ] **Step 6: Commit the independently usable shell.**

```bash
git add desktop pages/maoyan/runtime.js pages/maoyan/runtime.test.cjs pages/maoyan/index.html
git commit -m "feat: add electron shell and shared runtime adapter"
```

---

### Task 2: Implement Worker URL normalization, profile isolation, and secure Token storage

**Files:**
- Create: `desktop/main/credential-store.js`
- Create: `desktop/main/worker-client.js`
- Create: `desktop/test/credential-store.test.cjs`
- Create: `desktop/test/worker-client.test.cjs`
- Modify: `desktop/main/index.js`
- Modify: `desktop/preload/index.js`

**Interfaces:**
- `normalizeWorkerUrl(input)` returns `{ baseUrl, protocol, hostname, isLoopback, requiresHttpConfirmation }`.
- `createWorkerClient({ app, safeStorage, fetchImpl, confirmHttp })` returns `connectWorker`, `requestWorker`, `getProfile`, `clearProfile`.
- `createCredentialStore({ app, safeStorage })` returns `getToken(profileKey)`, `setToken(profileKey, token)`, `clearToken(profileKey)`, `isPersistent()`.
- Profile preferences contain only normalized URL, timestamps, and risk flags; Token values never appear in preference JSON.

- [ ] **Step 1: Write URL, risk, and request-boundary tests.**

```js
test("normalizes an HTTPS Worker and rejects credentials/query/fragment", () => {
  assert.equal(normalizeWorkerUrl(" https://worker.example/api/ ").baseUrl, "https://worker.example/api");
  assert.throws(() => normalizeWorkerUrl("https://u:p@worker.example"), /用户名|密码/);
  assert.throws(() => normalizeWorkerUrl("https://worker.example?token=x"), /查询|fragment/);
  assert.throws(() => normalizeWorkerUrl("file:///tmp/worker"), /HTTP|HTTPS/);
});

test("non-loopback HTTP requires confirmation before connect and upload", async () => {
  const client = createWorkerClient({ ...fixtures, confirmHttp: async () => false });
  await assert.rejects(client.connectWorker({ workerUrl: "http://worker.example", token: "t" }), /确认/);
});

test("requestWorker cannot send absolute URLs or arbitrary headers", async () => {
  const client = connectedClient();
  await assert.rejects(client.requestWorker("https://evil.example/api/status"), /路径/);
  await assert.rejects(client.requestWorker("/api/status", { headers: { Cookie: "secret" } }), /Header/);
});
```

- [ ] **Step 2: Run focused tests and confirm they fail.**

Run: `npm --prefix desktop test -- --test-name-pattern "normalizes|requires confirmation|arbitrary headers"`

Expected: FAIL because the client and credential store are not implemented.

- [ ] **Step 3: Implement `normalizeWorkerUrl` and profile persistence.**

Use `new URL`, trim one trailing slash, preserve an optional path and port, reject `username`, `password`, `search`, and `hash`, and accept only `http:`/`https:`. Treat empty hostname, `localhost`, `127.0.0.1`, and `::1` as loopback. Store profile keys as the complete normalized `baseUrl`; never use only hostname so two ports or paths cannot share credentials.

- [ ] **Step 4: Implement the secure credential store without plaintext fallback.**

When `safeStorage.isEncryptionAvailable()` is true, encrypt each profile token with `safeStorage.encryptString` and persist only base64 ciphertext under the app user-data directory. When unavailable, keep a `Map` in process memory and make `isPersistent()` return `false`. On startup, malformed ciphertext is treated as missing; do not log or return the stored value except to the main-process request builder.

- [ ] **Step 5: Implement the Worker client and IPC validation.**

`connectWorker` must normalize the URL, require `httpRiskConfirmed` for non-loopback HTTP, save the token under the normalized profile key, issue `GET /api/status`, and return only status/profile metadata. On a failed status request, clear only the newly supplied token and leave other profiles unchanged. `requestWorker` must allow `GET`, `POST`, `PUT`, and `DELETE`, require `/api/` relative paths, cap JSON bodies at 256 KiB, construct only `X-Token` and `Content-Type`, and return parsed JSON. `POST /api/lock/session` additionally requires the second HTTP risk confirmation before the body is sent.

- [ ] **Step 6: Add main-process tests for profile switching and secure-storage fallback.**

Run: `npm --prefix desktop test -- worker-client.test.cjs credential-store.test.cjs`

Expected: PASS for two normalized Worker URLs having independent tokens, HTTP risk flags not carrying to a new profile, and no plaintext token in the preferences file when safe storage is unavailable.

- [ ] **Step 7: Commit the Worker security layer.**

```bash
git add desktop/main/index.js desktop/main/worker-client.js desktop/main/credential-store.js desktop/preload/index.js desktop/test
git commit -m "feat: isolate worker profiles and protect electron tokens"
```

---

### Task 3: Route the shared page through runtime and expose Worker/HTTP state

**Files:**
- Modify: `pages/maoyan/app.js`
- Modify: `pages/maoyan/index.html`
- Modify: `pages/maoyan/style.css`
- Modify: `pages/maoyan/runtime.js`
- Modify: `pages/maoyan/app.test.cjs`

**Interfaces:**
- `app.js` calls only `runtime.requestWorker`, never direct `fetch` for Worker APIs.
- Runtime `connectWorker` receives `{ workerUrl, token, httpRiskConfirmed }` and returns `{ profile, httpRisk, status }`.
- `runtime.getRuntimeInfo()` returns `{ kind: "web" | "electron", canLoginMaoyan, persistentTokenStorage }`.

- [ ] **Step 1: Add regression tests for the visible Worker URL and profile reset.**

```js
test("login markup exposes the Worker URL input", () => {
  assert.doesNotMatch(indexHtml, /id="worker-url"[^>]*class="hidden"/);
});

test("switching profiles clears cinema and lock state before reconnect", async () => {
  const state = createAppStateFixture({ cinemaId: "25428", selectedMovies: ["1"] });
  await switchWorkerProfile(state, "https://second.example");
  assert.equal(state.cinemaId, "");
  assert.deepEqual(state.selectedMovies, []);
});
```

The test file must define `createAppStateFixture(initial)` with `{ cinemaId, selectedMovies, lockOpen: true }` and exercise the exported `switchWorkerProfile(state, normalizedUrl)` helper; the helper clears `cinemaId`, `selectedMovies`, and `lockOpen` before updating the profile key.

- [ ] **Step 2: Run existing page tests to capture the current behavior.**

Run: `node --test pages/maoyan/app.test.cjs pages/maoyan/lock.test.cjs`

Expected: Existing tests pass; the new visibility/reset assertions fail until the adapter is wired.

- [ ] **Step 3: Replace direct `api()` transport with `runtime.requestWorker`.**

Keep the existing response/error behavior and progress indicator, but make `api(path, options)` call `window.maoyanRuntime.requestWorker(path, options)`. Web runtime retains `secure-store.js` and localStorage behavior. Electron connect sends the typed token once, then clears `#token-input`; subsequent calls obtain the token in the main process. Do not put the token in renderer localStorage in Electron.

- [ ] **Step 4: Make the Worker URL input visible and add connection state.**

Remove the `hidden` class from the Worker URL label/input. Add a small status node near `#status-line` with text `HTTPS` or `不安全 HTTP 连接`; the Electron runtime supplies `httpRisk` and the Web runtime derives it from the normalized URL. For HTTPS-page-to-HTTP Web failures, map mixed-content/network errors to a Chinese message that recommends HTTPS Worker or Electron.

- [ ] **Step 5: Implement profile switch cleanup.**

Before connecting a different normalized base URL, set `connected=false`, clear selected cinema/movie/seat/rule UI, call `lockController.close()`, remove stale status text and stop monitor UI updates. Only after the new `/api/status` succeeds should `loadCities()` and `restoreConfig()` run. Keep Worker address preference per runtime rules; never send the previous token to the new base URL.

- [ ] **Step 6: Run the full page regression tests.**

Run: `node --test pages/maoyan/app.test.cjs pages/maoyan/lock.test.cjs pages/maoyan/runtime.test.cjs`

Expected: PASS with visible Worker URL, runtime-mediated API calls, and no regression to monitor, push, cinema, or lock availability flows.

- [ ] **Step 7: Commit the shared page transport changes.**

```bash
git add pages/maoyan/app.js pages/maoyan/index.html pages/maoyan/style.css pages/maoyan/runtime.js pages/maoyan/app.test.cjs
git commit -m "feat: route maoyan page through shared runtime"
```

---

### Task 4: Update the lock modal for Electron login and main-process file upload

**Files:**
- Modify: `pages/maoyan/lock.js`
- Modify: `pages/maoyan/index.html`
- Modify: `pages/maoyan/style.css`
- Modify: `pages/maoyan/lock.test.cjs`

**Interfaces:**
- `createMaoyanLockController({ api, runtime, getContext, onLog })` consumes `runtime.getRuntimeInfo`, `runtime.loginMaoyan`, and `runtime.uploadSessionFile`.
- `runtime.loginMaoyan(cinemaId)` resolves `{ session }` or `{ cancelled: true }`; it never resolves raw cookies.
- `runtime.uploadSessionFile()` resolves `{ session }` or a user-safe error; it never resolves file contents.

- [ ] **Step 1: Add modal tests for both runtime modes and renamed upload action.**

```js
test("web mode disables one-click login and keeps manual upload", () => {
  const dom = mountLock({ runtimeInfo: { kind: "web", canLoginMaoyan: false } });
  assert.equal(dom.loginButton.disabled, true);
  assert.match(dom.loginButton.textContent, /Web.*不支持/);
  assert.match(dom.uploadButton.textContent, /手动上传登录态/);
});

test("electron login updates only the masked session state", async () => {
  const controller = createController({ runtime: electronFixture({ session: { uploaded: true, uidMasked: "UID 123***789" } }) });
  await controller.loginMaoyan();
  assert.equal(controller.getSession().uidMasked, "UID 123***789");
  assert.equal(controller.getSession().cookies, undefined);
});
```

The lock test harness must provide `mountLock({ runtimeInfo })` with detached button/status nodes matching the IDs in `index.html`, and `createController({ runtime })` must return a controller exposing `loginMaoyan()` and `getSession()` for the assertions above.

- [ ] **Step 2: Run lock tests and verify the new interaction fails.**

Run: `node --test pages/maoyan/lock.test.cjs`

Expected: FAIL because the modal has no login button/runtime hooks and still uses the old upload label.

- [ ] **Step 3: Add the two session actions to the modal markup.**

Add `#btn-lock-login` beside `#btn-lock-upload`, change the visible upload text to `手动上传登录态`, and keep the browser file input for Web. The login button is disabled until the Worker is connected and a cinema is selected; `renderSession` continues to show only `uidMasked`, `sourceSavedAt`, and `uploadedAt`.

- [ ] **Step 4: Implement runtime-dependent upload and login handlers.**

For Web, preserve the existing 256 KiB file read and `POST /api/lock/session` call, then clear the input and local string. For Electron, call `runtime.uploadSessionFile()` and let the main process choose/read/validate/upload the file. The renderer receives only the public session status. `loginMaoyan` calls `runtime.loginMaoyan(state.context.cinemaId)`, shows cancellation as informational, and invokes `refreshRemoteState()`/`loadSeats()` only after success.

- [ ] **Step 5: Make session reset and availability behavior consistent.**

Disable both actions while an upload/login is in progress, retain the existing remove-session behavior, and ensure a failed/cancelled Electron operation leaves the previous `state.session` intact. A missing Electron bridge must render the Web-disabled state rather than throw during modal initialization.

- [ ] **Step 6: Run focused and full page tests.**

Run: `node --test pages/maoyan/lock.test.cjs pages/maoyan/app.test.cjs`

Expected: PASS for Web manual upload, Web disabled login, Electron one-click login, cancellation, and no raw session fields in renderer state.

- [ ] **Step 7: Commit the lock modal changes.**

```bash
git add pages/maoyan/lock.js pages/maoyan/index.html pages/maoyan/style.css pages/maoyan/lock.test.cjs
git commit -m "feat: add electron maoyan login actions to lock modal"
```

---

### Task 5: Implement temporary Maoyan login capture, validation, upload, and cleanup

**Files:**
- Create: `desktop/main/maoyan-login.js`
- Create: `desktop/main/session-validation.js`
- Create: `desktop/test/maoyan-login.test.cjs`
- Create: `desktop/test/session-validation.test.cjs`
- Modify: `desktop/main/index.js`
- Modify: `desktop/main/worker-client.js`

**Interfaces:**
- `createMaoyanLogin({ BrowserWindow, session, workerClient, clock, logger })` returns `start(cinemaId)`, `cancel()`, and `dispose()`.
- `captureSession({ cookies, requestHeaders, requestUrl, userAgent })` returns the exact upload shape `{ cookies, csrf, mtgsig, create_order_query, user_agent, saved_at }` or a safe validation error.
- `sanitizeError(error)` removes Token, Cookie, CSRF, `mtgsig`, UID, full request headers/bodies, and Worker query strings from messages.

- [ ] **Step 1: Write validation and navigation-policy tests first.**

```js
test("captureSession keeps only the Worker-compatible fields", () => {
  const session = captureSession({
    cookies: [{ domain: ".maoyan.com", name: "uid", value: "123456789" }, { domain: ".maoyan.com", name: "_csrf", value: "csrf" }],
    requestHeaders: { mtgsig: "sig" },
    requestUrl: "https://www.maoyan.com/ajax/createOrder?yodaReady=h5&csecplatform=4&csecversion=2.6.0&secret=drop",
    userAgent: "Mozilla/5.0"
  });
  assert.deepEqual(session.create_order_query, { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" });
  assert.equal(session.cookies[0].value, "123456789");
  assert.equal(session.secret, undefined);
});

test("top-level navigation permits Maoyan only", () => {
  assert.equal(isAllowedMaoyanNavigation("https://www.maoyan.com/"), true);
  assert.equal(isAllowedMaoyanNavigation("https://passport.maoyan.com/login"), true);
  assert.equal(isAllowedMaoyanNavigation("https://evil.example/"), false);
  assert.equal(isAllowedMaoyanNavigation("http://www.maoyan.com/"), false);
});

test("cancel and timeout preserve the old remote session", async () => {
  const worker = fakeWorkerWithExistingSession();
  const login = createMaoyanLogin(testFixtures(worker));
  const result = await login.start("25428");
  assert.equal(result.cancelled, true);
  assert.deepEqual(worker.session, worker.originalSession);
  assert.equal(worker.clearTemporarySessionCalled, true);
});
```

`fakeWorkerWithExistingSession()` returns `{ originalSession, session, clearTemporarySessionCalled, uploadSession, getSessionStatus }`, while `testFixtures(worker)` supplies a fake `BrowserWindow`, temporary Session, clock, and logger. The fake window closes immediately so `start()` follows the cancellation path without contacting the Worker.

- [ ] **Step 2: Run the focused tests and confirm capture is not implemented.**

Run: `npm --prefix desktop test -- maoyan-login.test.cjs session-validation.test.cjs`

Expected: FAIL because the validation module, navigation predicate, and login controller do not yet exist.

- [ ] **Step 3: Implement Worker-compatible session validation.**

Filter cookies to `*.maoyan.com`, keep valid cookie names and values within the Worker limits, require numeric `uid`, non-empty `_csrf`, non-empty `mtgsig`, and a real User-Agent. Parse only `yodaReady`, `csecplatform`, and `csecversion` from the captured Maoyan request URL and accept only the same safe character set used by `worker/src/maoyan/lock-session.js`. Stamp `saved_at` in UTC. Do not include any other captured header or query value.

- [ ] **Step 4: Implement the disposable login window and capture hooks.**

Create a random non-`persist:` Session partition, a window with no preload and no Node integration, and a 10-minute deadline. Install `will-navigate`/`will-redirect` guards for `https:` Maoyan origin/subdomains. Attach `webRequest.onBeforeSendHeaders` to requests whose URL is under `https://www.maoyan.com`, retaining the latest non-empty `mtgsig` and whitelisted query values. Third-party CAPTCHA subresources may load because only top-level navigation is blocked.

- [ ] **Step 5: Complete login, upload directly, and clean every temporary layer.**

After the user logs in, navigate to `https://www.maoyan.com/cinema/<validated cinemaId>` and trigger the same cinema detail request used by the existing Python script. Read cookies and User-Agent from the temporary Session, validate the object, require HTTP risk confirmation when the current Worker is non-loopback HTTP, and call `POST /api/lock/session` through `workerClient`. Return only the public session status to renderer. In all paths (success, cancel, timeout, validation failure, Worker failure, renderer disconnect), clear cookies, cache, storage data, remove request listeners, destroy the window, and leave the pre-existing Worker session unchanged on failure.

- [ ] **Step 6: Add redacted logging assertions.**

Run: `npm --prefix desktop test -- maoyan-login.test.cjs session-validation.test.cjs`

Expected: PASS, including assertions that log records contain phase/status/category but never `mtgsig`, `_csrf`, `Cookie`, full UID, token, request body, or a Worker query string.

- [ ] **Step 7: Wire IPC handlers and verify renderer receives no plaintext.**

`index.js` must keep one active login per main window, reject a second start with a structured busy error, forward `maoyan:cancel`, and return only `{ session }`, `{ cancelled: true }`, or a safe error. Add a test that serializes every IPC result and asserts no sensitive key/value is present.

- [ ] **Step 8: Commit the login implementation.**

```bash
git add desktop/main/maoyan-login.js desktop/main/session-validation.js desktop/main/index.js desktop/main/worker-client.js desktop/test
git commit -m "feat: capture and upload maoyan sessions in electron"
```

---

### Task 6: Add Electron manual file picker and release update checks

**Files:**
- Modify: `desktop/main/index.js`
- Modify: `desktop/main/worker-client.js`
- Create: `desktop/main/updates.js`
- Create: `desktop/test/updates.test.cjs`
- Modify: `pages/maoyan/app.js`
- Modify: `pages/maoyan/index.html`
- Modify: `pages/maoyan/style.css`

**Interfaces:**
- `uploadSessionFile` opens one native JSON file, caps it at 256 KiB, parses/validates/uploads in main, and returns public session status only.
- `checkForUpdates({ currentVersion, fetchImpl })` returns `{ available, version, notes, releaseUrl }` using `https://api.github.com/repos/shovelshit/tools/releases/latest`.
- `openExternal(url)` accepts only the validated GitHub release URL or approved HTTP/HTTPS user links.

- [ ] **Step 1: Write update comparison and file-picker privacy tests.**

```js
test("update check accepts only the fixed GitHub release endpoint", async () => {
  const result = await checkForUpdates({
    currentVersion: "1.0.0",
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v1.1.0", body: "notes", html_url: "https://github.com/shovelshit/tools/releases/tag/v1.1.0" }) })
  });
  assert.deepEqual(result, { available: true, version: "1.1.0", notes: "notes", releaseUrl: "https://github.com/shovelshit/tools/releases/tag/v1.1.0" });
});

test("native upload never returns file contents", async () => {
  const result = await uploadSessionFileWithFixture({ json: validSessionJson() });
  assert.equal(result.session.cookies, undefined);
  assert.equal(result.session.uploaded, true);
});
```

`uploadSessionFileWithFixture({ json })` runs the main-process handler with a fake `dialog.showOpenDialog`, a temporary file path and a fake Worker client; `validSessionJson()` returns a JSON string containing numeric `uid`, `_csrf`, `mtgsig`, `user_agent`, and the three whitelisted query keys.

- [ ] **Step 2: Implement native JSON upload in the main process.**

Use `dialog.showOpenDialog` with `properties: ["openFile"]` and JSON filters. `stat` the chosen path before reading, reject over 256 KiB, parse JSON, pass through the same `session-validation.js` logic, and upload through the current Worker profile. Clear the local string and never send it through IPC. Cancel returns `{ cancelled: true }` without changing the cloud session.

- [ ] **Step 3: Implement fixed-source version checking and safe external navigation.**

Require HTTPS for the GitHub API and release URLs, reject redirects to other hosts, compare normalized semver-like `major.minor.patch` values, truncate release notes to a bounded length, and map network/JSON errors to a generic update-unavailable result. `openExternal` must validate the URL before calling Electron shell and must never open a Worker URL as a page.

- [ ] **Step 4: Add unobtrusive update UI and HTTP warning persistence.**

On app ready, invoke `checkForUpdates` once per 24 hours and show a status line with the new version and a button opening the official release page. Display an explicit unsigned-app note in the release dialog. Persist only per-profile `httpRiskConfirmed` and `httpSessionUploadConfirmed` flags, and show `不安全 HTTP 连接` while active.

- [ ] **Step 5: Run the update and upload tests.**

Run: `npm --prefix desktop test -- updates.test.cjs` and `node --test pages/maoyan/app.test.cjs pages/maoyan/lock.test.cjs`

Expected: PASS for cancel/oversize/invalid JSON upload, no renderer file contents, fixed Releases source, manual open behavior, and visible risk/update state.

- [ ] **Step 6: Commit release and native-upload changes.**

```bash
git add desktop/main desktop/test pages/maoyan/app.js pages/maoyan/index.html pages/maoyan/style.css
git commit -m "feat: add native session upload and release checks"
```

---

### Task 7: Add cross-platform packaging, CI, and end-to-end regression coverage

**Files:**
- Modify: `desktop/package.json`
- Create: `.github/workflows/electron.yml`
- Create: `desktop/test/integration.test.cjs`
- Create: `desktop/README.md`

**Interfaces:**
- `npm --prefix desktop test` runs all desktop unit/integration tests with Node’s built-in test runner.
- `npm --prefix desktop run package:mac` builds unsigned arm64/x64 macOS artifacts on macOS.
- `npm --prefix desktop run package:win` builds unsigned Windows x64 artifacts on Windows.
- CI runs `npm --prefix worker test` before packaging and publishes SHA-256 files as release artifacts.

- [ ] **Step 1: Add mock Worker and mock Maoyan integration tests.**

```js
test("profile switching cannot reuse the old token or page state", async () => {
  const app = await launchWithMockWorker({
    workers: {
      "https://one.example": { token: "one-token" },
      "https://two.example": { token: "two-token" }
    }
  });
  await app.connect("https://one.example", "one-token");
  await app.connect("https://two.example", "two-token");
  assert.deepEqual(app.requestLog.map((item) => item.headers["X-Token"]), ["one-token", "two-token"]);
  assert.equal(app.rendererCanRead("cookies"), false);
});

test("failed login leaves the existing Worker session intact", async () => {
  const app = await launchWithMockWorker({ existingSession: { uploaded: true }, login: "upload-fails" });
  await assert.rejects(app.login("25428"), /上传失败/);
  assert.deepEqual(await app.workerSession(), { uploaded: true });
});
```

- [ ] **Step 2: Run integration tests against the current implementation.**

Run: `npm --prefix desktop test -- integration.test.cjs`

Expected: FAIL only for not-yet-wired mock Electron interactions; the Worker mock must already answer `/api/status`, `/api/config`, `/api/lock/session`, `/api/lock/session/status`, and `/api/lock/session/remove` with the existing response shapes.

- [ ] **Step 3: Configure deterministic package scripts and electron-builder targets.**

Add scripts `test`, `start`, `package:mac`, and `package:win`. Configure unsigned macOS `dmg`/`zip` for `arm64` and `x64`, Windows `nsis`/`zip` for `x64`, and include `pages/maoyan`, `desktop/main`, and `desktop/preload` in the packaged files. Keep `asar` enabled; do not include `local/.maoyan-lock-session.json`, `.maoyan-lock-profile`, `.dev.vars`, or any user-data directory.

- [ ] **Step 4: Add CI build and checksum steps.**

The workflow must run on `macos-latest` and `windows-latest`, install the pinned desktop dependencies, run Worker tests and desktop tests, build the platform artifact, execute `shasum -a 256` on macOS or `certutil -hashfile ... SHA256` on Windows, and upload artifacts. It must not auto-publish or auto-install on user machines. Release documentation must state that artifacts are unsigned and may trigger Gatekeeper/SmartScreen warnings.

- [ ] **Step 5: Add the operator README.**

Document supported platforms, first-run Worker URL/token setup, HTTP risk prompts, Electron “登录猫眼” flow, Web manual upload fallback, cancellation/timeout semantics, where to find GitHub Releases checksums, and the fact that the app creates unpaid orders only. Do not document or expose local session file paths as a supported workflow.

- [ ] **Step 6: Run all verification commands.**

Run:

```bash
npm --prefix worker test
npm --prefix desktop test
node --test pages/maoyan/app.test.cjs pages/maoyan/lock.test.cjs pages/maoyan/runtime.test.cjs
npm --prefix desktop run package:mac -- --dir   # on macOS, smoke package without signing
npm --prefix desktop run package:win -- --dir   # on Windows, smoke package without signing
```

Expected: all Worker/page/desktop tests pass; each platform package starts to the local shared page, displays the Worker URL, and does not load a remote Worker page. On a platform that cannot build the other target, CI supplies the corresponding artifact check.

- [ ] **Step 7: Commit the packaging and verification layer.**

```bash
git add desktop/package.json desktop/README.md desktop/test/integration.test.cjs .github/workflows/electron.yml
git commit -m "build: package unsigned maoyan electron clients"
```

---

## Self-Review Checklist

- Spec coverage: Tasks 1-3 cover the shared source/runtime, Worker URL visibility, profile isolation, safe storage, HTTP confirmation, and main-window security. Task 4 covers the modal copy and Web/Electron upload behavior. Task 5 covers top-level navigation, capture fields, timeout/cancel/failure cleanup, and redacted logs. Task 6 covers native file upload, release checks, manual updates, and unsigned warnings. Task 7 covers mock Worker/猫眼 integration, platform artifacts, checksums, and full regression.
- Placeholder scan: no task depends on a future unnamed decision; every named interface, command, and file is specified above.
- Type consistency: `requestWorker`, `loginMaoyan`, `uploadSessionFile`, `normalizeWorkerUrl`, `captureSession`, and `checkForUpdates` signatures are reused consistently across Tasks 1-7.
- Sensitive-data review: no task writes the captured session to a file, returns it through preload, logs it, or sends it to a Worker before the explicit HTTP risk gate.
