import test from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import { claimMaintenanceDay, completeMaintenanceDay, releaseMaintenanceDay } from "../src/maoyan/maintenance-store.js";

test("maintenance can rescan a completed day and ignores a legacy cursor", async () => {
  const DB = await createDB();
  const input = { job: "reminder", localDate: "2026-09-14", nowMs: 100_000 };
  const first = await claimMaintenanceDay(DB, input);
  assert.equal(first.leaseUntil, 220_000);
  assert.equal(await claimMaintenanceDay(DB, input), null);
  await DB.prepare("UPDATE maoyan_maintenance_runs SET cursor='legacy-user' WHERE job_id='reminder'").run();
  const next = await claimMaintenanceDay(DB, { ...input, nowMs: 300_000 });
  await completeMaintenanceDay(DB, { ...input, nowMs: 300_000, leaseUntil: next.leaseUntil });
  const incomplete = await claimMaintenanceDay(DB, { ...input, nowMs: 500_000 });
  await releaseMaintenanceDay(DB, { ...input, nowMs: 500_000, leaseUntil: incomplete.leaseUntil });
  assert.equal((await DB.prepare("SELECT completed_at FROM maoyan_maintenance_runs WHERE job_id='reminder'").first()).completed_at, 300_000);
  assert.ok(await claimMaintenanceDay(DB, { ...input, localDate: "2026-09-15", nowMs: 500_000 }));
});

test("expired worker cannot overwrite or release a newer worker's maintenance lease", async () => {
  const DB = await createDB();
  const input = { job: "reminder", localDate: "2026-09-14" };
  const old = await claimMaintenanceDay(DB, { ...input, nowMs: 100_000 });
  const current = await claimMaintenanceDay(DB, { ...input, nowMs: 300_000 });
  assert.notEqual(old.leaseUntil, current.leaseUntil);
  await assert.rejects(completeMaintenanceDay(DB, { ...input, nowMs: 300_000, leaseUntil: old.leaseUntil }), /租约已失效/);
  await releaseMaintenanceDay(DB, { ...input, nowMs: 300_000, leaseUntil: old.leaseUntil });
  assert.equal(await claimMaintenanceDay(DB, { ...input, nowMs: 300_001 }), null);
  await assert.rejects(completeMaintenanceDay(DB, { ...input, nowMs: 300_001, leaseUntil: old.leaseUntil }), /租约已失效/);
  await completeMaintenanceDay(DB, { ...input, nowMs: 300_001, leaseUntil: current.leaseUntil });
  assert.ok(await claimMaintenanceDay(DB, { ...input, nowMs: 500_000 }));
});
