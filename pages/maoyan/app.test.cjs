const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("switching connections clears only the Maoyan user connection", () => {
  const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.equal(source.includes("localStorage.clear()"), false);
  assert.match(source, /localStorage\.removeItem\("workerUrl"\)/);
  assert.match(source, /localStorage\.removeItem\("authMode"\)/);
  assert.match(source, /secureSet\("token", ""\)/);
});

test("lock submission restores disabled state after the loading button resets", () => {
  const source = fs.readFileSync(path.join(__dirname, "lock.js"), "utf8");
  assert.match(source, /await buttonLoading\(els\.submit,[\s\S]*?\n\s*renderSelection\(\);\n\s*}/);
});
