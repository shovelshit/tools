import test from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import { handleAdminTokens, runScheduledChecks } from "../src/maoyan/tokens.js";
import * as db from "../src/maoyan/db.js";

// 固定窗口内时刻(北京 10:00), 使 runScheduledChecks 的监控窗口判断稳定通过
const WINDOW_NOW = Date.parse("2026-09-14T02:00:00.000Z");

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("admin token listing masks short and long access tokens", async () => {
  const env = {
    ADMIN_TOKEN: "admin-secret",
    DB: await createDB({
      tokens: [
        { id: "short-id", token: "abcdef", remark: "short" },
        { id: "long-id", token: "abcdefghijklmnop", remark: "long" }
      ]
    })
  };
  const request = new Request("https://worker.example/api/admin/tokens", {
    headers: { "X-Admin-Token": "admin-secret" }
  });
  const response = await handleAdminTokens(request, env, new URL(request.url));
  const body = await response.json();

  assert.equal(response.status, 200);
  const byRemark = Object.fromEntries(body.tokens.map((token) => [token.remark, token]));
  assert.equal(byRemark.short.token, "abcd **** cdef");
  assert.equal(byRemark.long.token, "abcd **** mnop");
  assert.equal(JSON.stringify(body).includes("abcdef"), false);
  assert.equal(JSON.stringify(body).includes("abcdefghijklmnop"), false);
});

test("scheduled monitoring hands data off only after snapshot and status persistence", async () => {
  const tokenId = "11111111-1111-4111-8111-111111111111";
  const cinema = { showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-12", plist: [
      { seqNo: "200", tm: "20:00", ticketStatus: 0 }
    ] }] }]
  } };
  const baseConfig = {
    enabled: true,
    cinemaId: "25428",
    selectedMovieIds: ["7"],
    monitorDdl: "2099-01-01T00:00:00.000Z"
  };
  const env = {
    DB: await createDB({
      tokens: [{ id: tokenId, token: "access-token" }],
      configs: { [tokenId]: baseConfig }
    })
  };
  let handoffs = 0;

  await withMockFetch(async (input) => {
    if (String(input).includes("/ajax/cinemaDetail")) {
      return new Response(JSON.stringify(cinema), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }, async () => {
    await runScheduledChecks(env, async (id, monitoredCinema) => {
      handoffs++;
      assert.equal(id, tokenId);
      assert.deepEqual(monitoredCinema, cinema);
      assert.ok(Object.keys(await db.getSnapshot(env.DB, tokenId)).length > 0);
      assert.ok(await db.getStatus(env.DB, tokenId));
    }, { now: WINDOW_NOW });
  });

  assert.equal(handoffs, 1);

  await db.putConfig(env.DB, tokenId, { enabled: false, cinemaId: "25428" });
  await runScheduledChecks(env, async () => { handoffs++; }, { now: WINDOW_NOW });
  assert.equal(handoffs, 1);

  await db.putConfig(env.DB, tokenId, baseConfig);
  await db.deleteStatus(env.DB, tokenId);
  await withMockFetch(async () => { throw new Error("provider unavailable"); }, async () => {
    await runScheduledChecks(env, async () => { handoffs++; }, { now: WINDOW_NOW });
  });
  assert.equal(handoffs, 1);
});
