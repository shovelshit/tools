import test from "node:test";
import assert from "node:assert/strict";
import {
  lockNotification,
  newShowsNotification,
  testNotification
} from "../src/maoyan/notification-copy.js";

test("new-show notification keeps each real show visible and limits the preview", () => {
  const shows = Array.from({ length: 22 }, (_, index) => ({
    showDate: "2026-09-19",
    tm: `${String(18 + Math.floor(index / 6)).padStart(2, "0")}:${String((index % 6) * 10).padStart(2, "0")}`,
    th: index % 2 ? "2号杜比厅" : "1号激光IMAX厅",
    lang: "英语",
    tp: index % 2 ? "杜比全景声" : "IMAX2D"
  }));

  const message = newShowsNotification({
    cinemaName: "寰映影城（大融城激光IMAX店）",
    movieName: "奥德赛",
    shows
  });

  assert.equal(message.title, "🎬 新增 22 场｜奥德赛");
  assert.match(message.content, /^🏢 寰映影城（大融城激光IMAX店）\n🎞 奥德赛\n\n🗓 新增场次\n/);
  assert.match(message.content, /• 2026-09-19 18:00 · 1号激光IMAX厅 · 英语 IMAX2D/);
  assert.match(message.content, /• 2026-09-19 18:10 · 2号杜比厅 · 英语 杜比全景声/);
  assert.match(message.content, /… 另有 2 场，请进入监控页查看/);
  assert.match(message.content, /🔎 进入监控页查看并选择场次$/);
});

test("locked notification shows seats, fuzzy match and returned payment time", () => {
  const message = lockNotification({
    state: "locked",
    cinemaName: "测试影院",
    movieName: "奥德赛",
    hall: "1号激光IMAX厅",
    targetDate: "2026-09-19",
    templateTime: "18:40",
    targetTime: "18:50",
    matchMode: "fuzzy",
    timeDeltaMinutes: 10,
    seats: [{ label: "9排15座" }, { label: "9排16座" }],
    payLeftSecond: 600
  });

  assert.equal(message.title, "✅ 锁座成功｜奥德赛");
  assert.equal(message.content, [
    "🏢 测试影院",
    "🎞 1号激光IMAX厅",
    "📅 2026-09-19 18:50",
    "💺 9排15座、9排16座",
    "🔄 场次匹配：18:40 → 18:50（+10分钟）",
    "",
    "💳 已创建待支付订单，请尽快前往猫眼付款",
    "⏳ 猫眼返回剩余支付时间：600 秒"
  ].join("\n"));
});

test("failed notification gives a retry action without payment wording", () => {
  const message = lockNotification({
    state: "failed",
    cinemaName: "测试影院",
    movieName: "奥德赛",
    targetDate: "2026-09-19",
    targetTime: "18:50",
    seats: [{ label: "9排15座" }],
    lastError: "所选座位已不可购买"
  });

  assert.equal(message.title, "❌ 锁座失败｜奥德赛");
  assert.match(message.content, /📌 原因：所选座位已不可购买/);
  assert.match(message.content, /👉 请查看当前座位，重新选择$/);
  assert.doesNotMatch(message.content, /支付/);
});

test("unknown notification asks for manual order confirmation and never says failed", () => {
  const message = lockNotification({
    state: "unknown",
    cinemaName: "测试影院",
    movieName: "奥德赛",
    targetDate: "2026-09-19",
    targetTime: "18:50",
    seats: [{ label: "9排15座" }],
    lastError: "创建订单结果不确定，请到猫眼订单中确认"
  });

  assert.equal(message.title, "⚠️ 订单结果待确认｜奥德赛");
  assert.match(message.content, /📡 请求已发出，但未收到明确结果/);
  assert.match(message.content, /🛑 请先查看猫眼订单，避免重复下单$/);
  assert.doesNotMatch(message.title + message.content, /锁座失败/);
});

test("expired and sparse lock notifications omit unavailable detail lines", () => {
  const message = lockNotification({
    state: "expired",
    movieName: "奥德赛",
    targetDate: "2026-09-18",
    lastError: "目标场次已过期",
    seats: []
  });

  assert.equal(message.title, "⌛ 锁座任务已过期｜奥德赛");
  assert.equal(message.content, [
    "📅 2026-09-18",
    "📌 原因：目标场次已过期",
    "",
    "👉 请重新设置目标日期和场次"
  ].join("\n"));
  assert.doesNotMatch(message.content, /undefined|null|🏢|💺/);
});

test("test notification explains what receiving it means", () => {
  assert.deepEqual(testNotification(), {
    title: "🔔 猫眼监控｜通知测试",
    content: "✅ 这是一条测试消息\n📡 收到此消息，说明当前通知通道可用"
  });
});
