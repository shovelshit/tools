import test from "node:test";
import assert from "node:assert/strict";
import { compareLotteryCandidates, drawLotteryKey } from "../src/maoyan/lock-lottery.js";

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
