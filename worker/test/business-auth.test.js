import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";

test("a Store key cannot read Maoyan status", async () => {
  const env = await createAccountEnv();
  const { key } = await seedAccount(env, { businessLine: "store" });

  const response = await worker.fetch(new Request("https://worker.example/api/status", {
    headers: { "X-Token": key }
  }), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "FORBIDDEN");
});

test("a Store key cannot create a Maoyan monitor session", async () => {
  const env = await createAccountEnv();
  const { key } = await seedAccount(env, { businessLine: "store" });

  const response = await worker.fetch(new Request("https://worker.example/api/auth/session", {
    method: "POST",
    headers: { "X-Token": key }
  }), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "FORBIDDEN");
});
