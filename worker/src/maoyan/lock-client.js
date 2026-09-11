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

function requiredSeatNumber(value) {
  const seatNo = String(value || "");
  if (!/^\d+-\d+-\d+$/.test(seatNo)) throw malformedSeatMap();
  return seatNo;
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

export async function requestMaoyan(session, value, options = {}) {
  const url = trustedUrl(value);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: requestHeaders(session, options.headers),
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
  if (!response.ok) throw new Error(`猫眼请求失败：HTTP ${response.status}`);
  return response;
}

export function parseSeatPage(html) {
  const block = String(html).match(/<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bseats-block\b[^"']*\1[^>]*>/i);
  if (!block) throw malformedSeatMap();
  const blockAttributes = attributes(block[0]);
  const sectionId = requiredSeatMapValue(blockAttributes["data-section-id"]);
  const sectionName = String(blockAttributes["data-section-name"] || "");
  const seqNo = requiredSeatMapValue(blockAttributes["data-seq-no"]);
  if (!sectionName) throw malformedSeatMap();

  const seats = [];
  for (const match of String(html).matchAll(/<span\b[^>]*>/gi)) {
    const seatAttributes = attributes(match[0]);
    if (!hasClass(seatAttributes.class, "seat")) continue;
    seats.push({
      rowId: requiredSeatMapValue(seatAttributes["data-row-id"]),
      columnId: requiredSeatMapValue(seatAttributes["data-column-id"]),
      seatNo: requiredSeatNumber(seatAttributes["data-no"]),
      type: String(seatAttributes["data-st"] || ""),
      available: hasClass(seatAttributes.class, "selectable")
    });
  }
  if (!seats.length) throw malformedSeatMap();
  return { sectionId, sectionName, seqNo, seats };
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
  url.searchParams.set("movieId", assertId(movieId));
  url.searchParams.set("cinemaId", assertId(cinemaId));
  const response = await requestMaoyan(session, url.toString());
  return parseSeatPage(await response.text());
}

function selectedSeats(seatMap, seats) {
  if (!Array.isArray(seats) || !seats.length || new Set(seats).size !== seats.length) {
    throw new Error("所选座位无效");
  }
  const available = new Set(seatMap.seats.filter((seat) => seat.available).map((seat) => seat.seatNo));
  if (!seats.every((seat) => available.has(seat))) throw new Error("所选座位不可用");
  return seats.map(String);
}

export async function createUnpaidOrder(session, seatMap, seats) {
  const selected = selectedSeats(seatMap, seats);
  const url = new URL(`${ORIGIN}/ajax/createOrder`);
  for (const [key, value] of Object.entries(DEFAULT_ORDER_QUERY)) url.searchParams.set(key, value);
  const body = new URLSearchParams({
    sectionId: seatMap.sectionId,
    sectionName: seatMap.sectionName,
    seqNo: seatMap.seqNo,
    seats: JSON.stringify({ count: selected.length, list: selected })
  });
  let response;
  try {
    response = await requestMaoyan(session, url.toString(), {
      method: "POST",
      headers: {
        mtgsig: session.mtgsig,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/xseats/${seatMap.seqNo}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body
    });
  } catch {
    throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
  }
  const order = payload?.data?.data;
  if (order && (typeof order.id === "string" || typeof order.id === "number")) {
    const payLeftSecond = Number(order.payLeftSecond);
    return {
      orderId: String(order.id),
      payLeftSecond: Number.isFinite(payLeftSecond) ? payLeftSecond : null
    };
  }
  if (explicitProviderRejection(payload)) throw new OrderAttemptError("猫眼拒绝创建订单", false);
  throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
}
