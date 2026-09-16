import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import * as db from "../src/maoyan/db.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

function request(path, key) {
  return new Request(`https://worker.example${path}`, { headers: { "X-Token": key } });
}

test("summary status does not select change-log payloads", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, { expiresAt: NOW + 60_000, config: { enabled: true } });
  await db.appendChange(env.DB, (await env.DB.prepare("SELECT id FROM users").first()).id, {
    time: new Date(NOW).toISOString(), type: "new", text: "payload"
  });
  env.DB.queries = [];
  const response = await worker.fetch(request("/api/status?view=summary", key), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Object.hasOwn(body, "changes"), false);
  assert.equal(body.changesVersion, 1);
  assert.equal(env.DB.queries.some((query) => /FROM\s+change_log/i.test(query.sql)), false);
});

test("incremental changes paginate without overlap and stay account-scoped", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const first = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const second = await seedAccount(env, { expiresAt: NOW + 60_000 });
  for (let index = 1; index <= 25; index += 1) {
    await db.appendChange(env.DB, first.account.id, {
      time: new Date(NOW + index).toISOString(), type: "new", text: `first-${index}`
    });
  }
  await db.appendChange(env.DB, second.account.id, {
    time: new Date(NOW).toISOString(), type: "new", text: "other-account"
  });
  const latest = await worker.fetch(request("/api/changes?limit=20", first.key), env);
  assert.equal(latest.status, 200);
  const firstPage = await latest.json();
  assert.equal(firstPage.items.length, 20);
  assert.equal(firstPage.items.some((item) => item.text === "other-account"), false);
  assert.equal(firstPage.hasMore, true);
  const older = await worker.fetch(request(`/api/changes?before_id=${firstPage.nextBeforeId}&limit=20`, first.key), env);
  const secondPage = await older.json();
  assert.equal(secondPage.items.length, 5);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 25);
  const newestId = firstPage.nextAfterId;
  await db.appendChange(env.DB, first.account.id, {
    time: new Date(NOW + 100).toISOString(), type: "ok", text: "increment"
  });
  const incremental = await worker.fetch(request(`/api/changes?after_id=${newestId}&limit=20`, first.key), env);
  assert.deepEqual((await incremental.json()).items.map((item) => item.text), ["increment"]);
});

test("changes rejects conflicting cursors", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  env.NOW_MS = String(NOW);
  const { key } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const response = await worker.fetch(request("/api/changes?after_id=1&before_id=2", key), env);
  assert.equal(response.status, 400);
});
