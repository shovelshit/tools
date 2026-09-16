const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadLockModule() {
  const source = fs.readFileSync(path.join(__dirname, "lock.js"), "utf8");
  const context = { module: { exports: {} }, exports: {}, Intl, Date, Set };
  vm.runInNewContext(source, context, { filename: "lock.js" });
  return context.module.exports;
}

function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    disabled: false,
    dataset: {},
    files: [],
    innerHTML: "",
    textContent: "",
    title: "",
    value: "",
    checked: false,
    selectedOptions: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
    closest: () => fakeElement(),
    append: () => {},
    setAttribute(name, value) { this[name] = String(value); },
    removeAttribute: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 })
  };
}

function mountLock({
  runtimeInfo, runtime: runtimeOverrides = {}, context: contextOverrides = {}, api: apiOverrides = {},
  getProfileGeneration, isProfileGenerationCurrent
} = {}) {
  const ids = [
    "btn-lock-seats", "lock-overlay", "btn-lock-close", "lock-cinema", "lock-movie", "lock-template",
    "lock-target-date", "lock-session-file", "btn-lock-login", "btn-lock-upload", "btn-lock-remove-session",
    "lock-session-status", "lock-seat-grid", "lock-seat-count", "lock-risk-accepted", "lock-rule-status",
    "btn-lock-cancel-rule", "lock-template-label", "lock-seat-source", "btn-lock-seat-feedback", "lock-official-toggle",
    "lock-official-wrap", "lock-official-frame", "btn-official-zoom-in", "btn-official-zoom-out",
    "btn-official-zoom-reset", "official-zoom-label", "lock-official-gesture", "lock-gate-hint",
    "lock-section-schedule", "lock-section-seats", "lock-section-risk", "lock-section-rules", "btn-lock-cancel",
    "btn-lock-submit", "btn-lock-zoom-in", "btn-lock-zoom-out", "btn-lock-zoom-reset", "lock-zoom-label"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  const document = {
    getElementById: (id) => elements[id] || null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const messages = [];
  const root = { document, window: null, showToast: (message, type) => messages.push({ message, type }) };
  root.window = root;
  const source = fs.readFileSync(path.join(__dirname, "lock.js"), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Intl, Date, Set, document, window: root,
    Option: function Option(text, value) { this.text = text; this.value = value; }
  }, { filename: "lock.js" });
  const runtime = {
    kind: runtimeInfo?.kind,
    getRuntimeInfo: () => runtimeInfo,
    loginMaoyan: async () => ({ cancelled: true }),
    uploadSessionFile: async () => ({ cancelled: true }),
    ...runtimeOverrides
  };
  const api = async (path, options) => {
    if (Object.hasOwn(apiOverrides, path)) {
      const result = apiOverrides[path];
      return typeof result === "function" ? result(options) : result;
    }
    if (path === "/api/lock/session/status") return { session: { uploaded: false } };
    if (path === "/api/lock/rule") return { rule: null };
    return {};
  };
  const controller = module.exports.createMaoyanLockController({
    api,
    runtime,
    getProfileGeneration,
    isProfileGenerationCurrent,
    getContext: () => ({
      connected: true, cinemaId: "25428", cinemaName: "测试影院", cinemaSelected: true,
      lockServiceEnabled: true, monitorEnabled: true, movies: [], ...contextOverrides
    })
  });
  return {
    controller,
    messages,
    loginButton: elements["btn-lock-login"],
    uploadButton: elements["btn-lock-upload"],
    fileInput: elements["lock-session-file"]
  };
}

function loadRuntime() {
  const source = fs.readFileSync(path.join(__dirname, "runtime.js"), "utf8");
  const window = { window: null };
  window.window = window;
  vm.runInNewContext(source, { window }, { filename: "runtime.js" });
  return window;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("seat visual state prioritizes selection and never treats unknown as sold", () => {
  const { lockUtils } = loadLockModule();
  assert.equal(lockUtils.seatVisualState({ availability: "sold", available: false }), "sold");
  assert.equal(lockUtils.seatVisualState({ availability: "unknown", available: false }), "unknown");
  assert.equal(lockUtils.seatVisualState({ availability: "sold", available: false }, { selected: true }), "selected");
  assert.equal(lockUtils.seatVisualState({ availability: "sold", available: false }, { isTemplate: true }), "available");
});

test("web mode disables one-click login and keeps manual upload", async () => {
  const dom = mountLock({ runtimeInfo: { kind: "web", canLoginMaoyan: false } });
  await Promise.resolve();
  assert.equal(dom.loginButton.disabled, true);
  assert.match(dom.loginButton.textContent, /Web.*不支持/);
  assert.match(dom.uploadButton.textContent, /手动上传登录态/);
  assert.equal(dom.fileInput.classList.contains("hidden"), false);
});

test("electron login updates only the masked session state", async () => {
  const session = {
    uploaded: true,
    uidMasked: "UID 123***789",
    sourceSavedAt: "2026-09-15T10:00:00.000Z",
    uploadedAt: "2026-09-15T10:01:00.000Z",
    cookies: [{ name: "_m_h5_tk", value: "secret" }]
  };
  const dom = mountLock({
    runtimeInfo: { kind: "electron", canLoginMaoyan: true },
    runtime: { loginMaoyan: async () => ({ session }) },
    api: {
      "/api/lock/session/status": { session },
      "/api/lock/rule": { rule: null }
    }
  });
  await Promise.resolve();
  await dom.controller.loginMaoyan();
  assert.equal(dom.controller.getSession().uidMasked, "UID 123***789");
  assert.equal(dom.controller.getSession().cookies, undefined);
});

test("web upload keeps the file in the renderer only for the upload request", async () => {
  const uploaded = [];
  const dom = mountLock({
    runtimeInfo: { kind: "web", canLoginMaoyan: false },
    api: {
      "/api/lock/session": ({ body }) => {
        uploaded.push(body);
        return { session: { uploaded: true, uidMasked: "UID 456***321", cookies: ["secret"] } };
      }
    }
  });
  dom.fileInput.files = [{ size: 24, text: async () => '{"cookies":["secret"]}' }];
  await dom.controller.uploadSession();
  assert.deepEqual(uploaded, ['{"cookies":["secret"]}']);
  assert.equal(dom.fileInput.value, "");
  assert.equal(dom.controller.getSession().uidMasked, "UID 456***321");
  assert.equal(dom.controller.getSession().cookies, undefined);
});

test("electron manual upload delegates file selection to the runtime", async () => {
  let uploads = 0;
  const session = { uploaded: true, uidMasked: "UID 789***123", sourceSavedAt: "2026-09-15T10:00:00.000Z" };
  const dom = mountLock({
    runtimeInfo: { kind: "electron", canLoginMaoyan: true },
    runtime: { uploadSessionFile: async () => { uploads += 1; return { session }; } },
    api: {
      "/api/lock/session/status": { session },
      "/api/lock/rule": { rule: null }
    }
  });
  await Promise.resolve();
  await dom.controller.uploadSession();
  assert.equal(uploads, 1);
  assert.equal(dom.fileInput.classList.contains("hidden"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(dom.controller.getSession())), session);
});

test("cancelled electron login preserves the previous public session", async () => {
  let calls = 0;
  const session = { uploaded: true, uidMasked: "UID 123***789", uploadedAt: "2026-09-15T10:01:00.000Z" };
  const dom = mountLock({
    runtimeInfo: { kind: "electron", canLoginMaoyan: true },
    runtime: { loginMaoyan: async () => ++calls === 1 ? { session } : { cancelled: true } },
    api: {
      "/api/lock/session/status": { session },
      "/api/lock/rule": { rule: null }
    }
  });
  await Promise.resolve();
  await dom.controller.loginMaoyan();
  await dom.controller.loginMaoyan();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.controller.getSession())), session);
});

