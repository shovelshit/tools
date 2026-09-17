import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkDeploymentConfig } from "../scripts/deploy-preflight.mjs";

test("deployment template contains no production resource identities", async () => {
  const text = await readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8");
  assert.equal(text.includes("ee66c7c1-58b6-4d95-8f68-d0ff4b092bd2"), false);
  assert.equal(text.includes("2027a99d8e934025b3b82ef203c4acff"), false);
  assert.equal(text.includes("ltools.asia"), false);
  assert.equal(text.includes("new_sqlite_classes"), true);
  assert.match(text, /公开申请在 D1 管理设置中默认关闭/);
  assert.equal(text.includes("PUBLIC_ENROLLMENT_ENABLED"), false);
});

test("preflight reports required bindings and secret presence without values", () => {
  const result = checkDeploymentConfig({ configText: "name = \"mine\"", secretNames: [] });
  assert.equal(result.ok, false);
  for (const name of ["DB", "MAOYAN_KV", "LOCK_COORDINATOR", "MONITOR_DISPATCHER", "MONITOR_COORDINATOR", "NOTIFICATION_DISPATCHER", "ADMIN_TOKEN", "SESSION_ENCRYPTION_KEY", "ENROLLMENT_HMAC_KEY"]) {
    assert.equal(result.errors.some((error) => error.includes(name)), true, name);
  }
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("Turnstile is optional for private deployments and required when enrollment is enabled", async () => {
  const configText = await readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8");
  const secretNames = ["ADMIN_TOKEN", "SESSION_ENCRYPTION_KEY", "ENROLLMENT_HMAC_KEY"];
  const privateResult = checkDeploymentConfig({ configText, secretNames });
  assert.equal(privateResult.ok, true, privateResult.errors.join("\n"));
  const publicResult = checkDeploymentConfig({
    configText,
    secretNames,
    publicEnrollment: true
  });
  assert.equal(publicResult.ok, false);
  assert.equal(publicResult.errors.some((error) => /TURNSTILE_SECRET_KEY/.test(error)), true);
  assert.equal(publicResult.errors.some((error) => /ENROLLMENT_ORIGIN/.test(error)), true);
  assert.equal(publicResult.errors.some((error) => /ENROLLMENT_HOSTNAME/.test(error)), true);
});

test("fresh production schema does not recreate the retired plaintext token table", async () => {
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS tokens\s*\(/);
});
