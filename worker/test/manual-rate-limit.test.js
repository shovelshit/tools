import test from "node:test";
import assert from "node:assert/strict";
import { allowManualOperation } from "../src/maoyan/resource-budget.js";
import { createStorageFixture } from "./scaling-fixtures.js";

test("manual operations have an isolated thirty-second cooldown", async () => {
  const storage = createStorageFixture();
  const input = { userId: "user-a", cinemaId: "25428", kind: "check", nowMs: 100_000 };
  assert.deepEqual(await allowManualOperation(storage, input), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(await allowManualOperation(storage, { ...input, nowMs: 101_000 }), { allowed: false, retryAfterSeconds: 29 });
  assert.deepEqual(await allowManualOperation(storage, { ...input, kind: "test-push", nowMs: 101_000 }), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(await allowManualOperation(storage, { ...input, nowMs: 130_000 }), { allowed: true, retryAfterSeconds: 0 });
});
