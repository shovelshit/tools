import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { cinemaFixture } from "./scaling-fixtures.js";
import {
  advanceSubscriber,
  diffCinemaSnapshot,
  listDueCinemas,
  listSubscribers,
  persistCinemaSnapshot,
  saveConfigWithSubscription,
  syncSubscription
} from "../src/maoyan/monitor-store.js";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");

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

test("shared cinema snapshot writes changed movies once and replays a committed batch", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const first = await persistCinemaSnapshot(env.DB, {
    cinemaId: "1", batchId: "b1", data: cinemaFixture({ seqNos: ["s1"] }), capturedAt: NOW
  });
  assert.equal(first.replayed, false);
  assert.equal(first.snapshot.version, 1);
  assert.equal(first.events.length, 0);
  env.DB.resetWrites();
  const changed = await persistCinemaSnapshot(env.DB, {
    cinemaId: "1", batchId: "b2", data: cinemaFixture({ seqNos: ["s1", "s2"] }), capturedAt: NOW + 1
  });
  assert.equal(changed.snapshot.version, 2);
  assert.equal(changed.events.length, 1);
  assert.deepEqual(Object.keys(changed.events[0].shows[0]).sort(), ["lang", "seqNo", "showDate", "th", "ticketStatus", "tm", "tp"]);
  assert.equal(env.DB.writeCount("cinema_snapshots"), 1);
  assert.equal(env.DB.writeCount("cinema_events"), 1);
  env.DB.resetWrites();
  const replay = await persistCinemaSnapshot(env.DB, {
    cinemaId: "1", batchId: "b2", data: cinemaFixture({ seqNos: ["ignored"] }), capturedAt: NOW + 2
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.version, 2);
  assert.equal(env.DB.writeCount("cinema_snapshots"), 0);
  assert.equal(env.DB.writeCount("cinema_events"), 0);
});

test("unchanged snapshot commits a batch without rewriting movie rows or events", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  await persistCinemaSnapshot(env.DB, {
    cinemaId: "1", batchId: "b1", data: cinemaFixture({ seqNos: ["s1", "s2"] }), capturedAt: NOW
  });
  env.DB.resetWrites();
  const result = await persistCinemaSnapshot(env.DB, {
    cinemaId: "1", batchId: "b2", data: cinemaFixture({ seqNos: ["s2", "s1"] }), capturedAt: NOW + 1
  });
  assert.equal(result.snapshot.version, 1);
  assert.equal(env.DB.writeCount("cinema_snapshots"), 0);
  assert.equal(env.DB.writeCount("cinema_events"), 0);
});

test("committed shared data excludes prices and unknown provider fields", async () => {
  const env = await createAccountEnv({ nowMs: NOW });
  const data = cinemaFixture({ seqNos: ["s1"] });
  Object.assign(data.showData.movies[0].shows[0].plist[0], {
    vipPrice: "99.9", vipPriceSuffix: "起", providerSecret: "do-not-share"
  });
  const result = await persistCinemaSnapshot(env.DB, {
    cinemaId: "1", batchId: "private-fields", data, capturedAt: NOW
  });
  const serialized = JSON.stringify(result.data);
  assert.equal(serialized.includes("99.9"), false);
  assert.equal(serialized.includes("providerSecret"), false);
  assert.equal(serialized.includes("s1"), true);
});
