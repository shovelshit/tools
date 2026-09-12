import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole, MemoryKV } from "./helpers.js";
import { OrderAttemptError } from "../src/maoyan/lock-client.js";
import * as lockRunner from "../src/maoyan/lock-runner.js";
import { LockCoordinator, runOneLockRule } from "../src/maoyan/lock-runner.js";
import worker from "../src/index.js";

const tokenId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-11T04:00:00.000Z");

function rule(overrides = {}) {
  return {
    id: "rule-a",
    cinemaId: "25428",
    cinemaName: "测试影院",
    movieId: "7",
    movieName: "测试电影",
    targetDate: "2026-09-12",
    templateTime: "20:00",
    seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N" }],
    state: "waiting_schedule",
    ...overrides
  };
}

function runtime(overrides = {}) {
  return { MAOYAN_KV: new MemoryKV(), LOCK_SERVICE_ENABLED: "true", ...overrides };
}

function deps(stored, overrides = {}) {
  const saved = [];
  return {
    now: () => now,
    getRule: async () => stored,
    putRule: async (_env, _token, value) => { Object.assign(stored, value); saved.push(structuredClone(value)); },
    fetchCinema: async () => ({ showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00" }] }] }] } }),
    findShows: (cinema, input) => cinema.showData.movies[0].shows[0].plist
      .filter((show) => show.tm === input.templateTime)
      .map((show) => ({ ...show, showDate: input.targetDate })),
    loadSession: async () => ({ session: true }),
    fetchSeats: async () => ({ seqNo: "200", sectionId: "1", sectionName: "1号厅", seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: true }] }),
    createOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 }),
    notify: async () => {},
    saved,
    ...overrides
  };
}

test("automation disabled leaves a waiting rule unchanged", async () => {
  const stored = rule();
  const result = await runOneLockRule(runtime({ LOCK_SERVICE_ENABLED: "false" }), tokenId, deps(stored));
  assert.deepEqual(result, { ok: true, skipped: true, disabled: true });
  assert.equal(stored.state, "waiting_schedule");
});

test("scheduled locking receives only the monitored cinema projection", async () => {
  let requestBody;
  const env = runtime({
    LOCK_COORDINATOR: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async (request) => {
          requestBody = await request.json();
          return Response.json({ ok: true, waiting: true });
        }
      })
    }
  });
  const monitoredCinema = {
    providerSecret: "must-not-cross-boundary",
    showData: {
      cinemaName: "测试影院",
      privateField: "must-not-cross-boundary",
      movies: [{ id: 7, nm: "测试电影", privateField: "must-not-cross-boundary", shows: [{
        showDate: "2026-09-12",
        plist: [{ seqNo: "200", tm: "20:00", ticketStatus: 0, privateField: "must-not-cross-boundary" }]
      }] }]
    }
  };

  await lockRunner.runScheduledLockAfterMonitor(env, tokenId, monitoredCinema);

  assert.equal(requestBody.action, "run");
  assert.equal(requestBody.tokenId, tokenId);
  assert.equal(JSON.stringify(requestBody).includes("must-not-cross-boundary"), false);
  assert.deepEqual(requestBody.input.monitoredCinema.showData.movies[0].shows[0].plist[0], {
    seqNo: "200",
    tm: "20:00",
    ticketStatus: 0
  });

  const failedEnv = runtime({
    LOCK_COORDINATOR: {
      idFromName: (id) => id,
      get: () => ({ fetch: async () => Response.json({ ok: false }, { status: 500 }) })
    }
  });
  await assert.rejects(
    () => lockRunner.runScheduledLockAfterMonitor(failedEnv, tokenId, monitoredCinema),
    /锁座协调器执行失败/
  );
});

