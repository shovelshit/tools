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

test("cinema selection no longer depends on the removed manual input", () => {
  const source = readSource("app.js");
  const html = readSource("index.html");
  assert.equal(html.includes("manual-cinema"), false);
  assert.equal(html.includes("cinema-input"), false);
  assert.equal(source.includes("cinemaInput"), false);
  // 影院 ID 的三个写入点: 搜索选中 / 加载成功 / 云端恢复
  assert.match(source, /selectedCinemaId = id;/);
  assert.match(source, /selectedCinemaId = String\(res\.cinemaId\)/);
  assert.match(source, /if \(config\.cinemaId\) selectedCinemaId = String\(config\.cinemaId\);/);
});

test("push key is masked after save and read from memory, not the masked input", () => {
  const source = readSource("app.js");
  assert.match(source, /function maskKey/);
  assert.match(source, /const realKeys = \{ bark: "", serverchan: "" \};/);
  assert.match(source, /input\.value = real \? maskKey\(real\) : "";/);
  // 保存体与测试推送都从内存取真实密钥, 不能把掩码当密钥提交
  assert.equal(source.includes("currentKeyInput().value.trim()"), false);
  assert.match(source, /const key = currentRealKey\(\);/);
});

test("lock dialog gates everything behind maoyan session upload", () => {
  const source = readSource("lock.js");
  const html = readSource("index.html");
  assert.match(source, /function renderGate/);
  assert.match(source, /els\.sectionSchedule, els\.sectionSeats, els\.sectionRisk, els\.sectionRules/);
  assert.match(source, /await loadSeats\(\); \/\/ 门控解除后立即加载座位表/);
  assert.match(html, /id="lock-section-session"/);
  assert.match(html, /id="lock-gate-hint"/);
  assert.match(html, /保存并测试/);
});
