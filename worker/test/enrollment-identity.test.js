import test from "node:test";
import assert from "node:assert/strict";
import { digestEnrollmentIdentity } from "../src/maoyan/enrollment-identity.js";
import { testEncryptionKey } from "./helpers.js";

test("client IP canonicalization keeps equivalent IPv6 identities stable", async () => {
  const env = { ENROLLMENT_HMAC_KEY: testEncryptionKey() };
  const a = await digestEnrollmentIdentity(env, {
    fingerprint: "f".repeat(32), version: "thumbmark-1.11.0-v1", edgeIp: "2001:0db8::1"
  });
  const b = await digestEnrollmentIdentity(env, {
    fingerprint: "f".repeat(32), version: "thumbmark-1.11.0-v1", edgeIp: "2001:db8:0:0:0:0:0:1"
  });
  assert.equal(a.ipDigest, b.ipDigest);
  assert.equal(a.fingerprintDigest, b.fingerprintDigest);
  assert.equal(JSON.stringify(a).includes("2001:db8"), false);
});

test("identity rejects untrusted or malformed inputs", async () => {
  const env = { ENROLLMENT_HMAC_KEY: testEncryptionKey() };
  await assert.rejects(() => digestEnrollmentIdentity(env, {
    fingerprint: "short", version: "thumbmark-1.11.0-v1", edgeIp: "127.0.0.1"
  }), /浏览器标识/);
  await assert.rejects(() => digestEnrollmentIdentity(env, {
    fingerprint: "a".repeat(32), version: "future", edgeIp: "127.0.0.1"
  }), /版本/);
});
