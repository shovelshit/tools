// ---------------- 写额度优化(D1 版): 条件落盘语义 ----------------
// */3 批次若每批必写 snapshot/changes/status, 单活跃令牌即打满存储写额度。优化后:
// snapshot/changes 只在变化时写, status 按心跳(30min)节流, 新增场次/错误恢复/手动检查必写。
// 本文件断言「每批到底落了哪些盘」(D1 表级写语句计数)。
import test from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "../src/maoyan/check.js";
import { createDB } from "./helpers.js";
import * as db from "../src/maoyan/db.js";

const tokenId = "33333333-3333-4333-8333-333333333333";
const HEARTBEAT_MS = 30 * 60e3;
const SNAP = "monitor_snapshot";
const CHG = "change_log";
const ST = "monitor_status";

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

async function runtime({ config = baseConfig(), snapshot = null, status = null, changes = null } = {}) {
  const DB = await createDB({
    tokens: [{ id: tokenId, token: "access-token" }],
    configs: { [tokenId]: config },
    ...(snapshot ? { snapshots: { [tokenId]: snapshot } } : {}),
    ...(status ? { statuses: { [tokenId]: status } } : {}),
    ...(changes ? { changes: { [tokenId]: changes } } : {})
  });
  return { DB };
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
      const [, , title, content] = new URL(url).pathname.split("/");
      counters.notification = {
        title: decodeURIComponent(title),
        content: decodeURIComponent(content)
      };
      return new Response("ok", { status: 200 });
    }
    return new Response("ok", { status: 200 });
  };
}

test("无变化批次零落盘: snapshot/changes/status 都不写", async () => {
  const env = await runtime({ snapshot: { "900": ["A1"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 0);
  assert.equal(env.DB.writeCount(SNAP), 0);
  assert.equal(env.DB.writeCount(CHG), 0);
  assert.equal(env.DB.writeCount(ST), 0);
});

test("心跳到期(距上次写入≥30min)且无变化: 仅写 status 刷新存活", async () => {
  const env = await runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - HEARTBEAT_MS - 60e3, lastCheck: "stale" }
  });
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(env.DB.writeCount(SNAP), 0);
  assert.equal(env.DB.writeCount(CHG), 0);
  assert.equal(env.DB.writeCount(ST), 1);
  const st = await db.getStatus(env.DB, tokenId);
  assert.ok(st.lastCheckTs > Date.now() - 60e3);
  assert.equal(st.lastError, undefined);
});

test("心跳未到且无变化: status 不写(心跳节流生效)", async () => {
  const env = await runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3 }
  });
  await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(env.DB.writeCount(ST), 0);
});

test("新增场次: snapshot+changes+status 全落盘, 推送恰好一次", async () => {
  const env = await runtime({ snapshot: { "900": ["A1"] } });
  const counters = { pushCalls: 0 };
  const data = cinemaData([{ id: "900", nm: "片X", seqNos: ["A1", "A2"] }]);
  const res = await withMockFetch(
    upstreamMock(data, counters),
    () => runCheck(env, false, tokenId, { fetchCinema: async () => data })
  );
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 1);
  assert.equal(counters.pushCalls, 1);
  assert.equal(counters.notification.title, "🎬 新增 1 场｜片X");
  assert.equal(counters.notification.content, "🏢 测试影院\n🎞 片X\n\n🗓 新增场次\n• 2026-09-15 19:00 · 1号厅 · 国语 2D\n\n🔎 进入监控页查看并选择场次");
  assert.equal(env.DB.writeCount(SNAP), 1);
  assert.deepEqual((await db.getSnapshot(env.DB, tokenId))["900"], ["A1", "A2"]);
  assert.equal(env.DB.writeCount(CHG), 2); // new + ok 两条
  const changes = await db.listChanges(env.DB, tokenId);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].type, "ok");
  assert.equal(changes[1].type, "new");
  assert.equal(env.DB.writeCount(ST), 1);
  const st = await db.getStatus(env.DB, tokenId);
  assert.equal(st.newTotal, 1);
});

