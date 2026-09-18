import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole, createDB, MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import { userKey, cleanupUserData, putUserConfig } from "../src/maoyan/user.js";
import { getLockRuleRow, putConfig } from "../src/maoyan/db.js";
import { OrderAttemptError, ORDER_REJECTED_SEATS } from "../src/maoyan/lock-client.js";
import {
  createLockRule,
  getLockRule,
  lockNotificationContent,
  publicLockRule,
  putLockRule,
  removeLockRule
} from "../src/maoyan/lock-rule.js";

const now = new Date("2026-09-11T04:00:00.000Z");

test("immediate order failure queues sanitized diagnostics without retaining a rule", async () => {
  const env = await envWithConfig();
  env.DB = await createDB({ tokens: [{ id: "token-a", token: "test-token" }], configs: { "token-a": { cinemaId: "25428", selectedMovieIds: ["7"] } } });
  let wakes = 0;
  let orders = 0;
  env.NOTIFICATION_DISPATCHER = {
    idFromName: (id) => id,
    get: () => ({ fetch: async () => { wakes++; throw new Error("notification unavailable"); } })
  };
  const failureDetail = JSON.stringify({ stage: "order", status: 403 });
  await assert.rejects(createLockRule(env, "token-a", validInput({ targetDate: "2026-09-11" }), dependencies({
    placeOrder: async () => {
      orders++;
      throw Object.assign(new Error("failed"), { detail: "token=private-cookie", failureDetail });
    }
  })), (error) => error.kind === "upstream" && !error.message.includes("private-cookie"));
  assert.equal(await getLockRule(env, "token-a"), null);
  const rows = (await env.DB.prepare("SELECT * FROM notification_outbox").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].failure_detail, failureDetail);
  assert.equal(rows[0].last_error, null);
  assert.doesNotMatch(rows[0].payload, /private-cookie/);
  assert.equal(wakes, 1);
  assert.equal(orders, 1);
});

test("immediate explicit rejection queues failure and ignores legacy raw detail", async () => {
  const env = await envWithConfig();
  env.DB = await createDB({ tokens: [{ id: "token-a", token: "test-token" }], configs: { "token-a": { cinemaId: "25428", selectedMovieIds: ["7"] } } });
  await assert.rejects(createLockRule(env, "token-a", validInput({ targetDate: "2026-09-11" }), dependencies({
    placeOrder: async () => {
      throw Object.assign(new OrderAttemptError(ORDER_REJECTED_SEATS, false), { detail: "legacy-raw-secret" });
    }
  })), (error) => error.kind === "upstream" && error.message.includes("座位可能已被抢占"));
  const row = await env.DB.prepare("SELECT failure_detail,payload FROM notification_outbox").first();
  assert.equal(row.failure_detail, null);
  assert.doesNotMatch(row.payload, /legacy-raw-secret/);
  assert.equal(await getLockRule(env, "token-a"), null);
});

async function envWithConfig(config = { cinemaId: "25428", selectedMovieIds: ["7"] }) {
  const env = {
    LOCK_SERVICE_ENABLED: "true",
    DB: await createDB(),
    MAOYAN_KV: new MemoryKV(),
    SESSION_ENCRYPTION_KEY: testEncryptionKey()
  };
  await putUserConfig(env, "token-a", config);
  return env;
}

function dependencies(overrides = {}) {
  return {
    now,
    requireActive: async () => ({}),
    loadSession: async () => validSession(),
    fetchCinema: async () => ({ showData: {
      cinemaName: "测试影院",
      movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", ticketStatus: 0, th: "2号杜比巨幕厅-1.3米以下儿童需要购票" }
      ] }] }]
    } }),
    fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: [
      { seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true },
      { seatNo: "1-6-19", rowId: "6", columnId: "19", type: "N", available: false }
    ] }),
    ...overrides
  };
}

function validInput(overrides = {}) {
  return {
    cinemaId: "25428",
    movieId: "7",
    templateSeqNo: "100",
    targetDate: "2026-09-12",
    seatNos: ["1-6-18"],
    riskAccepted: true,
    ...overrides
  };
}

