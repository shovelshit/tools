import { seatDisplayLabel, seatSegmentOf } from "./lock-client.js";

const SHOW_PREVIEW_LIMIT = 20;

function text(value) {
  return String(value || "").trim();
}

function titled(prefix, name) {
  const value = text(name);
  return value ? `${prefix}｜${value}` : prefix;
}

function showLine(show) {
  const when = [text(show?.showDate || show?.dt), text(show?.tm)].filter(Boolean).join(" ");
  const format = [text(show?.lang), text(show?.tp)].filter(Boolean).join(" ");
  return [when, text(show?.th), format].filter(Boolean).join(" · ");
}

export function newShowsNotification({ cinemaName, movieName, shows } = {}) {
  const items = Array.isArray(shows) ? shows : [];
  const lines = [];
  if (text(cinemaName)) lines.push(`🏢 ${text(cinemaName)}`);
  if (text(movieName)) lines.push(`🎞 ${text(movieName)}`);
  if (lines.length) lines.push("");
  lines.push("🗓 新增场次");
  for (const show of items.slice(0, SHOW_PREVIEW_LIMIT)) {
    const detail = showLine(show);
    if (detail) lines.push(`• ${detail}`);
  }
  if (items.length > SHOW_PREVIEW_LIMIT) {
    lines.push(`… 另有 ${items.length - SHOW_PREVIEW_LIMIT} 场，请进入监控页查看`);
  }
  lines.push("", "🔎 进入监控页查看并选择场次");
  return {
    title: titled(`🎬 新增 ${items.length} 场`, movieName),
    content: lines.join("\n")
  };
}

function lockTitle(rule) {
  const prefixes = {
    locked: "✅ 锁座成功",
    failed: "❌ 锁座失败",
    unknown: "❌ 锁座失败",
    expired: "⌛ 锁座任务已过期"
  };
  return titled(prefixes[rule?.state] || "🎟️ 锁座任务更新", rule?.movieName);
}

function selectedSeatLabels(rule) {
  const seats = Array.isArray(rule?.seats) ? rule.seats : [];
  const fallbackSegment = seatSegmentOf(seats);
  return seats
    .map((seat) => text(seat?.label) || seatDisplayLabel(seat, fallbackSegment))
    .filter(Boolean)
    .join("、");
}

function lockActionLines(rule) {
  if (rule?.state === "locked") {
    const lines = ["", "💳 已创建待支付订单，请尽快前往猫眼付款"];
    if (rule.payLeftSecond !== null && rule.payLeftSecond !== undefined && Number.isFinite(Number(rule.payLeftSecond))) {
      lines.push(`⏳ 猫眼返回剩余支付时间：${Number(rule.payLeftSecond)} 秒`);
    }
    return lines;
  }
  const reason = rule?.state === "unknown" ? "锁座失败，未获得有效订单" :
    text(rule?.lastError) || (rule?.state === "expired" ? "目标场次已过期" : "锁座未完成");
  return [
    `📌 原因：${reason}`,
    "",
    rule?.state === "expired" ? "👉 请重新设置目标日期和场次" : "👉 请查看当前座位，重新选择"
  ];
}

export function lockNotification(rule = {}) {
  const lines = [];
  if (text(rule.cinemaName)) lines.push(`🏢 ${text(rule.cinemaName)}`);
  if (text(rule.hall)) lines.push(`🎞 ${text(rule.hall)}`);
  const when = [text(rule.targetDate), text(rule.targetTime || rule.templateTime)].filter(Boolean).join(" ");
  if (when) lines.push(`📅 ${when}`);
  const seats = selectedSeatLabels(rule);
  if (seats) lines.push(`💺 ${seats}`);

  const delta = Number(rule.timeDeltaMinutes);
  if (rule.matchMode === "fuzzy" && text(rule.templateTime) && text(rule.targetTime) && Number.isFinite(delta)) {
    lines.push(`🔄 场次匹配：${text(rule.templateTime)} → ${text(rule.targetTime)}（${delta >= 0 ? "+" : ""}${delta}分钟）`);
  }

  lines.push(...lockActionLines(rule));
  return { title: lockTitle(rule), content: lines.join("\n") };
}

export function testNotification() {
  return {
    title: "🔔 猫眼监控｜通知测试",
    content: "✅ 这是一条测试消息\n📡 收到此消息，说明当前通知通道可用"
  };
}
