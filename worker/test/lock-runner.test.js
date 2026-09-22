import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole, createDB } from "./helpers.js";
import { OrderAttemptError } from "../src/maoyan/lock-client.js";
import * as db from "../src/maoyan/db.js";
import * as lockRunner from "../src/maoyan/lock-runner.js";
import { LockCoordinator, resolveLockTarget, runOneLockRule } from "../src/maoyan/lock-runner.js";
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

async function runtime(overrides = {}) {
  return { DB: await createDB(), LOCK_SERVICE_ENABLED: "true", ...overrides };
}

function deps(stored, overrides = {}) {
  const saved = [];
  return {
    now: () => now,
    requireActive: async () => ({}),
    getRule: async () => stored.deleted ? null : stored,
    removeRule: async () => { stored.deleted = true; },
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

test("resolveLockTarget selects one exact show in the requested hall", () => {
  const target = resolveLockTarget(rule({ hall: "2号厅" }), {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "wrong-hall", tm: "20:00", th: "1号厅" },
      { seqNo: "exact", tm: "20:00", th: "2号厅" }
    ] }] }] }
  });

  assert.equal(target.status, "matched");
  assert.equal(target.show.seqNo, "exact");
  assert.equal(target.matchMode, "exact");
  assert.equal(target.timeDeltaMinutes, 0);
});

test("resolveLockTarget selects the nearest same-hall show within the legacy thirty-minute default", () => {
  const target = resolveLockTarget(rule({ hall: "2号厅", templateTime: "20:00" }), {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "far", tm: "19:35", th: "2号厅", ticketStatus: 0 },
      { seqNo: "near", tm: "20:10", th: "2号厅", ticketStatus: 0 },
      { seqNo: "other-hall", tm: "20:05", th: "1号厅", ticketStatus: 0 }
    ] }] }] }
  });

  assert.equal(target.status, "matched");
  assert.equal(target.show.seqNo, "near");
  assert.equal(target.matchMode, "fuzzy");
  assert.equal(target.timeDeltaMinutes, 10);
});

test("resolveLockTarget deterministically chooses the earlier equally-near same-hall show", () => {
  const target = resolveLockTarget(rule({ hall: "2号厅", templateTime: "20:00" }), {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "early", tm: "19:50", th: "2号厅", ticketStatus: 0 },
      { seqNo: "late", tm: "20:10", th: "2号厅", ticketStatus: 0 }
    ] }] }] }
  });

  assert.equal(target.status, "matched");
  assert.equal(target.show.seqNo, "early");
  assert.equal(target.matchMode, "fuzzy");
  assert.equal(target.timeDeltaMinutes, -10);
});

test("resolveLockTarget uses ascending sequence number for identical fuzzy show times", () => {
  const target = resolveLockTarget(rule({ hall: "2号厅" }), {}, {
    findShows: () => [],
    findCompatibleShows: () => [
      { seqNo: "z-last", tm: "20:10", timeDeltaMinutes: 10 },
      { seqNo: "a-first", tm: "20:10", timeDeltaMinutes: 10 }
    ]
  });

  assert.equal(target.status, "matched");
  assert.equal(target.show.seqNo, "a-first");
});

test("resolveLockTarget accepts a configured tolerance at the inclusive 180-minute boundary", () => {
  const cinema = {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "inside-180", tm: "23:00", th: "2号厅", ticketStatus: 0 }
    ] }] }] }
  };

  const configured = resolveLockTarget(rule({ hall: "2号厅", timeToleranceMinutes: 180 }), cinema);
  assert.equal(configured.status, "matched");
  assert.equal(configured.show.seqNo, "inside-180");
});

test("resolveLockTarget waits when the only configured-tolerance candidate is 181 minutes away", () => {
  const cinema = {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "outside-180", tm: "23:01", th: "2号厅", ticketStatus: 0 }
    ] }] }] }
  };

  assert.deepEqual(resolveLockTarget(rule({ hall: "2号厅", timeToleranceMinutes: 180 }), cinema), { status: "waiting" });
});

test("resolveLockTarget keeps malformed stored tolerance at thirty minutes", () => {
  const cinema = {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "outside-default", tm: "20:31", th: "2号厅", ticketStatus: 0 }
    ] }] }] }
  };
  const legacy = resolveLockTarget(rule({ hall: "2号厅" }), cinema);
  assert.deepEqual(legacy, { status: "waiting" });
  const malformed = resolveLockTarget(rule({ hall: "2号厅", timeToleranceMinutes: 181 }), cinema);
  assert.deepEqual(malformed, { status: "waiting" });
});

