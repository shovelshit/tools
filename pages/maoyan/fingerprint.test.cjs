const test = require("node:test");
const assert = require("node:assert/strict");
const { collectEnrollmentFingerprint } = require("./fingerprint.js");

test("fingerprint package never enables telemetry", async () => {
  let options;
  class ThumbmarkClass {
    constructor(input) { options = input; }
    async get() { return { thumbmark: "a".repeat(32), version: "1.11.0" }; }
  }
  const result = await collectEnrollmentFingerprint({ ThumbmarkClass });
  assert.equal(options.logging, false);
  assert.equal(options.api_key, undefined);
  assert.equal(result.version, "thumbmark-1.11.0-v1");
});

test("fatal or malformed fingerprints fail closed", async () => {
  class BadThumbmark { async get() { return { thumbmark: "", error: [{ type: "fatal" }] }; } }
  await assert.rejects(() => collectEnrollmentFingerprint({ ThumbmarkClass: BadThumbmark }), /浏览器标识/);
});
