import { fetchCinemaDetail } from "./api.js";
import { fetchSeatMap } from "./lock-client.js";
import { loadLockSession } from "./lock-session.js";
import { getUserConfig, userKey } from "./user.js";

const RULE_NAME = "maoyan-lock-rule";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_FIELDS = [
  "id", "cinemaId", "cinemaName", "movieId", "movieName", "targetDate",
  "templateDate", "templateTime", "templateSeqNo", "seats", "state",
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
  if (targetDay === null || templateDay === null || targetDay <= templateDay || targetDay - today > 30) {
    throw new Error("目标日期必须晚于模板场次且在未来 30 天内");
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

function selectedSeats(seatMap, seatNos) {
  const byNumber = new Map((seatMap?.seats || []).map((seat) => [String(seat.seatNo), seat]));
  const selected = seatNos.map((number) => byNumber.get(number));
  if (selected.some((seat) => !seat || !seat.available)) throw new Error("所选座位不可用");
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
  const values = assertExactInput(input);
  const existing = await getLockRule(env, tokenId);
  if (existing && !TERMINAL_STATES.has(existing.state)) throw new Error("已有进行中的锁座规则");

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
  const seatMap = await fetchSeats(session, {
    cinemaId: values.cinemaId,
    movieId: values.movieId,
    seqNo: values.templateSeqNo
  });
  if (String(seatMap?.seqNo) !== values.templateSeqNo) throw new Error("猫眼座位图场次无效");
  const seats = selectedSeats(seatMap, values.seatNos);
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