test("resolveLockTarget reports no match outside the fuzzy window", () => {
  const target = resolveLockTarget(rule({ hall: "2号厅", templateTime: "20:00" }), {
    showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "late", tm: "20:31", th: "2号厅", ticketStatus: 0 }
    ] }] }] }
  });

  assert.deepEqual(target, { status: "waiting" });
});

test("automation disabled leaves a waiting rule unchanged", async () => {
  const stored = rule();
  const result = await runOneLockRule(await runtime({ LOCK_SERVICE_ENABLED: "false" }), tokenId, deps(stored));
  assert.deepEqual(result, { ok: true, skipped: true, disabled: true });
  assert.equal(stored.state, "waiting_schedule");
});

test("scheduled locking receives only the monitored cinema projection", async () => {
  let requestBody;
  const env = await runtime({
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

  const failedEnv = await runtime({
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
    const coordinator = new LockCoordinator(coordinatorState(), await runtime(), deps(stored, {
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

test("the monitor cron hands a persisted monitor result to locking", async (t) => {
  // cron 入口有北京 23:00~06:59 监控窗口闸(inMonitorWindow): 此前用例读真实墙钟,
  // 深夜跑套件必挂(coordinatorCalls=0)。mock 时钟固定在窗口内(北京 12:00)消除时间依赖。
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  let coordinatorCalls = 0;
  const env = await runtime({
    DB: await createDB({
      tokens: [{ id: tokenId, token: "access-token" }],
      configs: { [tokenId]: {
        enabled: true,
        cinemaId: "25428",
        selectedMovieIds: ["7"],
        monitorDdl: "2099-01-01T00:00:00.000Z"
      } }
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
  assert.ok(Object.keys(await db.getSnapshot(env.DB, tokenId)).length > 0);
  assert.ok(await db.getStatus(env.DB, tokenId));
});

test("automation exact HH:mm locks only selectable matching seats", async () => {
  const stored = rule();
  const result = await runOneLockRule(await runtime(), tokenId, deps(stored));
  assert.equal(result.ok, true);
  assert.equal(stored.state, "locked");
  assert.equal(stored.orderId, "order-1");
  assert.equal(stored.payLeftSecond, 600);
  assert.equal(stored.seqNo, "200");
});

test("scheduled locking rechecks account eligibility immediately before ordering", async () => {
  const stored = rule();
  let orderCalls = 0;
  await assert.rejects(
    runOneLockRule(await runtime(), tokenId, deps(stored, {
      requireActive: async () => {
        const error = new Error("账号已到期，请先续期");
        error.code = "ACCOUNT_EXPIRED";
        throw error;
      },
      createOrder: async () => { orderCalls += 1; return { orderId: "forbidden" }; }
    })),
    { code: "ACCOUNT_EXPIRED" }
  );
  assert.equal(orderCalls, 0);
});

test("scheduled lock push renders hall row/seat instead of the internal identifier", async () => {
  const stored = rule({
    seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", type: "N" }],
    targetDate: "2026-09-12"
  });
  let notification;
  const result = await runOneLockRule(await runtime(), tokenId, deps(stored, {
    fetchSeats: async () => ({
      seqNo: "200", sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", available: true }]
    }),
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(result.ok, true);
  assert.equal(stored.state, "locked");
  assert.equal(notification.title, "✅ 锁座成功｜测试电影");
  // 实测样本: 1-12-1 是 1 区第 1 排第 12 号座 => 票面「1排12座」
  assert.equal(notification.content, "🏢 测试影院\n📅 2026-09-12 20:00\n💺 1排12座\n\n💳 已创建待支付订单，请尽快前往猫眼付款\n🧾 订单号：order-1\n⏳ 猫眼返回剩余支付时间：600 秒");
  assert.equal(notification.content.includes("1-12-1"), false);
});

test("scheduled lock failure push keeps the readable seat label", async () => {
  const stored = rule({ seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", type: "N" }] });
  let notification;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    fetchSeats: async () => ({
      seqNo: "200", sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-12-1", rowId: "1", columnId: "10", available: true }]
    }),
    createOrder: async () => { throw new OrderAttemptError("rejected", false); },
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(stored.deleted, true);
  assert.equal(notification.title, "❌ 锁座失败｜测试电影");
  // 失败通知没有支付倒计时
  assert.equal(notification.content, "🏢 测试影院\n📅 2026-09-12 20:00\n💺 1排12座\n📌 原因：锁座失败，未获得有效订单\n\n👉 请查看当前座位，重新选择");
});

test("automation marks a past China target date expired before provider calls", async () => {
  const stored = rule({ targetDate: "2026-09-10" });
  let cinemaCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, { fetchCinema: async () => { cinemaCalls++; return {}; } }));
  assert.equal(stored.deleted, true);
  assert.equal(cinemaCalls, 0);
});

test("production expiration removes the rule and queues its notification atomically", async () => {
  const DB = await createDB({
    tokens: [{ id: tokenId, token: "access-token" }],
    configs: { [tokenId]: { enabled: true, cinemaId: "25428" } },
    lockRules: { [tokenId]: rule({ targetDate: "2026-09-10" }) }
  });
  let wakes = 0;
  const env = await runtime({
    DB,
    NOTIFICATION_DISPATCHER: {
      idFromName: (id) => id,
      get: () => ({ fetch: async () => { wakes += 1; return Response.json({ ok: true }); } })
    }
  });
  const result = await runOneLockRule(env, tokenId, {
    now: () => now,
    getConfig: async () => ({ version: 1 })
  });
  assert.deepEqual(result, { ok: true, state: "expired" });
  assert.equal(await db.getLockRuleRow(DB, tokenId), null);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 1);
  assert.equal(wakes, 1);
});

test("production order failure deletes the rule, queues failure once, and never retries", async () => {
  const stored = rule();
  const DB = await createDB({
    tokens: [{ id: tokenId, token: "access-token" }],
    configs: { [tokenId]: { enabled: true, cinemaId: "25428" } },
    lockRules: { [tokenId]: stored }
  });
  const env = await runtime({
    DB,
    NOTIFICATION_DISPATCHER: {
      idFromName: (id) => id,
      get: () => ({ fetch: async () => Response.json({ ok: true }) })
    }
  });
  let attempts = 0;
  const options = deps(stored, {
    getConfig: async () => ({ version: 1 }),
    createOrder: async () => { attempts++; const error = new OrderAttemptError("timeout", true); error.detail = "raw-secret"; error.failureDetail = '{"status":403}'; throw error; }
  });
  for (const key of ["getRule", "putRule", "removeRule", "notify"]) delete options[key];
  assert.equal((await runOneLockRule(env, tokenId, options)).state, "failed");
  assert.equal(await db.getLockRuleRow(DB, tokenId), null);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 1);
  assert.equal((await DB.prepare("SELECT failure_detail FROM notification_outbox").first()).failure_detail, '{"status":403}');
  assert.equal((await runOneLockRule(env, tokenId, options)).skipped, true);
  assert.equal(attempts, 1);
});

test("successful order persistence failure does not delete the rule as an order failure", async () => {
  const stored = rule();
  const env = await runtime();
  let attempts = 0;
  await assert.rejects(() => runOneLockRule(env, tokenId, deps(stored, {
    putRule: async (_env, _id, value) => {
      if (value.state === "locked") throw new Error("database unavailable");
      Object.assign(stored, value);
    },
    createOrder: async () => { attempts++; return { orderId: "created-order" }; }
  })), /database unavailable/);
  assert.equal(stored.deleted, undefined);
  assert.equal(stored.state, "matching");
  assert.equal(attempts, 1);
});

test("automation keeps no exact HH:mm match waiting without seat request", async () => {
  const stored = rule();
  let seatsCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [],
    fetchSeats: async () => { seatsCalls++; return {}; }
  }));
  assert.equal(stored.state, "waiting_schedule");
  assert.equal(seatsCalls, 0);
});

test("automation locks a same-hall show within thirty minutes and notifies with actual time", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  let notification;
  let orderCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [],
    findCompatibleShows: () => [{ seqNo: "250", tm: "18:50", th: "1号激光IMAX厅", showDate: stored.targetDate, timeDeltaMinutes: 10, matchMode: "fuzzy" }],
    fetchSeats: async (_session, request) => ({
      seqNo: request.seqNo, sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: true }]
    }),
    createOrder: async () => { orderCalls++; return { orderId: "order-250", payLeftSecond: 600 }; },
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(stored.state, "locked");
  assert.equal(stored.seqNo, "250");
  assert.equal(stored.targetSeqNo, "250");
  assert.equal(stored.targetTime, "18:50");
  assert.equal(stored.matchMode, "fuzzy");
  assert.equal(stored.timeDeltaMinutes, 10);
  assert.equal(orderCalls, 1);
  assert.equal(notification.title, "✅ 锁座成功｜测试电影");
  assert.match(notification.content, /2026-09-12 18:50/);
  assert.match(notification.content, /🔄 场次匹配：18:40 → 18:50（\+10分钟）/);
});

test("automation keeps waiting when no same-hall nearby show exists", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  let notifications = 0;
  let seatsCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [],
    findCompatibleShows: () => [],
    fetchSeats: async () => { seatsCalls++; return {}; },
    notify: async () => { notifications++; }
  }));

  assert.equal(stored.state, "waiting_schedule");
  assert.equal(seatsCalls, 0);
  assert.equal(notifications, 0);
});

test("automation chooses the earlier equally-near nearby show", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  let requestedSeqNo = "";
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [],
    findCompatibleShows: () => [
      { seqNo: "250", tm: "18:30", th: "1号激光IMAX厅", timeDeltaMinutes: -10, matchMode: "fuzzy" },
      { seqNo: "260", tm: "18:50", th: "1号激光IMAX厅", timeDeltaMinutes: 10, matchMode: "fuzzy" }
    ],
    fetchSeats: async (_session, request) => {
      requestedSeqNo = request.seqNo;
      return { seqNo: request.seqNo, sectionId: "1", sectionName: "1号厅", seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: true }] };
    },
    createOrder: async () => ({ orderId: "order-early", payLeftSecond: 600 })
  }));

  assert.equal(requestedSeqNo, "250");
  assert.equal(stored.state, "locked");
  assert.equal(stored.targetTime, "18:30");
});