test("coordinator locks from monitored data without fetching schedules again", async () => {
  const stored = rule();
  let independentFetches = 0;
  let orderCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    independentFetches++;
    throw new Error("independent schedule fetch is forbidden");
  };
  try {
    const coordinator = new LockCoordinator(coordinatorState(), runtime(), deps(stored, {
      fetchCinema: undefined,
      createOrder: async () => {
        orderCalls++;
        return { orderId: "order-1", payLeftSecond: 600 };
      }
    }));
    const response = await coordinator.fetch(coordinatorRequest({
      action: "run",
      tokenId,
      input: { monitoredCinema: {
        showData: {
          cinemaName: "测试影院",
          movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
            { seqNo: "200", tm: "20:00", ticketStatus: 0 }
          ] }] }]
        }
      } }
    }));

    assert.equal(response.status, 200);
    assert.equal(stored.state, "locked");
    assert.equal(orderCalls, 1);
    assert.equal(independentFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the monitor cron hands a persisted monitor result to locking", async () => {
  let coordinatorCalls = 0;
  const env = runtime({
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([{ id: tokenId, token: "access-token" }]),
      [`u:${tokenId}:config`]: JSON.stringify({
        enabled: true,
        cinemaId: "25428",
        selectedMovieIds: ["7"],
        monitorDdl: "2099-01-01T00:00:00.000Z"
      })
    }),
    LOCK_COORDINATOR: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async () => {
          coordinatorCalls++;
          return Response.json({ ok: true, waiting: true });
        }
      })
    }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/ajax/cinemaDetail")) {
      return new Response(JSON.stringify({ showData: {
        cinemaName: "测试影院",
        movies: [{ id: 7, nm: "测试电影", shows: [] }]
      } }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  };
  try {
    await worker.scheduled({ cron: "*/30 * * * *" }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(coordinatorCalls, 1);
  assert.ok(await env.MAOYAN_KV.get(`u:${tokenId}:snapshot`, "json"));
  assert.ok(await env.MAOYAN_KV.get(`u:${tokenId}:status`, "json"));
});

test("automation exact HH:mm locks only selectable matching seats", async () => {
  const stored = rule();
  const result = await runOneLockRule(runtime(), tokenId, deps(stored));
  assert.equal(result.ok, true);
  assert.equal(stored.state, "locked");
  assert.equal(stored.orderId, "order-1");
  assert.equal(stored.payLeftSecond, 600);
  assert.equal(stored.seqNo, "200");
});

test("scheduled lock push renders hall row/seat instead of the internal identifier", async () => {
  const stored = rule({
    seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", type: "N" }],
    targetDate: "2026-09-12"
  });
  let notification;
  const result = await runOneLockRule(runtime(), tokenId, deps(stored, {
    fetchSeats: async () => ({
      seqNo: "200", sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", available: true }]
    }),
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(result.ok, true);
  assert.equal(stored.state, "locked");
  assert.equal(notification.title, "猫眼锁座成功");
  // 实测样本: 1-12-1 是 1 区第 1 排第 12 号座 => 票面「1排12座」
  assert.equal(notification.content, "测试影院 测试电影\n2026-09-12 20:00\n1排12座\n剩余支付时间 600 秒");
  assert.equal(notification.content.includes("1-12-1"), false);
});

test("scheduled lock failure push keeps the readable seat label", async () => {
  const stored = rule({ seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", type: "N" }] });
  let notification;
  await runOneLockRule(runtime(), tokenId, deps(stored, {
    createOrder: async () => { throw new OrderAttemptError("rejected", false); },
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(stored.state, "failed");
  assert.equal(notification.title, "猫眼锁座失败");
  // 失败通知没有支付倒计时
  assert.equal(notification.content, "测试影院 测试电影\n2026-09-12 20:00\n1排12座");
});

test("automation marks a past China target date expired before provider calls", async () => {
  const stored = rule({ targetDate: "2026-09-10" });
  let cinemaCalls = 0;
  await runOneLockRule(runtime(), tokenId, deps(stored, { fetchCinema: async () => { cinemaCalls++; return {}; } }));
  assert.equal(stored.state, "expired");
  assert.equal(cinemaCalls, 0);
});

test("automation keeps no exact HH:mm match waiting without seat request", async () => {
  const stored = rule();
  let seatsCalls = 0;
  await runOneLockRule(runtime(), tokenId, deps(stored, {
    findShows: () => [],
    fetchSeats: async () => { seatsCalls++; return {}; }
  }));
  assert.equal(stored.state, "waiting_schedule");
  assert.equal(seatsCalls, 0);
});

test("automation fails ambiguous exact HH:mm schedules without an order", async () => {
  const stored = rule();
  let orderCalls = 0;
  await runOneLockRule(runtime(), tokenId, deps(stored, {
    findShows: () => [{ seqNo: "200" }, { seqNo: "201" }],
    createOrder: async () => { orderCalls++; return {}; }
  }));
  assert.equal(stored.state, "failed");
  assert.equal(orderCalls, 0);
});

test("automation fails when a selected future seat is unavailable", async () => {
  const stored = rule();
  let orderCalls = 0;
  await runOneLockRule(runtime(), tokenId, deps(stored, {
    fetchSeats: async () => ({ seqNo: "200", seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: false }] }),
    createOrder: async () => { orderCalls++; return {}; }
  }));
  assert.equal(stored.state, "failed");
  assert.equal(orderCalls, 0);
});

test("automation records certain provider rejection as failed and ambiguous order as unknown", async () => {
  const rejected = rule();
  await runOneLockRule(runtime(), tokenId, deps(rejected, {
    createOrder: async () => { throw new OrderAttemptError("rejected", false); }
  }));
  assert.equal(rejected.state, "failed");

  const unknown = rule();
  await runOneLockRule(runtime(), tokenId, deps(unknown, {
    createOrder: async () => { throw new OrderAttemptError("ambiguous", true); }
  }));
  assert.equal(unknown.state, "unknown");
});

test("automation skips terminal and matching rules forever", async () => {
  for (const state of ["locked", "failed", "expired", "unknown", "matching"]) {
    const stored = rule({ state });
    let called = false;
    const result = await runOneLockRule(runtime(), tokenId, deps(stored, { fetchCinema: async () => { called = true; return {}; } }));
    assert.equal(result.skipped, true);
    assert.equal(called, false);
  }
});

function coordinatorState() {
  const data = new Map();
  return { storage: { get: async (key) => data.get(key), put: async (key, value) => data.set(key, value) } };
}

function coordinatorRequest(body) {
  return new Request("https://lock-coordinator/", {
    method: "POST", headers: { "X-Lock-Action": body.action }, body: JSON.stringify(body)
  });
}

test("concurrency serializes a run and skips the second request", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const stored = rule();
  const coordinator = new LockCoordinator(coordinatorState(), runtime(), deps(stored, {
    createOrder: async () => { calls++; await wait; return { orderId: "order-1", payLeftSecond: 600 }; }
  }));
  const first = coordinator.fetch(coordinatorRequest({ action: "run", tokenId }));
  const second = await coordinator.fetch(coordinatorRequest({ action: "run", tokenId }));
  assert.deepEqual(await second.json(), { ok: true, skipped: true });
  release();
  await first;
  assert.equal(calls, 1);
});

test("concurrency serializes rule creation and rejects the second active rule", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let creates = 0;
  const coordinator = new LockCoordinator(coordinatorState(), runtime(), {
    createRule: async () => { creates++; await wait; return { id: "rule-a" }; }
  });
  const first = coordinator.fetch(coordinatorRequest({ action: "create", tokenId, input: {} }));
  const second = await coordinator.fetch(coordinatorRequest({ action: "create", tokenId, input: {} }));
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 201);
  assert.equal(creates, 1);
});

test("concurrency cancellation prevents a delayed run from creating an order or restoring its rule", async () => {
  let release;
  let started;
  const delayed = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { started = resolve; });
  let rulePresent = true;
  let orderCalls = 0;
  const stored = rule();
  const coordinator = new LockCoordinator(coordinatorState(), runtime(), deps(stored, {
    getRule: async () => rulePresent ? stored : null,
    putRule: async (_env, _token, next) => { if (rulePresent) Object.assign(stored, next); },
    removeRule: async () => { rulePresent = false; },
    fetchCinema: async () => { started(); await delayed; return { showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00" }] }] }] } }; },
    createOrder: async () => { orderCalls++; return { orderId: "order-1", payLeftSecond: 600 }; }
  }));
  const run = coordinator.fetch(coordinatorRequest({ action: "run", tokenId }));
  await begun;
  const cancel = coordinator.fetch(coordinatorRequest({ action: "cancel", tokenId }));
  release();
  assert.equal((await cancel).status, 200);
  await run;
  assert.equal(orderCalls, 0);
  assert.equal(rulePresent, false);
});

test("concurrency session removal prevents a delayed run from creating an order or restoring session data", async () => {
  let release;
  let started;
  const delayed = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { started = resolve; });
  let rulePresent = true;
  let sessionPresent = true;
  let orderCalls = 0;
  const stored = rule();
  const coordinator = new LockCoordinator(coordinatorState(), runtime(), deps(stored, {
    getRule: async () => rulePresent ? stored : null,
    putRule: async (_env, _token, next) => { if (rulePresent) Object.assign(stored, next); },
    getSessionStatus: async () => ({ uploaded: sessionPresent }),
    removeRule: async () => { rulePresent = false; },
    removeSession: async () => { sessionPresent = false; },
    fetchCinema: async () => { started(); await delayed; return { showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00" }] }] }] } }; },
    createOrder: async () => { orderCalls++; return { orderId: "order-1", payLeftSecond: 600 }; }
  }));
  const run = coordinator.fetch(coordinatorRequest({ action: "run", tokenId }));
  await begun;
  const removal = coordinator.fetch(coordinatorRequest({ action: "remove-session", tokenId }));
  release();
  assert.equal((await removal).status, 200);
  await run;
  assert.equal(orderCalls, 0);
  assert.equal(rulePresent, false);
  assert.equal(sessionPresent, false);
});

test("concurrency cancellation after matching persistence prevents an order and removes both resources", async () => {
  let release;
  let matchingStarted;
  const delayed = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { matchingStarted = resolve; });
  let rulePresent = true;
  let sessionPresent = true;
  let orderCalls = 0;
  const stored = rule();
  const coordinator = new LockCoordinator(coordinatorState(), runtime(), deps(stored, {
    getRule: async () => rulePresent ? stored : null,
    putRule: async (_env, _token, next) => {
      if (next.state === "matching") {
        matchingStarted();
        await delayed;
      }
      if (rulePresent) Object.assign(stored, next);
    },
    getSessionStatus: async () => ({ uploaded: sessionPresent }),
    removeRule: async () => { rulePresent = false; },
    removeSession: async () => { sessionPresent = false; },
    createOrder: async () => { orderCalls++; return { orderId: "order-1", payLeftSecond: 600 }; }
  }));
  const run = coordinator.fetch(coordinatorRequest({ action: "run", tokenId }));
  await begun;
  const cancel = coordinator.fetch(coordinatorRequest({ action: "cancel", tokenId }));
  const removal = coordinator.fetch(coordinatorRequest({ action: "remove-session", tokenId }));
  release();
  assert.equal((await cancel).status, 200);
  assert.equal((await removal).status, 200);
  await run;
  assert.equal(orderCalls, 0);
  assert.equal(rulePresent, false);
  assert.equal(sessionPresent, false);
});

test("cron reporting keeps every configured monitor schedule", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result: [
    { cron: "*/30 * * * *" }, { cron: "* * * * *" }
  ] }));
  try {
    const freshCron = await import(`../src/maoyan/cron.js?test=${Date.now()}`);
    const monitorCrons = await freshCron.resolveCronExprs({ CF_API_TOKEN: "test", CF_ACCOUNT_ID: "account" });
    assert.deepEqual(monitorCrons, ["*/30 * * * *", "* * * * *"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled rule logs are structured and omit rule identifiers", async () => {
  const stored = rule({
    cinemaName: "影院敏感值",
    movieName: "影片敏感值",
    targetDate: "2026-09-12",
    templateTime: "20:00"
  });
  const { text: logs, entries } = await captureConsole(() => runOneLockRule(
    runtime(),
    tokenId,
    deps(stored, { createOrder: async () => ({ orderId: "order-sensitive", payLeftSecond: 600 }) })
  ));

  assert.equal(entries.every((args) => args.length === 1 && typeof args[0] === "object"), true);
  assert.match(logs, /"scope":"maoyan-lock"/);
  assert.match(logs, /"event":"scheduled_rule"/);
  assert.match(logs, /"state":"locked"/);
  assert.doesNotMatch(logs, /影院敏感值|影片敏感值|2026-09-12|20:00|1-6-18|order-sensitive|11111111/);
});
