// 猫眼各院线的 data-no 编码并不统一。策略层只负责把原始座位映射为
// 统一展示坐标；下单仍必须使用上游原始 seatNo，不能在这里改写。
import { normalizeRowLabel, partsOf, positiveInteger } from "./seat-layout/common.js";
import * as defaultStrategy from "./seat-layout/strategies/default.js";
import * as wandaStrategy from "./seat-layout/strategies/wanda.js";
import * as huanyingStrategy from "./seat-layout/strategies/huanying.js";
import * as numericIdStrategy from "./seat-layout/strategies/numeric-id.js";
import * as alphaRowStrategy from "./seat-layout/strategies/alpha-row.js";

export { normalizeRowLabel } from "./seat-layout/common.js";

// 兼容旧调用方：2 表示「区-座-排」，3 表示「区-排-座」。
export function seatSegmentOf(seats) {
  const parsed = [];
  for (const seat of seats || []) {
    const parts = partsOf(seat?.seatNo);
    if (parts) parsed.push({ rowId: String(seat?.rowId ?? ""), seg2: parts[1], seg3: parts[2] });
  }
  const rowGroups = new Map();
  for (const item of parsed) {
    if (!rowGroups.has(item.rowId)) rowGroups.set(item.rowId, []);
    rowGroups.get(item.rowId).push(item);
  }
  let checkedRows = 0;
  let vary2 = 0;
  let vary3 = 0;
  for (const group of rowGroups.values()) {
    if (group.length < 2) continue;
    checkedRows += 1;
    if (new Set(group.map((item) => item.seg2)).size > 1) vary2 += 1;
    if (new Set(group.map((item) => item.seg3)).size > 1) vary3 += 1;
  }
  if (checkedRows > 0) {
    if (vary2 > 0 && vary3 === 0) return 2;
    if (vary3 > 0 && vary2 === 0) return 3;
  }
  const uniq2 = new Set(parsed.map((item) => item.seg2)).size;
  const uniq3 = new Set(parsed.map((item) => item.seg3)).size;
  return uniq3 > uniq2 && uniq3 > rowGroups.size ? 3 : 2;
}

export function detectSeatLayout(seats) {
  const values = Array.isArray(seats) ? seats : [];
  if (values.some((seat) => /[^0-9]/.test(String(seat?.rowId ?? "")))) return "alpha-row";
  if (values.some((seat) => partsOf(seat?.seatNo))) {
    return seatSegmentOf(values) === 3 ? "huanying" : "wanda";
  }
  if (values.some((seat) => /^\d+$/.test(String(seat?.seatNo || "")))) return "numeric-id";
  return "default";
}

const strategies = Object.freeze(Object.fromEntries([
  defaultStrategy, wandaStrategy, huanyingStrategy, numericIdStrategy, alphaRowStrategy
].map((strategy) => [strategy.id, strategy])));

function strategyName(layoutOrSegment) {
  if (layoutOrSegment === 3) return "huanying";
  // 旧接口接收数字段位；Array#map 会额外传入索引，也应保持旧缺省段 2。
  if (typeof layoutOrSegment === "number") return "wanda";
  return Object.hasOwn(strategies, layoutOrSegment) ? layoutOrSegment : "default";
}

export function resolveSeatPosition(seat, layoutOrSegment = "default") {
  if (!seat || typeof seat !== "object") return null;
  const rowNumber = normalizeRowLabel(seat.rowLabel ?? seat.rowId);
  if (rowNumber == null) return null;
  const name = strategyName(layoutOrSegment);
  let seatNumber = positiveInteger(seat.seatNumber) || strategies[name].seatNumber(seat);

  // 寰映「区-排-座」可由 rowId/columnId 给出强信号，即使调用方尚未加载全图。
  const parts = partsOf(seat.seatNo);
  const column = positiveInteger(seat.columnId);
  const numericRow = positiveInteger(rowNumber);
  if (parts?.every((part) => /^\d+$/.test(part)) && numericRow && column &&
      Number(parts[1]) === numericRow && Number(parts[2]) === column) {
    seatNumber = column;
  }
  if (!seatNumber) seatNumber = column;
  return seatNumber ? { rowNumber, seatNumber } : null;
}

export function seatDisplayLabel(seatOrSeatNo, layoutOrSegment = 2) {
  if (!seatOrSeatNo || typeof seatOrSeatNo !== "object") {
    return seatOrSeatNo == null ? "" : String(seatOrSeatNo);
  }
  const position = resolveSeatPosition(seatOrSeatNo, layoutOrSegment);
  return position
    ? `${position.rowNumber}排${position.seatNumber}座`
    : String(seatOrSeatNo.seatNo || "");
}

export const seatLayoutStrategies = strategies;