test("automation notifies when a selected nearby show cannot load its seat map", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  let notification;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [],
    findCompatibleShows: () => [{ seqNo: "250", tm: "18:50", th: "1号激光IMAX厅", timeDeltaMinutes: 10, matchMode: "fuzzy" }],
    fetchSeats: async () => { throw new Error("座位图暂不可用"); },
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(stored.deleted, true);
  assert.equal(notification.title, "❌ 锁座失败｜测试电影");
  assert.match(notification.content, /2026-09-12 18:50/);
});

test("automation accepts the inclusive thirty-minute boundary from the default matcher", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  const result = await runOneLockRule(await runtime(), tokenId, deps(stored, {
    fetchCinema: async () => ({ showData: { movies: [{ id: "7", shows: [{ showDate: stored.targetDate, plist: [
      { seqNo: "270", tm: "19:10", th: "1号激光IMAX厅", ticketStatus: 0 }
    ] }] }] } }),
    findShows: () => [],
    fetchSeats: async (_session, request) => ({
      seqNo: request.seqNo, sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: true }]
    }),
    createOrder: async () => ({ orderId: "order-270", payLeftSecond: 600 })
  }));

  assert.equal(result.state, "locked");
  assert.equal(stored.targetSeqNo, "270");
  assert.equal(stored.timeDeltaMinutes, 30);
});