test("resolved native unknown errors preserve refresh guidance and the previous session", async () => {
  const message = "The upload outcome is unknown. Refresh the remote session status before trying again.";
  const cleanup = "Temporary login cleanup failed. Please restart the application.";
  for (const [operation, method] of [["loginMaoyan", "loginMaoyan"], ["uploadSession", "uploadSessionFile"]]) {
    let calls = 0;
    const session = { uploaded: true, uidMasked: "UID 123***789" };
    const dom = mountLock({
      runtimeInfo: { kind: "electron", canLoginMaoyan: true },
      runtime: { [method]: async () => ++calls === 1 ? { session } : {
        ok: false, code: "unknown", message, cookies: "sensitive-cookie", error: "sensitive-error",
        warnings: [{ code: "cleanup", message: cleanup, raw: "sensitive-warning" }]
      } },
      api: { "/api/lock/session/status": { session } }
    });
    await Promise.resolve(); await dom.controller[operation](); await dom.controller[operation]();
    assert.match(dom.messages.at(-1).message, /Refresh the remote session status/);
    assert.match(dom.messages.at(-1).message, /restart the application/);
    assert.equal(dom.messages.at(-1).type, "error");
    assert.doesNotMatch(JSON.stringify(dom.messages), /sensitive/);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.controller.getSession())), session);
    assert.equal(dom.loginButton.disabled, false); assert.equal(dom.uploadButton.disabled, false);
  }
});

