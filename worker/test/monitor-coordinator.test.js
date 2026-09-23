import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";
import { putLockRuleRow } from "../src/maoyan/db.js";
import { MonitorCoordinator, processCinemaRun } from "../src/maoyan/monitor-coordinator.js";
import { cinemaFixture, createStorageFixture } from "./scaling-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

const processCinemaBatch = (env, input) => processCinemaRun(env, {
  ...input,
  runId: input.runId || input.batchId
});

function waitingRule({ lotteryKey, seqNo, templateTime, targetDate = "2026-09-19" }) {
  return {
    id: crypto.randomUUID(),
    cinemaId: "1",
    movieId: "7",
    targetDate,
    templateTime,
    hall: "1号厅",
    seats: [{ seatNo: "1-1-1", rowId: "1", columnId: "1" }],
    state: "waiting_schedule",
    lotteryKey,
    expectedSeqNo: seqNo
  };
}

test("expired unmatched waiting rules are dispatched for terminal handling", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const userId = "00000000-0000-4000-8000-000000000010";
  await seedAccount(env, {
    id: userId,
    expiresAt: NOW + 600_000,
    config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] }
  });
  await syncSubscription(env.DB, userId, { enabled: true, cinemaId: "1" }, 1, NOW);
  await putLockRuleRow(env.DB, userId, waitingRule({
    lotteryKey: "expired", seqNo: "absent", templateTime: "18:40", targetDate: "2026-09-15"
  }));
  const dispatched = [];

  const result = await processCinemaBatch(env, {
    cinemaId: "1",
    batchId: "expired-unmatched",
    nowMs: NOW,
    fetchCinema: async () => ({ showData: { cinemaName: "影院 1", movies: [] } }),
    runLock: async (_env, dispatchedUserId) => { dispatched.push(dispatchedUserId); }
  });

  assert.deepEqual(dispatched, [userId]);
  assert.equal(result.lockAttempts, 1);
  assert.equal(result.lockFailures, 0);
});

test("lock dispatch lotteries within actual shows, interleaves groups, and isolates failures", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 10 });
  const definitions = [
    ["00000000-0000-4000-8000-000000000001", "z", "show-a", "18:40"],
    ["00000000-0000-4000-8000-000000000002", "a", "show-b", "19:40"],
    ["00000000-0000-4000-8000-000000000003", "a", "show-a", "18:40"],
    ["00000000-0000-4000-8000-000000000004", "z", "show-b", "19:40"],
    ["00000000-0000-4000-8000-000000000005", "m", "show-a", "18:40"]
  ];
  const expectedSeqNo = new Map();
  for (const [userId, lotteryKey, seqNo, templateTime] of definitions) {
    await seedAccount(env, {
      id: userId,
      expiresAt: NOW + 600_000,
      config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] }
    });
    await syncSubscription(env.DB, userId, { enabled: true, cinemaId: "1" }, 1, NOW);
    await putLockRuleRow(env.DB, userId, waitingRule({ lotteryKey, seqNo, templateTime }));
    expectedSeqNo.set(userId, seqNo);
  }
  const starts = [];
  let active = 0;
  let maximumActive = 0;
  const rejectedUser = definitions[4][0];
  const result = await processCinemaBatch(env, {
    cinemaId: "1",
    batchId: "lottery-batch",
    nowMs: NOW,
    lockConcurrency: 2,
    fetchCinema: async () => ({ showData: { cinemaName: "影院 1", movies: [{
      id: "7", nm: "影片 7", shows: [{ showDate: "2026-09-19", plist: [
        { seqNo: "show-a", tm: "18:40", th: "1号厅", ticketStatus: 0 },
        { seqNo: "show-b", tm: "19:40", th: "1号厅", ticketStatus: 0 }
      ] }]
    }] } }),
    runLock: async (_env, userId, cinema) => {
      const showSeqNos = cinema.showData.movies[0].shows[0].plist.map((show) => show.seqNo);
      assert.ok(showSeqNos.includes(expectedSeqNo.get(userId)));
      starts.push(userId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (userId === rejectedUser) throw new Error("individual lock failed");
    }
  });

  assert.deepEqual(starts, [definitions[2][0], definitions[1][0], definitions[4][0], definitions[3][0], definitions[0][0]]);
  assert.equal(maximumActive, 2);
  assert.equal(result.subscribers, 5);
  assert.equal(result.lockAttempts, 5);
  assert.equal(result.lockFailures, 1);
});

test("twenty subscribers share one cinema fetch and receive isolated events", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  for (let index = 0; index < 20; index += 1) {
    const { account } = await seedAccount(env, {
      expiresAt: NOW + 600_000,
      config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] }
    });
    await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, NOW);
  }
  let fetches = 0;
  await processCinemaBatch(env, {
    cinemaId: "1", batchId: "b1", nowMs: NOW,
    fetchCinema: async () => { fetches += 1; return cinemaFixture({ seqNos: ["s1"] }); }
  });
  const result = await processCinemaBatch(env, {
    cinemaId: "1", batchId: "b2", nowMs: NOW + 180_000,
    fetchCinema: async () => { fetches += 1; return cinemaFixture({ seqNos: ["s1", "s2"] }); }
  });
  assert.equal(fetches, 2);
  assert.equal(result.subscribers, 20);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 20);
  const timestamp = await env.DB.prepare("SELECT detected_at,created_at FROM notification_outbox LIMIT 1").first();
  assert.ok(timestamp.detected_at >= NOW);
  assert.ok(timestamp.created_at >= timestamp.detected_at);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM change_log").first()).n, 20);
});

