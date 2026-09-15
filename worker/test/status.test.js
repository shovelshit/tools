import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createDB } from "./helpers.js";

const tokenId = "11111111-1111-4111-8111-111111111111";

async function runtime(enabled) {
  return {
    LOCK_SERVICE_ENABLED: enabled,
    DB: await createDB({
      tokens: [{ id: tokenId, token: "access-token" }]
    })
  };
}

test("status exposes the single lock-service capability switch", async () => {
  for (const [value, expected] of [["true", true], ["false", false], [undefined, false]]) {
    const request = new Request("https://worker.example/api/status", {
      headers: { "X-Token": "access-token" }
    });
    const response = await worker.fetch(request, await runtime(value));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.lockServiceEnabled, expected);
  }
});
