// 锁座边界补充测试: 覆盖既有用例未触及的分支
// - 情侣座成对约束(含真实场次/推断场次两种模式)
// - 输入白名单与非法日历日期
// - 会话规范化(cookie 域名/名称/长度过滤、截断、下单参数白名单)
// - 座位页解析的退化输入
// - 定时锁座: 缺少监控数据 / 影厅布局变化
// - 锁座 API: 未知路径、非数字参数、超长会话体、无会话删除
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import { createLockRule, validateLockRuleInput } from "../src/maoyan/lock-rule.js";
import { handleLockApi } from "../src/maoyan/lock-api.js";
import { runOneLockRule } from "../src/maoyan/lock-runner.js";
import { parseSeatPage } from "../src/maoyan/lock-client.js";
import { normalizeSession } from "../src/maoyan/lock-session.js";
import { userKey } from "../src/maoyan/user.js";

const now = new Date("2026-09-11T04:00:00.000Z");
const tokenId = "11111111-1111-4111-8111-111111111111";

function envWithConfig(config = { cinemaId: "25428", selectedMovieIds: ["7"] }) {
  return {
    LOCK_SERVICE_ENABLED: "true",
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    MAOYAN_KV: new MemoryKV({ [userKey("token-a", "config")]: JSON.stringify(config) })
  };
}

function dependencies(overrides = {}) {
  return {
    now,
    loadSession: async () => validSession(),
    fetchCinema: async () => ({ showData: {
      cinemaName: "测试影院",
      movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", ticketStatus: 0 }
      ] }] }]
    } }),
    fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: [] }),
    ...overrides
  };
}

function validInput(overrides = {}) {
  return {
    cinemaId: "25428",
    movieId: "7",
    templateSeqNo: "100",
    targetDate: "2026-09-12",
    seatNos: ["1-6-18"],
    riskAccepted: true,
    ...overrides
  };
}

function coupleSeats(extra = []) {
  return [
    { seatNo: "1-6-18", rowId: "6", columnId: "18", type: "L", available: true },
    { seatNo: "1-6-19", rowId: "6", columnId: "19", type: "R", available: true },
    ...extra
  ];
}

// ---------------- 情侣座 ----------------

test("情侣座必须成对选择: 只选一半会被拒绝", async () => {
  const env = envWithConfig();
  await assert.rejects(
    createLockRule(env, "token-a", validInput({ seatNos: ["1-6-18"] }), dependencies({
      fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: coupleSeats() })
    })),
    /情侣座需成对选择/
  );
});

test("情侣座成对选择时规则同时记录两个座位", async () => {
  const env = envWithConfig();
  const rule = await createLockRule(env, "token-a", validInput({ seatNos: ["1-6-18", "1-6-19"] }), dependencies({
    fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: coupleSeats() })
  }));
  assert.deepEqual(rule.seats.map((seat) => seat.seatNo), ["1-6-18", "1-6-19"]);
  assert.equal(rule.state, "waiting_schedule");
});

test("情侣座的另一半不相邻时仍视为未成对", async () => {
  const env = envWithConfig();
  await assert.rejects(
    createLockRule(env, "token-a", validInput({ seatNos: ["1-6-18"] }), dependencies({
      fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: [
        { seatNo: "1-6-18", rowId: "6", columnId: "18", type: "L", available: true },
        { seatNo: "1-6-25", rowId: "6", columnId: "25", type: "R", available: true }
      ] })
    })),
    /情侣座需成对选择/
  );
});

test("目标场次真实存在时情侣座成对约束同样生效且校验可售", async () => {
  const cinemaWithTarget = {
    showData: {
      cinemaName: "测试影院",
      movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-12", plist: [
        { seqNo: "100", tm: "20:00", ticketStatus: 0 }
      ] }] }]
    }
  };
  // 成对选择且可售 → 立即下单成功, 状态 locked
  const locked = await createLockRule(envWithConfig(), "token-a",
    validInput({ seatNos: ["1-6-18", "1-6-19"] }), dependencies({
      fetchCinema: async () => cinemaWithTarget,
      fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: coupleSeats() }),
      placeOrder: async () => ({ orderId: "order-9", payLeftSecond: 300 })
    }));
  assert.equal(locked.state, "locked");
  assert.equal(locked.orderId, "order-9");

  // 只选一半 → 拒绝, 不会有订单
  let ordered = 0;
  await assert.rejects(
    createLockRule(envWithConfig(), "token-a", validInput({ seatNos: ["1-6-18"] }), dependencies({
      fetchCinema: async () => cinemaWithTarget,
      fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: coupleSeats() }),
      placeOrder: async () => { ordered++; return { orderId: "x" }; }
    })),
    /情侣座需成对选择/
  );
  assert.equal(ordered, 0);
});

