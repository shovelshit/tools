// ---------------- KV 写额度优化: 条件落盘语义 ----------------
// */3 批次若每批必写 snapshot/changes/status 三 key, 单活跃令牌 960 写/天即打满 KV 免费
// 额度(写 1,000/天)。优化后: snapshot/changes 只在变化时写, status 按心跳(30min)节流,
// 新增场次/错误恢复/手动检查必写。本文件断言「每批到底落了哪些盘」。
import test from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "../src/maoyan/check.js";
import { MemoryKV } from "./helpers.js";
import { userKey } from "../src/maoyan/user.js";

const tokenId = "33333333-3333-4333-8333-333333333333";
const HEARTBEAT_MS = 30 * 60e3;

function baseConfig() {
  return {
    enabled: true,
    cinemaId: "111",
    selectedMovieIds: ["900"],
    monitorDdl: "2099-01-01T00:00:00.000Z",
    notifyChannel: "bark",
    barkKey: "test-key"
  };
}

function runtime({ config = baseConfig(), snapshot = null, status = null, changes = null } = {}) {
  const entries = {
    "meta:tokens": JSON.stringify([{ id: tokenId, token: "access-token" }]),
    [userKey(tokenId, "config")]: JSON.stringify(config)
  };
  if (snapshot !== null) entries[userKey(tokenId, "snapshot")] = JSON.stringify(snapshot);
  if (status !== null) entries[userKey(tokenId, "status")] = JSON.stringify(status);
  if (changes !== null) entries[userKey(tokenId, "changes")] = JSON.stringify(changes);
  return { MAOYAN_KV: new MemoryKV(entries) };
}

// 上游影院数据: movies = [{ id, nm, seqNos: ["A1", ...] }]
function cinemaData(movies) {
  return { showData: {
    cinemaName: "测试影院",
    movies: movies.map((m) => ({
      id: m.id,
      nm: m.nm,
      shows: [{ showDate: "2026-09-15", plist: m.seqNos.map((seqNo) => ({ seqNo, tm: "19:00", lang: "国语", tp: "2D", th: "1号厅" })) }]
    }))
  } };
}

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

// fetch 全 mock: cinemaDetail 走注入数据, Bark 推送计数并返回成功
function upstreamMock(cinema, counters) {
  return async (input) => {
    const url = String(input);
    if (url.includes("/ajax/cinemaDetail")) return new Response(JSON.stringify(cinema), { status: 200 });
    if (url.includes("api.day.app")) {
      counters.pushCalls += 1;
      return new Response("ok", { status: 200 });
    }
    return new Response("ok", { status: 200 });
  };
}

const snapKey = userKey(tokenId, "snapshot");
const chKey = userKey(tokenId, "changes");
const stKey = userKey(tokenId, "status");

test("无变化批次零落盘: snapshot/changes/status 都不写", async () => {
  const env = runtime({ snapshot: { "900": ["A1"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 0);
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 0);
});

test("心跳到期(距上次写入≥30min)且无变化: 仅写 status 刷新存活", async () => {
  const env = runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - HEARTBEAT_MS - 60e3, lastCheck: "stale" }
  });
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
  const st = await env.MAOYAN_KV.get(stKey, "json");
  assert.ok(st.lastCheckTs > Date.now() - 60e3);
  assert.equal(st.lastError, undefined);
});

test("心跳未到且无变化: status 不写(心跳节流生效)", async () => {
  const env = runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3 }
  });
  await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 0);
});

test("新增场次: snapshot+changes+status 全落盘, 推送恰好一次", async () => {
  const env = runtime({ snapshot: { "900": ["A1"] } });
  const counters = { pushCalls: 0 };
  const res = await withMockFetch(
    upstreamMock(cinemaData([{ id: "900", nm: "片X", seqNos: ["A1", "A2"] }]), counters),
    () => runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1", "A2"] }]) })
  );
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 1);
  assert.equal(counters.pushCalls, 1);
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 1);
  assert.deepEqual((await env.MAOYAN_KV.get(snapKey, "json"))["900"], ["A1", "A2"]);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 1);
  const changes = await env.MAOYAN_KV.get(chKey, "json");
  assert.equal(changes.length, 2);
  assert.equal(changes[0].type, "ok");
  assert.equal(changes[1].type, "new");
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
  const st = await env.MAOYAN_KV.get(stKey, "json");
  assert.equal(st.newTotal, 1);
});