async function reject(env, input, pattern, deps = dependencies()) {
  await assert.rejects(createLockRule(env, "token-a", input, deps), pattern);
}

test("creates a rule from authoritative cinema and seat data", async () => {
  const env = await envWithConfig();
  const rule = await createLockRule(env, "token-a", validInput({ seatNos: ["1-6-18", "1-6-18"] }), dependencies());

  assert.equal(rule.cinemaName, "测试影院");
  assert.equal(rule.movieName, "测试电影");
  assert.equal(rule.hall, "2号杜比巨幕厅-1.3米以下儿童需要购票");
  assert.equal(rule.templateDate, "2026-09-11");
  assert.equal(rule.templateTime, "20:00");
  assert.equal(rule.templateSeqNo, "100");
  // label 在创建时用全图普查定段持久化(夹具数据 seg2=rowId、seg3 逐座变化 → 区-排-座, 座号=18),
  // 通知与「已保存规则」直接复用, 不再做单座二次判别
  assert.deepEqual(rule.seats, [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", label: "6排18座" }]);
  assert.equal(rule.state, "waiting_schedule");
  assert.equal(rule.automationEnabled, true);
  assert.equal(rule.lastError, null);
  assert.equal(rule.orderId, null);
  assert.equal(rule.payLeftSecond, null);
  assert.match(rule.id, /^[0-9a-f-]{36}$/i);
  assert.equal((await getLockRule(env, "token-a")).id, rule.id);
});

test("persists one injected lottery draw for a waiting rule without exposing it", async () => {
  const env = await envWithConfig();
  let draws = 0;
  const rule = await createLockRule(env, "token-a", validInput(), dependencies({
    drawLottery: () => {
      draws += 1;
      return "00112233-4455-4677-8899-aabbccddeeff";
    }
  }));

  const stored = await getLockRule(env, "token-a");
  assert.equal(draws, 1);
  assert.equal(stored.lotteryKey, "00112233-4455-4677-8899-aabbccddeeff");
  assert.equal(Object.hasOwn(rule, "lotteryKey"), false);
  assert.equal(Object.hasOwn(publicLockRule(stored, true), "lotteryKey"), false);
});

test("maps the template sequence to the authenticated seat-map request", async () => {
  const env = await envWithConfig();
  await createLockRule(env, "token-a", validInput(), dependencies({
    fetchSeats: async (_session, request) => {
      assert.deepEqual(request, { cinemaId: "25428", movieId: "7", seqNo: "100" });
      return {
        sectionId: "1",
        sectionName: "1号厅",
        seqNo: "100",
        seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true }]
      };
    }
  }));
});

test("requires explicit risk acceptance", async () => {
  await reject(await envWithConfig(),validInput({ riskAccepted: "true" }), /风险/);
});

test("a real target show does not require risk acceptance (inferred ones still do)", async () => {
  // 目标场次(真实座位图): 前端不显示风险勾选框, payload riskAccepted=false 也必须能下单
  const realShowCinema = { showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "200", tm: "20:00", ticketStatus: 0 }
    ] }] }]
  } };
  const locked = await createLockRule(await envWithConfig(),"token-a", validInput({ templateSeqNo: "200", riskAccepted: false }), dependencies({
    fetchCinema: async () => realShowCinema,
    fetchSeats: async (_session, request) => ({
      seqNo: request.seqNo, sectionId: "1", sectionName: "2号厅",
      seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true }]
    }),
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 })
  }));
  assert.equal(locked.state, "locked");
  assert.equal(locked.orderId, "order-1");
  // 推断模式(目标日期无排期): 缺少风险勾选仍拒绝
  await reject(await envWithConfig(),validInput({ riskAccepted: false }), /风险/);
});

test("rejects non-decimal IDs before reading provider data", async () => {
  let called = false;
  await reject(await envWithConfig(),validInput({ cinemaId: "25428x" }), /参数/, dependencies({
    fetchCinema: async () => { called = true; return {}; }
  }));
  assert.equal(called, false);
});

