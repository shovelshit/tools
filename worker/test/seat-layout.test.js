import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSeatLayout, normalizeRowLabel, resolveSeatPosition, seatDisplayLabel
} from "../src/maoyan/seat-layout.js";

test("seat layout strategies identify Wanda, HuanYing, numeric and alphabetic formats", () => {
  const wanda = [
    { seatNo: "1-1-11", rowId: "11", columnId: "1" },
    { seatNo: "1-2-11", rowId: "11", columnId: "2" }
  ];
  const huanying = [
    { seatNo: "33-1-29", rowId: "1", columnId: "29" },
    { seatNo: "33-1-30", rowId: "1", columnId: "30" }
  ];
  assert.equal(detectSeatLayout(wanda), "wanda");
  assert.equal(detectSeatLayout(huanying), "huanying");
  assert.equal(detectSeatLayout([{ seatNo: "7376", rowId: "9", columnId: "12" }]), "numeric-id");
  assert.equal(detectSeatLayout([{ seatNo: "6166", rowId: "A", columnId: "26" }]), "alpha-row");
});

test("normalized seat positions preserve alphabetic rows and provider seat numbers", () => {
  const alpha = { seatNo: "6166", rowId: "A", columnId: "26" };
  assert.equal(normalizeRowLabel("07"), 7);
  assert.equal(normalizeRowLabel("A"), "A");
  assert.deepEqual(resolveSeatPosition(alpha, "alpha-row"), { rowNumber: "A", seatNumber: 26 });
  assert.equal(seatDisplayLabel(alpha, "alpha-row"), "A排26座");
  assert.deepEqual(
    resolveSeatPosition({ ...alpha, rowLabel: "VIP", seatNumber: 8 }, "default"),
    { rowNumber: "VIP", seatNumber: 8 }
  );
});