test("native success and cancellation show cleanup warnings without leaking other result fields", async () => {
  const session = { uploaded: true, uidMasked: "UID 123***789" };
  for (const [operation, method] of [["loginMaoyan", "loginMaoyan"], ["uploadSession", "uploadSessionFile"]]) {
    for (const cancelled of [false, true]) {
      const dom = mountLock({
        runtimeInfo: { kind: "electron", canLoginMaoyan: true },
        runtime: { [method]: async () => ({
          ...(cancelled ? { cancelled: true } : { session }),
          warnings: [{ code: "cleanup", message: "Temporary login cleanup failed. Please restart the application." }, { code: "raw", message: "sensitive-warning" }],
          mtgsig: "sensitive-signature"
        }) },
        api: { "/api/lock/session/status": { session } }
      });
      await Promise.resolve(); await dom.controller[operation]();
      assert.ok(dom.messages.some(({ message, type }) => /restart the application/.test(message) && type === "warn"));
      assert.doesNotMatch(JSON.stringify(dom.messages), /sensitive/);
      assert.equal(dom.controller.getSession().uploaded, !cancelled);
    }
  }
});

test("native promise rejections cannot display unprojected sensitive error messages", async () => {
  for (const [operation, method] of [["loginMaoyan", "loginMaoyan"], ["uploadSession", "uploadSessionFile"]]) {
    const dom = mountLock({
      runtimeInfo: { kind: "electron", canLoginMaoyan: true },
      runtime: { [method]: async () => { throw new Error("sensitive-cookie _csrf=secret mtgsig=secret"); } }
    });
    await Promise.resolve(); await dom.controller[operation]();
    assert.equal(dom.messages.at(-1).type, "error");
    assert.doesNotMatch(dom.messages.at(-1).message, /sensitive|_csrf|mtgsig|secret/);
  }
});

test("profile reset clears a pending web upload without a stale completion re-disabling actions", async () => {
  const fileText = deferred();
  const replacementText = deferred();
  let generation = 0;
  const dom = mountLock({
    runtimeInfo: { kind: "web", canLoginMaoyan: false },
    getProfileGeneration: () => generation,
    isProfileGenerationCurrent: (value) => value === generation
  });
  dom.fileInput.files = [{ size: 24, text: () => fileText.promise }];
  const upload = dom.controller.uploadSession();
  assert.equal(dom.uploadButton.disabled, true);
  generation += 1;
  dom.controller.reset();
  assert.equal(dom.uploadButton.disabled, false);
  dom.fileInput.files = [{ size: 24, text: () => replacementText.promise }];
  const replacement = dom.controller.uploadSession();
  assert.equal(dom.uploadButton.disabled, true);
  fileText.resolve('{"cookies":["stale"]}');
  await upload;
  assert.equal(dom.uploadButton.disabled, true);
  replacementText.resolve('{"cookies":["current"]}');
  await replacement;
  assert.equal(dom.uploadButton.disabled, false);
});

