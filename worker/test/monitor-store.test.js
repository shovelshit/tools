import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { cinemaFixture } from "./scaling-fixtures.js";
import {
  advanceSubscriber,
  beginCinemaRun,
  completeCinemaRun,
  completeRunSubscriber,
  diffCinemaSnapshot,
  hashCinemaData,
  listRunSubscribers,
  listDueCinemas,
  listSubscribers,
  normalizeCinemaData,
  saveConfigWithSubscription,
  syncSubscription
} from "../src/maoyan/monitor-store.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

test("cinema data hashes are canonical and ignore irrelevant provider fields", () => {
  const before = cinemaFixture({ seqNos: ["s1", "s2"] });
  const after = structuredClone(before);
  after.showData.movies[0].shows[0].plist.reverse();
  after.showData.movies[0].shows[0].plist[0].providerOnly = "ignored";
  assert.deepEqual(normalizeCinemaData(before), normalizeCinemaData(after));
  assert.equal(hashCinemaData(before), hashCinemaData(after));

  const changedTime = structuredClone(before);
  changedTime.showData.movies[0].shows[0].plist[0].tm = "23:59";
  const changedHall = structuredClone(before);
  changedHall.showData.movies[0].shows[0].plist[0].th = "2号厅";
  const changedStatus = structuredClone(before);
  changedStatus.showData.movies[0].shows[0].plist[0].ticketStatus = 2;
  assert.notEqual(hashCinemaData(before), hashCinemaData(changedTime));
  assert.notEqual(hashCinemaData(before), hashCinemaData(changedHall));
  assert.notEqual(hashCinemaData(before), hashCinemaData(changedStatus));
});

test("an active cinema run returns stored data idempotently", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const first = cinemaFixture({ cinemaId: "run-1", seqNos: ["s1"] });
  const started = await beginCinemaRun(env.DB, {
    cinemaId: "run-1", runId: "r1", nowMs: NOW, fetchedData: first
  });
  const retry = await beginCinemaRun(env.DB, {
    cinemaId: "run-1", runId: "r1", nowMs: NOW + 10, fetchedData: cinemaFixture({ seqNos: ["different"] })
  });
  assert.deepEqual(retry, started);
});

test("a different active run cannot replace an in-flight run", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  await beginCinemaRun(env.DB, { cinemaId: "run-conflict", runId: "r1", nowMs: NOW, fetchedData: cinemaFixture() });
  await assert.rejects(
    () => beginCinemaRun(env.DB, { cinemaId: "run-conflict", runId: "r2", nowMs: NOW + 1, fetchedData: cinemaFixture({ seqNos: ["other"] }) }),
    { code: "RUN_IN_PROGRESS" }
  );
  const state = await env.DB.prepare("SELECT active_run_id FROM cinema_state WHERE cinema_id=?").bind("run-conflict").first();
  assert.equal(state.active_run_id, "r1");
});

test("begin run reports a CAS miss without claiming the run", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const originalBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => [{ meta: { changes: 0 } }];
  await assert.rejects(
    () => beginCinemaRun(env.DB, { cinemaId: "run-begin-cas", runId: "r1", nowMs: NOW, fetchedData: cinemaFixture() }),
    { code: "RUN_CONFLICT" }
  );
  env.DB.batch = originalBatch;
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM cinema_state WHERE cinema_id=?").bind("run-begin-cas").first().then((row) => Number(row.n)), 0);
});

test("run subscribers skip completed users but keep failed users selectable", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const first = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const second = await seedAccount(env, { expiresAt: NOW + 60_000 });
  for (const account of [first.account, second.account]) {
    await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "run-2" }, 1, NOW);
  }
  await env.DB.prepare("UPDATE monitor_subscriptions SET last_run_id=? WHERE user_id=?").bind("r2", first.account.id).run();
  const page = await listRunSubscribers(env.DB, {
    cinemaId: "run-2", runId: "r2", startedAt: NOW, limit: 10
  });
  assert.deepEqual(page.items.map((item) => item.userId), [second.account.id]);
  await completeRunSubscriber(env.DB, {
    userId: second.account.id, cinemaId: "run-2", runId: "r2", configVersion: 1,
    nextDueAt: NOW + 1000, baselineVersion: null
  });
  assert.deepEqual((await listRunSubscribers(env.DB, {
    cinemaId: "run-2", runId: "r2", startedAt: NOW, limit: 10
  })).items, []);
});