test("上游删场: 写 snapshot, 不写 changes, 不推送", async () => {
  const env = await runtime({ snapshot: { "900": ["A1", "A2"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  const counters = { pushCalls: 0 };
  const data = cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]);
  const res = await withMockFetch(
    upstreamMock(data, counters),
    () => runCheck(env, false, tokenId, { fetchCinema: async () => data })
  );
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 0);
  assert.equal(counters.pushCalls, 0);
  assert.equal(env.DB.writeCount(SNAP), 1);
  assert.deepEqual((await db.getSnapshot(env.DB, tokenId))["900"], ["A1"]);
  assert.equal(env.DB.writeCount(CHG), 0);
  assert.equal(env.DB.writeCount(ST), 0);
});

test("seqNo 顺序打乱但集合相同: 视为未变, 不落盘", async () => {
  const env = await runtime({ snapshot: { "900": ["A1", "A2"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A2", "A1"] }]) });
  assert.equal(env.DB.writeCount(SNAP), 0);
  assert.equal(env.DB.writeCount(CHG), 0);
  assert.equal(env.DB.writeCount(ST), 0);
});

test("首次检查(空快照): 建基线写 snapshot+status, 不推送不记 changes", async () => {
  const env = await runtime();
  const counters = { pushCalls: 0 };
  const data = cinemaData([
    { id: "900", nm: "片X", seqNos: ["A1"] },
    { id: "901", nm: "片Y", seqNos: ["B1", "B2"] }
  ]);
  const res = await withMockFetch(
    upstreamMock(data, counters),
    () => runCheck(env, false, tokenId, { fetchCinema: async () => data })
  );
  assert.equal(res.ok, true);
  assert.equal(res.newTotal, 0);
  assert.equal(counters.pushCalls, 0);
  const snapshot = await db.getSnapshot(env.DB, tokenId);
  assert.deepEqual(snapshot["900"], ["A1"]);
  assert.deepEqual(snapshot["901"], ["B1", "B2"]);
  assert.equal(env.DB.writeCount(CHG), 0);
  assert.equal(env.DB.writeCount(ST), 1);
});

test("错误恢复: 成功批清除 lastError 并写 status(即使心跳未到)", async () => {
  const env = await runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3, lastError: "猫眼接口返回了无效 JSON" }
  });
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(env.DB.writeCount(ST), 1);
  const st = await db.getStatus(env.DB, tokenId);
  assert.equal(st.lastError, undefined);
  assert.equal(st.newTotal, 0);
});

test("持续失败节流: 同一错误 30min 内不重写 status, 超时或错误变化才写", async () => {
  // 同一错误 + 心跳未到: 不写 status; changes 1h 节流后首条仍会写(独立逻辑, 不受影响)
  const env = await runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3, lastError: "上游挂了" }
  });
  const fail = async () => runCheck(env, false, tokenId, { fetchCinema: async () => { throw new Error("上游挂了"); } });
  await assert.rejects(fail, /上游挂了/);
  assert.equal(env.DB.writeCount(ST), 0);

  // 超 30min: 心跳到期, 重写 status 留存活痕迹
  await db.putStatus(env.DB, tokenId, { lastCheckTs: Date.now() - HEARTBEAT_MS - 60e3, lastError: "上游挂了" });
  env.DB.resetWrites();
  await assert.rejects(fail, /上游挂了/);
  assert.equal(env.DB.writeCount(ST), 1);
  const st = await db.getStatus(env.DB, tokenId);
  assert.equal(st.lastError, "上游挂了");

  // 错误信息变化: 立即重写(重置 lastCheckTs 避免被 90s 去抖跳过)
  await db.putStatus(env.DB, tokenId, { lastCheckTs: Date.now() - 10 * 60e3, lastError: "上游挂了" });
  env.DB.resetWrites();
  await assert.rejects(() => runCheck(env, false, tokenId, { fetchCinema: async () => { throw new Error("换了个错"); } }), /换了个错/);
  assert.equal(env.DB.writeCount(ST), 1);
});

test("手动检查: 即使无变化也写 status(用户在等即时反馈)", async () => {
  const env = await runtime({ snapshot: { "900": ["A1"] }, status: { lastCheckTs: Date.now() - 10 * 60e3 } });
  const res = await runCheck(env, true, tokenId, { fetchCinema: async () => cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]) });
  assert.equal(res.ok, true);
  assert.equal(env.DB.writeCount(SNAP), 0);
  assert.equal(env.DB.writeCount(CHG), 0);
  assert.equal(env.DB.writeCount(ST), 1);
});

test("手动检查失败: 不受心跳节流影响, status 必写最新错误", async () => {
  const env = await runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 10 * 60e3, lastError: "上游挂了" }
  });
  await assert.rejects(
    () => runCheck(env, true, tokenId, { fetchCinema: async () => { throw new Error("上游挂了"); } }),
    /上游挂了/
  );
  assert.equal(env.DB.writeCount(ST), 1);
});

test("去抖锚点仍生效: 距上次检查<半个批次间隔的重复触发跳过", async () => {
  const env = await runtime({
    snapshot: { "900": ["A1"] },
    status: { lastCheckTs: Date.now() - 30e3 } // 90s 容差内
  });
  let fetchCalls = 0;
  const res = await runCheck(env, false, tokenId, { fetchCinema: async () => { fetchCalls += 1; return cinemaData([{ id: "900", nm: "片X", seqNos: ["A1"] }]); } });
  assert.equal(res.skipped, true);
  assert.equal(fetchCalls, 0);
  assert.equal(env.DB.writeCount(SNAP), 0);
});