test("profile reset clears a pending electron login without a stale completion re-disabling actions", async () => {
  const oldLogin = deferred();
  const replacementLogin = deferred();
  let attempts = 0;
  let generation = 0;
  const dom = mountLock({
    runtimeInfo: { kind: "electron", canLoginMaoyan: true },
    runtime: { loginMaoyan: () => ++attempts === 1 ? oldLogin.promise : replacementLogin.promise },
    getProfileGeneration: () => generation,
    isProfileGenerationCurrent: (value) => value === generation
  });
  await Promise.resolve();
  const operation = dom.controller.loginMaoyan();
  assert.equal(dom.loginButton.disabled, true);
  generation += 1;
  dom.controller.reset();
  assert.equal(dom.loginButton.disabled, false);
  const replacement = dom.controller.loginMaoyan();
  assert.equal(dom.loginButton.disabled, true);
  oldLogin.resolve({ session: { uploaded: true, uidMasked: "UID stale" } });
  await operation;
  assert.equal(dom.loginButton.disabled, true);
  replacementLogin.resolve({ session: { uploaded: true, uidMasked: "UID current" } });
  await replacement;
  assert.equal(dom.loginButton.disabled, false);
});

test("rejected electron login preserves the previous public session and re-enables actions", async () => {
  let attempts = 0;
  const session = { uploaded: true, uidMasked: "UID 123***789", uploadedAt: "2026-09-15T10:01:00.000Z" };
  const dom = mountLock({
    runtimeInfo: { kind: "electron", canLoginMaoyan: true },
    runtime: { loginMaoyan: async () => ++attempts === 1 ? { session } : Promise.reject(new Error("login rejected")) },
    api: { "/api/lock/session/status": { session }, "/api/lock/rule": { rule: null } }
  });
  await Promise.resolve();
  await dom.controller.loginMaoyan();
  await dom.controller.loginMaoyan();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.controller.getSession())), session);
  assert.equal(dom.loginButton.disabled, false);
  assert.equal(dom.uploadButton.disabled, false);
});

test("rejected electron upload preserves the previous public session and re-enables actions", async () => {
  let attempts = 0;
  const session = { uploaded: true, uidMasked: "UID 789***123", uploadedAt: "2026-09-15T10:01:00.000Z" };
  const dom = mountLock({
    runtimeInfo: { kind: "electron", canLoginMaoyan: true },
    runtime: { uploadSessionFile: async () => ++attempts === 1 ? { session } : Promise.reject(new Error("upload rejected")) },
    api: { "/api/lock/session/status": { session }, "/api/lock/rule": { rule: null } }
  });
  await Promise.resolve();
  await dom.controller.uploadSession();
  await dom.controller.uploadSession();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.controller.getSession())), session);
  assert.equal(dom.loginButton.disabled, false);
  assert.equal(dom.uploadButton.disabled, false);
});

test("old lock refresh and seat responses cannot repopulate reset state", async () => {
  const { createProfileGeneration } = loadRuntime();
  const generation = createProfileGeneration();
  const oldGeneration = generation.current();
  const refresh = deferred();
  const seats = deferred();
  const state = { session: null, seatMap: null };

  const operations = [
    generation.run(oldGeneration, refresh.promise, (value) => { state.session = value; }),
    generation.run(oldGeneration, seats.promise, (value) => { state.seatMap = value; })
  ];
  generation.invalidate();
  refresh.resolve({ uploaded: true });
  seats.resolve({ seats: [{ seatNo: "1-2-3" }] });

  assert.deepEqual(await Promise.all(operations), [false, false]);
  assert.deepEqual(state, { session: null, seatMap: null });
});

