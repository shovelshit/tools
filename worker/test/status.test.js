import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { MemoryKV } from "./helpers.js";

function runtime(enabled) {
  return {
    LOCK_SERVICE_ENABLED: enabled,
    MAOYAN_KV: new MemoryKV({
      "meta:tokens": JSON.stringify([{ id: "token-id", token: "access-token" }])
    })
  };
}

test("status exposes the single lock-service capability switch", async () => {
  for (const [value, expected] of [["true", true], ["false", false], [undefined, false]]) {
    const request = new Request("https://worker.example/api/status", {
      headers: { "X-Token": "access-token" }
    });
    const response = await worker.fetch(request, runtime(value));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.lockServiceEnabled, expected);
  }
});