test("requires the movie to be selected in the monitor configuration", async () => {
  await reject(await envWithConfig({ cinemaId: "25428", selectedMovieIds: ["8"] }), validInput(), /监控/);
});

test("requires the template sequence to belong to the configured cinema movie", async () => {
  await reject(await envWithConfig(),validInput({ templateSeqNo: "101" }), /场次/);
});

test("seat availability is enforced for real shows but ignored for inferred ones", async () => {
  // 目标日期无排期(推断模式): 模板座位图中"已售"的座位也允许锁定
  const inferred = await createLockRule(await envWithConfig(),"token-a", validInput({ seatNos: ["1-6-19"] }), dependencies());
  assert.deepEqual(inferred.seats.map((seat) => seat.seatNo), ["1-6-19"]);
  // 目标日期有真实排期: 强制校验真实售卖状态
  const realShowCinema = { showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [
      { showDate: "2026-09-11", plist: [{ seqNo: "100", tm: "20:00", ticketStatus: 0 }] },
      { showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00", ticketStatus: 0 }] }
    ] }]
  } };
  const realDeps = dependencies({
    fetchCinema: async () => realShowCinema,
    fetchSeats: async (_session, request) => {
      assert.equal(request.seqNo, "200");
      return { sectionId: "1", sectionName: "1号厅", seqNo: "200", seats: [
        { seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true },
        { seatNo: "1-6-19", rowId: "6", columnId: "19", type: "N", available: false }
      ] };
    }
  });
  await reject(await envWithConfig(),validInput({ templateSeqNo: "200", seatNos: ["1-6-19"] }), /座位/, realDeps);
  const locked = await createLockRule(await envWithConfig(),"token-a", validInput({ templateSeqNo: "200" }), {
    ...realDeps,
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 })
  });
  assert.equal(locked.state, "locked");
  assert.equal(locked.targetSeqNo, "200");
  assert.equal(locked.orderId, "order-1");
});

test("an immediate successful lock sends the same terminal notification after persistence", async () => {
  const env = await envWithConfig({
    cinemaId: "25428",
    selectedMovieIds: ["7"],
    notifyChannel: "bark",
    barkKey: "test-key"
  });
  let notification;
  const locked = await createLockRule(env, "token-a", validInput({ targetDate: "2026-09-11" }), dependencies({
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 }),
    notify: async (config, title, content) => {
      assert.equal((await getLockRule(env, "token-a")).state, "locked");
      notification = { config, title, content };
    }
  }));

  assert.equal(locked.state, "locked");
  assert.equal(notification.config.barkKey, "test-key");
  assert.equal(notification.title, "✅ 锁座成功｜测试电影");
  // 推送里必须是人看的「几排几座」, 不能是内部座位标识; 座号取创建时全图普查持久化的 label
  // (夹具数据为「区-排-座」: seg2=rowId 恒定、seg3 逐座变化 → 6排18座)。
  // 影厅名也要带上, 便于用户核对(如 2号杜比巨幕厅)
  assert.equal(notification.content, [
    "🏢 测试影院",
    "🎞 2号杜比巨幕厅-1.3米以下儿童需要购票",
    "📅 2026-09-11 20:00",
    "💺 6排18座",
    "",
    "💳 已创建待支付订单，请尽快前往猫眼付款",
    "🧾 订单号：order-1",
    "⏳ 猫眼返回剩余支付时间：600 秒"
  ].join("\n"));
});

test("immediate locking rechecks account eligibility before ordering", async () => {
  const env = await envWithConfig();
  let orderCalls = 0;
  await assert.rejects(
    createLockRule(env, "token-a", validInput({ targetDate: "2026-09-11", riskAccepted: false }), dependencies({
      requireActive: async () => {
        const error = new Error("账号已到期，请先续期");
        error.code = "ACCOUNT_EXPIRED";
        throw error;
      },
      placeOrder: async () => { orderCalls += 1; return { orderId: "forbidden" }; }
    })),
    { code: "ACCOUNT_EXPIRED" }
  );
  assert.equal(orderCalls, 0);
});

