// ---------------- store 工具页: AList API 反代 + http 文件代理 ----------------

const STORE_UPSTREAM = "http://appstore.cnmlynk.org";
const STORE_HOST = "appstore.cnmlynk.org";
const MAX_REDIRECTS = 5;

function isAllowedStoreUrl(value) {
  const target = new URL(value);
  return (target.protocol === "http:" || target.protocol === "https:") && target.hostname === STORE_HOST;
}

async function fetchStore(url, init = {}) {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    if (!isAllowedStoreUrl(current)) throw new Error("上游重定向到了不受信任的地址");
    const response = await fetch(current, { ...init, redirect: "manual", signal: AbortSignal.timeout(15e3) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("上游返回了无目标的重定向");
    current = new URL(location, current).href;
  }
  throw new Error("上游重定向超过限制");
}

function storeError(message, status = 502) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

// /store/api/* -> 上游 AList /api/* (隐藏真实地址, 仅允许同源 Store 会话访问)
export async function handleStoreApi(request, url) {
  try {
    const sub = url.pathname.slice("/store/api".length);
    const init = { method: request.method, headers: { "Content-Type": "application/json" } };
    if (request.method === "POST") init.body = await request.text();
    const res = await fetchStore(STORE_UPSTREAM + "/api" + sub, init);
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") || "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (e) {
    return storeError("AList 反代失败: " + e.message);
  }
}

// /store/file?url=... 代理上游直链，所有预览和下载继续受 Store 会话保护。
// 安全限制: 仅允许上游 AList 域名的 http/https 直链, 防止被当作开放代理滥用
const FILE_PROXY_ALLOWED_HOSTS = new Set(["appstore.cnmlynk.org"]);

export async function handleStoreFile(url) {
  const fileUrl = url.searchParams.get("url") || "";
  let target;
  try {
    target = new URL(fileUrl);
  } catch (e) {
    return storeError("无效的 url 参数", 400);
  }
  if (!isAllowedStoreUrl(target.href) || !FILE_PROXY_ALLOWED_HOSTS.has(target.hostname)) {
    return storeError("仅支持代理上游 AList 域名的直链", 403);
  }
  try {
    const res = await fetchStore(target.href);
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": res.headers.get("content-disposition") || "",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (e) {
    return storeError("文件代理失败: " + e.message);
  }
}
