import { lockError, lockLog } from "./log.js";
import { captureFailureDetail } from "./failure-detail.js";
import { seatDisplayLabel, seatSegmentOf } from "./seat-layout.js";

export { seatDisplayLabel, seatSegmentOf } from "./seat-layout.js";

const ORIGIN = "https://www.maoyan.com";
const HOST = "www.maoyan.com";
// Remote Worker verification: m returned a valid order; www returned HTTP 403.
const ORDER_ORIGIN = "https://m.maoyan.com";
const TIMEOUT_MS = 15000;
const DEFAULT_ORDER_QUERY = {
  yodaReady: "h5",
  csecplatform: "4",
  csecversion: "2.6.0"
};

export class OrderAttemptError extends Error {
  constructor(message, uncertain) {
    super(message);
    this.name = "OrderAttemptError";
    this.uncertain = Boolean(uncertain);
  }
}

// 上游(猫眼)明确拒绝的文案: 导出为共享常量, 供 lock-rule 的错误白名单引用, 杜绝文案漂移
export const ORDER_REJECTED_SESSION = "猫眼拒绝当前下单请求，请稍后重试或重新上传会话";
export const ORDER_REJECTED_SEATS = "猫眼拒绝创建订单";

function trustedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("猫眼请求目标不受信任");
  }
  if (url.protocol !== "https:" || (url.hostname !== HOST && url.hostname !== "m.maoyan.com")) {
    throw new Error("猫眼请求目标不受信任");
  }
  return url;
}

