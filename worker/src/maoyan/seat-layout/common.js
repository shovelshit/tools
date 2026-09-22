export function partsOf(seatNo) {
  const parts = String(seatNo || "").split(/[^0-9A-Za-z]+/);
  return parts.length === 3 && parts.every((part) => part) ? parts : null;
}

export function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeRowLabel(value) {
  const label = String(value ?? "").trim();
  if (!label) return null;
  return /^\d+$/.test(label) ? positiveInteger(label) : label;
}