test("an immediate notification failure keeps the successful order locked", async () => {
  const env = await envWithConfig();
  const locked = await createLockRule(env, "token-a", validInput({ targetDate: "2026-09-11" }), dependencies({
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 }),
    notify: async () => { throw new Error("push unavailable"); }
  }));

  assert.equal(locked.state, "locked");
  assert.equal(locked.orderId, "order-1");
  assert.equal((await getLockRule(env, "token-a")).notifyError, "通知发送失败");
});

test("a real show uses exactly the sequence selected by the user", async () => {
  const cinema = { showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "200", tm: "20:00", ticketStatus: 0 },
      { seqNo: "201", tm: "20:00", ticketStatus: 0 }
    ] }] }]
  } };
  let orderedSeqNo = null;
  const result = await createLockRule(await envWithConfig(),"token-a", validInput({ templateSeqNo: "201" }), dependencies({
    fetchCinema: async () => cinema,
    fetchSeats: async (_session, request) => ({
      seqNo: request.seqNo, sectionId: "1", sectionName: "2号厅",
      seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true }]
    }),
    placeOrder: async (_session, seatMap) => {
      orderedSeqNo = seatMap.seqNo;
      return { orderId: "order-201", payLeftSecond: 600 };
    }
  }));
  assert.equal(orderedSeqNo, "201");
  assert.equal(result.targetSeqNo, "201");
});

test("a stale template cannot replace a selectable real target show", async () => {
  const cinema = { showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [
      { showDate: "2026-09-11", plist: [{ seqNo: "100", tm: "20:00", ticketStatus: 0 }] },
      { showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00", ticketStatus: 0 }] }
    ] }]
  } };
  await reject(await envWithConfig(),validInput(), /目标日期的实际场次/, dependencies({ fetchCinema: async () => cinema }));
});

test("requires at least one well-formed selected seat", async () => {
  await reject(await envWithConfig(),validInput({ seatNos: [] }), /座位/);
  await reject(await envWithConfig(),validInput({ seatNos: ["one"] }), /座位/);
});

test("targets are limited to today through the next 30 China calendar days", async () => {
  // 昨天不可锁
  await reject(await envWithConfig(),validInput({ targetDate: "2026-09-10" }), /目标日期/);
  // 今天可锁(即使与模板场次同日): 真实场次存在 → 立即锁座下单
  const today = await createLockRule(await envWithConfig(),"token-a", validInput({ targetDate: "2026-09-11" }), {
    ...dependencies(),
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 })
  });
  assert.equal(today.targetDate, "2026-09-11");
  assert.equal(today.state, "locked");
  assert.equal(today.targetSeqNo, "100");
  // 超出 30 天不可锁
  await reject(await envWithConfig(),validInput({ targetDate: "2026-10-12" }), /目标日期/);
});

test("allows only one non-terminal rule for a token", async () => {
  const env = await envWithConfig();
  await putLockRule(env, "token-a", { id: "existing", state: "waiting_schedule" });
  await reject(env, validInput(), /进行中/);
  await putLockRule(env, "token-a", { id: "finished", state: "failed" });
  const rule = await createLockRule(env, "token-a", validInput(), dependencies());
  assert.notEqual(rule.id, "finished");
});

test("replaces terminal rules including legacy unknown but retains active rules", async () => {
  for (const state of ["locked", "expired", "failed", "unknown"]) {
    const env = await envWithConfig();
    await putLockRule(env, "token-a", { id: `old-${state}`, state });
    const replacement = await createLockRule(env, "token-a", validInput(), dependencies());
    assert.notEqual(replacement.id, `old-${state}`);
    assert.equal(replacement.state, "waiting_schedule");
  }
  for (const state of ["waiting_schedule", "matching"]) {
    const env = await envWithConfig();
    await putLockRule(env, "token-a", { id: `active-${state}`, state });
    await reject(env, validInput(), /进行中/);
  }
});

