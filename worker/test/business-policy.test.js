import test from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import { businessTime, nextMaintenanceStart, formatMonitorWindowLabel } from "../src/maoyan/business-time.js";
import { readBusinessPolicy, updateBusinessPolicy } from "../src/maoyan/business-policy-store.js";
import { readStatusSummary } from "../src/maoyan/status-api.js";

const at = (iso) => Date.parse(iso);

test("default policy gates both Beijing half-open windows", async () => {
  const policy = await readBusinessPolicy(await createDB());
  assert.deepEqual([policy.monitorStartMinute, policy.monitorEndMinute, policy.maintenanceStartMinute, policy.maintenanceEndMinute], [420, 1380, 60, 120]);
  for (const [iso, monitorOpen, maintenanceOpen] of [
    ["2026-09-13T22:59:00Z", false, false],
    ["2026-09-13T23:00:00Z", true, false],
    ["2026-09-14T14:59:00Z", true, false],
    ["2026-09-14T15:00:00Z", false, false],
    ["2026-09-13T16:59:00Z", false, false],
    ["2026-09-13T17:00:00Z", false, true],
    ["2026-09-13T17:59:00Z", false, true],
    ["2026-09-13T18:00:00Z", false, false]
  ]) {
    assert.deepEqual([businessTime(at(iso), policy).monitorOpen, businessTime(at(iso), policy).maintenanceOpen], [monitorOpen, maintenanceOpen], iso);
  }
  assert.equal(businessTime(at("2026-09-13T17:00:00Z"), policy).localDate, "2026-09-14");
  assert.equal(nextMaintenanceStart(at("2026-09-13T17:00:00Z"), policy), at("2026-09-14T17:00:00Z"));
});

test("configured midnight-spanning monitoring and maintenance are independently gated", async () => {
  const DB = await createDB();
  const policy = await updateBusinessPolicy(DB, {
    expectedVersion: 1, monitorStartMinute: 1320, monitorEndMinute: 120,
    maintenanceStartMinute: 180, maintenanceEndMinute: 240, nowMs: 1234
  });
  assert.equal(policy.version, 2);
  assert.equal(businessTime(at("2026-09-14T15:00:00Z"), policy).monitorOpen, true);
  assert.equal(businessTime(at("2026-09-13T17:30:00Z"), policy).monitorOpen, true);
  assert.equal(businessTime(at("2026-09-13T18:00:00Z"), policy).monitorOpen, false);
  assert.equal(businessTime(at("2026-09-13T19:00:00Z"), policy).maintenanceOpen, true);
  assert.equal(formatMonitorWindowLabel(policy), "监控时段 22:00~次日 01:59");
  assert.equal(nextMaintenanceStart(at("2026-09-13T20:00:00Z"), policy), at("2026-09-14T19:00:00Z"));
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='maoyan_business_policy_updated'").first()).n, 1);
  await assert.rejects(updateBusinessPolicy(DB, { ...policy, expectedVersion: 1, nowMs: 2345 }), { code: "VERSION_CONFLICT" });
});

test("invalid, overlapping and midnight-spanning maintenance policies cannot be saved", async () => {
  const DB = await createDB();
  const base = { expectedVersion: 1, monitorStartMinute: 420, monitorEndMinute: 1380, maintenanceStartMinute: 60, maintenanceEndMinute: 120 };
  for (const patch of [
    { monitorStartMinute: -1 },
    { monitorStartMinute: 420.5 },
    { monitorStartMinute: 420, monitorEndMinute: 420 },
    { maintenanceStartMinute: 1380, maintenanceEndMinute: 60 },
    { maintenanceStartMinute: 1320, maintenanceEndMinute: 1383 },
    { maintenanceStartMinute: 120, maintenanceEndMinute: 122 },
    { maintenanceStartMinute: 1350, maintenanceEndMinute: 1400 }
  ]) await assert.rejects(updateBusinessPolicy(DB, { ...base, ...patch, nowMs: 1 }), { code: "INVALID_REQUEST" });
  assert.equal((await readBusinessPolicy(DB)).version, 1);
});

test("user status displays the latest saved monitoring window", async () => {
  const DB = await createDB({ tokens: [{ id: "user-1", token: "key" }] });
  await updateBusinessPolicy(DB, {
    expectedVersion: 1, monitorStartMinute: 1320, monitorEndMinute: 120,
    maintenanceStartMinute: 180, maintenanceEndMinute: 240, nowMs: 1234
  });
  const summary = await readStatusSummary({ DB }, { userId: "user-1" });
  assert.equal(summary.cronText, "每 3 分钟一批 · 监控时段 22:00~次日 01:59");
});
