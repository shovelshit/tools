import { fetchCinemaDetail } from "./api.js";
import { fetchSeatMap, findExactShows, createUnpaidOrder, OrderAttemptError } from "./lock-client.js";
import { loadLockSession } from "./lock-session.js";
import { getUserConfig, userKey } from "./user.js";
import { pushNotify } from "./notify.js";
import { lockError, lockLog } from "./log.js";

const RULE_NAME = "maoyan-lock-rule";
// 这些错误会原样透传给前端(而不是笼统的"锁座参数无效")
export const RULE_KNOWN_ERRORS = [
  "锁座参数无效", "请确认锁座风险提示", "所选座位无效", "所选座位不可用", "情侣座需成对选择",
  "影片未在当前影院监控配置中选择", "模板场次不属于当前影院影片", "目标日期需在今天起 30 天内",
  "猫眼场次数据无效", "猫眼座位图场次无效", "猫眼会话不完整", "猫眼拒绝创建订单：座位可能已被抢占",
  "猫眼拒绝当前请求，会话或签名可能已过期，请重新登录并上传会话",
  "目标日期存在多个相同时间场次", "所选未来座位不可用或影厅布局已变化", "锁座服务尚未配置加密密钥",
  "请选择目标日期的实际场次", "所选目标场次不可售"
];
export const LOCK_RULE_TERMINAL_STATES = new Set(["locked", "expired", "failed", "completed", "cancelled"]);
const PUBLIC_FIELDS = [
  "id", "cinemaId", "cinemaName", "movieId", "movieName", "targetDate",
  "templateDate", "templateTime", "templateSeqNo", "targetSeqNo", "seats", "state",
  "createdAt", "updatedAt", "lastError", "orderId", "payLeftSecond"
];

function decimal(value) {
  return /^\d+$/.test(String(value || ""));
}

function seatNo(value) {
  return /^\d+-\d+-\d+$/.test(String(value || ""));
}

function assertExactInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("锁座参数无效");
  const allowed = new Set(["cinemaId", "movieId", "templateSeqNo", "targetDate", "seatNos", "riskAccepted"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("锁座参数无效");
  if (!decimal(input.cinemaId) || !decimal(input.movieId) || !decimal(input.templateSeqNo)) {
    throw new Error("锁座参数无效");
  }
  if (input.riskAccepted !== true) throw new Error("请确认锁座风险提示");
  if (!Array.isArray(input.seatNos) || !input.seatNos.length || input.seatNos.some((value) => !seatNo(value))) {
    throw new Error("所选座位无效");
  }
  return {
    cinemaId: String(input.cinemaId),
    movieId: String(input.movieId),
    templateSeqNo: String(input.templateSeqNo),
    targetDate: String(input.targetDate),
    seatNos: [...new Set(input.seatNos.map(String))]
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
  const partnerOf = (seat) => {
    if (!isCouple(seat)) return null;
    const opposite = seat.type === "L" ? "R" : "L";
    return (seatMap?.seats || []).find((candidate) => candidate !== seat && candidate.type === opposite &&
      String(candidate.rowId) === String(seat.rowId) &&
      Math.abs(Number(candidate.columnId) - Number(seat.columnId)) === 1) || null;
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
    type: String(seat.type || "")
  }));
}

function ruleKey(tokenId) {
  return userKey(tokenId, RULE_NAME);
}

async function notifyLockedRule(config, rule, notify = pushNotify) {
  const labels = rule.seats.map((seat) => seat.seatNo).join("、");
  const content = `${rule.cinemaName} ${rule.movieName}\n${rule.targetDate} ${rule.templateTime}\n${labels}` +
    (rule.payLeftSecond !== null ? `\n剩余支付时间 ${rule.payLeftSecond} 秒` : "");
  await notify(config, "猫眼锁座成功", content);
}

export async function getLockRule(env, tokenId) {
  return await env.MAOYAN_KV.get(ruleKey(tokenId), "json");
}

export async function putLockRule(env, tokenId, rule) {
  await env.MAOYAN_KV.put(ruleKey(tokenId), JSON.stringify(rule));
}

export async function removeLockRule(env, tokenId) {
  await env.MAOYAN_KV.delete(ruleKey(tokenId));
}

export function publicLockRule(rule, automationEnabled) {
  if (!rule || typeof rule !== "object") return null;
  const result = Object.fromEntries(PUBLIC_FIELDS.filter((field) => Object.hasOwn(rule, field)).map((field) => [field, rule[field]]));
  return { ...result, automationEnabled: Boolean(automationEnabled) };
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
  const fetchSeats = options.fetchSeats || fetchSeatMap;
  const placeOrder = options.placeOrder || createUnpaidOrder;
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
    targetDate: values.targetDate,
    templateDate: template.date,
    templateTime: template.time,
    templateSeqNo: values.templateSeqNo,
    targetSeqNo: seatSeqNo,
    seats,
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
    orderId: null,
    payLeftSecond: null,
    ...extra
  });
  if (targetShow) {
    // 目标场次真实存在: 跳过等待, 立即尝试锁座下单
    try {
      const order = await placeOrder(session, seatMap, seats.map((seat) => seat.seatNo));
      lockLog("rule_create", { phase: "complete", state: "locked" });
      const rule = buildRule("locked", {
        orderId: String(order.orderId),
        payLeftSecond: order.payLeftSecond ?? null,
        lockedAt: timestamp
      });
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
    } catch (error) {
      if (error instanceof OrderAttemptError && !error.uncertain) {
        lockError("rule_create", { phase: "complete", state: "failed", reason: "provider_rejected" });
        throw new Error(error.message === "猫眼拒绝创建订单" ? "猫眼拒绝创建订单：座位可能已被抢占" : error.message);
      }
      // 结果不确定(网络异常等): 保存为待人工确认, 避免重复下单
      lockError("rule_create", { phase: "complete", state: "unknown", reason: "ambiguous_result" });
      const rule = buildRule("unknown", { lastError: "创建订单结果不确定，请到猫眼订单中确认" });
      await putLockRule(env, tokenId, rule);
      return publicLockRule(rule, String(env.LOCK_SERVICE_ENABLED) === "true");
    }
  }
  lockLog("rule_create", { phase: "complete", state: "waiting_schedule" });
  const rule = buildRule("waiting_schedule");
  await putLockRule(env, tokenId, rule);
  return publicLockRule(rule, String(env.LOCK_SERVICE_ENABLED) === "true");
}
