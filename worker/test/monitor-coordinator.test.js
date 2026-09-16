import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";
import { MonitorCoordinator, processCinemaBatch } from "../src/maoyan/monitor-coordinator.js";
import { cinemaFixture, createStorageFixture } from "./scaling-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

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
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM change_log").first()).n, 20);
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
  await processCinemaBatch(env, input);
  assert.equal(fetches, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).n, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM change_log").first()).n, 1);
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