test("completing a cinema run promotes active data and clears active fields", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const data = cinemaFixture({ cinemaId: "run-3", seqNos: ["s1"] });
  const started = await beginCinemaRun(env.DB, {
    cinemaId: "run-3", runId: "r3", nowMs: NOW, fetchedData: data
  });
  const result = await completeCinemaRun(env.DB, { cinemaId: "run-3", runId: "r3", nowMs: NOW + 1 });
  assert.deepEqual(result, { runId: "r3", version: started.version, data: started.data, changed: started.changed });
  const row = await env.DB.prepare("SELECT current_version,current_hash,current_data,active_run_id,active_data,run_state FROM cinema_state WHERE cinema_id=?").bind("run-3").first();
  assert.equal(Number(row.current_version), started.version);
  assert.equal(row.current_hash, hashCinemaData(data));
  assert.equal(row.current_data, JSON.stringify(started.data));
  assert.equal(row.active_run_id, null);
  assert.equal(row.active_data, null);
  assert.equal(row.run_state, "completed");
  assert.deepEqual(await completeCinemaRun(env.DB, { cinemaId: "run-3", runId: "r3", nowMs: NOW + 2 }), { status: "skipped", runId: "r3" });
});

test("an unchanged scan keeps one current JSON body and does not create history", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const data = cinemaFixture({ cinemaId: "unchanged-store", seqNos: ["s1"] });
  const first = await beginCinemaRun(env.DB, {
    cinemaId: "unchanged-store", runId: "first", nowMs: NOW, fetchedData: data
  });
  await completeCinemaRun(env.DB, { cinemaId: "unchanged-store", runId: "first", nowMs: NOW + 1 });
  env.DB.resetWrites();

  const second = await beginCinemaRun(env.DB, {
    cinemaId: "unchanged-store", runId: "second", nowMs: NOW + 2,
    fetchedData: structuredClone(data)
  });
  assert.equal(second.changed, false);
  assert.equal(second.version, first.version);
  await completeCinemaRun(env.DB, { cinemaId: "unchanged-store", runId: "second", nowMs: NOW + 3 });

  const state = await env.DB.prepare(
    "SELECT current_version,current_data,active_data FROM cinema_state WHERE cinema_id=?"
  ).bind("unchanged-store").first();
  assert.equal(Number(state.current_version), first.version);
  assert.equal(state.current_data, JSON.stringify(first.data));
  assert.equal(state.active_data, null);
  assert.equal(env.DB.writeCount("cinema_batches"), 0);
  assert.equal(env.DB.writeCount("cinema_snapshots"), 0);
  assert.equal(env.DB.writeCount("cinema_events"), 0);
});

test("complete run CAS miss preserves active data", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  await beginCinemaRun(env.DB, { cinemaId: "run-complete-cas", runId: "r1", nowMs: NOW, fetchedData: cinemaFixture() });
  const originalBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => [{ meta: { changes: 0 } }];
  assert.deepEqual(await completeCinemaRun(env.DB, { cinemaId: "run-complete-cas", runId: "r1", nowMs: NOW + 1 }), { status: "conflict", runId: "r1" });
  env.DB.batch = originalBatch;
  const state = await env.DB.prepare("SELECT active_run_id,active_data FROM cinema_state WHERE cinema_id=?").bind("run-complete-cas").first();
  assert.equal(state.active_run_id, "r1");
  assert.ok(state.active_data);
});

test("seat-order-free show reorder creates no new event", () => {
  const before = cinemaFixture({ seqNos: ["s1", "s2"] });
  const after = cinemaFixture({ seqNos: ["s2", "s1"] });
  assert.deepEqual(diffCinemaSnapshot(before, after), { changedMovieIds: [], additions: [] });
});

test("new movies establish a baseline while later shows become additions", () => {
  const empty = cinemaFixture({ movieIds: [] });
  const first = cinemaFixture({ seqNos: ["s1"] });
  const second = cinemaFixture({ seqNos: ["s1", "s2"] });
  assert.deepEqual(diffCinemaSnapshot(empty, first).additions, []);
  const diff = diffCinemaSnapshot(first, second);
  assert.deepEqual(diff.changedMovieIds, ["7"]);
  assert.deepEqual(diff.additions.map((item) => item.shows.map((show) => show.seqNo)), [["s2"]]);
});

