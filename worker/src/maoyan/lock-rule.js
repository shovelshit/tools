import { fetchCinemaDetail } from "./api.js";
import { fetchSeatMap, findExactShows } from "./lock-client.js";
import { loadLockSession } from "./lock-session.js";
import { getUserConfig, userKey } from "./user.js";

const RULE_NAME = "maoyan-lock-rule";
export const LOCK_RULE_TERMINAL_STATES = new Set(["locked", "expired", "failed", "unknown", "completed", "cancelled"]);
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

function assertTargetDate(targetDate, templateDate, now) {
  const targetDay = dayNumber(targetDate);
  const templateDay = dayNumber(templateDate);
  const today = dayNumber(chinaDate(now));
  if (targetDay === null || templateDay === null || targetDay < today || targetDay < templateDay || targetDay - today > 30) {
    throw new Error("目标日期需在今天起 30 天内，且不早于模板场次日期");
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
        return { cinemaName: String(data?.showData?.cinemaName || ""), movieName: String(movie.nm || ""), date, time: String(show.tm) };
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
  const now = options.now || new Date();
  const [session, cinema] = await Promise.all([loadSession(env, tokenId), fetchCinema(values.cinemaId)]);
  const template = scheduleForTemplate(cinema, values.movieId, values.templateSeqNo);
  if (!template.cinemaName || !template.movieName) throw new Error("猫眼场次数据无效");
  assertTargetDate(values.targetDate, template.date, now);
  // 目标日期已有排期: 直接使用目标场次的真实座位图; 否则用模板座位图(尚未开售, 座位全部可锁)
  const targetShows = findExactShows(cinema, { movieId: values.movieId, targetDate: values.targetDate, templateTime: template.time });
  const targetShow = targetShows.find((show) => Number(show.ticketStatus) === 0) || targetShows[0] || null;
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
  const rule = {
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
    state: "waiting_schedule",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
    orderId: null,
    payLeftSecond: null
  };
  await putLockRule(env, tokenId, rule);
  return publicLockRule(rule, false);
}
