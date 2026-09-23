import test from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import { claimMaintenanceDay, saveMaintenanceCursor, completeMaintenanceDay, releaseMaintenanceDay } from "../src/maoyan/maintenance-store.js";

test("maintenance claims resume the saved cursor after lease expires and complete once daily", async () => {
  const DB = await createDB();
  const input = { job: "reminder", localDate: "2026-09-14", nowMs: 100_000 };
  const first = await claimMaintenanceDay(DB, input);
  assert.equal(first.cursor, null);
  assert.equal(await claimMaintenanceDay(DB, input), null);
  await saveMaintenanceCursor(DB, { ...input, cursor: "user-5", leaseUntil: first.leaseUntil });
  const next = await claimMaintenanceDay(DB, { ...input, nowMs: 300_000 });
  assert.equal(next.cursor, "user-5");
  await completeMaintenanceDay(DB, { ...input, nowMs: 300_000, leaseUntil: next.leaseUntil });
  assert.equal(await claimMaintenanceDay(DB, { ...input, nowMs: 500_000 }), null);
  assert.equal((await claimMaintenanceDay(DB, { ...input, localDate: "2026-09-15", nowMs: 500_000 })).cursor, null);
});

test("expired worker cannot overwrite or release a newer worker's maintenance lease", async () => {
  const DB = await createDB();
  const input = { job: "reminder", localDate: "2026-09-14" };
  const old = await claimMaintenanceDay(DB, { ...input, nowMs: 100_000 });
  const current = await claimMaintenanceDay(DB, { ...input, nowMs: 300_000 });
  assert.notEqual(old.leaseUntil, current.leaseUntil);
  await assert.rejects(saveMaintenanceCursor(DB, { ...input, nowMs: 300_000, cursor: "old", leaseUntil: old.leaseUntil }), /租约已失效/);
  await releaseMaintenanceDay(DB, { ...input, nowMs: 300_000, leaseUntil: old.leaseUntil });
  assert.equal(await claimMaintenanceDay(DB, { ...input, nowMs: 300_001 }), null);
  await saveMaintenanceCursor(DB, { ...input, nowMs: 300_001, cursor: "new", leaseUntil: current.leaseUntil });
  await assert.rejects(completeMaintenanceDay(DB, { ...input, nowMs: 300_001, leaseUntil: old.leaseUntil }), /租约已失效/);
  await completeMaintenanceDay(DB, { ...input, nowMs: 300_001, leaseUntil: current.leaseUntil });
  assert.equal(await claimMaintenanceDay(DB, { ...input, nowMs: 500_000 }), null);
});
