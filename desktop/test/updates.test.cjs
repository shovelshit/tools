const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkForUpdates, GITEE_RELEASES_API, isOfficialReleaseUrl, openExternal } = require("../main/updates");

function loadMain(electron = {
  app: { whenReady: () => new Promise(() => {}), on() {} },
  BrowserWindow: {}, dialog: {}, ipcMain: {}, safeStorage: {}, session: {}, shell: {}
}) {
  const mainPath = path.join(__dirname, "..", "main", "index.js");
  delete require.cache[mainPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(mainPath);
  } finally {
    Module._load = originalLoad;
  }
}

const { uploadSessionFile } = loadMain();

function validSessionJson() {
  return JSON.stringify({
    uid: 123456789,
    _csrf: "csrf-secret",
    mtgsig: "signature-secret",
    user_agent: "Mozilla/5.0",
    yodaReady: "h5",
    csecplatform: "4",
    csecversion: "2.6.0"
  });
}

async function uploadSessionFileWithFixture({ json = validSessionJson(), cancelled = false, fileSize } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-native-upload-"));
  const filePath = path.join(directory, "session.json");
  fs.writeFileSync(filePath, json);
  const uploaded = [];
  try {
    const result = await uploadSessionFile({
      dialog: { showOpenDialog: async () => ({ canceled: cancelled, filePaths: cancelled ? [] : [filePath] }) },
      workerClient: {
        prepareSessionUpload() {
          return async (payload) => {
            uploaded.push(payload);
            return { session: { uploaded: true, uidMasked: "UID 123***789", cookies: payload.cookies, mtgsig: payload.mtgsig } };
          };
        }
      },
      fs: {
        open: async () => {
          const handle = await fs.promises.open(filePath, "r");
          if (fileSize === undefined) return handle;
          return {
            stat: async () => ({ size: fileSize, isFile: () => true }),
            read: handle.read.bind(handle),
            close: handle.close.bind(handle)
          };
        }
      }
    });
    return { result, uploaded };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("update check accepts only the fixed GitHub release endpoint", async () => {
  const calls = [];
  const result = await checkForUpdates({
    currentVersion: "1.0.0",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          tag_name: "v1.1.0",
          body: "notes",
          html_url: "https://github.com/shovelshit/tools/releases/tag/v1.1.0"
        })
      };
    }
  });

  assert.deepEqual(result, {
    available: true,
    version: "1.1.0",
    notes: "notes",
    releaseUrl: "https://github.com/shovelshit/tools/releases/tag/v1.1.0"
  });
  assert.deepEqual(calls, [{ url: GITEE_RELEASES_API, options: { redirect: "error" } }]);
});

test("update check rejects redirected or non-official releases without exposing failures", async () => {
  const result = await checkForUpdates({
    currentVersion: "1.0.0",
    fetchImpl: async () => ({
      ok: true,
      url: "https://evil.example/releases/latest",
      json: async () => ({ tag_name: "v9.0.0", body: "ignore", html_url: "https://evil.example/release" })
    })
  });

  assert.deepEqual(result, { available: false });
  assert.equal(isOfficialReleaseUrl("https://github.com/shovelshit/tools/releases/tag/v1.1.0"), true);
  assert.equal(isOfficialReleaseUrl("http://github.com/shovelshit/tools/releases/tag/v1.1.0"), false);
  assert.equal(isOfficialReleaseUrl("https://github.com/shovelshit/other/releases/tag/v1.1.0"), false);
});

test("manual release open accepts the checked official page but never opens a Worker page", async () => {
  const opened = [];
  const shell = { openExternal: async (url) => { opened.push(url); } };
  const releaseUrl = "https://github.com/shovelshit/tools/releases/tag/v1.1.0";

  assert.deepEqual(await openExternal(releaseUrl, {
    shell,
    approvedUrls: [releaseUrl],
    workerProfile: { baseUrl: "https://worker.example" }
  }), { opened: true });
  assert.deepEqual(await openExternal("https://worker.example/api/status", {
    shell,
    approvedUrls: ["https://worker.example/api/status"],
    workerProfile: { baseUrl: "https://worker.example" }
  }), { opened: false });
  assert.deepEqual(await openExternal("https://example.com", { shell }), { opened: false });
  assert.deepEqual(opened, [releaseUrl]);
});