// ---------------- 输入白名单与日期 ----------------

test("锁座输入拒绝未声明的额外字段", () => {
  assert.throws(() => validateLockRuleInput({ ...validInput(), extra: "nope" }), /锁座参数无效/);
});

test("riskAccepted 必须是布尔 true, 字符串 \"true\" 不被接受", () => {
  assert.throws(() => validateLockRuleInput(validInput({ riskAccepted: "true" })), /请确认锁座风险提示/);
});

test("重复座位号在下发前被去重", () => {
  const values = validateLockRuleInput(validInput({ seatNos: ["1-6-18", "1-6-18", "1-6-19"] }));
  assert.deepEqual(values.seatNos, ["1-6-18", "1-6-19"]);
});

test("不存在的日历日期会被拒绝", async () => {
  for (const targetDate of ["2026-02-30", "2026-13-01", "2026-09-31"]) {
    await assert.rejects(
      createLockRule(envWithConfig(), "token-a", validInput({ targetDate }), dependencies()),
      /目标日期需在今天起 30 天内/
    );
  }
});

// ---------------- 会话规范化 ----------------

function sessionWithCookies(cookies, overrides = {}) {
  return validSession({ cookies, ...overrides });
}

test("非猫眼域名的 cookie 会被丢弃, 导致会话不完整", () => {
  assert.throws(
    () => normalizeSession(sessionWithCookies([
      { name: "uid", value: "123456789", domain: "evil.example.com" }
    ])),
    /猫眼会话不完整/
  );
});

test("cookie 名称含非法字符或值超长时被过滤", () => {
  const session = normalizeSession(sessionWithCookies([
    { name: "uid", value: "123456789", domain: ".maoyan.com" },
    { name: "bad name!", value: "x", domain: ".maoyan.com" },
    { name: "oversize", value: "a".repeat(4097), domain: ".maoyan.com" }
  ]));
  assert.deepEqual(session.cookies.map((cookie) => cookie.name), ["uid"]);
});

test("cookie 数量超过 64 个时按上限截断", () => {
  const extras = Array.from({ length: 80 }, (_, index) => ({
    name: `c${index}`, value: "v", domain: ".maoyan.com"
  }));
  const session = normalizeSession(sessionWithCookies([
    { name: "uid", value: "123456789", domain: ".maoyan.com" },
    ...extras
  ]));
  assert.equal(session.cookies.length, 64);
  assert.equal(session.cookies[0].name, "uid");
});

test("下单查询参数只保留白名单键且值须为安全字符", () => {
  const session = normalizeSession(sessionWithCookies(
    [{ name: "uid", value: "123456789", domain: ".maoyan.com" }],
    { create_order_query: { yodaReady: "h5", evil: "x", csecplatform: "has space" } }
  ));
  assert.deepEqual(session.createOrderQuery, { yodaReady: "h5" });
});

// ---------------- 座位页解析退化输入 ----------------

test("缺少 seats-block 时座位图视为格式无效", () => {
  assert.throws(() => parseSeatPage('<div class="other">没有座位块</div>'), /猫眼座位图格式无效/);
});

test("seats-block 内没有完整座位字段时视为格式无效", () => {
  const html = '<div class="seats-block" data-section-id="1" data-section-name="1号厅" data-seq-no="100">' +
    '<span class="seat selectable" data-row-id="6" data-column-id="18"></span>' +
    '<span class="seat walkway"></span></div>';
  assert.throws(() => parseSeatPage(html), /猫眼座位图格式无效/);
});

test("seats-block 缺少厅名时视为格式无效", () => {
  const html = '<div class="seats-block" data-section-id="1" data-seq-no="100">' +
    '<span class="seat selectable" data-no="1-6-18" data-row-id="6" data-column-id="18"></span></div>';
  assert.throws(() => parseSeatPage(html), /猫眼座位图格式无效/);
});

test("座位 parse 结果区分可售与不可售且保留排列表", () => {
  const html = '<div class="seats-block" data-section-id="1" data-section-name="1号厅" data-seq-no="100">' +
    '<span class="seat selectable" data-no="1-6-18" data-row-id="6" data-column-id="18" data-st="N"></span>' +
    '<span class="seat" data-no="1-6-19" data-row-id="6" data-column-id="19" data-st="N"></span>' +
    '</div>';
  const seatMap = parseSeatPage(html);
  assert.equal(seatMap.sectionName, "1号厅");
  assert.deepEqual(seatMap.seats.map((seat) => [seat.seatNo, seat.available]), [
    ["1-6-18", true], ["1-6-19", false]
  ]);
});

