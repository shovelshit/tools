const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pageDir = path.resolve(__dirname, "../../pages/maoyan");
const html = fs.readFileSync(path.join(pageDir, "claim.html"), "utf8");
const source = fs.readFileSync(path.join(pageDir, "claim-page.js"), "utf8");

test("claim UI never transfers access keys through URLs", () => {
  assert.doesNotMatch(source, /searchParams\.set\([^,]+,\s*key/);
  assert.doesNotMatch(source, /[?&](?:token|key)=/);
  assert.match(source, /secureSet\(window\.webTokenKey/);
});

test("claim external links prevent opener and referrer leakage", () => {
  const external = [...html.matchAll(/<a[^>]+target="_blank"[^>]*>/g)].map((match) => match[0]);
  assert.ok(external.length >= 2);
  assert.equal(external.every((tag) => /rel="[^"]*noopener[^"]*noreferrer[^"]*"/.test(tag)), true);
});
