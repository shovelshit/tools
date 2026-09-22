(function (root) {
  function partsOf(seatNo) {
    const parts = String(seatNo || "").split(/[^0-9A-Za-z]+/);
    return parts.length === 3 && parts.every((part) => part) ? parts : null;
  }
  function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }
  function normalizeRowLabel(value) {
    const label = String(value ?? "").trim();
    if (!label) return null;
    return /^\d+$/.test(label) ? positiveInteger(label) : label;
  }
  function seatSegmentOf(seats) {
    const parsed = [];
    for (const seat of seats || []) {
      const parts = partsOf(seat?.seatNo);
      if (parts) parsed.push({ rowId: String(seat?.rowId ?? ""), seg2: parts[1], seg3: parts[2] });
    }
    const rows = new Map();
    for (const item of parsed) {
      if (!rows.has(item.rowId)) rows.set(item.rowId, []);
      rows.get(item.rowId).push(item);
    }
    let checked = 0, vary2 = 0, vary3 = 0;
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      checked += 1;
      if (new Set(row.map((item) => item.seg2)).size > 1) vary2 += 1;
      if (new Set(row.map((item) => item.seg3)).size > 1) vary3 += 1;
    }
    if (checked) {
      if (vary2 > 0 && vary3 === 0) return 2;
      if (vary3 > 0 && vary2 === 0) return 3;
    }
    const uniq2 = new Set(parsed.map((item) => item.seg2)).size;
    const uniq3 = new Set(parsed.map((item) => item.seg3)).size;
    return uniq3 > uniq2 && uniq3 > rows.size ? 3 : 2;
  }
  function seatPosition(seat, layoutOrSegment = "default") {
    if (!seat || typeof seat !== "object") return null;
    const rowNumber = normalizeRowLabel(seat.rowLabel ?? seat.rowId);
    if (rowNumber == null) return null;
    let seatNumber = positiveInteger(seat.seatNumber);
    const parts = partsOf(seat.seatNo);
    if (!seatNumber && parts?.every((part) => /^\d+$/.test(part))) {
      seatNumber = positiveInteger(parts[layoutOrSegment === 3 || layoutOrSegment === "huanying" ? 2 : 1]);
      const row = positiveInteger(rowNumber);
      const column = positiveInteger(seat.columnId);
      if (row && column && Number(parts[1]) === row && Number(parts[2]) === column) seatNumber = column;
    }
    if (!seatNumber) seatNumber = positiveInteger(seat.columnId);
    return seatNumber ? { rowNumber, seatNumber } : null;
  }
  function seatDisplayLabel(seat, layoutOrSegment) {
    const position = seatPosition(seat, layoutOrSegment);
    return position ? `${position.rowNumber}排${position.seatNumber}座` : String(seat?.seatNo || seat || "");
  }
  const api = { normalizeRowLabel, seatSegmentOf, seatPosition, seatDisplayLabel };
  root.MaoyanSeatLayout = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
