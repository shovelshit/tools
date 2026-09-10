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
export async function handleStoreFile(url) {
  const fileUrl = url.searchParams.get("url") || "";
  if (!/^http:\/\//i.test(fileUrl)) return json({ error: "仅支持代理 http 直链" }, 400);
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
