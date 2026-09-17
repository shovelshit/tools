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

test("public claim UI exposes no external source or deployment links", () => {
  assert.doesNotMatch(html, /<a\b[^>]*target\s*=\s*["']_blank["'][^>]*>/i);
  assert.doesNotMatch(html, /(?:github\.com|源码|部署方式|自行部署)/i);
});
