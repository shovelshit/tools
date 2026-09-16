import test from "node:test";
import assert from "node:assert/strict";
import { pushBark, pushServerChan, serverChanEndpoint } from "../src/common/notify.js";

test("ServerChan v3 uses its numbered host", () => {
  assert.equal(serverChanEndpoint("sctp123tabc"), "https://123.push.ft07.com/send/sctp123tabc.send");
  assert.equal(serverChanEndpoint("SCTabc"), "https://sctapi.ftqq.com/SCTabc.send");
  assert.throws(() => serverChanEndpoint("https://evil.example/key"), /格式/);
});

test("HTTP 200 business failures are rejected for both notification channels", async () => {
  const barkFetch = async () => Response.json({ code: 400, message: "bad" });
  await assert.rejects(() => pushBark("key", "title", "body", { fetchImpl: barkFetch }), /Bark 推送失败/);
  const serverFetch = async () => Response.json({ code: 1, message: "bad" });
  await assert.rejects(() => pushServerChan("SCTabc", "title", "body", { fetchImpl: serverFetch }), /Server酱 推送失败/);
});

test("valid business responses are accepted", async () => {
  await pushBark("https://bark.example/custom", "title", "body", {
    fetchImpl: async (url) => { assert.match(url, /^https:\/\/bark\.example\/custom\//); return Response.json({ code: 200 }); }
  });
  await pushServerChan("sctp123tabc", "title", "body", {
    fetchImpl: async (url) => { assert.equal(url, serverChanEndpoint("sctp123tabc")); return Response.json({ code: 0 }); }
  });
});
