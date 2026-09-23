import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";
import { MonitorDispatcher, dispatchCinema } from "../src/maoyan/monitor-dispatcher.js";
import { createStorageFixture } from "./scaling-fixtures.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

test("dispatcher handles at most twenty cinemas before continuing by alarm", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 25 });
  for (let index = 1; index <= 21; index += 1) {
    const { account } = await seedAccount(env, { expiresAt: NOW + 600_000 });
    await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: String(index) }, 1, NOW);
  }
  const storage = createStorageFixture();
  const cinemas = [];
  const dispatcher = new MonitorDispatcher({ storage }, env, {
    dispatchCinema: async (_env, input) => { cinemas.push(input.cinemaId); }
  });
  const response = await dispatcher.fetch(new Request("https://internal/internal/batch", {
    method: "POST", body: JSON.stringify({ batchId: "b1", nowMs: NOW })
  }));
  assert.equal(response.status, 202);
  assert.equal(cinemas.length, 20);
  assert.ok(await storage.getAlarm());
  await dispatcher.alarm();
  assert.equal(cinemas.length, 21);
  assert.equal(await storage.getAlarm(), null);
  assert.equal(await storage.get("currentBatch"), undefined);
});

test("newer batches replace only the pending batch while current work finishes", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const storage = createStorageFixture();
  await storage.put("currentBatch", { batchId: "old", nowMs: NOW, cursor: "" });
  const dispatcher = new MonitorDispatcher({ storage }, env, { dispatchCinema: async () => {} });
  await dispatcher.fetch(new Request("https://internal/internal/batch", {
    method: "POST", body: JSON.stringify({ batchId: "new", nowMs: NOW + 180_000 })
  }));
  assert.equal((await storage.get("currentBatch")).batchId, "new");
});

test("alarm resumes the current run before accepting a newer run", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 600_000 });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, NOW);
  const storage = createStorageFixture();
  const dispatched = [];
  const dispatcher = new MonitorDispatcher({ storage }, env, {
    dispatchCinema: async (_env, input) => dispatched.push(input.runId)
  });
  await storage.put("currentBatch", { runId: "run-current", nowMs: NOW, cursor: "" });
  await dispatcher.fetch(new Request("https://internal/internal/batch", {
    method: "POST", body: JSON.stringify({ runId: "run-new", nowMs: NOW + 180_000 })
  }));
  assert.ok(dispatched.every((runId) => runId === "run-current"));
  await dispatcher.alarm();
  assert.ok(dispatched.includes("run-new"));
  assert.equal(dispatched.filter((runId) => runId === "run-current").length, 1);
});

test("retryable coordinator response retains the failed cinema and delays a newer run", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  for (const cinemaId of ["1", "2"]) {
    const { account } = await seedAccount(env, { expiresAt: NOW + 600_000 });
    await syncSubscription(env.DB, account.id, { enabled: true, cinemaId }, 1, NOW);
  }
  const calls = [];
  env.MONITOR_COORDINATOR = {
    idFromName: (name) => name,
    get: (cinemaId) => ({
      fetch: async (request) => {
        const input = await request.json();
        calls.push([cinemaId, input.runId]);
        const incomplete = cinemaId === "2" && calls.filter(([id, runId]) => id === "2" && runId === "old").length === 1;
        return Response.json({ completed: !incomplete, retryable: incomplete, runId: input.runId });
      }
    })
  };
  const storage = createStorageFixture();
  const dispatcher = new MonitorDispatcher({ storage }, env);
  const request = (runId, nowMs) => new Request("https://internal/internal/batch", {
    method: "POST", body: JSON.stringify({ runId, nowMs })
  });

  const first = await dispatcher.fetch(request("old", NOW));
  assert.equal(first.status, 202);
  assert.deepEqual(calls, [["1", "old"], ["2", "old"]]);
  assert.equal((await storage.get("currentBatch")).runId, "old");
  assert.equal((await storage.get("currentBatch")).cursor, "1");
  assert.ok(await storage.getAlarm());

  await dispatcher.fetch(request("new", NOW + 180_000));
  assert.deepEqual(calls, [["1", "old"], ["2", "old"], ["2", "old"]]);
  assert.equal((await storage.get("currentBatch")).runId, "new");
  await dispatcher.alarm();
  assert.deepEqual(calls, [["1", "old"], ["2", "old"], ["2", "old"], ["1", "new"], ["2", "new"]]);
  assert.equal(await storage.get("currentBatch"), undefined);
});

test("dispatchCinema rejects an incomplete 200 response", async () => {
  const env = { MONITOR_COORDINATOR: {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => Response.json({ completed: false, retryable: true, runId: "r1" }) })
  } };
  const result = await dispatchCinema(env, { cinemaId: "1", runId: "r1", nowMs: NOW });
  assert.equal(result.completed, false);
  assert.equal(result.retryable, true);
});