test("lock utilities expose selectable current-show templates only", () => {
  const { lockUtils } = loadLockModule();
  const templates = lockUtils.templatesFromMovies([
    {
      id: "7", nm: "测试电影", checked: true, shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", lang: "国语", tp: "2D", th: "1号厅", ticketStatus: 0 },
        { seqNo: "101", tm: "21:00", ticketStatus: 1 },
        { seqNo: "invalid", tm: "22:00", ticketStatus: 0 }
      ] }]
    },
    { id: "8", nm: "未选电影", checked: false, shows: [] }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(templates)), [{
    movieId: "7", movieName: "测试电影", showDate: "2026-09-11", tm: "20:00",
    seqNo: "100", lang: "国语", tp: "2D", th: "1号厅", disabled: false
  }, {
    movieId: "7", movieName: "测试电影", showDate: "2026-09-11", tm: "21:00",
    seqNo: "101", lang: "", tp: "", th: "", disabled: true
  }]);
});

test("lock utilities derive China date bounds and submit readiness", () => {
  const { lockUtils } = loadLockModule();
  const bounds = lockUtils.chinaDateBounds(new Date("2026-09-11T16:30:00.000Z"));
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { min: "2026-09-12", max: "2026-10-12" });

  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-12", riskAccepted: true
  }), true);
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(),
    targetDate: "2026-09-12", riskAccepted: true
  }), false);
});

test("lock utilities derive hall row/seat from the Maoyan seat identifier", () => {
  const { lockUtils } = loadLockModule();
  // 票面口径(真实订单锚定): 排号 = rowId, 座号 = seatNo 第二段;
  // data-no 第三段是影厅内部物理排号(跳过"4排"), 与票面错位, 不可用于展示
  assert.equal(lockUtils.seatDisplayLabel({ seatNo: "1-1-10", rowId: "9" }), "9排1座");
  assert.equal(lockUtils.seatDisplayLabel({ seatNo: "1-12-1", rowId: "1" }), "1排12座");
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.seatPosition({ seatNo: "1-05-07", rowId: "07" }))), { rowNumber: 7, seatNumber: 5 });
  // 只有 seatNo 字符串无法换算票面排号, 原样返回(不猜测)
  assert.equal(lockUtils.seatDisplayLabel("1-12-1"), "1-12-1");
  assert.equal(lockUtils.seatDisplayLabel("unexpected"), "unexpected");
  assert.equal(lockUtils.seatDisplayLabel(""), "");
  assert.equal(lockUtils.seatPosition("unexpected"), null);
  assert.equal(lockUtils.seatPosition({ seatNo: "1-2-x", rowId: "3" }), null);
  assert.equal(lockUtils.seatPosition({ seatNo: "1-2-3" }), null);
});

test("lock utilities detect swapped seatNo segments in laser IMAX halls", () => {
  const { lockUtils } = loadLockModule();
  // 真实座位页锚定(寰映影城大融城 1号激光IMAX厅): data-no=区-排号-座号(11排×35座),
  // 与杜比厅「区-座号-物理排」相反; 固定把第二段当座号会把同排座位挤进同一列(竖条 bug)。
  const imaxSeats = [
    { seatNo: "33-1-29", rowId: "1", columnId: "29" },
    { seatNo: "33-1-30", rowId: "1", columnId: "30" },
    { seatNo: "33-2-31", rowId: "2", columnId: "31" },
    { seatNo: "33-11-1", rowId: "11", columnId: "1" }
  ];
  assert.equal(lockUtils.seatSegmentOf(imaxSeats), 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(lockUtils.seatPosition(imaxSeats[0], 3))),
    { rowNumber: 1, seatNumber: 29 }
  );
  assert.equal(lockUtils.seatDisplayLabel(imaxSeats[0], 3), "1排29座");
  // 杜比厅口径不受影响: 判别回退第二段=座号
  const dolbySeats = [
    { seatNo: "1-12-1", rowId: "1", columnId: "10" },
    { seatNo: "1-1-10", rowId: "9", columnId: "1" }
  ];
  assert.equal(lockUtils.seatSegmentOf(dolbySeats), 2);
  // 保守回退: 无法区分时维持旧口径
  assert.equal(lockUtils.seatSegmentOf([]), 2);
});

