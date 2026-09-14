// 影院切换行为: 快照生命周期 + 监控数据源
// 背景: 快照按影片 id 记 seqNo, 切换影院后同影片 seqNo 全部不同 —
//       若 POST /api/config 换影院时不清快照, cron 首检会把新影院该影片全部场次误报为"新增场次"
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { runCheck } from "../src/maoyan/check.js";
import { MemoryKV } from "./helpers.js";
import { userKey } from "../src/maoyan/user.js";

const tokenId = "22222222-2222-4222-8222-222222222222";

function request(path, body) {
  return new Request(`https://worker.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Token": "access-token",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
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

// 构造已验证推送渠道 + 监控开启的运行环境(与 config.test.js 同路径: test-push → enabled)
async function verifiedEnv(extraKV = {}) {
  const env = {
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([{ id: tokenId, token: "access-token" }]),
      ...extraKV
    })
  };
  // 与 config.test.js 同路径: 先保存推送密钥 → 测试推送验证 → 才能开启监控
  const keySaved = await worker.fetch(request("/api/config", { barkKey: "test-key" }), env);
  assert.equal(keySaved.status, 200);
  await withMockFetch(async () => new Response("ok", { status: 200 }), async () => {
    const r = await worker.fetch(request("/api/test-push", {}), env);
    assert.equal(r.status, 200);
  });
  const start = await worker.fetch(request("/api/config", {
    cinemaId: "111", selectedMovieIds: ["900"], enabled: true
  }), env);
  assert.equal(start.status, 200);
  return env;
}

// 影院 A/B 同映一部影片(900), 场次 seqNo 完全不同 — 模拟真实跨影院情形
const cinemaA = {
  showData: { cinemaName: "影院A", movies: [{ id: "900", nm: "片X", shows: [{ showDate: "2026-09-13", plist: [{ tm: "19:00", lang: "国语", tp: "2D", th: "1号厅", seqNo: "A1" }] }] }] }
};
const cinemaB = {
  showData: { cinemaName: "影院B", movies: [{ id: "900", nm: "片X", shows: [{ showDate: "2026-09-13", plist: [{ tm: "20:00", lang: "国语", tp: "2D", th: "2号厅", seqNo: "B1" }] }] }] }
};

test("switching cinema resets the show snapshot so the new cinema is not reported as new shows", async () => {
  const env = await verifiedEnv({
    // 旧影院(111)的快照: 影片 900 已记录 seqNo A1
    [userKey(tokenId, "snapshot")]: JSON.stringify({ "900": ["A1"] })
  });
  const post = await worker.fetch(request("/api/config", { cinemaId: "222" }), env);
  assert.equal(post.status, 200);
  const cfg = await env.MAOYAN_KV.get(userKey(tokenId, "config"), "json");
  assert.equal(cfg.cinemaId, "222");
  assert.equal(await env.MAOYAN_KV.get(userKey(tokenId, "snapshot"), "json"), null); // 快照已随切影院清空

  // 切影院后首次检查: 重建基线, 不产生"新增场次"告警, 不推送
  const res = await withMockFetch(async () => {
    throw new Error("pushNotify must not be called right after a cinema switch");
  }, () => runCheck(env, false, tokenId, { fetchCinema: async () => cinemaB }));
  assert.equal(res.skipped, undefined);
  // 无变化批次(重建基线)不再落盘 changes(KV 写额度优化), 读取为 null
  const changes = (await env.MAOYAN_KV.get(userKey(tokenId, "changes"), "json")) || [];
  assert.equal(changes.length, 0);
  const snapshot = await env.MAOYAN_KV.get(userKey(tokenId, "snapshot"), "json");
  assert.deepEqual(snapshot["900"], ["B1"]); // 新影院基线已建立
});

test("re-saving the same cinema keeps the snapshot (no spurious baseline resets)", async () => {
  const env = await verifiedEnv();
  // 切到 222(快照本就为空) → 首检建立基线 B1(直接预置模拟)
  await worker.fetch(request("/api/config", { cinemaId: "222" }), env);
  await env.MAOYAN_KV.put(userKey(tokenId, "snapshot"), JSON.stringify({ "900": ["B1"] }));
  // 前端每次加载影院/勾选影片都会重复保存同一 cinemaId — 不得清快照(否则持续漏报真实新增)
  const post = await worker.fetch(request("/api/config", { cinemaId: "222", selectedMovieIds: ["900"] }), env);
  assert.equal(post.status, 200);
  const snapshot = await env.MAOYAN_KV.get(userKey(tokenId, "snapshot"), "json");
  assert.deepEqual(snapshot["900"], ["B1"]);
});

test("monitor keeps running and follows the new cinema after a switch (config untouched elsewhere)", async () => {
  const env = await verifiedEnv();
  const post = await worker.fetch(request("/api/config", { cinemaId: "222" }), env);
  assert.equal(post.status, 200);
  const cfg = await env.MAOYAN_KV.get(userKey(tokenId, "config"), "json");
  assert.equal(cfg.enabled, true); // 切影院不停止监控
  assert.equal(cfg.monitorDdl !== undefined && cfg.monitorDdl !== null, true); // 截止时间不重置
  assert.deepEqual(cfg.selectedMovieIds, ["900"]); // 未随请求变化
});
