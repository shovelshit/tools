// ---------------- store 工具页: AList API 反代 + http 文件代理 ----------------

import { CORS, json } from "../common/http.js";

const STORE_UPSTREAM = "http://appstore.cnmlynk.org";

// /store/api/* -> 上游 AList /api/* (隐藏真实地址, 统一 CORS)
export async function handleStoreApi(request, url) {
  try {
    const sub = url.pathname.slice("/store/api".length);
    const init = { method: request.method, headers: { "Content-Type": "application/json" } };
    if (request.method === "POST") init.body = await request.text();
    const res = await fetch(STORE_UPSTREAM + "/api" + sub, init);
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/json; charset=utf-8", ...CORS }
    });
  } catch (e) {
    return json({ ok: false, error: "AList 反代失败: " + e.message }, 502);
  }
}

// /store/file?url=... 代理 http 直链(解决 HTTPS 页面加载 HTTP 资源被拦)
// 安全限制: 仅允许上游 AList 域名的 http 直链, 防止被当作开放代理滥用
const FILE_PROXY_ALLOWED_HOSTS = new Set(["appstore.cnmlynk.org"]);

export async function handleStoreFile(url) {
  const fileUrl = url.searchParams.get("url") || "";
  let target;
  try {
    target = new URL(fileUrl);
  } catch (e) {
    return json({ error: "无效的 url 参数" }, 400);
  }
  if (target.protocol !== "http:" || !FILE_PROXY_ALLOWED_HOSTS.has(target.hostname)) {
    return json({ error: "仅支持代理上游 AList 域名的 http 直链" }, 403);
  }
  try {
    const res = await fetch(fileUrl, { redirect: "follow" });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": res.headers.get("content-disposition") || "",
        ...CORS
      }
    });
  } catch (e) {
    return json({ ok: false, error: "文件代理失败: " + e.message }, 502);
  }
}