function cookieHeader(session) {
  return session.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

function requestHeaders(session, extra = {}) {
  return {
    Cookie: cookieHeader(session),
    "User-Agent": session.userAgent,
    ...extra
  };
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attributes(markup) {
  const values = {};
  const pattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of markup.matchAll(pattern)) values[match[1]] = decodeHtml(match[3]);
  return values;
}

function hasClass(value, className) {
  return String(value).split(/\s+/).includes(className);
}

function malformedSeatMap() {
  return new Error("猫眼座位图格式无效");
}

function decimal(value) {
  return /^\d+$/.test(String(value || ""));
}

function requiredSeatMapValue(value) {
  if (!decimal(value)) throw malformedSeatMap();
  return String(value);
}

function explicitProviderRejection(body) {
  if (!body || typeof body !== "object") return false;
  const data = body.data && typeof body.data === "object" ? body.data : {};
  return body.success === false || data.success === false ||
    (Object.hasOwn(body, "status") && Number(body.status) !== 0) ||
    typeof body.msg === "string" || typeof body.message === "string" || typeof body.error === "string" ||
    typeof data.msg === "string" || typeof data.message === "string" || typeof data.error === "string" ||
    (Object.hasOwn(body, "code") && Number(body.code) !== 0) ||
    (Object.hasOwn(data, "code") && Number(data.code) !== 0);
}

function assertId(value) {
  if (!decimal(value)) throw new Error("猫眼场次参数无效");
  return String(value);
}

function snippet(text, max = 400) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function providerErrorSummary(error, response, session) {
  let sanitized = {};
  try {
    sanitized = JSON.parse(captureFailureDetail(response, JSON.stringify({ name: error?.name, message: error?.message }), session).responseBody);
  } catch { /* Oversized summaries are omitted; the bounded body remains available. */ }
  const errorName = typeof sanitized.name === "string" ? snippet(sanitized.name, 80) : "UnknownError";
  const errorMessage = typeof sanitized.message === "string" ? snippet(sanitized.message, 160) : "无错误信息";
  return { errorName, errorMessage };
}

function nonJsonResponseDiagnostics(headers, text) {
  const title = snippet((String(text).match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "", 80);
  const markers = [];
  if (/cf-chl|captcha|challenge|验证/i.test(text)) markers.push("challenge");
  if (/forbidden|access denied|\b403\b/i.test(text)) markers.push("forbidden");
  if (/\blogin\b|登录/i.test(text)) markers.push("login");
  return {
    contentType: headers?.contentType || undefined,
    server: headers?.server || undefined,
    mitigation: headers?.mitigation || undefined,
    bodyLength: String(text).length,
    responseHint: `页面 ${title || "无标题"}; 标记 ${markers.length ? markers.join(",") : "none"}`
  };
}

export async function requestMaoyan(session, value, options = {}) {
  const url = trustedUrl(value);
  const { allowHttpError = false, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(url, {
      ...requestOptions,
      headers: requestHeaders(session, requestOptions.headers),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: 0 }
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("猫眼请求失败：请求超时");
    }
    throw new Error("猫眼请求失败：网络异常");
  }
  if (response.status >= 300 && response.status < 400 && !allowHttpError) {
    throw new Error(`猫眼请求失败：HTTP ${response.status}`);
  }
  if (!response.ok && !allowHttpError) throw new Error(`猫眼请求失败：HTTP ${response.status}`);
  return response;
}

// 解析失败时的页面诊断信息: 标题 + 关键标记, 帮助判断是登录页/验证页/改版
function pageHint(html) {
  const source = String(html);
  const title = (source.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
  const flags = [];
  if (/登录|login/i.test(source)) flags.push("含登录提示");
  if (/验证|captcha|geetest/i.test(source)) flags.push("含验证提示");
  if (/seats-block/.test(source)) flags.push("含座位块");
  if (/selectable/.test(source)) flags.push("含可选座位");
  const titleText = title.trim().slice(0, 40);
  return flags.length ? `页面「${titleText}」${flags.join("/")}` : `页面「${titleText}」无座位相关标记`;
}

export function parseSeatPage(html) {
  const source = String(html);
  const block = source.match(/<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bseats-block\b[^"']*\1[^>]*>/i);
  if (!block) throw malformedSeatMap();
  const blockAttributes = attributes(block[0]);
  // 分区 id 实证存在字母数字混合值(如 "A001", 9 页语料), 仅作元数据透传不参与下单, 放宽为非空可见字符
  const sectionIdRaw = String(blockAttributes["data-section-id"] || "");
  if (!/^[\x21-\x7e]{1,64}$/.test(sectionIdRaw)) throw malformedSeatMap();
  const sectionId = sectionIdRaw;
  const sectionName = String(blockAttributes["data-section-name"] || "");
  const seqNo = requiredSeatMapValue(blockAttributes["data-seq-no"]);
  if (!sectionName) throw malformedSeatMap();

  const divPattern = /<\/?div\b[^>]*>/gi;
  divPattern.lastIndex = block.index + block[0].length;
  let depth = 1;
  let blockEnd = -1;
  for (const tag of source.matchAll(divPattern)) {
    if (/^<\//i.test(tag[0])) depth -= 1;
    else if (!/\/\s*>$/.test(tag[0])) depth += 1;
    if (depth === 0) {
      blockEnd = tag.index;
      break;
    }
  }
  if (blockEnd < 0) throw malformedSeatMap();

  const seats = [];
  // 物理布局口径(主站同款): 每排 span 按 DOM 顺序即物理从左到右, class 含 seat 的 span
  // 都占一个物理格——包括 data-st="E" 的空占位符(无 data-no/column-id, 表示过道/空白)。
  // orderIndex = 座位在其排内含占位符的位次(1 起), 前端据此复现主站的居中/孤立座布局;
  // 丢弃占位符本体(不可选不可下单), 只把它计入位次。
  const orderCounter = new Map();
  const seatMarkup = source.slice(block.index + block[0].length, blockEnd);
  for (const match of seatMarkup.matchAll(/<span\b[^>]*>/gi)) {
    const seatAttributes = attributes(match[0]);
    if (!hasClass(seatAttributes.class, "seat")) continue;
    const rowId = String(seatAttributes["data-row-id"] || "");
    let orderIndex = 0;
    if (rowId) {
      orderIndex = (orderCounter.get(rowId) || 0) + 1;
      orderCounter.set(rowId, orderIndex);
    }
    // 跳过空位/走道占位符: 只收集字段完整的座位。data-no 是不透明主键, 官方前端点击时
    // 原样透传(官方 JS 解码实证), 实际存在「-」三段/「#」三段/纯数字 seatId 等形状,
    // 因此不做格式校验, 仅要求非空且携带 rowId/columnId(解析序号, 展示与情侣座配对依赖它们)。
    const seatNo = String(seatAttributes["data-no"] || "");
    const columnId = String(seatAttributes["data-column-id"] || "");
    if (!seatNo || !rowId || !columnId) continue;
    const sold = hasClass(seatAttributes.class, "sold");
    const selectable = !sold && hasClass(seatAttributes.class, "selectable");
    const explicitlyUnavailable = hasClass(seatAttributes.class, "disabled") || hasClass(seatAttributes.class, "unavailable");
    const availability = sold ? "sold" : selectable ? "available" : explicitlyUnavailable ? "unavailable" : "unknown";
    seats.push({
      rowId,
      columnId,
      seatNo,
      type: String(seatAttributes["data-st"] || ""),
      available: availability === "available",
      availability,
      disabledReason: availability === "sold" ? "已售"
        : availability === "unavailable" ? "不可用"
          : availability === "unknown" ? "状态未知" : null,
      orderIndex
    });
  }
  if (!seats.length) throw malformedSeatMap();
  // data-cols = 每排物理格总数(含过道占位), 主站以此铺排; 缺失时前端按最大 orderIndex 兜底
  const colsRaw = String(blockAttributes["data-cols"] || "");
  const cols = /^\d+$/.test(colsRaw) ? Number(colsRaw) : 0;
  return { sectionId, sectionName, seqNo, cols, seats };
}

// 官方座位图 1:1 对比: 从原页提取 seats-block 整块(排号列+银幕+座位 DOM, 官方 class 语义),
// 供前端在沙箱 iframe 内配合官方 CSS 副本还原主站渲染(实证: 官方 CSS 无属性选择器依赖,
// data-act/data-bid 仅为埋点, 可安全剥离; data-no/row-id/column-id/st 保留)。
// 失败一律返回空串——对比图是增强能力, 任何提取异常都不能影响座位数据主链路。
export function extractOfficialSeatHtml(html) {
  try {
    const source = String(html);
    const block = source.match(/<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bseats-block\b[^"']*\1[^>]*>/i);
    if (!block) return "";
    const divPattern = /<\/?div\b[^>]*>/gi;
    divPattern.lastIndex = block.index + block[0].length;
    let depth = 1;
    let blockEnd = -1;
    for (const tag of source.matchAll(divPattern)) {
      if (/^<\//i.test(tag[0])) depth -= 1;
      else if (!/\/\s*>$/.test(tag[0])) depth += 1;
      if (depth === 0) {
        blockEnd = tag.index + tag[0].length;
        break;
      }
    }
    if (blockEnd < 0) return "";
    let fragment = source.slice(block.index, blockEnd);
    fragment = fragment.replace(/<script\b[\s\S]*?<\/script>/gi, "");
    fragment = fragment.replace(/<!--[\s\S]*?-->/g, "");
    // 埋点属性剥离(官方 CSS 与本工具前端均不使用)
    fragment = fragment.replace(/\s(?:data-act|data-bid)="[^"]*"/gi, "");
    // 标签间空白压缩(片段原样含大量缩进, 直接影响响应体积)
    fragment = fragment.replace(/>\s+</g, "><").trim();
    return fragment;
  } catch {
    return "";
  }
}

export function findExactShows(data, { movieId, targetDate, templateTime }) {
  const movie = (data?.showData?.movies || []).find((item) => String(item.id) === String(movieId));
  if (!movie) return [];
  return (movie.shows || []).flatMap((day) => {
    const showDate = String(day.showDate || day.dt || "");
    if (showDate !== targetDate) return [];
    return (day.plist || [])
      .filter((show) => String(show.tm || "") === templateTime)
      .map((show) => ({ ...show, showDate }));
  });
}

function showMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function findCompatibleShows(data, { movieId, targetDate, templateTime, templateHall, maxMinutes = 30 }) {
  const movie = (data?.showData?.movies || []).find((item) => String(item.id) === String(movieId));
  const templateMinutes = showMinutes(templateTime);
  const hall = String(templateHall || "");
  if (!movie || templateMinutes === null || !hall) return [];
  const limit = Number(maxMinutes);
  if (!Number.isFinite(limit) || limit < 0) return [];
  return (movie.shows || []).flatMap((day) => {
    const showDate = String(day.showDate || day.dt || "");
    if (showDate !== String(targetDate)) return [];
    return (day.plist || []).flatMap((show) => {
      if (String(show.th || "") !== hall || (show.ticketStatus != null && Number(show.ticketStatus) !== 0)) return [];
      const candidateMinutes = showMinutes(show.tm);
      if (candidateMinutes === null) return [];
      const timeDeltaMinutes = candidateMinutes - templateMinutes;
      if (Math.abs(timeDeltaMinutes) > limit) return [];
      return [{ ...show, showDate, timeDeltaMinutes, matchMode: "fuzzy" }];
    });
  }).sort((left, right) => Math.abs(left.timeDeltaMinutes) - Math.abs(right.timeDeltaMinutes) ||
    String(left.seqNo || "").localeCompare(String(right.seqNo || "")));
}

export async function fetchSeatMap(session, { cinemaId, movieId, seqNo, includeOfficial = false }) {
  const url = new URL(`${ORIGIN}/xseats/${assertId(seqNo)}`);
  const normalizedMovieId = assertId(movieId);
  const normalizedCinemaId = assertId(cinemaId);
  url.searchParams.set("movieId", normalizedMovieId);
  url.searchParams.set("cinemaId", normalizedCinemaId);
  const response = await requestMaoyan(session, url.toString());
  const html = await response.text();
  try {
    const result = {
      ...parseSeatPage(html),
      movieId: normalizedMovieId,
      cinemaId: normalizedCinemaId
    };
    if (includeOfficial) result.officialHtml = extractOfficialSeatHtml(html);
    return result;
  } catch (error) {
    if (/^猫眼座位图格式无效$/.test(String(error?.message || ""))) {
      error.message = `${error.message}（${pageHint(html)}）`;
    }
    throw error;
  }
}

function selectedSeats(seatMap, seats) {
  const seatNos = Array.isArray(seats) ? seats.map(String) : [];
  if (!seatNos.length || new Set(seatNos).size !== seatNos.length) {
    throw new Error("所选座位无效");
  }
  const available = new Map(
    seatMap.seats
      .filter((seat) => seat.available)
      .map((seat) => [String(seat.seatNo), seat])
  );
  if (!seatNos.every((seatNo) => available.has(seatNo))) throw new Error("所选座位不可用");
  return seatNos.map((seatNo) => {
    const seat = available.get(seatNo);
    return {
      rowId: String(seat.rowId),
      columnId: String(seat.columnId),
      seatNo: String(seat.seatNo),
      type: String(seat.type || "N")
    };
  });
}

export async function createUnpaidOrder(session, seatMap, seats) {
  const selected = selectedSeats(seatMap, seats);
  // Keep seat-page reads on www; the verified order endpoint is on m.
  const url = new URL(`${ORDER_ORIGIN}/ajax/createOrder`);
  // 会话捕获的下单参数优先(签名版本等必须与登录会话匹配), 缺省时用默认值
  const query = { ...DEFAULT_ORDER_QUERY, ...(session.createOrderQuery || {}) };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const body = new URLSearchParams({
    sectionId: seatMap.sectionId,
    sectionName: seatMap.sectionName,
    seqNo: seatMap.seqNo,
    seats: JSON.stringify({ count: selected.length, list: selected })
  });
  const startedAt = Date.now();
  const context = {
    attemptId: crypto.randomUUID(), endpoint: `${ORDER_ORIGIN}/ajax/createOrder`,
    seqNo: String(seatMap.seqNo), seatCount: selected.length
  };
  const fields = (extra) => ({ ...context, durationMs: Date.now() - startedAt, ...extra });
  lockLog("order_attempt", fields({ phase: "request" }));
  let response;
  try {
    response = await requestMaoyan(session, url.toString(), {
      allowHttpError: true,
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Origin: ORDER_ORIGIN,
        Referer: `${ORDER_ORIGIN}/`,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body
    });
  } catch (error) {
    lockError("order_attempt", fields({ phase: "request", state: "failed", reason: "network_error" }));
    // 诊断上下文跟随错误透传: 网络异常的具体形态(超时/连接重置等), 便于区分风控拦截与链路问题
    throw orderUncertainError(`网络异常：${snippet(error?.message || "unknown", 80)}`);
  }
  context.httpStatus = response.status;
  let text;
  try {
    text = await response.text();
  } catch {
    lockError("order_attempt", fields({ phase: "response", state: "failed", reason: "body_read_error" }));
    throw orderUncertainError(`HTTP ${response.status} 响应读取失败`);
  }
  const contentType = response.headers.get("content-type") || "";
  const failure = captureFailureDetail(response, text, session);
  const withFailureDetail = (error) => {
    error.failureDetail = JSON.stringify(failure);
    return error;
  };
  context.responseType = /json/i.test(contentType) ? "json" : /xml/i.test(contentType) ? "xml" : /html/i.test(contentType) ? "html" : "other";
  lockLog("order_attempt", fields({ phase: "response" }));
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const diagnostics = nonJsonResponseDiagnostics({
      contentType: failure.headers["content-type"] || "",
      server: failure.headers.server || "",
      mitigation: failure.headers["cf-mitigated"] || ""
    }, failure.responseBody);
    lockError("order_attempt", fields({
      phase: "response",
      state: "failed",
      reason: "invalid_json",
      responseBody: failure.responseBody,
      ...diagnostics
    }));
    throw withFailureDetail(orderUncertainError(`HTTP ${response.status} 非 JSON 响应`));
  }
  const rejected = explicitProviderRejection(payload);
  // Mobile responses expose data.id; desktop responses wrap it in data.data.
  const order = payload?.data?.data ?? (
    payload?.success === true && payload?.status === 0 ? payload?.data : null
  );
  if (response.ok && !payload?.error && !rejected && order &&
      ((typeof order.id === "string" && order.id.trim().length > 0) ||
       (typeof order.id === "number" && Number.isFinite(order.id) && order.id > 0))) {
    const payLeftSecond = Number(order.payLeftSecond);
    lockLog("order_attempt", fields({ phase: "complete", state: "locked" }));
    return {
      orderId: String(order.id),
      payLeftSecond: Number.isFinite(payLeftSecond) ? payLeftSecond : null
    };
  }
  // 猫眼网关错误(error 对象, 如 NetError/Bad Request): 多为会话或 mtgsig 签名过期
  if (payload?.error && typeof payload.error === "object") {
    lockError("order_attempt", fields({
      phase: "response",
      state: "failed",
      responseBody: failure.responseBody,
      ...providerErrorSummary(payload.error, response, session)
    }));
    throw withFailureDetail(new OrderAttemptError(ORDER_REJECTED_SESSION, false));
  }
  if (rejected) {
    lockError("order_attempt", fields({ phase: "response", state: "failed", reason: "provider_rejected", responseBody: failure.responseBody }));
    throw withFailureDetail(new OrderAttemptError(ORDER_REJECTED_SEATS, false));
  }
  lockError("order_attempt", fields({ phase: "response", state: "failed", reason: "unrecognized_response", responseBody: failure.responseBody }));
  // Error details reach the API caller; never include raw provider JSON.
  throw withFailureDetail(orderUncertainError(`HTTP ${response.status} JSON 响应结构未识别`));
}

// 失败文案保持稳定, 真实原因放 detail 由上层决定是否透出
function orderUncertainError(detail) {
  const error = new OrderAttemptError("锁座失败，未获得有效订单", true);
  error.detail = snippet(detail, 200);
  return error;
}
