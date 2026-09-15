// ---------------- 监控窗口测试 ----------------
// cron 表达式保持全天分钟步进型(wrangler.toml "*/3 * * * *"), 北京时间 07:00~22:59 之外的
// 批次在 runScheduledChecks 入口整体跳过(不抓上游、锁座链不执行; 手动「立即检查」不受限)。
import test from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import {
  CRON_EXPRESSION,
  MONITOR_WINDOW,
  MONITOR_WINDOW_LABEL,
  inMonitorWindow,
  describeCrons
} from "../src/maoyan/cron.js";
import { runScheduledChecks } from "../src/maoyan/tokens.js";
import * as db from "../src/maoyan/db.js";

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("CRON_EXPRESSION 与 wrangler.toml 保持同步(分钟步进型, 供 API 查询失败回落)", () => {
  assert.equal(CRON_EXPRESSION, "*/3 * * * *");
});

test("inMonitorWindow 边界: 北京 07:00 开窗, 23:00 关窗(UTC+8 无夏令时)", () => {
  assert.equal(MONITOR_WINDOW.startHour, 7);
  assert.equal(MONITOR_WINDOW.endHour, 23);
  // 北京 06:59 = UTC 前一天 22:59 → 窗口外
  assert.equal(inMonitorWindow(Date.parse("2026-09-13T22:59:00.000Z")), false);
  // 北京 07:00 = UTC 23:00 → 窗口内
  assert.equal(inMonitorWindow(Date.parse("2026-09-13T23:00:00.000Z")), true);
  // 北京 22:59 = UTC 14:59 → 窗口内
  assert.equal(inMonitorWindow(Date.parse("2026-09-14T14:59:00.000Z")), true);
  // 北京 23:00 = UTC 15:00 → 窗口外
  assert.equal(inMonitorWindow(Date.parse("2026-09-14T15:00:00.000Z")), false);
  // 北京 00:30 = UTC 前一天 16:30 → 窗口外(跨日)
  assert.equal(inMonitorWindow(Date.parse("2026-09-13T16:30:00.000Z")), false);
});

test("cronText 组装: 分钟步进描述 + 监控时段标签", () => {
  assert.equal(
    describeCrons(["*/3 * * * *"]) + " · " + MONITOR_WINDOW_LABEL,
    "每 3 分钟一批 · 监控时段 07:00~22:59"
  );
});

const tokenId = "22222222-2222-4222-8222-222222222222";

async function runtime() {
  return {
    DB: await createDB({
      tokens: [{ id: tokenId, token: "access-token" }],
      configs: { [tokenId]: {
        enabled: true,
        cinemaId: "25428",
        selectedMovieIds: ["7"],
        monitorDdl: "2099-01-01T00:00:00.000Z"
      } }
    })
  };
}

const cinema = { showData: {
  cinemaName: "测试影院",
  movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-14", plist: [
    { seqNo: "300", tm: "20:00", ticketStatus: 0 }
  ] }] }]
} };

test("窗口外批次整体跳过: 不抓上游, 锁座链(afterMonitor)不执行", async () => {
  const env = await runtime();
  const OUT_NOW = Date.parse("2026-09-13T16:30:00.000Z"); // 北京 00:30
  let handoffs = 0;
  await withMockFetch(async () => {
    throw new Error("窗口外不应抓取上游");
  }, async () => {
    await runScheduledChecks(env, async () => { handoffs++; }, { now: OUT_NOW });
  });
  assert.equal(handoffs, 0);
  // 不留任何检查痕迹
  assert.equal(await db.getStatus(env.DB, tokenId), null);
});

test("窗口内批次正常执行: 监控数据持久化并交接锁座", async () => {
  const env = await runtime();
  const IN_NOW = Date.parse("2026-09-14T02:00:00.000Z"); // 北京 10:00
  let handoffs = 0;
  await withMockFetch(async (input) => {
    if (String(input).includes("/ajax/cinemaDetail")) {
      return new Response(JSON.stringify(cinema), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }, async () => {
    await runScheduledChecks(env, async (id, monitoredCinema) => {
      handoffs++;
      assert.equal(id, tokenId);
      assert.deepEqual(monitoredCinema, cinema);
    }, { now: IN_NOW });
  });
  assert.equal(handoffs, 1);
  assert.ok(Object.keys(await db.getSnapshot(env.DB, tokenId)).length > 0);
});
