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
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { min: "2026-09-13", max: "2026-10-12" });

  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-13", riskAccepted: true
  }), true);
  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(),
    targetDate: "2026-09-13", riskAccepted: true
  }), false);
});

test("lock utilities shorten displayed seat numbers without altering the full identifier", () => {
  const { lockUtils } = loadLockModule();
  assert.equal(lockUtils.seatLabel("1-6-18"), "18");
  assert.equal(lockUtils.seatLabel("unexpected"), "unexpected");
});

test("lock utilities require an active connection before enabling lock configuration", () => {
  const { lockUtils } = loadLockModule();
  assert.equal(lockUtils.isLockAvailable({ connected: true, cinemaId: "25428", movies: [{ checked: true }] }), true);
  assert.equal(lockUtils.isLockAvailable({ connected: false, cinemaId: "25428", movies: [{ checked: true }] }), false);
});

test("lock utilities constrain targets to the day after a future template", () => {
  const { lockUtils } = loadLockModule();
  const now = new Date("2026-09-11T01:00:00.000Z");
  const bounds = lockUtils.lockDateBounds("2026-09-20", now);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { min: "2026-09-21", max: "2026-10-11", valid: true });

  assert.equal(lockUtils.isReadyToSubmit({
    session: { uploaded: true }, templateSeqNo: "100", selectedSeatNos: new Set(["1-6-18"]),
    targetDate: "2026-09-20", riskAccepted: true, dateBounds: bounds
  }), false);
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
  assert.equal(lockUtils.isReadyToSubmit({ ...base, rule: { state: "failed" } }), true);
});
