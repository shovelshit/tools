const test = require("node:test");
const assert = require("node:assert/strict");
const { nextPollDelay, createPollingController } = require("./polling.js");

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: "visible",
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    emit(name) { listeners.get(name)?.(); }
  };
}

test("poll delay is active only for visible running or active-lock views", () => {
  assert.equal(nextPollDelay({ visible: false, step: 4, monitorEnabled: true }), null);
  assert.equal(nextPollDelay({ visible: true, step: 3, monitorEnabled: true }), null);
  assert.equal(nextPollDelay({ visible: true, step: 4, monitorEnabled: true }), 180_000);
  assert.equal(nextPollDelay({ visible: true, step: 2, monitorEnabled: false, lockOpen: true, lockActive: true }), 15_000);
});

test("controller suppresses concurrent refreshes and fetches changes only by version", async () => {
  const document = fakeDocument();
  let statusCalls = 0;
  let changeCalls = 0;
  let resolveStatus;
  const statusPromise = new Promise((resolve) => { resolveStatus = resolve; });
  const controller = createPollingController({
    document,
    requestStatus: async () => { statusCalls += 1; return await statusPromise; },
    requestChanges: async () => { changeCalls += 1; return { items: [], nextAfterId: null }; },
    setTimer: () => 1,
    clearTimer: () => {}
  });
  controller.update({ connected: true, step: 4, monitorEnabled: true, profileKey: "one" });
  const first = controller.refresh();
  const second = controller.refresh();
  assert.equal(statusCalls, 1);
  resolveStatus({ changesVersion: 1 });
  await Promise.all([first, second]);
  assert.equal(changeCalls, 1);
  controller.dispose();
});

test("hidden pages make no request and foregrounding refreshes once", async () => {
  const document = fakeDocument();
  let calls = 0;
  const controller = createPollingController({
    document,
    requestStatus: async () => { calls += 1; return { changesVersion: 0 }; },
    requestChanges: async () => ({ items: [] }),
    setTimer: () => 1,
    clearTimer: () => {}
  });
  controller.update({ connected: true, step: 4, monitorEnabled: true });
  document.visibilityState = "hidden";
  document.emit("visibilitychange");
  await controller.refresh();
  assert.equal(calls, 0);
  document.visibilityState = "visible";
  document.emit("visibilitychange");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  controller.dispose();
});

test("manual refresh resets the change cursor and replaces the rendered page", async () => {
  const document = fakeDocument();
  const cursors = [];
  const renders = [];
  let version = 1;
  const controller = createPollingController({
    document,
    requestStatus: async () => ({ changesVersion: version }),
    requestChanges: async (afterId) => {
      cursors.push(afterId);
      return { items: [{ id: afterId == null ? 10 : 11 }], nextAfterId: afterId == null ? 10 : 11 };
    },
    onChanges: (_page, options) => renders.push(options),
    setTimer: () => 1,
    clearTimer: () => {}
  });
  controller.update({ connected: true, step: 4, monitorEnabled: true });
  await controller.refresh();
  version = 2;
  await controller.refresh();
  await controller.refresh({ forceChanges: true });
  assert.deepEqual(cursors, [null, 10, null]);
  assert.deepEqual(renders, [{ reset: true }, { reset: false }, { reset: true }]);
  controller.dispose();
});
