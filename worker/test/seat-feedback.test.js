// 座位解析失败反馈测试: 手动按钮 API / KV 记录与去重 / 管理端列表删除 / cron 与立即锁座自动留档
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import {
  recordSeatFeedback, seatFeedbackKey, listSeatFeedback, deleteSeatFeedback, withSeatFeedback
} from "../src/maoyan/seat-feedback.js";
import { handleLockApi } from "../src/maoyan/lock-api.js";
import { handleAdminTokens } from "../src/maoyan/tokens.js";
import { createLockRule } from "../src/maoyan/lock-rule.js";
import { runOneLockRule } from "../src/maoyan/lock-runner.js";
import { userKey } from "../src/maoyan/user.js";

const tokenId = "11111111-1111-4111-8111-111111111111";
// 固定"现在": 中国日期 2026-09-13(UTC 时间 09-12 晚)
const now = new Date("2026-09-12T20:00:00.000Z");

// ---------------- recordSeatFeedback ----------------

test("手动反馈写入纯标识记录, 同 key 覆盖更新", async () => {
  const env = { MAOYAN_KV: new MemoryKV() };
  assert.equal(await recordSeatFeedback(env, {
    tokenId, cinemaId: "25428", movieId: "7", seqNo: "100", source: "manual", now
  }), true);
  const key = seatFeedbackKey("25428", "100");
  assert.equal(key, "seatfb:25428:100");
  assert.deepEqual(await env.MAOYAN_KV.get(key, "json"), {
    reportedAt: "2026-09-12T20:00:00.000Z",
    day: "2026-09-13",
    tokenId,
    cinemaId: "25428",
    movieId: "7",
    seqNo: "100",
    source: "manual"
  });
  // 覆盖更新: 换个令牌再报, 只留最新一条
  await recordSeatFeedback(env, {
    tokenId: "22222222-2222-4222-8222-222222222222", cinemaId: "25428", movieId: "7", seqNo: "100",
    source: "manual", now: new Date("2026-09-12T21:00:00.000Z")
  });
  const listed = await listSeatFeedback(env);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenId, "22222222-2222-4222-8222-222222222222");
  assert.equal(listed[0].reportedAt, "2026-09-12T21:00:00.000Z");
});

test("自动留档按中国日期当天去重, 手动反馈不受去重限制", async () => {
  const env = { MAOYAN_KV: new MemoryKV() };
  assert.equal(await recordSeatFeedback(env, { cinemaId: "25428", seqNo: "100", source: "auto", now }), true);
  // 同一天重复 cron → 跳过
  assert.equal(await recordSeatFeedback(env, { cinemaId: "25428", seqNo: "100", source: "auto", now }), false);
  // 手动反馈总是覆盖
  assert.equal(await recordSeatFeedback(env, { cinemaId: "25428", seqNo: "100", source: "manual", now }), true);
  assert.equal((await listSeatFeedback(env)).length, 1);
});

test("反馈记录缺 cinemaId 或缺 KV 时静默失败", async () => {
  assert.equal(await recordSeatFeedback({ MAOYAN_KV: new MemoryKV() }, { seqNo: "100" }), false);
  assert.equal(await recordSeatFeedback(null, { cinemaId: "25428" }), false);
  // KV 抛错也不外泄
  const broken = { MAOYAN_KV: { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } };
  assert.equal(await recordSeatFeedback(broken, { cinemaId: "25428", source: "manual" }), false);
});

// ---------------- withSeatFeedback 包装 ----------------

test("withSeatFeedback 只在座位图格式无效时留档, 并原样抛出错误", async () => {
  const env = { MAOYAN_KV: new MemoryKV() };
  const params = { cinemaId: "25428", movieId: "7", seqNo: "100" };
  const malformed = () => { throw new Error("猫眼座位图格式无效"); };

  await assert.rejects(withSeatFeedback(malformed, env, { tokenId })(validSession(), params), /猫眼座位图格式无效/);
  const [record] = await listSeatFeedback(env);
  assert.equal(record.key, "seatfb:25428:100");
  assert.equal(record.tokenId, tokenId);
  assert.equal(record.cinemaId, "25428");
  assert.equal(record.movieId, "7");
  assert.equal(record.seqNo, "100");
  assert.equal(record.source, "auto");
  assert.ok(record.reportedAt);
  assert.ok(record.day);

  // 其它错误(网络/HTTP)不记录
  const network = () => { throw new Error("猫眼请求失败：HTTP 500"); };
  await assert.rejects(withSeatFeedback(network, env, { tokenId })(validSession(), params), /HTTP 500/);
  assert.equal((await listSeatFeedback(env)).length, 1);

  // 成功路径不记录
  const ok = async () => ({ seqNo: "100", seats: [] });
  assert.deepEqual(await withSeatFeedback(ok, env, { tokenId })(validSession(), params), { seqNo: "100", seats: [] });
  assert.equal((await listSeatFeedback(env)).length, 1);
});

