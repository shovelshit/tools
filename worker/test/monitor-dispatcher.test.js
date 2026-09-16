import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";
import { MonitorDispatcher } from "../src/maoyan/monitor-dispatcher.js";
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