test("projects only public rule fields and removes token-scoped rule", async () => {
  const env = await envWithConfig();
  const rule = await createLockRule(env, "token-a", validInput(), dependencies());
  const projected = publicLockRule({ ...rule, attemptMarker: "internal", session: "secret" }, false);
  assert.equal(projected.automationEnabled, false);
  assert.equal(Object.hasOwn(projected, "attemptMarker"), false);
  assert.equal(Object.hasOwn(projected, "session"), false);
  await removeLockRule(env, "token-a");
  assert.equal(await getLockRule(env, "token-a"), null);
});

test("projects fuzzy target show details and renders the actual time in notifications", () => {
  const rule = {
    cinemaName: "测试影院",
    movieName: "测试电影",
    hall: "1号激光IMAX厅",
    targetDate: "2026-09-12",
    templateTime: "18:40",
    targetTime: "18:50",
    matchMode: "fuzzy",
    timeDeltaMinutes: 10,
    seats: [{ label: "6排18座" }],
    state: "failed",
    lastError: "所选未来座位不可用或影厅布局已变化"
  };

  const projected = publicLockRule({ ...rule, secret: "hidden" }, true);
  assert.equal(projected.targetTime, "18:50");
  assert.equal(projected.matchMode, "fuzzy");
  assert.equal(projected.timeDeltaMinutes, 10);
  assert.equal(Object.hasOwn(projected, "secret"), false);
  assert.equal(
    lockNotificationContent(rule),
    "🏢 测试影院\n🎞 1号激光IMAX厅\n📅 2026-09-12 18:50\n💺 6排18座\n🔄 场次匹配：18:40 → 18:50（+10分钟）\n📌 原因：所选未来座位不可用或影厅布局已变化\n\n👉 请查看当前座位，重新选择"
  );
});

test("legacy exact rules keep using the template time in notifications", () => {
  assert.equal(
    lockNotificationContent({
      cinemaName: "测试影院",
      movieName: "测试电影",
      hall: "1号厅",
      targetDate: "2026-09-12",
      templateTime: "18:40",
      seats: [{ label: "6排18座" }],
      state: "failed"
    }),
    "🏢 测试影院\n🎞 1号厅\n📅 2026-09-12 18:40\n💺 6排18座\n📌 原因：锁座未完成\n\n👉 请查看当前座位，重新选择"
  );
});

test("cleanup deletes the encrypted session (KV) and the lock rule (D1)", async () => {
  const env = await envWithConfig();
  await env.MAOYAN_KV.put(userKey("token-a", "maoyan-session"), "ciphertext");
  await putLockRule(env, "token-a", { id: "rule-a", state: "waiting_schedule" });
  await cleanupUserData(env, "token-a");
  assert.equal(await env.MAOYAN_KV.get(userKey("token-a", "maoyan-session")), null);
  assert.equal(await getLockRuleRow(env.DB, "token-a"), null);
});

test("rule logs are structured and omit user, show, seat, and order identifiers", async () => {
  const env = await envWithConfig();
  await putConfig(env.DB, "token-a-sensitive", {
    cinemaId: "25428",
    selectedMovieIds: ["7"]
  });
  const { text: logs, entries } = await captureConsole(() => createLockRule(
    env,
    "token-a-sensitive",
    validInput({ targetDate: "2026-09-11" }),
    dependencies({ placeOrder: async () => ({ orderId: "order-sensitive", payLeftSecond: 600 }) })
  ));

  assert.equal(entries.every((args) => args.length === 1 && typeof args[0] === "object"), true);
  assert.match(logs, /"scope":"maoyan-lock"/);
  assert.match(logs, /"event":"rule_create"/);
  assert.match(logs, /"state":"locked"/);
  assert.doesNotMatch(logs, /token-a-sensitive|测试影院|测试电影|2026-09-11|20:00|1-6-18|order-sensitive|"100"/);
});
