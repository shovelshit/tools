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
  // 保存体与测试推送都从内存取真实密钥, 不能把掩码当密钥提交
  assert.equal(source.includes("currentKeyInput().value.trim()"), false);
  assert.match(source, /const key = currentRealKey\(\);/);
});

test("stored key shows placeholder mask after refresh (cloud hasBark, no plaintext in memory)", () => {
  const source = readSource("app.js");
  // 刷新后内存无明文但云端已存: 输入框回显固定占位掩码, 不再一片空白
  assert.match(source, /const KEY_STORED_MASK = "••••••••";/);
  assert.match(source, /const keyStored = \{ bark: false, serverchan: false \};/);
  assert.match(source, /keyStored\.bark = config\.hasBark === true;/);
  assert.match(source, /keyStored\.serverchan = config\.hasServerChan === true;/);
  assert.match(source, /else if \(keyStored\[getChannel\(\)\]\) \{\s*\n\s*input\.value = KEY_STORED_MASK;/);
  // 占位掩码不当作密钥提交: 失焦保存与聚焦还原都跳过它
  assert.match(source, /typed !== KEY_STORED_MASK/);
  assert.match(source, /input\.value === KEY_STORED_MASK\) input\.select\(\);/);
  // 按渠道独立记录, 只配置过 Bark 时切到 Server酱 不应显示已存掩码
  assert.doesNotMatch(source, /pushSaved = keyStored\.bark \|\| keyStored\.serverchan;\s*\n\s*keyStored/);
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

test("seat map centers, pans by drag, zooms at cursor; risk box only for inferred seats", () => {
  const source = readSource("lock.js");
  const html = readSource("index.html");
  // 平移/缩放/居中: translate+scale 变换, 内容小于容器时固定居中, 拖动吞 click 防误选
  assert.match(source, /translate\(\$\{state\.panX\}px, \$\{state\.panY\}px\) scale\(\$\{state\.zoom\}\)/);
  assert.match(source, /function clampPan/);
  assert.match(source, /function centerSeatMap/);
  assert.match(source, /centerSeatMap\(\);/);
  assert.match(source, /suppressClick/);
  // 推断标记必须在模板分支被置真(此前从未置真, warn 与推断座位全可选逻辑均不生效)
  assert.match(source, /state\.showMode = "template";\n          state\.seatMapIsTemplate = true;/);
  // 风险区: 仅推断座位展示, 门控期隐藏; 勾选仅在推断模式下必填
  assert.match(source, /setHidden\(els\.sectionRisk, !state\.session\?\.uploaded \|\| state\.seatMapIsTemplate !== true\)/);
  assert.match(source, /if \(state\.seatMapIsTemplate && !els\.risk\?\.checked\) return "请先勾选风险提示";/);
  // 风险框红色
  assert.match(readSource("style.css"), /\.lock-risk \{ padding: 10px 12px; border: 1px solid #f2b8b5; border-radius: 6px; background: #fdeceb; color: #b3261e;/);
  // 画布式容器: 滚轮缩放/拖动平移
  assert.match(html, /滚轮缩放 · 按住拖动 · 双指捏合/);
  assert.match(readSource("style.css"), /\.lock-seat-scroll \{ overflow: hidden;.*cursor: grab;/);
});

test("seat map auto-detects swapped seatNo segment order (Dolby vs laser IMAX halls)", () => {
  const source = readSource("lock.js");
  // 真实缺陷: 寰映IMAX厅 data-no=区-排-座, 固定把第二段当座号 → 同排座位挤进同一列(竖条)。
  // 座号段判别 + 加载座位表后写入 state, 布局/表头/文案统一走判别后的段位。
  assert.match(source, /function seatSegmentOf\(seats\)/);
  assert.match(source, /return seg3 > seg2 && seg3 > rows \? 3 : 2;/);
  assert.match(source, /seatPosition\(seat, state\.seatSeg\)/);
  assert.match(source, /state\.seatSeg = seatSegmentOf\(seatMap\?\.seats\)/);
  assert.match(source, /seatDisplayLabel\(seat, state\.seatSeg\)/);
});

test("empty today/past target date lists other-date real sessions and locks them as real shows", () => {
  const source = readSource("lock.js");
  // 今天/已过日期无场次: 不再走推断逻辑, 选中即按 jumpDate 切换目标日期进入真实场次模式
  assert.match(source, /else if \(!isFuture\) \{\n          \/\/ 今天\/已过日期无场次/);
  assert.match(source, /els\.templateLabel\.textContent = "其他日期场次（真实可锁）"/);
  assert.match(source, /option\.dataset\.jumpDate = item\.showDate;/);
  assert.match(source, /const jumpDate = els\.template\.selectedOptions\?\.\[0\]\?\.dataset\?\.jumpDate;/);
  assert.match(source, /els\.date\.value = jumpDate;/);
  // 该分支不产生推断座位, 风险框保持隐藏
  assert.match(source, /state\.showMode = "target";\n          state\.seatMapIsTemplate = false;/);
  // 未来日期无场次的推断路径保持不变
  assert.match(source, /以下为模板场次的未来推断座位/);
});

test("lock entry follows the monitor switch and explains a paused lock rule", () => {
  const source = readSource("app.js");
  // getContext 携带监控状态; 监控开关切换后即时刷新锁座入口可用性
  assert.match(source, /monitorEnabled, \/\/ 锁座随监控启停/);
  assert.match(source, /lockController\.syncAvailability\(\);\s*[\s\S]{0,400}?\/\/ 停止监控时若挂着进行中的自动锁座规则/);
  assert.match(source, /已随监控暂停，重新开始监控后自动继续/);
});
