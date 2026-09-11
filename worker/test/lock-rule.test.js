import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, validSession } from "./helpers.js";
import { userKey, cleanupUserData } from "../src/maoyan/user.js";
import {
  createLockRule,
  getLockRule,
  publicLockRule,
  putLockRule,
  removeLockRule
} from "../src/maoyan/lock-rule.js";

const now = new Date("2026-09-11T04:00:00.000Z");

function envWithConfig(config = { cinemaId: "25428", selectedMovieIds: ["7"] }) {
  return {
    MAOYAN_KV: new MemoryKV({
      [userKey("token-a", "config")]: JSON.stringify(config)
    })
  };
}

function dependencies(overrides = {}) {
  return {
    now,
    loadSession: async () => validSession(),
    fetchCinema: async () => ({ showData: {
      cinemaName: "测试影院",
      movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", ticketStatus: 0 }
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
  const env = envWithConfig();
  const rule = await createLockRule(env, "token-a", validInput({ seatNos: ["1-6-18", "1-6-18"] }), dependencies());

  assert.equal(rule.cinemaName, "测试影院");
  assert.equal(rule.movieName, "测试电影");
  assert.equal(rule.templateDate, "2026-09-11");
  assert.equal(rule.templateTime, "20:00");
  assert.equal(rule.templateSeqNo, "100");
  assert.deepEqual(rule.seats, [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N" }]);
  assert.equal(rule.state, "waiting_schedule");
  assert.equal(rule.lastError, null);
  assert.equal(rule.orderId, null);
  assert.equal(rule.payLeftSecond, null);
  assert.match(rule.id, /^[0-9a-f-]{36}$/i);
  assert.equal((await getLockRule(env, "token-a")).id, rule.id);
});

test("maps the template sequence to the authenticated seat-map request", async () => {
  const env = envWithConfig();
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
  await reject(envWithConfig(), validInput({ riskAccepted: "true" }), /风险/);
});

test("rejects non-decimal IDs before reading provider data", async () => {
  let called = false;
  await reject(envWithConfig(), validInput({ cinemaId: "25428x" }), /参数/, dependencies({
    fetchCinema: async () => { called = true; return {}; }
  }));
  assert.equal(called, false);
});

test("requires the movie to be selected in the monitor configuration", async () => {
  await reject(envWithConfig({ cinemaId: "25428", selectedMovieIds: ["8"] }), validInput(), /监控/);
});

test("requires the template sequence to belong to the configured cinema movie", async () => {
  await reject(envWithConfig(), validInput({ templateSeqNo: "101" }), /场次/);
});

test("seat availability is enforced for real shows but ignored for inferred ones", async () => {
  // 目标日期无排期(推断模式): 模板座位图中"已售"的座位也允许锁定
  const inferred = await createLockRule(envWithConfig(), "token-a", validInput({ seatNos: ["1-6-19"] }), dependencies());
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
  await reject(envWithConfig(), validInput({ seatNos: ["1-6-19"] }), /座位/, realDeps);
  const locked = await createLockRule(envWithConfig(), "token-a", validInput(), {
    ...realDeps,
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 })
  });
  assert.equal(locked.state, "locked");
  assert.equal(locked.targetSeqNo, "200");
  assert.equal(locked.orderId, "order-1");
});

test("requires at least one well-formed selected seat", async () => {
  await reject(envWithConfig(), validInput({ seatNos: [] }), /座位/);
  await reject(envWithConfig(), validInput({ seatNos: ["one"] }), /座位/);
});

test("targets are limited to today through the next 30 China calendar days", async () => {
  // 昨天不可锁
  await reject(envWithConfig(), validInput({ targetDate: "2026-09-10" }), /目标日期/);
  // 今天可锁(即使与模板场次同日): 真实场次存在 → 立即锁座下单
  const today = await createLockRule(envWithConfig(), "token-a", validInput({ targetDate: "2026-09-11" }), {
    ...dependencies(),
    placeOrder: async () => ({ orderId: "order-1", payLeftSecond: 600 })
  });
  assert.equal(today.targetDate, "2026-09-11");
  assert.equal(today.state, "locked");
  assert.equal(today.targetSeqNo, "100");
  // 超出 30 天不可锁
  await reject(envWithConfig(), validInput({ targetDate: "2026-10-12" }), /目标日期/);
});

test("allows only one non-terminal rule for a token", async () => {
  const env = envWithConfig();
  await putLockRule(env, "token-a", { id: "existing", state: "waiting_schedule" });
  await reject(env, validInput(), /进行中/);
  await putLockRule(env, "token-a", { id: "finished", state: "failed" });
  const rule = await createLockRule(env, "token-a", validInput(), dependencies());
  assert.notEqual(rule.id, "finished");
});

test("replaces every current terminal lock rule but retains active rules", async () => {
  for (const state of ["locked", "expired", "failed", "unknown"]) {
    const env = envWithConfig();
    await putLockRule(env, "token-a", { id: `old-${state}`, state });
    const replacement = await createLockRule(env, "token-a", validInput(), dependencies());
    assert.notEqual(replacement.id, `old-${state}`);
    assert.equal(replacement.state, "waiting_schedule");
  }
  for (const state of ["waiting_schedule", "matching"]) {
    const env = envWithConfig();
    await putLockRule(env, "token-a", { id: `active-${state}`, state });
    await reject(env, validInput(), /进行中/);
  }
});

test("projects only public rule fields and removes token-scoped rule", async () => {
  const env = envWithConfig();
  const rule = await createLockRule(env, "token-a", validInput(), dependencies());
  const projected = publicLockRule({ ...rule, attemptMarker: "internal", session: "secret" }, false);
  assert.equal(projected.automationEnabled, false);
  assert.equal(Object.hasOwn(projected, "attemptMarker"), false);
  assert.equal(Object.hasOwn(projected, "session"), false);
  await removeLockRule(env, "token-a");
  assert.equal(await getLockRule(env, "token-a"), null);
});

test("cleanup deletes the encrypted session and lock rule keys", async () => {
  const env = envWithConfig();
  await env.MAOYAN_KV.put(userKey("token-a", "maoyan-session"), "ciphertext");
  await env.MAOYAN_KV.put(userKey("token-a", "maoyan-lock-rule"), "rule");
  await cleanupUserData(env, "token-a");
  assert.equal(await env.MAOYAN_KV.get(userKey("token-a", "maoyan-session")), null);
  assert.equal(await env.MAOYAN_KV.get(userKey("token-a", "maoyan-lock-rule")), null);
});
