// ---------------- 回归测试: 2026-09-12 缺陷修复 ----------------
// 覆盖 BUG-1(误报到期) / BUG-2(检查假成功) / BUG-4(切渠道静默失效) / BUG-5(非法 cinemaId) 与状态码统一

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { MemoryKV } from "./helpers.js";
import { isExpired } from "../src/maoyan/ddl.js";
import { runScheduledChecks } from "../src/maoyan/tokens.js";
import { userKey } from "../src/maoyan/user.js";

const tokenId = "11111111-1111-4111-8111-111111111111";
const ACCESS = "access-token";
const FUTURE = new Date(Date.now() + 86400e3).toISOString();

function runtime(config = {}) {
  return {
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([{ id: tokenId, token: ACCESS }]),
      [userKey(tokenId, "config")]: JSON.stringify(config)
    })
  };
}

function request(path, body) {
  return new Request(`https://worker.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Token": ACCESS,
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

test("BUG-1: isExpired 只对「明确开始监控」的配置生效", () => {
  const past = new Date(Date.now() - 86400e3).toISOString();
  // 只选好影院、从未点「开始监控」(enabled 未设置) -> 不算到期
  assert.equal(isExpired({ cinemaId: "38569" }), false);
  assert.equal(isExpired({ cinemaId: "38569", enabled: undefined }), false);
  // 手动停止 -> 不算到期
  assert.equal(isExpired({ enabled: false, monitorDdl: past }), false);
  // 明确开启: 未设截止(历史配置)视为到期, 未来的截止不算到期, 已过期的截止算到期
  assert.equal(isExpired({ enabled: true }), true);
  assert.equal(isExpired({ enabled: true, monitorDdl: FUTURE }), false);
  assert.equal(isExpired({ enabled: true, monitorDdl: past }), true);
});

test("BUG-1: cron 跳过从未开始监控的用户, 不写告警也不抓取上游", async () => {
  const config = { cinemaId: "38569", selectedMovieIds: ["1545360"] };
  const env = runtime(config);
  let upstreamCalls = 0;
  await withMockFetch(async () => {
    upstreamCalls += 1;
    throw new Error("不应为未监控用户抓取上游");
  }, async () => {
    await runScheduledChecks(env);
  });
  assert.equal(upstreamCalls, 0);
  assert.equal(await env.MAOYAN_KV.get(userKey(tokenId, "changes"), "json"), null);
  // 配置未被改写(不会被写入 enabled:false 或误导性的到期文案)
  assert.deepEqual(await env.MAOYAN_KV.get(userKey(tokenId, "config"), "json"), config);
});

test("BUG-2: 手动检查用真实状态码回报, 不再假装成功", async () => {
  const noCinema = await worker.fetch(
    request("/api/check", {}),
    runtime({ enabled: true, monitorDdl: FUTURE })
  );
  assert.equal(noCinema.status, 400);
  assert.match((await noCinema.json()).error, /未配置影院/);

  const notStarted = await worker.fetch(request("/api/check", {}), runtime({ cinemaId: "38569" }));
  assert.equal(notStarted.status, 409);
  assert.match((await notStarted.json()).error, /尚未开始监控/);

  const stopped = await worker.fetch(
    request("/api/check", {}),
    runtime({ cinemaId: "38569", enabled: false, monitorDdl: FUTURE })
  );
  assert.equal(stopped.status, 409);
  assert.match((await stopped.json()).error, /监控已停止/);
});

test("BUG-4: 运行中切到未配置渠道时自动停止监控并留痕", async () => {
  const env = runtime({ cinemaId: "38569", notifyChannel: "bark", barkKey: "bark-key" });
  await withMockFetch(async () => new Response("ok", { status: 200 }), async () => {
    const tested = await worker.fetch(request("/api/test-push", {}), env);
    assert.equal(tested.status, 200);

    const started = await worker.fetch(request("/api/config", { enabled: true }), env);
    assert.equal(started.status, 200);
    assert.equal((await started.json()).config.enabled, true);

    const switched = await worker.fetch(request("/api/config", { notifyChannel: "serverchan" }), env);
    assert.equal(switched.status, 200);
    const body = await switched.json();
    assert.equal(body.config.enabled, false);
    assert.match(body.notice, /Server酱/);
    assert.match(body.notice, /自动停止/);
  });

  const changes = await env.MAOYAN_KV.get(userKey(tokenId, "changes"), "json");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "warn");
  assert.match(changes[0].text, /监控已自动停止/);
});

test("BUG-5: 非法 cinemaId 被拒绝且不落库", async () => {
  const env = runtime({});
  const rejected = await worker.fetch(request("/api/config", { cinemaId: "abc" }), env);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /纯数字/);
  assert.deepEqual(await env.MAOYAN_KV.get(userKey(tokenId, "config"), "json"), {});
});

test("状态码统一: shows/cinemas 的非法入参返回 400 而非 500", async () => {
  const env = runtime({ cinemaId: "38569" });
  const shows = await worker.fetch(request("/api/shows?cinemaId=abc"), env);
  assert.equal(shows.status, 400);
  assert.match((await shows.json()).error, /cinemaId 无效/);

  const cinemas = await worker.fetch(request("/api/cinemas?cityId=abc&kw=x"), env);
  assert.equal(cinemas.status, 400);
  assert.match((await cinemas.json()).error, /cityId 无效/);
});
