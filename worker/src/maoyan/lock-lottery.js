export function drawLotteryKey(randomUUID = crypto.randomUUID) {
  return String(randomUUID.call(crypto));
}

function compareBytewise(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareLotteryCandidates(left, right) {
  return compareBytewise(left?.lotteryKey, right?.lotteryKey) ||
    compareBytewise(left?.userId, right?.userId);
}
