const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkForUpdates, GITHUB_RELEASES_API, isOfficialReleaseUrl, openExternal } = require("../main/updates");

function loadMain() {
  const mainPath = path.join(__dirname, "..", "main", "index.js");
  delete require.cache[mainPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { whenReady: () => new Promise(() => {}), on() {} },
        BrowserWindow: {}, dialog: {}, ipcMain: {}, safeStorage: {}, session: {}, shell: {}
      };
    }
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
        stat: async () => ({ size: fileSize ?? fs.statSync(filePath).size }),
        readFile: fs.promises.readFile
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
  assert.deepEqual(calls, [{ url: GITHUB_RELEASES_API, options: { redirect: "error" } }]);
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

test("native upload never returns file contents", async () => {
  const { result, uploaded } = await uploadSessionFileWithFixture();

  assert.deepEqual(result, { session: { uploaded: true, uidMasked: "UID 123***789" } });
  assert.equal(result.session.cookies, undefined);
  assert.equal(result.session.mtgsig, undefined);
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0].create_order_query, { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" });
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
      stat: async () => ({ size: 2 }),
      readFile: async () => " ".repeat(256 * 1024) + validSessionJson()
    }
  });

  assert.equal(result.code, "validation");
  assert.deepEqual(uploaded, []);
});
