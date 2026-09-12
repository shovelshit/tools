const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 统一按 LF 读取: 源码在多平台检出时可能是 CRLF, 不能让行尾符决定测试结果
function readSource(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8").replace(/\r\n/g, "\n");
}

test("switching connections clears only the Maoyan user connection", () => {
  const source = readSource("app.js");
  assert.equal(source.includes("localStorage.clear()"), false);
  assert.match(source, /localStorage\.removeItem\("workerUrl"\)/);
  assert.match(source, /localStorage\.removeItem\("authMode"\)/);
  assert.match(source, /secureSet\("token", ""\)/);
});

test("lock submission restores disabled state after the loading button resets", () => {
  const source = readSource("lock.js");
  assert.match(source, /await buttonLoading\(els\.submit,[\s\S]*?\n\s*renderSelection\(\);\n\s*}/);
});

test("monitor start stays disabled until the current push configuration is tested", () => {
  const source = readSource("app.js");
  assert.match(source, /let pushVerified = false/);
  assert.match(source, /!monitorEnabled && !pushVerified/);
  assert.match(source, /pushVerified = config\.notifyVerified === true/);
  assert.match(source, /pushVerified = res\.config\?\.notifyVerified === true/);
  assert.match(source, /pushVerified = true;[\s\S]*?updateMonitorBtn\(\)/);
});

test("stopped monitor status never falls back to an expired label", () => {
  const source = readSource("app.js");
  // 手动停止后服务端仍保留未来 monitorDdl, 状态文案必须依据 expired 而不是 monitorDdl 是否存在
  assert.match(source, /const main = stopped \? \(expired \? "已到期" : "已停止"\)/);
  assert.match(source, /await refreshChanges\(\);/);
});
