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

export function orderLockCandidates(candidates, _cinema) {
  const groups = new Map();
  for (const candidate of candidates || []) {
    const seqNo = String(candidate?.target?.show?.seqNo || "");
    if (!groups.has(seqNo)) groups.set(seqNo, []);
    groups.get(seqNo).push(candidate);
  }
  const queues = [...groups.entries()]
    .sort(([left], [right]) => compareBytewise(left, right))
    .map(([, items]) => items.toSorted(compareLotteryCandidates));
  const ordered = [];
  for (let index = 0; queues.some((queue) => index < queue.length); index += 1) {
    for (const queue of queues) {
      if (index < queue.length) ordered.push(queue[index]);
    }
  }
  return ordered;
}

export async function runBounded(items, limit, operation) {
  const input = Array.from(items || []);
  const concurrency = Math.max(1, Math.min(input.length || 1, Number.isInteger(limit) ? limit : 1));
  const results = new Array(input.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < input.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(input[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