test("lock utilities keep hash-delimited and numeric seats selectable and labelled", () => {
  const { lockUtils } = loadLockModule();
  // 金逸 # 样本: 同排 seg2(排号,前导零)恒定、seg3(座号)变化 → 座号在第三段
  const hashSeats = [
    { seatNo: "4401028106#01#01", rowId: "1", columnId: "1" },
    { seatNo: "4401028106#01#02", rowId: "1", columnId: "2" }
  ];
  assert.equal(lockUtils.seatSegmentOf(hashSeats), 3);
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.seatPosition(hashSeats[0], 3))), { rowNumber: 1, seatNumber: 1 });
  assert.equal(lockUtils.seatDisplayLabel(hashSeats[1], 3), "1排2座");
  // 纯数字 seatId: 无段语义 → 用解析列号兜底进座位图(与官方已选气泡同口径)
  const numeric = { seatNo: "7376", rowId: "9", columnId: "12" };
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.seatPosition(numeric, 2))), { rowNumber: 9, seatNumber: 12 });
  assert.equal(lockUtils.seatDisplayLabel(numeric, 2), "9排12座");
  // 既有保守护栏不回退: 非数字段/缺 rowId 仍无法定位
  assert.equal(lockUtils.seatPosition({ seatNo: "1-2-x", rowId: "3" }), null);
  assert.equal(lockUtils.seatPosition({ seatNo: "1-2-3" }), null);
});

test("lock utilities require a selected cinema before enabling lock configuration", () => {
  const { lockUtils } = loadLockModule();
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: true, monitorEnabled: true }), true);
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: false }), false);
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: false, lockServiceEnabled: true }), false);
  assert.equal(lockUtils.isLockAvailable({ connected: false, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: true }), false);
  // 锁座随监控启停: 停止监控后入口禁用; monitorEnabled 缺省(旧调用方)视为可用
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: true, monitorEnabled: false }), false);
});

test("lock utilities allow same-day and future targets within 30 days", () => {
  const { lockUtils } = loadLockModule();
  const now = new Date("2026-09-11T01:00:00.000Z");
  // 日期边界只与今天相关(今天起 30 天内), 不再受模板场次约束
  const bounds = lockUtils.lockDateBounds(now);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { min: "2026-09-11", max: "2026-10-11", valid: true });
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-11", riskAccepted: true, dateBounds: bounds
  }), true);
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-20", riskAccepted: true, dateBounds: bounds
  }), true);
});

test("lock utilities block duplicate submission for an active rule", () => {
  const { lockUtils } = loadLockModule();
  const base = {
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-13", riskAccepted: true,
    dateBounds: { min: "2026-09-12", max: "2026-10-11", valid: true }
  };
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "waiting_schedule" } }), false);
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "matching" } }), false);
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "unknown" } }), false);
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "failed" } }), true);
});

test("lock utilities distinguish immediate locking from a future rule", () => {
  const { lockUtils } = loadLockModule();
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.lockAction("target"))), {
    buttonText: "立即锁座",
    loadingText: "锁座中...",
    successText: "已创建待支付订单"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.lockAction("template"))), {
    buttonText: "保存自动锁座规则",
    loadingText: "保存中...",
    successText: "自动锁座规则已启用"
  });
});

test("movie selection rebuilds shows and reloads the selected seat map", async () => {
  const { lockUtils } = loadLockModule();
  const calls = [];
  const state = { movieId: "7", templateSeqNo: "100" };
  await lockUtils.changeMovieSelection({
    state,
    movieId: "8",
    renderShowOptions: () => calls.push("shows"),
    loadSeats: async () => calls.push("seats")
  });
  assert.deepEqual(state, { movieId: "8", templateSeqNo: "" });
  assert.deepEqual(calls, ["shows", "seats"]);
});

