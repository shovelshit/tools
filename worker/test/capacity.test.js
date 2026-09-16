import test from "node:test";
import assert from "node:assert/strict";
import { runCapacityScenario } from "../scripts/capacity-test.mjs";

test("shared cinema count controls public fetches", async () => {
  const report = await runCapacityScenario({ users: 20, cinemas: 2, batches: 320, adminUsers: 0 });
  assert.equal(report.publicFetchCalls, 640);
  assert.equal(report.minUpstreamHttpRequests, 1280);
  assert.ok(report.maxQueriesPerInvocation <= 35);
  assert.ok(report.maxSubrequestsPerInvocation <= 50);
  assert.equal(report.platformUnmeasured.includes("d1RowsRead"), true);
});

test("capacity scenario validates positive bounded input", async () => {
  await assert.rejects(() => runCapacityScenario({ users: 20, cinemas: 0, batches: 1 }), /cinemas/);
});
