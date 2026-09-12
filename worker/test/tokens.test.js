import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "./helpers.js";
import { handleAdminTokens, runScheduledChecks } from "../src/maoyan/tokens.js";
import { userKey } from "../src/maoyan/user.js";

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
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([
        { id: "short-id", token: "abcdef", remark: "short" },
        { id: "long-id", token: "abcdefghijklmnop", remark: "long" }
      ])
    })
  };
  const request = new Request("https://worker.example/api/admin/tokens", {
    headers: { "X-Admin-Token": "admin-secret" }
  });
  const response = await handleAdminTokens(request, env, new URL(request.url));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.tokens[0].token, "ab **** ef");
  assert.equal(body.tokens[1].token, "abcd **** mnop");
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
  const env = {
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([{ id: tokenId, token: "access-token" }]),
      [userKey(tokenId, "config")]: JSON.stringify({
        enabled: true,
        cinemaId: "25428",
        selectedMovieIds: ["7"],
        monitorDdl: "2099-01-01T00:00:00.000Z"
      })
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
      assert.ok(await env.MAOYAN_KV.get(userKey(tokenId, "snapshot"), "json"));
      assert.ok(await env.MAOYAN_KV.get(userKey(tokenId, "status"), "json"));
    });
  });

  assert.equal(handoffs, 1);

  await env.MAOYAN_KV.put(userKey(tokenId, "config"), JSON.stringify({ enabled: false, cinemaId: "25428" }));
  await runScheduledChecks(env, async () => { handoffs++; });
  assert.equal(handoffs, 1);
});
