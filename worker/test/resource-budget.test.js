import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { evaluateBudget } from "../src/maoyan/resource-budget.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { syncSubscription } from "../src/maoyan/monitor-store.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

test("admission closes before exhausting the configured budget", () => {
  assert.equal(evaluateBudget({ used: 70, limit: 100 }).admissionAllowed, false);
  assert.equal(evaluateBudget({ used: 69, limit: 100 }).admissionAllowed, true);
  assert.equal(evaluateBudget({ used: NaN, limit: 100 }).admissionAllowed, false);
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