test("fixed setup links open only their exact trusted HTTPS destinations", async () => {
  const opened = [];
  const shell = { openExternal: async (url) => opened.push(url) };
  const links = ["https://apps.apple.com/cn/app/id1403753865", "https://sct.ftqq.com/sendkey"];
  for (const link of links) assert.deepEqual(await openExternal(link, { shell }), { opened: true });
  for (const link of [
    "http://sct.ftqq.com/sendkey", "https://sct.ftqq.com/sendkey?redirect=https://evil.example", "https://sct.ftqq.com/sendkey#secret",
    "https://sct.ftqq.com/sendkey/other", "https://sct.ftqq.com.evil.example/sendkey", "https://user@sct.ftqq.com/sendkey",
    "https://sct.ftqq.com:8443/sendkey", "https://apps.apple.com/cn/app/id999999", "https://apps.apple.com.evil.example/cn/app/id1403753865",
    "javascript:alert(1)", "file:///tmp/session.json", "https://worker.example/api/status"
  ]) assert.deepEqual(await openExternal(link, { shell }), { opened: false }, link);
  for (const link of links) {
    assert.deepEqual(await openExternal(link, { shell, workerProfile: { baseUrl: new URL(link).origin } }), { opened: false });
    assert.deepEqual(await openExternal(link, { shell, workerProfile: { baseUrl: link } }), { opened: false });
  }
  assert.deepEqual(opened, links);
});

test("native upload never returns file contents", async () => {
  const { result, uploaded } = await uploadSessionFileWithFixture();

  assert.deepEqual(result, { session: { uploaded: true, uidMasked: "UID 123***789" } });
  assert.equal(result.session.cookies, undefined);
  assert.equal(result.session.mtgsig, undefined);
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0].create_order_query, { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" });
});

