// ---------------- 猫眼抓取 ----------------
// cookie jar 跟随 + 影院详情 / 影院搜索(moreCinemas HTML 解析)

const MAOYAN_API = "https://m.maoyan.com/ajax/cinemaDetail?cinemaId=";
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Referer: "https://m.maoyan.com/"
};

function mergeCookies(jar, setCookieList) {
  for (const raw of setCookieList || []) {
    const pair = raw.split(";")[0];
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const rest = jar.filter((c) => c.split("=")[0].trim() !== name);
    rest.push(pair);
    jar.length = 0;
    jar.push(...rest);
  }
}

async function fetchWithJar(url, jar) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const headers = { ...COMMON_HEADERS };
    if (jar.length) headers.Cookie = jar.join("; ");
    const res = await fetch(current, { headers, redirect: "manual", cf: { cacheTtl: 0 } });
    mergeCookies(jar, res.headers.getSetCookie?.() || []);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error("重定向超过 5 次");
}

// 影院详情(当日排片)
export async function fetchCinemaDetail(cinemaId) {
  const jar = [];
  await fetchWithJar("https://m.maoyan.com/", jar);
  const res = await fetchWithJar(MAOYAN_API + cinemaId, jar);
  const data = JSON.parse(await res.text());
  if (!data || !data.showData || !Array.isArray(data.showData.movies)) {
    throw new Error("接口数据异常(缺少 showData.movies)");
  }
  return data;
}

// ---------------- 影院搜索(解析猫眼 moreCinemas HTML) ----------------

function parseCinemasHTML(html) {
  const cinemas = [];
  const re = /<a href="\/shows\/(\d+)"[\s\S]*?data-id="\d+" data-bid="dp_wx_home_cinema_list">[\s\S]*?<span>([^<]*)<\/span>[\s\S]*?line-ellipsis">([^<]*)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    cinemas.push({ id: m[1], nm: m[2], addr: m[3].trim() });
  }
  return cinemas;
}

async function fetchCinemaPage(cityId, jar, offset, limit) {
  const params = new URLSearchParams({
    day: new Date().toISOString().slice(0, 10),
    offset: String(offset),
    limit: String(limit),
    districtId: "-1",
    lineId: "-1",
    hallType: "-1",
    brandId: "-1",
    serviceId: "-1",
    areaId: "-1",
    stationId: "-1",
    item: "",
    updateShowDay: "true",
    reqId: String(Date.now()),
    cityId: String(cityId),
  });
  const res = await fetchWithJar("https://m.maoyan.com/ajax/moreCinemas?" + params.toString(), jar);
  const text = await res.text();
  if (!text || text.trim().startsWith("<!DOCTYPE")) {
    throw new Error("猫眼返回异常页面");
  }
  return parseCinemasHTML(text);
}

// 拉取城市全量影院(KV 缓存 6 小时), 再本地模糊过滤
export async function searchCinemasByKw(env, cityId, kw) {
  const cacheKey = `cache:cinemas:${cityId}`;
  const cached = await env.MAOYAN_KV.get(cacheKey, "json");
  let all = Array.isArray(cached) ? cached : null;
  if (!all) {
    const jar = [];
    await fetchWithJar("https://m.maoyan.com/", jar);
    all = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await fetchCinemaPage(cityId, jar, offset, 100);
      all.push(...page);
      if (page.length < 100) break;
    }
    if (all.length) {
      await env.MAOYAN_KV.put(cacheKey, JSON.stringify(all), { expirationTtl: 6 * 3600 });
    }
  }
  const q = String(kw).toLowerCase();
  return all.filter(
    (c) => c.nm.toLowerCase().includes(q) || (c.addr || "").toLowerCase().includes(q)
  );
}
