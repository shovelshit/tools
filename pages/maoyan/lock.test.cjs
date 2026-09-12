const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadLockModule() {
  const source = fs.readFileSync(path.join(__dirname, "lock.js"), "utf8");
  const context = { module: { exports: {} }, exports: {}, Intl, Date, Set };
  vm.runInNewContext(source, context, { filename: "lock.js" });
  return context.module.exports;
}

test("lock utilities expose selectable current-show templates only", () => {
  const { lockUtils } = loadLockModule();
  const templates = lockUtils.templatesFromMovies([
    {
      id: "7", nm: "测试电影", checked: true, shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", lang: "国语", tp: "2D", th: "1号厅", ticketStatus: 0 },
        { seqNo: "101", tm: "21:00", ticketStatus: 1 },
        { seqNo: "invalid", tm: "22:00", ticketStatus: 0 }
      ] }]
    },
    { id: "8", nm: "未选电影", checked: false, shows: [] }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(templates)), [{
    movieId: "7", movieName: "测试电影", showDate: "2026-09-11", tm: "20:00",
    seqNo: "100", lang: "国语", tp: "2D", th: "1号厅", disabled: false
  }, {
    movieId: "7", movieName: "测试电影", showDate: "2026-09-11", tm: "21:00",
    seqNo: "101", lang: "", tp: "", th: "", disabled: true
  }]);
});

test("lock utilities derive China date bounds and submit readiness", () => {
  const { lockUtils } = loadLockModule();
  const bounds = lockUtils.chinaDateBounds(new Date("2026-09-11T16:30:00.000Z"));
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { min: "2026-09-12", max: "2026-10-12" });

  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-12", riskAccepted: true
  }), true);
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(),
    targetDate: "2026-09-12", riskAccepted: true
  }), false);
});

test("lock utilities derive hall row/seat from the Maoyan seat identifier", () => {
  const { lockUtils } = loadLockModule();
  // 票面口径(真实订单锚定): 排号 = rowId, 座号 = seatNo 第二段;
  // data-no 第三段是影厅内部物理排号(跳过"4排"), 与票面错位, 不可用于展示
  assert.equal(lockUtils.seatDisplayLabel({ seatNo: "1-1-10", rowId: "9" }), "9排1座");
  assert.equal(lockUtils.seatDisplayLabel({ seatNo: "1-12-1", rowId: "1" }), "1排12座");
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.seatPosition({ seatNo: "1-05-07", rowId: "07" }))), { rowNumber: 7, seatNumber: 5 });
  // 只有 seatNo 字符串无法换算票面排号, 原样返回(不猜测)
  assert.equal(lockUtils.seatDisplayLabel("1-12-1"), "1-12-1");
  assert.equal(lockUtils.seatDisplayLabel("unexpected"), "unexpected");
  assert.equal(lockUtils.seatDisplayLabel(""), "");
  assert.equal(lockUtils.seatPosition("unexpected"), null);
  assert.equal(lockUtils.seatPosition({ seatNo: "1-2-x", rowId: "3" }), null);
  assert.equal(lockUtils.seatPosition({ seatNo: "1-2-3" }), null);
});

test("lock utilities require a selected cinema before enabling lock configuration", () => {
  const { lockUtils } = loadLockModule();
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: true }), true);
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: false }), false);
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", cinemaSelected: false, lockServiceEnabled: true }), false);
  assert.equal(lockUtils.isLockAvailable({ connected: false, cinemaId: "25428", cinemaSelected: true, lockServiceEnabled: true }), false);
});

test("lock utilities allow same-day and future targets within 30 days", () => {
  const { lockUtils } = loadLockModule();
  const now = new Date("2026-09-11T01:00:00.000Z");
  // 日期边界只与今天相关(今天起 30 天内), 不再受模板场次约束
  const bounds = lockUtils.lockDateBounds(now);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { min: "2026-09-11", max: "2026-10-11", valid: true });
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-11", riskAccepted: true, dateBounds: bounds
  }), true);
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-20", riskAccepted: true, dateBounds: bounds
  }), true);
});

test("lock utilities block duplicate submission for an active rule", () => {
  const { lockUtils } = loadLockModule();
  const base = {
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-13", riskAccepted: true,
    dateBounds: { min: "2026-09-12", max: "2026-10-11", valid: true }
  };
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "waiting_schedule" } }), false);
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "matching" } }), false);
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "unknown" } }), false);
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "failed" } }), true);
});

test("lock utilities distinguish immediate locking from a future rule", () => {
  const { lockUtils } = loadLockModule();
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.lockAction("target"))), {
    buttonText: "立即锁座",
    loadingText: "锁座中...",
    successText: "已创建待支付订单"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(lockUtils.lockAction("template"))), {
    buttonText: "保存自动锁座规则",
    loadingText: "保存中...",
    successText: "自动锁座规则已启用"
  });
});

test("movie selection rebuilds shows and reloads the selected seat map", async () => {
  const { lockUtils } = loadLockModule();
  const calls = [];
  const state = { movieId: "7", templateSeqNo: "100" };
  await lockUtils.changeMovieSelection({
    state,
    movieId: "8",
    renderShowOptions: () => calls.push("shows"),
    loadSeats: async () => calls.push("seats")
  });
  assert.deepEqual(state, { movieId: "8", templateSeqNo: "" });
  assert.deepEqual(calls, ["shows", "seats"]);
});

test("target-show selection never defaults to a stopped show", () => {
  const { lockUtils } = loadLockModule();
  const shows = [
    { seqNo: "100", disabled: true },
    { seqNo: "101", disabled: false },
    { seqNo: "102", disabled: false }
  ];
  assert.equal(lockUtils.preferredTargetShow(shows, "102").seqNo, "102");
  assert.equal(lockUtils.preferredTargetShow(shows, "100").seqNo, "101");
  assert.equal(lockUtils.preferredTargetShow([{ seqNo: "100", disabled: true }], ""), null);
});

test("seat resets preserve source warnings unless explicitly cleared", () => {
  const { lockUtils } = loadLockModule();
  const state = {
    seatMap: { seats: [] },
    selectedSeatNos: new Set(["1-6-18"]),
    seatMapSource: "未来推断座位",
    seatMapIsTemplate: true
  };
  lockUtils.clearSeatSelection(state);
  assert.equal(state.seatMap, null);
  assert.equal(state.selectedSeatNos.size, 0);
  assert.equal(state.seatMapSource, "未来推断座位");
  assert.equal(state.seatMapIsTemplate, true);

  lockUtils.clearSeatSelection(state, { clearSource: true });
  assert.equal(state.seatMapSource, "");
  assert.equal(state.seatMapIsTemplate, false);
});