// ---------------- 锁座 API: POST /api/lock/seat-feedback ----------------

function lockApiEnv(overrides = {}) {
  return {
    MAOYAN_KV: new MemoryKV(),
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    LOCK_SERVICE_ENABLED: "true",
    ...overrides
  };
}

async function callLockApi(path, options, env = lockApiEnv()) {
  return await handleLockApi(
    new Request(`https://worker.example${path}`, options), env, new URL(`https://worker.example${path}`), tokenId
  );
}

test("座位反馈接口不需要已上传会话, 记录带令牌标识", async () => {
  const env = lockApiEnv();
  const response = await callLockApi("/api/lock/seat-feedback", {
    method: "POST",
    body: JSON.stringify({ cinemaId: "25428", movieId: "7", seqNo: "100" })
  }, env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).recorded, true);
  const records = await listSeatFeedback(env);
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "seatfb:25428:100");
  assert.equal(records[0].tokenId, tokenId);
  assert.equal(records[0].source, "manual");
});

test("座位反馈接口参数校验: 非数字/缺参 400, 方法不符 405", async () => {
  const invalidCinema = await callLockApi("/api/lock/seat-feedback", {
    method: "POST", body: JSON.stringify({ cinemaId: "abc", movieId: "7" })
  });
  assert.equal(invalidCinema.status, 400);
  assert.equal((await invalidCinema.json()).error, "cinemaId 无效");

  const invalidSeq = await callLockApi("/api/lock/seat-feedback", {
    method: "POST", body: JSON.stringify({ cinemaId: "25428", movieId: "7", seqNo: "x1" })
  });
  assert.equal(invalidSeq.status, 400);
  assert.equal((await invalidSeq.json()).error, "seqNo 无效");

  const notJson = await callLockApi("/api/lock/seat-feedback", { method: "POST", body: "not-json" });
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error, "反馈参数无效");

  const notAllowed = await callLockApi("/api/lock/seat-feedback", { method: "GET" });
  assert.equal(notAllowed.status, 405);
});

// ---------------- 立即锁座: 默认取图失败自动留档 ----------------

function createEnv(config = { cinemaId: "25428", selectedMovieIds: ["7"] }) {
  return {
    LOCK_SERVICE_ENABLED: "true",
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    MAOYAN_KV: new MemoryKV({ [userKey("token-a", "config")]: JSON.stringify(config) })
  };
}

function createDeps(overrides = {}) {
  return {
    now: new Date("2026-09-11T04:00:00.000Z"),
    loadSession: async () => validSession(),
    fetchCinema: async () => ({ showData: {
      cinemaName: "测试影院",
      movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", ticketStatus: 0 }
      ] }] }]
    } }),
    ...overrides
  };
}

function validInput(overrides = {}) {
  return {
    cinemaId: "25428",
    movieId: "7",
    templateSeqNo: "100",
    targetDate: "2026-09-12",
    seatNos: ["1-6-18"],
    riskAccepted: true,
    ...overrides
  };
}

test("立即锁座: 默认取图解析失败时自动留档并原样报错", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>登录页, 无座位块</html>", { status: 200 });
  try {
    await assert.rejects(
      createLockRule(env, "token-a", validInput(), createDeps()),
      /猫眼座位图格式无效/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const records = await listSeatFeedback(env);
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "seatfb:25428:100");
  assert.equal(records[0].source, "auto");
  assert.equal(records[0].cinemaId, "25428");
  assert.equal(records[0].movieId, "7");
  assert.equal(records[0].tokenId, "token-a");
});

test("立即锁座: 注入的 fetchSeats 失败不经留档包装", async () => {
  const env = createEnv();
  await assert.rejects(
    createLockRule(env, "token-a", validInput(), createDeps({
      fetchSeats: async () => { throw new Error("猫眼座位图格式无效"); }
    })),
    /猫眼座位图格式无效/
  );
  assert.equal((await listSeatFeedback(env)).length, 0);
});