test("automation does not match a default nearby candidate beyond thirty minutes", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  let orderCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    fetchCinema: async () => ({ showData: { movies: [{ id: "7", shows: [{ showDate: stored.targetDate, plist: [
      { seqNo: "271", tm: "19:11", th: "1号激光IMAX厅", ticketStatus: 0 }
    ] }] }] } }),
    findShows: () => [],
    createOrder: async () => { orderCalls++; return { orderId: "must-not-order", payLeftSecond: 600 }; }
  }));

  assert.equal(stored.state, "waiting_schedule");
  assert.equal(orderCalls, 0);
});

test("automation removes the rule and notifies failure when a fuzzy order has no confirmed success", async () => {
  const stored = rule({ hall: "1号激光IMAX厅", templateTime: "18:40" });
  let notification;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [],
    findCompatibleShows: () => [{ seqNo: "280", tm: "18:50", th: "1号激光IMAX厅", timeDeltaMinutes: 10, matchMode: "fuzzy" }],
    fetchSeats: async (_session, request) => ({
      seqNo: request.seqNo, sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: true }]
    }),
    createOrder: async () => { throw new OrderAttemptError("uncertain", true); },
    notify: async (_config, title, content) => { notification = { title, content }; }
  }));

  assert.equal(stored.deleted, true);
  assert.equal(notification.title, "❌ 锁座失败｜测试电影");
  assert.match(notification.content, /2026-09-12 18:50/);
});

