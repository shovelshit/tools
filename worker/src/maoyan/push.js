// ---------------- Bark 推送 ----------------

export async function pushBark(barkKey, title, content) {
  let base = String(barkKey || "").trim();
  if (!base) throw new Error("Bark 未配置");
  if (!/^https?:\/\//i.test(base)) base = "https://api.day.app/" + base;
  base = base.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}?group=maoyan`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error("Bark 推送失败: HTTP " + res.status);
}