test("上游删场: 写 snapshot, 不写 changes, 不推送", async () => {
  const env = runtime({ snapshot: { "900": ["A1", "A2"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  const counters = { pushCalls: 0 };
  const res = await withMockFetch(
    upstreamMock(cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]), counters),
    () => runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) })
  );
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 0);
  assert.equal(counters.pushCalls, 0);
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 1);
  assert.deepEqual((await env.MAOYAN_KV.get(snapKey, "json"))["900"], ["A1"]);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 0);
});

test("seqNo 顺序打乱但集合相同: 视为未变, 不落盘", async () => {
  const env = runtime({ snapshot: { "900": ["A1", "A2"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A2", "A1"] }]) });
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 0);
});

test("首次检查(空快照): 建基线写 snapshot+status, 不推送不记 changes", async () => {
  const env = runtime();
  const counters = { pushCalls: 0 };
  const res = await withMockFetch(
    upstreamMock(cinemaData([
      { id: "900", nm: "片X", seqNos: ["A1"] },
      { id: "901", nm: "片Y", seqNos: ["B1", "B2"] }
    ]), counters),
    () => runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([
      { id: "900", nm: "片X", seqNos: ["A1"] },
      { id: "901", nm: "片Y", seqNos: ["B1", "B2"] }
    ]) })
  );
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 0);
  assert.equal(counters.pushCalls, 0);
  const snapshot = await env.MAOYAN_KV.get(snapKey, "json");
  assert.deepEqual(snapshot["900"], ["A1"]);
  assert.deepEqual(snapshot["901"], ["B1", "B2"]);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
});

test("错误恢复: 成功批清除 lastError 并写 status(即使心跳未到)", async () => {
  const env = runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3, lastError: "猫眼接口返回了无效 JSON" }
  });
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
  const st = await env.MAOYAN_KV.get(stKey, "json");
  assert.equal(st.lastError, undefined);
  assert.equal(st.newTotal, 0);
});

test("持续失败节流: 同一错误 30min 内不重写 status, 超时或错误变化才写", async () => {
  // 同一错误 + 心跳未到: 不写 status; changes 1h 节流后首条仍会写(独立逻辑, 不受影响)
  const env = runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3, lastError: "上游挂了" }
  });
  const fail = async () => runCheck(env, false, tokenId, { fetchCinema: async () => { throw new Error("上游挂了"); } });
  await assert.rejects(fail, /上游挂了/);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 0);

  // 超 30min: 心跳到期, 重写 status 留存活痕迹
  await env.MAOYAN_KV.put(stKey, JSON.stringify({ lastCheckTs: Date.now() - HEARTBEAT_MS - 60e3, lastError: "上游挂了" }));
  env.MAOYAN_KV.resetOps();
  await assert.rejects(fail, /上游挂了/);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
  const st = await env.MAOYAN_KV.get(stKey, "json");
  assert.equal(st.lastError, "上游挂了");

  // 错误信息变化: 立即重写(重置 lastCheckTs 避免被 90s 去抖跳过)
  await env.MAOYAN_KV.put(stKey, JSON.stringify({ lastCheckTs: Date.now() - 10 * 60e3, lastError: "上游挂了" }));
  env.MAOYAN_KV.resetOps();
  await assert.rejects(() => runCheck(env, false, tokenId, { fetchCinema: async () => { throw new Error("换了个错"); } }), /换了个错/);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
});

test("手动检查: 即使无变化也写 status(用户在等即时反馈)", async () => {
  const env = runtime({ snapshot: { "900": ["A1"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  const res = await runCheck(env, true, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(chKey), 0);
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
});

test("手动检查失败: 不受心跳节流影响, status 必写最新错误", async () => {
  const env = runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3, lastError: "上游挂了" }
  });
  await assert.rejects(
    () => runCheck(env, true, tokenId, { fetchCinema: async () => { throw new Error("上游挂了"); } }),
    /上游挂了/
  );
  assert.equal(env.MAOYAN_KV.writeCount(stKey), 1);
});

test("去抖锚点仍生效: 距上次检查<半个批次间隔的重复触发跳过", async () => {
  const env = runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 30e3 } // 90s 容差内
  });
  let fetchCalls = 0;
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => { fetchCalls += 1; return cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]); } });
  assert.equal(res.skipped, true);
  assert.equal(fetchCalls, 0);
  assert.equal(env.MAOYAN_KV.writeCount(snapKey), 0);
});