test("target-show selection never defaults to a stopped show", () => {
  const { lockUtils } = loadLockModule();
  const shows = [
    { seqNo: "100", disabled: true },
    { seqNo: "101", disabled: false },
    { seqNo: "102", disabled: false }
  ];
  assert.equal(lockUtils.preferredTargetShow(shows, "102").seqNo, "102");
  assert.equal(lockUtils.preferredTargetShow(shows, "100").seqNo, "101");
  assert.equal(lockUtils.preferredTargetShow([{ seqNo: "100", disabled: true }], ""), null);
});

test("seat resets preserve source warnings unless explicitly cleared", () => {
  const { lockUtils } = loadLockModule();
  const state = {
    seatMap: { seats: [] },
    selectedSeatNos: new Set(["1-6-18"]),
    seatMapSource: "未来推断座位",
    seatMapIsTemplate: true
  };
  lockUtils.clearSeatSelection(state);
  assert.equal(state.seatMap, null);
  assert.equal(state.selectedSeatNos.size, 0);
  assert.equal(state.seatMapSource, "未来推断座位");
  assert.equal(state.seatMapIsTemplate, true);

  lockUtils.clearSeatSelection(state, { clearSource: true });
  assert.equal(state.seatMapSource, "");
  assert.equal(state.seatMapIsTemplate, false);
});

test("couple seats pair directionally by data-st L/R: 24 chains 23, 23 chains 24 (never 22)", () => {
  const { lockUtils } = loadLockModule();
  // 锚定真实数据(万达影城天和广场 2号杜比巨幕厅 19:35 场 11排): L/R 严格交替,
  // 配对为 (1,2),(3,4)...(21,22),(23,24)...; L 是左半(列号小), R 是右半
  const seats = [];
  for (let columnId = 1; columnId <= 30; columnId++) {
    seats.push({
      rowId: "11", columnId: String(columnId), seatNo: `1-${columnId}-12`,
      type: columnId % 2 === 1 ? "L" : "R", available: true
    });
  }
  const bySeatNo = (no) => seats.find((seat) => seat.seatNo === no);
  // 点 24(R) 连 23(L); 点 23(L) 连 24(R) —— 不允许误连 22 拆散 (21,22) 对
  assert.equal(lockUtils.couplePartnerOf(seats, bySeatNo("1-24-12")).seatNo, "1-23-12");
  assert.equal(lockUtils.couplePartnerOf(seats, bySeatNo("1-23-12")).seatNo, "1-24-12");
  assert.equal(lockUtils.couplePartnerOf(seats, bySeatNo("1-22-12")).seatNo, "1-21-12");
  assert.equal(lockUtils.couplePartnerOf(seats, bySeatNo("1-21-12")).seatNo, "1-22-12");
  // 普通座位与未知类型不连锁
  assert.equal(lockUtils.couplePartnerOf(seats, { ...bySeatNo("1-24-12"), type: "N" }), null);
  assert.equal(lockUtils.couplePartnerOf(seats, { ...bySeatNo("1-24-12"), type: "LK" }), null);
  // 同排方向位置上缺另一半返回 null(渲染层据此置灰): L 的右侧无 R、R 的左侧无 L
  const isolatedL = { rowId: "11", columnId: "31", seatNo: "1-31-12", type: "L", available: true };
  assert.equal(lockUtils.couplePartnerOf(seats, isolatedL), null);
  const isolatedR = { rowId: "11", columnId: "0", seatNo: "1-0-12", type: "R", available: true };
  assert.equal(lockUtils.couplePartnerOf(seats, isolatedR), null);
  assert.equal(lockUtils.couplePartnerOf([], bySeatNo("1-24-12")), null);
  assert.equal(lockUtils.couplePartnerOf(null, bySeatNo("1-24-12")), null);
  // 跨排不配对: 即使同列位置存在 L/R
  const otherRow = { rowId: "10", columnId: "24", seatNo: "1-24-11", type: "R", available: true };
  assert.equal(lockUtils.couplePartnerOf([...seats, otherRow], otherRow), null);
});