test("due cinema and subscriber queries exclude inactive accounts and paginate", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const first = await seedAccount(env, { expiresAt: NOW + 60_000, config: { enabled: true, cinemaId: "1", selectedMovieIds: ["7"] } });
  const second = await seedAccount(env, { expiresAt: NOW + 60_000, config: { enabled: true, cinemaId: "2", selectedMovieIds: ["7"] } });
  const expired = await seedAccount(env, { expiresAt: NOW - 1, config: { enabled: true, cinemaId: "3" } });
  await syncSubscription(env.DB, first.account.id, { enabled: true, cinemaId: "1" }, 1, NOW);
  await syncSubscription(env.DB, second.account.id, { enabled: true, cinemaId: "2" }, 1, NOW);
  await syncSubscription(env.DB, expired.account.id, { enabled: true, cinemaId: "3" }, 1, NOW);
  const page = await listDueCinemas(env.DB, { nowMs: NOW, limit: 1 });
  assert.deepEqual(page, { items: ["1"], nextCursor: "1" });
  assert.deepEqual((await listDueCinemas(env.DB, { nowMs: NOW, afterCinemaId: page.nextCursor, limit: 20 })).items, ["2"]);
  assert.deepEqual((await listSubscribers(env.DB, { cinemaId: "1", nowMs: NOW, limit: 10 })).items.map((item) => item.userId), [first.account.id]);
});

test("due cinema queries exclude Store subscriptions", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, {
    businessLine: "store", expiresAt: NOW + 60_000,
    config: { enabled: true, cinemaId: "99", selectedMovieIds: ["7"] }
  });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "99" }, 1, NOW);
  assert.deepEqual((await listDueCinemas(env.DB, { nowMs: NOW })).items, []);
  assert.deepEqual((await listSubscribers(env.DB, { cinemaId: "99", nowMs: NOW })).items, []);
});

test("cinema switch rejects prior subscription work", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "2" }, 2, NOW);
  const result = await advanceSubscriber(env.DB, {
    userId: account.id, cinemaId: "1", configVersion: 1, snapshotVersion: 5, events: [], nowMs: NOW
  });
  assert.deepEqual(result, { applied: false });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM change_log").first()).n, 0);
});

test("subscriber advancement is idempotent for one snapshot version", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  await syncSubscription(env.DB, account.id, { enabled: true, cinemaId: "1" }, 1, NOW);
  const input = {
    userId: account.id, cinemaId: "1", configVersion: 1, snapshotVersion: 5,
    events: [{ type: "new", text: "one event" }], nowMs: NOW
  };
  assert.deepEqual(await advanceSubscriber(env.DB, input), { applied: true, notificationsCreated: 0 });
  assert.deepEqual(await advanceSubscriber(env.DB, input), { applied: false });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM change_log").first()).n, 1);
});

test("config CAS and subscription projection commit together", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const { account } = await seedAccount(env, { expiresAt: NOW + 60_000 });
  const saved = await saveConfigWithSubscription(env.DB, {
    userId: account.id,
    storedConfig: { cinemaId: "8", enabled: true },
    config: { cinemaId: "8", enabled: true },
    expectedVersion: 1,
    nowMs: NOW
  });
  assert.equal(saved.version, 2);
  const subscription = await env.DB.prepare(
    "SELECT cinema_id,enabled,config_version FROM monitor_subscriptions WHERE user_id=?"
  ).bind(account.id).first();
  assert.deepEqual([subscription.cinema_id, Number(subscription.enabled), Number(subscription.config_version)], ["8", 1, 2]);
  await assert.rejects(() => saveConfigWithSubscription(env.DB, {
    userId: account.id,
    storedConfig: { cinemaId: "9", enabled: true },
    config: { cinemaId: "9", enabled: true },
    expectedVersion: 1,
    nowMs: NOW + 1
  }), { code: "CONFIG_CONFLICT" });
  assert.equal((await env.DB.prepare("SELECT cinema_id FROM monitor_subscriptions WHERE user_id=?").bind(account.id).first()).cinema_id, "8");
});
