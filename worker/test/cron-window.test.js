// ---------------- 监控窗口测试 ----------------
// cron 表达式保持全天分钟步进型(wrangler.toml "*/3 * * * *"), 北京时间 07:00~22:59 之外的
// 批次在 runScheduledChecks 入口整体跳过(不抓上游、锁座链不执行; 手动「立即检查」不受限)。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { createDB } from "./helpers.js";
import worker from "../src/index.js";
import {
  CRON_EXPRESSION,
  describeCrons,
  resolveCronExprs
} from "../src/maoyan/cron.js";
import { readBusinessPolicy } from "../src/maoyan/business-policy-store.js";
import { businessTime, formatMonitorWindowLabel } from "../src/maoyan/business-time.js";
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

test("正式与示例 Wrangler 均只配置一个三分钟业务 cron", async () => {
  for (const filename of ["wrangler.toml", "wrangler.example.toml"]) {
    const config = parseToml(await readFile(new URL(`../${filename}`, import.meta.url), "utf8"));
    assert.deepEqual(config.triggers.crons, ["*/3 * * * *"]);
  }
});

test("默认监控窗口边界: 北京 07:00 开窗, 23:00 关窗", async () => {
  const policy = await readBusinessPolicy(await createDB());
  // 北京 06:59 = UTC 前一天 22:59 → 窗口外
  assert.equal(businessTime(Date.parse("2026-09-13T22:59:00.000Z"), policy).monitorOpen, false);
  // 北京 07:00 = UTC 23:00 → 窗口内
  assert.equal(businessTime(Date.parse("2026-09-13T23:00:00.000Z"), policy).monitorOpen, true);
  // 北京 22:59 = UTC 14:59 → 窗口内
  assert.equal(businessTime(Date.parse("2026-09-14T14:59:00.000Z"), policy).monitorOpen, true);
  // 北京 23:00 = UTC 15:00 → 窗口外
  assert.equal(businessTime(Date.parse("2026-09-14T15:00:00.000Z"), policy).monitorOpen, false);
  // 北京 00:30 = UTC 前一天 16:30 → 窗口外(跨日)
  assert.equal(businessTime(Date.parse("2026-09-13T16:30:00.000Z"), policy).monitorOpen, false);
});

test("cronText 组装: 分钟步进描述 + 策略监控时段标签", async () => {
  assert.equal(
    describeCrons(["*/3 * * * *"]) + " · " + formatMonitorWindowLabel(await readBusinessPolicy(await createDB())),
    "每 3 分钟一批 · 监控时段 07:00~22:59"
  );
});

test("Cloudflare cron 报告不按旧每日维护表达式过滤", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, result: [
    { cron: "*/3 * * * *" }, { cron: "0 18 * * *" }
  ] });
  try {
    assert.deepEqual(await resolveCronExprs({ CF_API_TOKEN: "test", CF_ACCOUNT_ID: "test" }), ["*/3 * * * *", "0 18 * * *"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("运行时调度返回的表达式不会被静默丢弃", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, result: [{ cron: "0 18 * * *" }] });
  try {
    const freshCron = await import(`../src/maoyan/cron.js?daily-only=${Date.now()}`);
    assert.deepEqual(await freshCron.resolveCronExprs({ CF_API_TOKEN: "test", CF_ACCOUNT_ID: "test" }), ["0 18 * * *"]);
  } finally {
    globalThis.fetch = original;
  }
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

test("电影批次只派发电影监控，不扫描到期提醒", async () => {
  const nowMs = Date.parse("2026-09-14T02:00:00.000Z");
  const env = await runtime();
  env.NOW_MS = String(nowMs);
  await env.DB.prepare("UPDATE users SET expires_at=? WHERE id=?").bind(nowMs + 86400000, tokenId).run();
  let dispatched = 0;
  env.MONITOR_DISPATCHER = {
    idFromName: (id) => id,
    get: () => ({ fetch: async () => { dispatched++; return Response.json({ ok: true }); } })
  };
  env.MONITOR_COORDINATOR = {};
  await worker.scheduled({ cron: "*/3 * * * *", scheduledTime: nowMs }, env);
  assert.equal(dispatched, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 0);
  assert.equal(env.DB.queries.some(({ sql }) => sql.includes("FROM users u LEFT JOIN user_config")), false);
});

test("单 cron 在维护窗口发到期提醒且不派发电影批次", async () => {
  const nowMs = Date.parse("2026-09-14T17:00:00.000Z"); // 北京 01:00
  const env = await runtime();
  env.NOW_MS = String(nowMs);
  await env.DB.prepare("UPDATE users SET expires_at=? WHERE id=?").bind(nowMs + 86400000, tokenId).run();
  env.MONITOR_DISPATCHER = { idFromName: () => { throw new Error("不应派发电影"); } };
  env.MONITOR_COORDINATOR = {};
  await worker.scheduled({ cron: "*/3 * * * *", scheduledTime: nowMs }, env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 1);
});

test("无监控协调器的旧部署在维护窗口也不抓电影", async () => {
  const nowMs = Date.parse("2026-09-14T17:00:00.000Z");
  const env = await runtime();
  env.NOW_MS = String(nowMs);
  await env.DB.prepare("UPDATE users SET expires_at=? WHERE id=?").bind(nowMs + 86400000, tokenId).run();
  await withMockFetch(async () => { throw new Error("维护时不应抓电影"); }, () =>
    worker.scheduled({ cron: "*/3 * * * *", scheduledTime: nowMs }, env));
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='account-expiry'").first()).n, 1);
  assert.equal(env.DB.queries.some(({ sql }) => sql.startsWith("SELECT id FROM users WHERE role='user'")), false);
});

test("旧监控路径不归档已过期超过三十天的账户", async () => {
  const nowMs = Date.parse("2026-09-14T02:00:00.000Z");
  const env = await runtime();
  env.NOW_MS = String(nowMs);
  await env.DB.prepare("UPDATE users SET expires_at=? WHERE id=?").bind(nowMs - 31 * 86400000, tokenId).run();
  await withMockFetch(async () => { throw new Error("不应抓取电影"); }, () =>
    worker.scheduled({ cron: "*/3 * * * *", scheduledTime: nowMs }, env));
  const account = await env.DB.prepare("SELECT state,archived_at FROM users WHERE id=?").bind(tokenId).first();
  assert.equal(account.state, "active");
  assert.equal(account.archived_at, null);
  assert.equal(env.DB.queries.some(({ sql }) => sql.includes("FROM users u LEFT JOIN user_config")), false);
});
