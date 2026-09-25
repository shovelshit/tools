import { fetchCinemaDetail } from "./api.js";
import {
  fetchSeatMap, findExactShows, createUnpaidOrder, OrderAttemptError,
  ORDER_REJECTED_SESSION, ORDER_REJECTED_SEATS, seatDisplayLabel, seatSegmentOf
} from "./lock-client.js";
import { loadLockSession } from "./lock-session.js";
import { withSeatFeedback } from "./seat-feedback.js";
import * as db from "./db.js";
import { getUserConfig } from "./user.js";
import { currentCredential, pushNotify } from "./notify.js";
import { lockError, lockLog } from "./log.js";
import { lockNotification } from "./notification-copy.js";
import { requireActiveAccount } from "./auth.js";
import { drawLotteryKey } from "./lock-lottery.js";
import { persistTerminalNotification, wakeNotificationDispatcher } from "./notification-outbox.js";

// 这些错误会原样透传给前端(而不是笼统的"锁座参数无效")
// 注意: 与上游(猫眼)相关的文案直接引用 lock-client 导出的常量, 避免文案漂移
export const RULE_KNOWN_ERRORS = [
  "锁座参数无效", "请确认锁座风险提示", "所选座位无效", "所选座位不可用", "情侣座需成对选择",
  "影片未在当前影院监控配置中选择", "模板场次不属于当前影院影片", "目标日期需在今天起 30 天内",
  "猫眼场次数据无效", "猫眼座位图场次无效", "猫眼会话不完整", `${ORDER_REJECTED_SEATS}：座位可能已被抢占`,
  ORDER_REJECTED_SESSION,
  "目标日期存在多个相同时间场次", "所选未来座位不可用或影厅布局已变化", "锁座服务尚未配置加密密钥",
  "请选择目标日期的实际场次", "所选目标场次不可售"
];
export const LOCK_RULE_TERMINAL_STATES = new Set(["locked", "expired", "failed", "completed", "cancelled", "unknown"]);
const PUBLIC_FIELDS = [
  "id", "cinemaId", "cinemaName", "movieId", "movieName", "hall", "targetDate",
  "templateDate", "templateTime", "targetTime", "matchMode", "timeDeltaMinutes", "timeToleranceMinutes", "templateSeqNo", "targetSeqNo", "seats", "state",
  "createdAt", "updatedAt", "lastError", "orderId", "payLeftSecond"
];

function decimal(value) {
  return /^\d+$/.test(String(value || ""));
}

// 座位主键(data-no)是不透明字符串: 「-」三段/「#」三段/纯数字 seatId 并存, 官方原样透传。
// 校验只要求非空可见 ASCII 且长度有限; 真实有效性由座位图按 seatNo 全等匹配保证。
function seatNo(value) {
  return /^[\x21-\x7e]{1,64}$/.test(String(value || ""));
}

function assertExactInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("锁座参数无效");
  const allowed = new Set(["cinemaId", "movieId", "templateSeqNo", "targetDate", "seatNos", "riskAccepted", "timeToleranceMinutes"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("锁座参数无效");
  if (!decimal(input.cinemaId) || !decimal(input.movieId) || !decimal(input.templateSeqNo)) {
    throw new Error("锁座参数无效");
  }
  // riskAccepted 不在此处硬校验: 目标场次(真实座位图, 确认弹窗已明示将创建待支付订单)无推断风险,
  // 前端该模式下不显示风险勾选框; 推断模式(保存等待规则)的强制勾选在 createLockRule 按 targetShow 分支校验
  if (!Array.isArray(input.seatNos) || !input.seatNos.length || input.seatNos.some((value) => !seatNo(value))) {
    throw new Error("所选座位无效");
  }
  const timeToleranceMinutes = Object.hasOwn(input, "timeToleranceMinutes") ? input.timeToleranceMinutes : 30;
  if (!Number.isInteger(timeToleranceMinutes) || timeToleranceMinutes < 0 || timeToleranceMinutes > 180) {
    throw new Error("锁座参数无效");
  }
  return {
    cinemaId: String(input.cinemaId),
    movieId: String(input.movieId),
    templateSeqNo: String(input.templateSeqNo),
    targetDate: String(input.targetDate),
    seatNos: [...new Set(input.seatNos.map(String))],
    riskAccepted: input.riskAccepted === true,
    timeToleranceMinutes
  };
}

export function validateLockRuleInput(input) {
  return assertExactInput(input);
}

export function isLockRuleTerminal(state) {
  return LOCK_RULE_TERMINAL_STATES.has(String(state || ""));
}

function chinaDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayNumber(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return stamp / 86400000;
}

function assertTargetDate(targetDate, now) {
  const targetDay = dayNumber(targetDate);
  const today = dayNumber(chinaDate(now));
  if (targetDay === null || targetDay < today || targetDay - today > 30) {
    throw new Error("目标日期需在今天起 30 天内");
  }
}

function scheduleForTemplate(data, movieId, seqNo) {
  const movie = (data?.showData?.movies || []).find((item) => String(item.id) === movieId);
  if (!movie) throw new Error("模板场次不属于当前影院影片");
  for (const day of movie.shows || []) {
    const date = String(day.showDate || day.dt || "");
    for (const show of day.plist || []) {
      if (String(show.seqNo) === seqNo) {
        if (!dayNumber(date) || !/^\d{2}:\d{2}$/.test(String(show.tm || ""))) throw new Error("猫眼场次数据无效");
        return {
          cinemaName: String(data?.showData?.cinemaName || ""),
          movieName: String(movie.nm || ""),
          // 影厅名(如「2号杜比巨幕厅-1.3米以下儿童需要购票」), 推送与核对座位时必需
          hall: String(show.th || ""),
          date,
          time: String(show.tm),
          seqNo: String(show.seqNo),
          ticketStatus: Number(show.ticketStatus)
        };
      }
    }
  }
  throw new Error("模板场次不属于当前影院影片");
}

function selectedSeats(seatMap, seatNos, { ignoreAvailability = false } = {}) {
  const byNumber = new Map((seatMap?.seats || []).map((seat) => [String(seat.seatNo), seat]));
  const isCouple = (seat) => seat && (seat.type === "L" || seat.type === "R");
  // 情侣座按排内物理位置配对。columnId/票面座号在不同影院既可能递增也可能递减，
  // orderIndex 才是猫眼 DOM 中包含过道后的真实左右顺序。
  const partnerOf = (seat) => {
    if (!isCouple(seat)) return null;
    const orderIndex = Number(seat.orderIndex);
    if (!Number.isInteger(orderIndex) || orderIndex <= 0) return null;
    const expected = seat.type === "L" ? orderIndex + 1 : orderIndex - 1;
    const opposite = seat.type === "L" ? "R" : "L";
    const atPosition = (position) => (seatMap?.seats || []).filter((candidate) =>
      String(candidate.rowId) === String(seat.rowId) && Number(candidate.orderIndex) === position);
    const partners = atPosition(expected);
    return atPosition(orderIndex).length === 1 && partners.length === 1 && partners[0].type === opposite
      ? partners[0] : null;
  };
  const selected = seatNos.map((number) => byNumber.get(number));
  if (selected.some((seat) => !seat || (!seat.available && !ignoreAvailability))) throw new Error("所选座位不可用");
  if (selected.some((seat) => isCouple(seat) && !seatNos.map(String).includes(partnerOf(seat)?.seatNo || ""))) {
    throw new Error("情侣座需成对选择");
  }
  return selected.map((seat) => ({
    seatNo: String(seat.seatNo),
    rowId: String(seat.rowId),
    columnId: String(seat.columnId),
    type: String(seat.type || ""),
    // 展示标签在创建时用全图普查定段并持久化: 规则自身座位(常为单座)的二次普查不充分、
    // 恒回落 seg=2, 会把寰映型「区-排-座」的排号段误当座号(9排15座→9排9座)
    label: seatDisplayLabel(seat, seatSegmentOf(seatMap?.seats))
  }));
}

// 推送正文: 立即锁座(createLockRule)与定时锁座(lock-runner)共用一份, 避免两处副本再次漂移。
// 座位一律渲染成人看的「几排几座」(排号=rowId, 座号段按影厅口径自动判别), 不能直接扔内部标识。
// 影厅名(rule.hall, 来自场次 th 字段)是用户核对座位的关键信息, 缺失时跳过该行。
export function lockNotificationContent(rule) {
  return lockNotification(rule).content;
}

async function notifyLockedRule(config, rule, notify = pushNotify) {
  const notification = lockNotification(rule);
  await notify(config, notification.title, notification.content);
}

export async function getLockRule(env, tokenId) {
  return await db.getLockRuleRow(env.DB, tokenId);
}

export async function putLockRule(env, tokenId, rule) {
  await db.putLockRuleRow(env.DB, tokenId, rule);
}

export async function removeLockRule(env, tokenId) {
  await db.deleteLockRuleRow(env.DB, tokenId);
}

export function publicLockRule(rule, automationEnabled) {
  if (!rule || typeof rule !== "object") return null;
  const result = Object.fromEntries(PUBLIC_FIELDS.filter((field) => Object.hasOwn(rule, field)).map((field) => [field, rule[field]]));
  return { ...result, ...(result.state === "unknown" ? { state: "failed", lastError: "锁座失败，未获得有效订单" } : {}), automationEnabled: Boolean(automationEnabled) };
}

export async function createLockRule(env, tokenId, input, options = {}) {
  const values = validateLockRuleInput(input);
  const existing = await getLockRule(env, tokenId);
  if (existing && !isLockRuleTerminal(existing.state)) throw new Error("已有进行中的锁座规则");

  const config = await getUserConfig(env, tokenId);
  if (String(config.cinemaId || "") !== values.cinemaId || !(config.selectedMovieIds || []).map(String).includes(values.movieId)) {
    throw new Error("影片未在当前影院监控配置中选择");
  }

  const fetchCinema = options.fetchCinema || fetchCinemaDetail;
  const loadSession = options.loadSession || loadLockSession;
  // 默认的取图入口包一层解析失败自动留档(只写标识 KV, 失败静默); 测试/协调器注入的 fetchSeats 不经包装
  const fetchSeats = options.fetchSeats || withSeatFeedback(fetchSeatMap, env, { tokenId, cinemaId: values.cinemaId, movieId: values.movieId });
  const placeOrder = options.placeOrder || createUnpaidOrder;
  const drawLottery = options.drawLottery || drawLotteryKey;
  const now = options.now || new Date();
  const [session, cinema] = await Promise.all([loadSession(env, tokenId), fetchCinema(values.cinemaId)]);
  const template = scheduleForTemplate(cinema, values.movieId, values.templateSeqNo);
  if (!template.cinemaName || !template.movieName) throw new Error("猫眼场次数据无效");
  assertTargetDate(values.targetDate, now);
  // 真实场次只能使用用户明确选择的 seqNo；已有目标场次时禁止把旧模板静默替换过去。
  const targetShows = findExactShows(cinema, { movieId: values.movieId, targetDate: values.targetDate, templateTime: template.time });
  const targetShow = template.date === values.targetDate ? template : null;
  if (targetShow && targetShow.ticketStatus !== 0) throw new Error("所选目标场次不可售");
  if (!targetShow && targetShows.length) throw new Error("请选择目标日期的实际场次");
  const seatSeqNo = targetShow ? String(targetShow.seqNo) : values.templateSeqNo;
  const seatMap = await fetchSeats(session, {
    cinemaId: values.cinemaId,
    movieId: values.movieId,
    seqNo: seatSeqNo
  });
  if (String(seatMap?.seqNo) !== seatSeqNo) throw new Error("猫眼座位图场次无效");
  const ignoreAvailability = !targetShow;
  // 推断模式(保存等待规则, 未来场次可能无法兑现)必须显式勾选风险提示;
  // 目标场次为真实座位图, 与前端 renderInferenceControls/submitBlockReason 同口径(仅模板模式显示并要求勾选)
  if (!targetShow && values.riskAccepted !== true) throw new Error("请确认锁座风险提示");
  const seats = selectedSeats(seatMap, values.seatNos, { ignoreAvailability });
  const timestamp = new Date(now).toISOString();
  lockLog("rule_create", {
    phase: "validated",
    state: targetShow ? "matching" : "waiting_schedule",
    seatCount: seats.length
  });
  const buildRule = (state, extra = {}) => ({
    id: crypto.randomUUID(),
    cinemaId: values.cinemaId,
    cinemaName: template.cinemaName,
    movieId: values.movieId,
    movieName: template.movieName,
    hall: template.hall,
    targetDate: values.targetDate,
    templateDate: template.date,
    templateTime: template.time,
    timeToleranceMinutes: values.timeToleranceMinutes,
    templateSeqNo: values.templateSeqNo,
    targetSeqNo: seatSeqNo,
    seats,
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
    orderId: null,
    payLeftSecond: null,
    ...(targetShow ? { targetTime: template.time, matchMode: "exact", timeDeltaMinutes: 0 } : {}),
    ...extra
  });
  if (targetShow) {
    // 目标场次真实存在: 跳过等待, 立即尝试锁座下单
    await (options.requireActive || requireActiveAccount)(env, tokenId);
    let order;
    try {
      order = await placeOrder(session, seatMap, seats.map((seat) => seat.seatNo));
    } catch (error) {
      const rejected = error instanceof OrderAttemptError && !error.uncertain;
      const failedRule = buildRule("failed", { lastError: "锁座失败，未获得有效订单" });
      const notification = lockNotification(failedRule);
      await persistTerminalNotification(env, {
        userId: tokenId, rule: failedRule, ...notification,
        meta: {
          triggerSource: "manual", failureStage: "order",
          failureReason: rejected ? "provider_rejected" : "order_failed",
        providerResponse: error?.providerResponse || error?.failureDetail
        },
        failureSecrets: [currentCredential(config)],
        failureDetail: error?.failureDetail, credentialVersion: config.version,
        nowMs: new Date(now).getTime()
      });
      try { await wakeNotificationDispatcher(env, { kind: "lock-terminal", userId: tokenId }); } catch {}
      if (rejected) {
        lockError("rule_create", { phase: "complete", state: "failed", reason: "provider_rejected" });
        // 标记为上游拒绝: 协调器与 API 边界据此返回 502 并保留原文案, 而不是降级成笼统的 500
        const rejected = new Error(
          error.message === ORDER_REJECTED_SEATS ? `${ORDER_REJECTED_SEATS}：座位可能已被抢占` : error.message
        );
        rejected.kind = "upstream";
        throw rejected;
      }
      lockError("rule_create", { phase: "complete", state: "failed", reason: "order_failed" });
      const failure = new Error("锁座失败，未获得有效订单");
      failure.kind = "upstream";
      throw failure;
    }
    lockLog("rule_create", { phase: "complete", state: "locked" });
    const rule = buildRule("locked", {
      orderId: String(order.orderId),
      payLeftSecond: order.payLeftSecond ?? null,
      lockedAt: timestamp
    });
    if (!options.notify) {
      const notification = lockNotification(rule);
      await persistTerminalNotification(env, {
        userId: tokenId, rule, ...notification,
        meta: { triggerSource: "manual" },
        credentialVersion: config.version, nowMs: new Date(now).getTime()
      });
      try { await wakeNotificationDispatcher(env, { kind: "lock-terminal", userId: tokenId }); } catch {}
      return publicLockRule(rule, String(env.LOCK_SERVICE_ENABLED) === "true");
    }
    await putLockRule(env, tokenId, rule);
    try {
      await notifyLockedRule(config, rule, options.notify);
    } catch {
      rule.notifyError = "通知发送失败";
      try {
        await putLockRule(env, tokenId, rule);
      } catch {
      }
    }
    return publicLockRule(rule, String(env.LOCK_SERVICE_ENABLED) === "true");
  }
  lockLog("rule_create", { phase: "complete", state: "waiting_schedule" });
  const rule = buildRule("waiting_schedule", { lotteryKey: drawLottery() });
  await putLockRule(env, tokenId, rule);
  return publicLockRule(rule, String(env.LOCK_SERVICE_ENABLED) === "true");
}
