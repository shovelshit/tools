import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "./helpers.js";
import { handleAdminTokens } from "../src/maoyan/tokens.js";

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