test("automation fails ambiguous exact HH:mm schedules without an order", async () => {
  const stored = rule();
  let orderCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    findShows: () => [{ seqNo: "200" }, { seqNo: "201" }],
    createOrder: async () => { orderCalls++; return {}; }
  }));
  assert.equal(stored.deleted, true);
  assert.equal(orderCalls, 0);
});

test("automation fails when a selected future seat is unavailable", async () => {
  const stored = rule();
  let orderCalls = 0;
  await runOneLockRule(await runtime(), tokenId, deps(stored, {
    fetchSeats: async () => ({ seqNo: "200", seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", available: false }] }),
    createOrder: async () => { orderCalls++; return {}; }
  }));
  assert.equal(stored.deleted, true);
  assert.equal(orderCalls, 0);
});

test("automation removes both rejected and unconfirmed rules", async () => {
  const rejected = rule();
  await runOneLockRule(await runtime(), tokenId, deps(rejected, {
    createOrder: async () => { throw new OrderAttemptError("rejected", false); }
  }));
  assert.equal(rejected.deleted, true);

  const unknown = rule();
  await runOneLockRule(await runtime(), tokenId, deps(unknown, {
    createOrder: async () => { throw new OrderAttemptError("ambiguous", true); }
  }));
  assert.equal(unknown.deleted, true);
});

test("automation skips terminal and matching rules forever", async () => {
  for (const state of ["locked", "failed", "expired", "unknown", "matching"]) {
    const stored = rule({ state });
    let called = false;
    const result = await runOneLockRule(await runtime(), tokenId, deps(stored, { fetchCinema: async () => { called = true; return {}; } }));
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
  const coordinator = new LockCoordinator(coordinatorState(), await runtime(), deps(stored, {
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
  const coordinator = new LockCoordinator(coordinatorState(), await runtime(), {
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
  const coordinator = new LockCoordinator(coordinatorState(), await runtime(), deps(stored, {
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
  const coordinator = new LockCoordinator(coordinatorState(), await runtime(), deps(stored, {
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

test("concurrency session upload waits for a running rule before replacing credentials", async () => {
  let release;
  let started;
  const delayed = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { started = resolve; });
  let savedInput = null;
  let orderCalls = 0;
  const stored = rule();
  const coordinator = new LockCoordinator(coordinatorState(), await runtime(), deps(stored, {
    fetchCinema: async () => { started(); await delayed; return { showData: { movies: [] } }; },
    createOrder: async () => { orderCalls++; return { orderId: "must-not-order" }; },
    saveSession: async (_env, _token, input) => {
      savedInput = input;
      return { uploaded: true, uidMasked: "UID ***" };
    }
  }));
  const run = coordinator.fetch(coordinatorRequest({ action: "run", tokenId }));
  await begun;
  const upload = coordinator.fetch(coordinatorRequest({ action: "save-session", tokenId, input: { marker: "new" } }));
  assert.equal(savedInput, null);
  release();
  assert.equal((await upload).status, 200);
  await run;
  assert.deepEqual(savedInput, { marker: "new" });
  assert.equal(orderCalls, 0);
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
  const coordinator = new LockCoordinator(coordinatorState(), await runtime(), deps(stored, {
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
  const { text: logs, entries } = await captureConsole(async () => runOneLockRule(
    await runtime(),
    tokenId,
    deps(stored, { createOrder: async () => ({ orderId: "order-sensitive", payLeftSecond: 600 }) })
  ));

  assert.equal(entries.every((args) => args.length === 1 && typeof args[0] === "object"), true);
  assert.match(logs, /"scope":"maoyan-lock"/);
  assert.match(logs, /"event":"scheduled_rule"/);
  assert.match(logs, /"state":"locked"/);
  assert.doesNotMatch(logs, /影院敏感值|影片敏感值|2026-09-12|20:00|1-6-18|order-sensitive|11111111/);
});
