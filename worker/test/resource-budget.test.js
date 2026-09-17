import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { evaluateBudget, readResourceSummary } from "../src/maoyan/resource-budget.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

test("admission closes before exhausting the configured budget", () => {
  assert.equal(evaluateBudget({ used: 70, limit: 100 }).admissionAllowed, false);
  assert.equal(evaluateBudget({ used: 69, limit: 100 }).admissionAllowed, true);
  assert.equal(evaluateBudget({ used: NaN, limit: 100 }).admissionAllowed, false);
});

test("unmeasured resources do not block admission, but an exhausted measured resource does", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  assert.equal((await readResourceSummary(env, NOW)).admissionAllowed, true);

  env.RESOURCE_USAGE_JSON = JSON.stringify({ d1RowsRead: { used: 70, limit: 100 } });
  const exhausted = await readResourceSummary(env, NOW);
  assert.equal(exhausted.admissionAllowed, false);
  assert.equal(exhausted.reason, "RESOURCE_EXHAUSTED");
});

test("admin resources returns aggregate measured and estimated fields only", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  env.NOW_MS = String(NOW);
  env.RESOURCE_USAGE_JSON = JSON.stringify({ workerRequests: { used: 1000, limit: 100000 } });
  const { account } = await seedAccount(env, { expiresAt: NOW + 86_400_000 });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "25428" }, 1, NOW);
  const response = await worker.fetch(new Request("https://worker.example/api/admin/resources", {
    headers: { "X-Admin-Token": env.ADMIN_TOKEN }
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.resources.usage.workerRequests.measured, true);
  assert.equal(payload.resources.activeCinemas, 1);
  assert.equal(JSON.stringify(payload).includes(account.id), false);
  assert.equal(JSON.stringify(payload).includes("token"), false);
});

test("Maoyan resource capacity excludes active Store accounts", async () => {
  const env = await createAccountEnv({ nowMs: NOW, maxUsers: 20 });
  await seedAccount(env, { businessLine: "maoyan", expiresAt: NOW + 86_400_000 });
  await seedAccount(env, { businessLine: "store", expiresAt: NOW + 86_400_000 });
  await seedAccount(env, { businessLine: "store", expiresAt: NOW + 86_400_000 });

  assert.deepEqual((await readResourceSummary(env, NOW)).capacity, { used: 1, maxUsers: 20 });
});
