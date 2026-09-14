import { lockError, lockLog } from "./log.js";

const ORIGIN = "https://www.maoyan.com";
const HOST = "www.maoyan.com";
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
  if (url.protocol !== "https:" || url.hostname !== HOST) {
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

function providerErrorSummary(error) {
  const errorName = typeof error?.name === "string" ? snippet(error.name, 80) : "UnknownError";
  const errorMessage = typeof error?.message === "string" ? snippet(error.message, 160) : "无错误信息";
  return { errorName, errorMessage };
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
  if (response.status >= 300 && response.status < 400) {
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
    seats.push({
      rowId,
      columnId,
      seatNo,
      type: String(seatAttributes["data-st"] || ""),
      available: hasClass(seatAttributes.class, "selectable"),
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

// 猫眼座位口径: 票面排号 = data-row-id (影厅内 1..N 连续)。
// data-no 是官方前端原样透传的不透明主键, 实际存在四种编码形状(55 页普查实证):
//   ① 「#」三段: 影厅长编码#排#座 (seg2/seg3 常见两位前导零)
//   ② 「-」三段·全零区码: 0000000000000001-排-座 (seg3 前导零)
//   ③ 「-」三段·变长零填充区码: 同页 7~12 位填充并存, seg1 不能作为判别依据
//   ④ 纯数字 seatId: 无分隔符(约 15% 影院), 排/座信息无法从 seatNo 推出
// 另有万达天和型「区-座-排」与寰映型「区-排-座」两种段序, 以及多区厅同排跨区(seg1 行内混区)。
// 展示一律用下方两个函数(需要 seat 携带 rowId/columnId); 内部请求仍使用原始 seatNo(不可改写)。
export function seatSegmentOf(seats) {
  // 分段: 按非字母数字切分, 天然兼容「-」「#」及未来其它分隔符; 三段齐全才算有段语义
  const parsed = [];
  for (const seat of seats || []) {
    const parts = String(seat?.seatNo || "").split(/[^0-9A-Za-z]+/);
    if (parts.length === 3 && parts.every((part) => part)) {
      parsed.push({ rowId: String(seat?.rowId ?? ""), seg2: parts[1], seg3: parts[2] });
    }
  }
  // 行内判别(普查 75/75 零失败): 同一排内逐座恒定的段是排号, 逐座变化的段是座号
  const rowGroups = new Map();
  for (const item of parsed) {
    if (!rowGroups.has(item.rowId)) rowGroups.set(item.rowId, []);
    rowGroups.get(item.rowId).push(item);
  }
  let checkedRows = 0;
  let vary2 = 0;
  let vary3 = 0;
  for (const group of rowGroups.values()) {
    if (group.length < 2) continue;
    checkedRows += 1;
    if (new Set(group.map((item) => item.seg2)).size > 1) vary2 += 1;
    if (new Set(group.map((item) => item.seg3)).size > 1) vary3 += 1;
  }
  if (checkedRows > 0) {
    // 座号段须在所有受检排内逐座变化、排号段在所有受检排内恒定; 混合特征视为判别不充分
    if (vary2 > 0 && vary3 === 0) return 2;
    if (vary3 > 0 && vary2 === 0) return 3;
  }
  // 全局启发式兜底(单座规则/全是单座排/混合特征): 三段中唯一值更多者为座号
  const uniq2 = new Set(parsed.map((item) => item.seg2)).size;
  const uniq3 = new Set(parsed.map((item) => item.seg3)).size;
  return uniq3 > uniq2 && uniq3 > rowGroups.size ? 3 : 2;
}

export function seatDisplayLabel(seatOrSeatNo, seatSegment = 2) {
  const seat = seatOrSeatNo && typeof seatOrSeatNo === "object" ? seatOrSeatNo : null;
  if (!seat) return seatOrSeatNo == null ? "" : String(seatOrSeatNo);
  const seatNo = String(seat.seatNo || "");
  const row = Number(seat.rowId);
  if (!Number.isInteger(row) || row <= 0) return seatNo;
  const parts = seatNo.split(/[^0-9A-Za-z]+/);
  if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
    // 「区-排-座」强信号: seg2 与票面排号一致且 seg3 与解析列号一致(寰映激光IMAX型实证)。
    // 不依赖座位图普查 —— 单座规则/未加载座位图时普查不充分、恒回落 seg=2(万达「区-座-排」假设),
    // 会把该型排号段误当座号(真实缺陷: 9排15座 显示成 9排9座)。
    const colOrdinal = Number(seat.columnId);
    if (colOrdinal > 0 && Number(parts[1]) === row && Number(parts[2]) === colOrdinal) {
      return `${row}排${Number(parts[2])}座`;
    }
    // 段有效(三段全数字) → 排号仍用 rowId(与真实订单票面「9排1座」锚定), 座号取判别段并去前导零
    const seatNumber = Number(parts[seatSegment === 3 ? 2 : 1]);
    if (Number.isInteger(seatNumber) && seatNumber > 0) return `${row}排${seatNumber}座`;
  }
  // 段无效(纯数字 seatId 等) → 与官方「已选座」气泡同口径, 用解析序号兜底
  const column = Number(seat.columnId);
  if (Number.isInteger(column) && column > 0) return `${row}排${column}座`;
  return seatNo;
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

export async function fetchSeatMap(session, { cinemaId, movieId, seqNo }) {
  const url = new URL(`${ORIGIN}/xseats/${assertId(seqNo)}`);
  const normalizedMovieId = assertId(movieId);
  const normalizedCinemaId = assertId(cinemaId);
  url.searchParams.set("movieId", normalizedMovieId);
  url.searchParams.set("cinemaId", normalizedCinemaId);
  const response = await requestMaoyan(session, url.toString());
  const html = await response.text();
  try {
    return {
      ...parseSeatPage(html),
      officialHtml: extractOfficialSeatHtml(html),
      movieId: normalizedMovieId,
      cinemaId: normalizedCinemaId
    };
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

function seatPageReferer(seatMap) {
  const url = new URL(`${ORIGIN}/xseats/${assertId(seatMap.seqNo)}`);
  if (seatMap.movieId && seatMap.cinemaId) {
    url.searchParams.set("movieId", assertId(seatMap.movieId));
    url.searchParams.set("cinemaId", assertId(seatMap.cinemaId));
  }
  return url.toString();
}


export async function createUnpaidOrder(session, seatMap, seats) {
  const selected = selectedSeats(seatMap, seats);
  const url = new URL(`${ORIGIN}/ajax/createOrder`);
  // 会话捕获的下单参数优先(签名版本等必须与登录会话匹配), 缺省时用默认值
  const query = { ...DEFAULT_ORDER_QUERY, ...(session.createOrderQuery || {}) };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const body = new URLSearchParams({
    sectionId: seatMap.sectionId,
    sectionName: seatMap.sectionName,
    seqNo: seatMap.seqNo,
    seats: JSON.stringify({ count: selected.length, list: selected })
  });
  lockLog("order_attempt", { phase: "request", seatCount: selected.length });
  let response;
  try {
    response = await requestMaoyan(session, url.toString(), {
      allowHttpError: true,
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        mtgsig: session.mtgsig,
        Origin: ORIGIN,
        Referer: seatPageReferer(seatMap),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body
    });
  } catch (error) {
    lockError("order_attempt", { phase: "request", state: "unknown", reason: "network_error" });
    throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
  }
  const text = await response.text();
  lockLog("order_attempt", { phase: "response", httpStatus: response.status });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    lockError("order_attempt", { phase: "response", state: "unknown", reason: "invalid_json" });
    throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
  }
  const order = payload?.data?.data;
  if (order && (typeof order.id === "string" || typeof order.id === "number")) {
    const payLeftSecond = Number(order.payLeftSecond);
    lockLog("order_attempt", { phase: "complete", state: "locked" });
    return {
      orderId: String(order.id),
      payLeftSecond: Number.isFinite(payLeftSecond) ? payLeftSecond : null
    };
  }
  // 猫眼网关错误(error 对象, 如 NetError/Bad Request): 多为会话或 mtgsig 签名过期
  if (payload?.error && typeof payload.error === "object") {
    lockError("order_attempt", {
      phase: "response",
      state: "failed",
      ...providerErrorSummary(payload.error)
    });
    throw new OrderAttemptError(ORDER_REJECTED_SESSION, false);
  }
  if (explicitProviderRejection(payload)) {
    lockError("order_attempt", { phase: "response", state: "failed", reason: "provider_rejected" });
    throw new OrderAttemptError(ORDER_REJECTED_SEATS, false);
  }
  lockError("order_attempt", { phase: "response", state: "unknown", reason: "unrecognized_response" });
  throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
}