// ---------------- 定时锁座: cron 默认取图失败自动留档 ----------------

test("定时锁座: 默认取图解析失败时自动留档且规则回到等待", async () => {
  const stored = {
    id: "rule-a", cinemaId: "25428", cinemaName: "测试影院", movieId: "7", movieName: "测试电影",
    targetDate: "2026-09-12", templateTime: "20:00",
    seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N" }],
    state: "waiting_schedule"
  };
  const env = { MAOYAN_KV: new MemoryKV(), LOCK_SERVICE_ENABLED: "true" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>无座位块</html>", { status: 200 });
  try {
    const result = await runOneLockRule(env, tokenId, {
      now: () => new Date("2026-09-11T04:00:00.000Z"),
      getRule: async () => stored,
      putRule: async (_env, _token, value) => { Object.assign(stored, value); },
      fetchCinema: async () => ({ showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00" }] }] }] } }),
      findShows: () => [{ seqNo: "200", tm: "20:00" }],
      loadSession: async () => validSession(),
      notify: async () => {}
    });
    assert.equal(result.ok, false);
    assert.equal(result.waiting, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const records = await listSeatFeedback(env);
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "seatfb:25428:200");
  assert.equal(records[0].source, "auto");
  // 主流程不受影响: 规则保持 waiting(仅记录 lastError)
  assert.equal(stored.state, "waiting_schedule");
  assert.match(stored.lastError, /猫眼场次或座位信息暂时不可用/);
});

// ---------------- 管理端 ----------------

function adminEnv(kv) {
  return { ADMIN_TOKEN: "admin-secret", MAOYAN_KV: kv };
}

async function callAdmin(path, options, env) {
  const request = new Request(`https://worker.example${path}`, {
    headers: { "X-Admin-Token": "admin-secret" }, ...options
  });
  return await handleAdminTokens(request, env, new URL(request.url));
}

test("管理端: 反馈列表按时间倒序, DELETE 清除, 非法 key 拒绝", async () => {
  const env = adminEnv(new MemoryKV());
  await recordSeatFeedback(env, { tokenId, cinemaId: "25428", movieId: "7", seqNo: "100", source: "manual", now });
  await recordSeatFeedback(env, {
    tokenId, cinemaId: "39999", movieId: "8", seqNo: "", source: "auto",
    now: new Date("2026-09-12T20:05:00.000Z")
  });

  const list = await callAdmin("/api/admin/seat-feedback", { method: "GET" }, env);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.ok, true);
  assert.equal(body.feedback.length, 2);
  // 空序列表的 key 用 "na" 占位
  assert.equal(body.feedback.find((item) => item.cinemaId === "39999").key, "seatfb:39999:na");
  // 倒序: 后写的在前
  assert.equal(body.feedback[0].cinemaId, "39999");

  const removed = await callAdmin("/api/admin/seat-feedback?key=seatfb:25428:100", { method: "DELETE" }, env);
  assert.equal(removed.status, 200);
  assert.equal((await listSeatFeedback(env)).length, 1);

  const badKey = await callAdmin("/api/admin/seat-feedback", {
    method: "DELETE", body: JSON.stringify({ key: "meta:tokens" })
  }, env);
  assert.equal(badKey.status, 400);
});

test("管理端: 反馈接口同样受 X-Admin-Token 保护", async () => {
  const env = adminEnv(new MemoryKV());
  const request = new Request("https://worker.example/api/admin/seat-feedback", { method: "GET" });
  const response = await handleAdminTokens(request, env, new URL(request.url));
  assert.equal(response.status, 401);
});

test("deleteSeatFeedback 对合法 key 直删并返回 true", async () => {
  const env = adminEnv(new MemoryKV());
  await recordSeatFeedback(env, { tokenId, cinemaId: "25428", movieId: "7", seqNo: "100", source: "manual", now });
  assert.equal(await deleteSeatFeedback(env, "seatfb:25428:100"), true);
  assert.equal(await deleteSeatFeedback(env, "seatfb:25428:100"), true);
  assert.equal(await deleteSeatFeedback(env, "other:key"), false);
  assert.equal(await deleteSeatFeedback(env, ""), false);
});
