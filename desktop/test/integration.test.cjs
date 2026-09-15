const assert = require("node:assert/strict");
const test = require("node:test");
const { launchWithMockWorker } = require("./support/integration.cjs");

test("profile switching isolates tokens, clears page state, and invalidates pending login uploads", async (t) => {
  const app = await launchWithMockWorker(t);
  await app.runtime.connectWorker({ workerUrl: app.worker.url + "/one", token: "one-token" });
  const upload = app.client.prepareSessionUpload();
  const state = { cinemaId: "25428", selectedMovies: ["movie-one"], lockOpen: true, profileKey: "one" };
  const generation = app.window.createProfileGeneration();
  const oldGeneration = generation.current();
  generation.invalidate();
  app.window.switchWorkerProfile(state, app.worker.url + "/two");
  await app.runtime.connectWorker({ workerUrl: app.worker.url + "/two", token: "two-token" });
  assert.deepEqual(state, { cinemaId: "", selectedMovies: [], lockOpen: false, profileKey: app.worker.url + "/two" });
  assert.equal(await generation.run(oldGeneration, Promise.resolve("stale"), () => { state.cinemaId = "stale"; }), false);
  await assert.rejects(upload({}), { code: "disconnected" });
  await app.runtime.requestWorker("/api/config");
  assert.deepEqual(app.worker.requests.map(({ token }) => token), ["one-token", "two-token", "two-token"]);
  assert.equal(app.bridge.cookies, undefined);
  assert.equal(app.bridge.getToken, undefined);
  assert.equal(app.bridge.ipcRenderer, undefined);
});

test("failed Maoyan upload preserves the existing Worker session and cleans the temporary browser", async (t) => {
  const app = await launchWithMockWorker(t, { rejectUpload: true });
  await app.runtime.connectWorker({ workerUrl: app.worker.url + "/one", token: "one-token" });
  const before = await app.runtime.requestWorker("/api/lock/session/status");
  const pending = app.runtime.loginMaoyan("25428");
  await app.authenticate();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "upload");
  assert.deepEqual(await app.runtime.requestWorker("/api/lock/session/status"), before);
  assert.deepEqual(app.worker.requests.filter(({ method }) => method === "POST").map(({ path }) => path), ["/one/api/lock/session"]);
  app.assertClean();
});

test("Maoyan capture travels through main-process HTTP upload and returns only public session metadata", async (t) => {
  const app = await launchWithMockWorker(t);
  await app.runtime.connectWorker({ workerUrl: app.worker.url + "/one", token: "one-token" });
  const pending = app.runtime.loginMaoyan("25428");
  await app.authenticate();
  const result = await pending;
  assert.equal(result.session.uploaded, true);
  assert.equal(app.worker.uploads.length, 1);
  assert.equal(app.worker.uploads[0].mtgsig, "mock-signature-secret");
  assert.equal(app.worker.uploads[0].cookies.find(({ name }) => name === "uid").value, "123456789");
  assert.doesNotMatch(JSON.stringify(result), /mock-signature|mock-csrf|123456789|cookies|mtgsig/);
  assert.deepEqual(await app.runtime.requestWorker("/api/lock/session/remove", { method: "POST" }), { removed: true });
  assert.deepEqual(await app.runtime.requestWorker("/api/lock/session/status"), { session: { uploaded: false } });
  app.assertClean();
});