test("new show wakes its notification lane before a matching lock finishes", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, {
    expiresAt: NOW + 600_000,
    config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] }
  });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, NOW);
  await processCinemaBatch(env, {
    cinemaId: "1", batchId: "baseline", nowMs: NOW,
    fetchCinema: async () => cinemaFixture({ seqNos: ["s1"] })
  });
  await putLockRuleRow(env.DB, account.id, waitingRule({
    lotteryKey: "notify-first", seqNo: "s2", templateTime: "18:41"
  }));
  const wakes = [];
  env.NOTIFICATION_DISPATCHER = {
    idFromName: (name) => name,
    get: (name) => ({ fetch: async () => { wakes.push(name); return Response.json({ ok: true }); } })
  };
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const lockStarted = new Promise((resolve) => { started = resolve; });
  const pending = processCinemaBatch(env, {
    cinemaId: "1", batchId: "new-show", nowMs: NOW + 180_000,
    fetchCinema: async () => cinemaFixture({ seqNos: ["s1", "s2"] }),
    runLock: async () => { started(); await blocked; }
  });
  try {
    await lockStarted;
    assert.ok(wakes.some((name) => name === `urgent:new-shows:${account.id}`));
  } finally {
    release();
    await pending;
  }
});

test("replaying a committed cinema batch does not duplicate user events", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, {
    expiresAt: NOW + 600_000,
    config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] }
  });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, NOW);
  await processCinemaBatch(env, { cinemaId: "1", batchId: "b1", nowMs: NOW, fetchCinema: async () => cinemaFixture({ seqNos: ["s1"] }) });
  let fetches = 0;
  const input = { cinemaId: "1", batchId: "b2", nowMs: NOW + 180_000, fetchCinema: async () => { fetches += 1; return cinemaFixture({ seqNos: ["s1", "s2"] }); } };
  await processCinemaBatch(env, input);
  assert.equal(fetches, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM change_log").first()).n, 1);
});

test("unchanged run still checks a waiting lock and advances its due time", async () => {
  const runNow = Date.now();
  const env = await createAccountEnv({ nowMs: runNow });
  const { account } = await seedAccount(env, { expiresAt: runNow + 600_000, config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] } });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, runNow);
  await putLockRuleRow(env.DB, account.id, waitingRule({ lotteryKey: "same", seqNo: "s1", templateTime: "18:40" }));
  const calls = [];
  const fetchCinema = async () => cinemaFixture({ seqNos: ["s1"] });
  await processCinemaRun(env, { cinemaId: "1", runId: "run-1", nowMs: runNow, fetchCinema, runLock: async (_env, userId) => { calls.push(userId); } });
  const before = await env.DB.prepare("SELECT next_due_at FROM monitor_subscriptions WHERE user_id=?").bind(account.id).first();
  await processCinemaRun(env, { cinemaId: "1", runId: "run-2", nowMs: runNow + 180_000, fetchCinema, runLock: async (_env, userId) => { calls.push(userId); } });
  const after = await env.DB.prepare("SELECT next_due_at FROM monitor_subscriptions WHERE user_id=?").bind(account.id).first();
  assert.equal(calls.length, 2);
  assert.ok(Number(after.next_due_at) > Number(before.next_due_at));
});

test("failed lock resumes the same run without duplicating its notification", async () => {
  const runNow = Date.now();
  const env = await createAccountEnv({ nowMs: runNow, maxUsers: 2 });
  const first = await seedAccount(env, { expiresAt: runNow + 600_000, config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] } });
  const second = await seedAccount(env, { expiresAt: runNow + 600_000, config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] } });
  for (const account of [first.account, second.account]) await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, runNow);
  await processCinemaRun(env, { cinemaId: "1", runId: "base", nowMs: runNow, fetchCinema: async () => cinemaFixture({ seqNos: ["s1"] }), runLock: async () => {} });
  for (const account of [first.account, second.account]) await putLockRuleRow(env.DB, account.id, waitingRule({ lotteryKey: account.id, seqNo: "s2", templateTime: "18:41" }));
  let fail = true;
  const fetchCinema = async () => cinemaFixture({ seqNos: ["s1", "s2"] });
  const firstAttempt = await processCinemaRun(env, { cinemaId: "1", runId: "retry", nowMs: runNow + 180_000, fetchCinema, runLock: async (_env, userId) => { if (userId === second.account.id && fail) throw new Error("rejected"); } });
  assert.equal(firstAttempt.retryable, true);
  fail = false;
  await processCinemaRun(env, { cinemaId: "1", runId: "retry", nowMs: runNow + 240_000, fetchCinema: async () => { throw new Error("must reuse active data"); }, runLock: async () => {} });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='new-shows'").first()).n, 2);
});

test("concurrent manual checks share one cinema fetch and retain per-user cooldowns", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = new MonitorCoordinator({ storage: createStorageFixture() }, {}, {
    fetchCinema: async () => {
      fetches += 1;
      await gate;
      return cinemaFixture({ cinemaId: "1" });
    }
  });
  const request = (userId, nowMs = NOW) => coordinator.fetch(new Request("https://internal/internal/manual-check", {
    method: "POST",
    body: JSON.stringify({ cinemaId: "1", userId, nowMs })
  }));
  const first = request("user-a");
  const second = request("user-b");
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(fetches, 1);
  const limited = await request("user-a", NOW + 1000);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "29");
});