test("native upload accepts the local Python session export and drops untrusted fields", async () => {
  const { result, uploaded } = await uploadSessionFileWithFixture({ json: JSON.stringify({
    cookies: [
      { domain: ".maoyan.com", name: "uid", value: "123456789" },
      { domain: ".maoyan.com", name: "_csrf", value: "csrf-secret" },
      { domain: "evil.example", name: "drop", value: "no" }
    ],
    csrf: "csrf-secret",
    mtgsig: "signature-secret",
    user_agent: "Mozilla/5.0",
    create_order_query: { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0", injected: "drop" },
    saved_at: "2026-09-15T00:00:00.000Z",
    extra: "drop"
  }) });

  assert.deepEqual(result, { session: { uploaded: true, uidMasked: "UID 123***789" } });
  assert.deepEqual(uploaded, [{
    cookies: [{ name: "uid", value: "123456789" }, { name: "_csrf", value: "csrf-secret" }],
    csrf: "csrf-secret",
    mtgsig: "signature-secret",
    user_agent: "Mozilla/5.0",
    create_order_query: { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" },
    saved_at: "2026-09-15T00:00:00.000Z"
  }]);
});

test("native upload rejects unsafe Python session fields before Worker upload", async () => {
  const exported = {
    cookies: [{ domain: ".maoyan.com", name: "uid", value: "123456789" }, { domain: ".maoyan.com", name: "_csrf", value: "csrf-secret" }],
    csrf: "csrf-secret", mtgsig: "signature-secret", user_agent: "Mozilla/5.0",
    create_order_query: { yodaReady: "h5" }, saved_at: "2026-09-15T00:00:00.000Z"
  };
  for (const changes of [
    { mtgsig: "bad\r\nheader" }, { csrf: " " }, { user_agent: "x".repeat(4097) }
  ]) {
    const { result, uploaded } = await uploadSessionFileWithFixture({ json: JSON.stringify({ ...exported, ...changes }) });

    assert.equal(result.code, "validation");
    assert.deepEqual(uploaded, []);
  }
});

test("native upload leaves the cloud session untouched on cancel, oversize, or invalid JSON", async () => {
  const cancelled = await uploadSessionFileWithFixture({ cancelled: true });
  assert.deepEqual(cancelled, { result: { cancelled: true }, uploaded: [] });

  const oversize = await uploadSessionFileWithFixture({ fileSize: 256 * 1024 + 1 });
  assert.equal(oversize.result.code, "validation");
  assert.deepEqual(oversize.uploaded, []);

  const invalid = await uploadSessionFileWithFixture({ json: "{" });
  assert.equal(invalid.result.code, "validation");
  assert.deepEqual(invalid.uploaded, []);
});

test("native upload rejects a file that grows beyond 256 KiB after stat", async () => {
  const uploaded = [];
  const result = await uploadSessionFile({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/session.json"] }) },
    workerClient: { prepareSessionUpload: () => async (payload) => uploaded.push(payload) },
    fs: {
      open: async () => ({
        stat: async () => ({ size: 2, isFile: () => true }),
        read: async (buffer) => {
          const data = Buffer.from(" ".repeat(256 * 1024) + validSessionJson());
          data.copy(buffer);
          return { bytesRead: buffer.length };
        },
        close: async () => {}
      })
    }
  });

  assert.equal(result.code, "validation");
  assert.deepEqual(uploaded, []);
});

test("native upload reads only the opened regular file and rejects special files", async () => {
  let opened = 0;
  const special = await uploadSessionFile({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/session.json"] }) },
    workerClient: { prepareSessionUpload: () => async () => assert.fail("must not upload") },
    fs: {
      open: async () => {
        opened += 1;
        return { stat: async () => ({ size: 0, isFile: () => false }), read: async () => assert.fail("must not read"), close: async () => {} };
      },
      stat: () => assert.fail("must not stat a path"),
      readFile: () => assert.fail("must not read a path")
    }
  });

  assert.equal(opened, 1);
  assert.equal(special.code, "validation");
});

test("prepared upload rejects a Worker profile switch while the picker is open", async () => {
  let resolvePicker;
  let profile = "a";
  const uploads = [];
  const pending = uploadSessionFile({
    dialog: { showOpenDialog: () => new Promise((resolve) => { resolvePicker = resolve; }) },
    workerClient: {
      prepareSessionUpload: () => {
        const bound = profile;
        return async () => {
          if (profile !== bound) {
            const error = new Error("disconnected");
            error.code = "disconnected";
            throw error;
          }
          uploads.push(bound);
          return { session: { uploaded: true } };
        };
      }
    },
    fs: {
      open: async () => ({
        stat: async () => ({ size: Buffer.byteLength(validSessionJson()), isFile: () => true }),
        read: async (buffer) => {
          const data = Buffer.from(validSessionJson()); data.copy(buffer); return { bytesRead: data.length };
        },
        close: async () => {}
      })
    }
  });
  await new Promise(setImmediate);
  profile = "b";
  resolvePicker({ canceled: false, filePaths: ["/tmp/session.json"] });

  assert.equal((await pending).code, "disconnected");
  assert.deepEqual(uploads, []);
});

test("automatic update checks persist their 24-hour timestamp across main instances", async () => {
  let now = 1_000_000;
  let checked = 0;
  const preference = { lastAutomaticCheckAt: 0, read() { return this.lastAutomaticCheckAt; }, write(value) { this.lastAutomaticCheckAt = value; } };
  const sender = Object.assign(new (require("node:events").EventEmitter)(), {
    mainFrame: {}, getURL: () => require("node:url").pathToFileURL(path.join(__dirname, "../../pages/maoyan/index.html")).href
  });
  const event = { sender, senderFrame: sender.mainFrame };
  const makeHandler = () => {
    const handlers = new Map();
    const electron = {
      app: { whenReady: () => new Promise(() => {}), on() {}, getVersion: () => "1.0.0" },
      BrowserWindow: {}, dialog: {}, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, safeStorage: {}, session: {}, shell: {}
    };
    const { registerIpcHandlers } = loadMain(electron);
    registerIpcHandlers({ workerClient: {}, updatePreference: preference, clock: () => now, updateChecker: async () => { checked += 1; return { available: false }; } });
    return handlers.get("updates:check");
  };

  await makeHandler()(event);
  now += 23 * 60 * 60 * 1000;
  await makeHandler()(event);
  now += 60 * 60 * 1000 + 1;
  await makeHandler()(event);
  assert.equal(checked, 2);
});
