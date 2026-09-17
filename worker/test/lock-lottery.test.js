import test from "node:test";
import assert from "node:assert/strict";
import { compareLotteryCandidates, drawLotteryKey, orderLockCandidates, runBounded } from "../src/maoyan/lock-lottery.js";

test("drawLotteryKey defaults to a Web Crypto UUID", () => {
  assert.match(drawLotteryKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("drawLotteryKey uses the injected UUID source exactly once", () => {
  let calls = 0;
  const key = drawLotteryKey(() => {
    calls += 1;
    return "00112233-4455-4677-8899-aabbccddeeff";
  });

  assert.equal(key, "00112233-4455-4677-8899-aabbccddeeff");
  assert.equal(calls, 1);
});

test("lottery candidates sort bytewise with user ID as the deterministic tie break", () => {
  const candidates = [
    { userId: "user-z", lotteryKey: "same" },
    { userId: "user-b", lotteryKey: "a" },
    { userId: "user-a", lotteryKey: "same" },
    { userId: "user-c", lotteryKey: "B" }
  ];

  assert.deepEqual(
    candidates.toSorted(compareLotteryCandidates).map(({ userId }) => userId),
    ["user-c", "user-b", "user-a", "user-z"]
  );
});

test("lock candidates sort within actual shows and interleave show queues", () => {
  const cinema = { showData: { movies: [] } };
  const candidates = [
    { userId: "a-late", lotteryKey: "z", target: { show: { seqNo: "show-a" } } },
    { userId: "b-first", lotteryKey: "a", target: { show: { seqNo: "show-b" } } },
    { userId: "a-first", lotteryKey: "a", target: { show: { seqNo: "show-a" } } },
    { userId: "b-late", lotteryKey: "z", target: { show: { seqNo: "show-b" } } }
  ];

  assert.deepEqual(
    orderLockCandidates(candidates, cinema).map(({ userId }) => userId),
    ["a-first", "b-first", "a-late", "b-late"]
  );
});

test("runBounded respects its limit and settles every item after a rejection", async () => {
  let active = 0;
  let maximumActive = 0;
  const attempted = [];
  const operation = async (item) => {
    attempted.push(item);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (item === "reject") {
      active -= 1;
      throw new Error("rejected");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item;
  };

  const results = await runBounded(["one", "reject", "three", "four"], 2, operation);

  assert.deepEqual(attempted, ["one", "reject", "three", "four"]);
  assert.equal(maximumActive, 2);
  assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
});
