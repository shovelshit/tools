import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDB } from "./helpers.js";
import { getLockRule } from "../src/maoyan/lock-rule.js";

const fixtures = {
  missing: { id: "old", state: "waiting_schedule", seats: [{ label: "1排2座" }], updatedAt: "2026-09-20" },
  zero: { timeToleranceMinutes: 0 },
  default: { timeToleranceMinutes: 30 },
  explicit: { timeToleranceMinutes: 180 },
  null: { timeToleranceMinutes: null },
  invalid: { timeToleranceMinutes: "bad" }
};

async function rawRows(DB) {
  return (await DB.prepare("SELECT * FROM lock_rule ORDER BY token_id").all()).results;
}

function assertBackfilled(before, after) {
  assert.deepEqual(after.map(row => ({ ...row, data: JSON.parse(row.data) })), before.map(row => ({
    ...row, data: row.token_id === "missing" ? { ...JSON.parse(row.data), timeToleranceMinutes: 30 } : JSON.parse(row.data)
  })));
}

test("reading old rules persists missing tolerance, preserves explicit values and is idempotent", async () => {
  const DB = await createDB({ lockRules: fixtures });
  const before = await rawRows(DB);
  for (const [id, rule] of Object.entries(fixtures)) {
    assert.deepEqual(await getLockRule({ DB }, id), id === "missing" ? { ...rule, timeToleranceMinutes: 30 } : rule);
  }
  const after = await rawRows(DB);
  assertBackfilled(before, after);
  assert.equal(DB.writeCount("lock_rule"), 1);
  for (const id of Object.keys(fixtures)) await getLockRule({ DB }, id);
  assert.deepEqual(await rawRows(DB), after);
  assert.equal(await getLockRule({ DB }, "absent"), null);
  assert.equal(DB.writeCount("lock_rule"), 1);
});

test("standalone tolerance migration only fills absent fields and can run twice", async () => {
  const DB = await createDB({ lockRules: fixtures });
  const before = await rawRows(DB);
  const sql = readFileSync(new URL("../sql/lock-rule-time-tolerance.sql", import.meta.url), "utf8");
  DB.sqlite.exec(sql);
  const after = await rawRows(DB);
  assertBackfilled(before, after);
  DB.sqlite.exec(sql);
  assert.deepEqual(await rawRows(DB), after);
});

test("read repair preserves a concurrent rule replacement and returns its actual value", async () => {
  const DB = await createDB({ lockRules: { missing: fixtures.missing } });
  const prepare = DB.prepare.bind(DB);
  let replaced = false;
  DB.prepare = (sql) => {
    if (/UPDATE lock_rule/.test(sql) && !replaced) {
      replaced = true;
      DB.sqlite.prepare("UPDATE lock_rule SET data = ? WHERE token_id = ?")
        .run(JSON.stringify({ id: "new", timeToleranceMinutes: 180, state: "matching" }), "missing");
    }
    return prepare(sql);
  };
  assert.deepEqual(await getLockRule({ DB }, "missing"), { id: "new", timeToleranceMinutes: 180, state: "matching" });
  assert.deepEqual(JSON.parse((await rawRows(DB))[0].data), { id: "new", timeToleranceMinutes: 180, state: "matching" });
});