// ---------------- 定时锁座边界 ----------------

function runtime(overrides = {}) {
  return { MAOYAN_KV: new MemoryKV(), LOCK_SERVICE_ENABLED: "true", ...overrides };
}

function storedRule(overrides = {}) {
  return {
    id: "rule-a", cinemaId: "25428", cinemaName: "测试影院", movieId: "7", movieName: "测试电影",
    targetDate: "2026-09-12", templateTime: "20:00",
    seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N" }],
    state: "waiting_schedule", ...overrides
  };
}

test("缺少监控数据的定时锁座直接跳过而不是报错", async () => {
  const stored = storedRule();
  const result = await runOneLockRule(runtime(), tokenId, {
    now: () => now,
    getRule: async () => stored,
    putRule: async () => {}
  });
  assert.deepEqual(result, { ok: true, skipped: true, missingMonitorData: true });
  assert.equal(stored.state, "waiting_schedule");
});

test("座位仍可售但排号变化时按影厅布局变化失败且不下单", async () => {
  const stored = storedRule();
  let orderCalls = 0;
  await runOneLockRule(runtime(), tokenId, {
    now: () => now,
    getRule: async () => stored,
    putRule: async (_env, _token, value) => { Object.assign(stored, value); },
    fetchCinema: async () => ({ showData: { movies: [{ id: "7", shows: [{ showDate: "2026-09-12", plist: [{ seqNo: "200", tm: "20:00" }] }] }] } }),
    findShows: () => [{ seqNo: "200", tm: "20:00" }],
    loadSession: async () => ({ session: true }),
    fetchSeats: async () => ({ seqNo: "200", seats: [{ seatNo: "1-6-18", rowId: "7", columnId: "18", available: true }] }),
    createOrder: async () => { orderCalls++; return { orderId: "should-not-happen" }; },
    notify: async () => {}
  });
  assert.equal(stored.state, "failed");
  assert.match(stored.lastError, /影厅布局已变化/);
  assert.equal(orderCalls, 0);
});

// ---------------- 锁座 API 边界 ----------------

function lockApiEnv(overrides = {}) {
  return {
    MAOYAN_KV: new MemoryKV({
      [userKey(tokenId, "config")]: JSON.stringify({ cinemaId: "25428", selectedMovieIds: ["7"] })
    }),
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    LOCK_SERVICE_ENABLED: "true",
    ...overrides
  };
}

function lockRequest(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

async function callLockApi(path, options, env = lockApiEnv()) {
  return await handleLockApi(lockRequest(path, options), env, new URL(`https://worker.example${path}`), tokenId);
}

test("非锁座前缀的路径不由此处理器接管", async () => {
  const response = await callLockApi("/api/shows");
  assert.equal(response, null);
});

test("未知的锁座子路径返回 404", async () => {
  const response = await callLockApi("/api/lock/unknown");
  assert.equal(response.status, 404);
});

test("template-seats 的非数字参数返回 400 且不再请求上游", async () => {
  const response = await callLockApi("/api/lock/template-seats?cinemaId=abc&movieId=7&seqNo=100");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cinemaId 无效");
});

test("template-seats 缺少参数同样按 400 处理", async () => {
  const response = await callLockApi("/api/lock/template-seats?cinemaId=25428&movieId=7");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "seqNo 无效");
});

test("上传会话体超过 256KiB 时被拒绝", async () => {
  const response = await callLockApi("/api/lock/session", {
    method: "POST",
    body: JSON.stringify({ pad: "x".repeat(256 * 1024 + 10) })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "会话文件不能超过 256KiB");
});

test("上传非 JSON 会话体返回格式错误", async () => {
  const response = await callLockApi("/api/lock/session", { method: "POST", body: "not-json" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "猫眼会话格式错误");
});

test("未上传会话时删除锁座资源返回 404", async () => {
  const env = lockApiEnv({
    LOCK_COORDINATOR: {
      idFromName: (id) => id,
      get: () => ({ fetch: async () => Response.json({ ok: false, error: "未找到锁座资源" }, { status: 404 }) })
    }
  });
  const response = await callLockApi("/api/lock/session/remove", { method: "POST" }, env);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "未找到锁座资源");
});
