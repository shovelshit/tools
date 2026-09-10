// ---------------- 通用消息推送渠道 ----------------
// 与具体业务无关: 只负责把 (标题, 内容) 发到某个渠道
// 用哪个渠道、凭据从哪读取, 由业务模块(如 maoyan)自己决定

export async function pushBark(key, title, content) {
  let base = String(key || "").trim();
  if (!base) throw new Error("Bark 未配置");
  if (!/^https?:\/\//i.test(base)) base = "https://api.day.app/" + base;
  base = base.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}?group=maoyan`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error("Bark 推送失败: HTTP " + res.status);
}

// Server酱(Server酱³): POST https://sctapi.ftqq.com/<SENDKEY>.send
export async function pushServerChan(key, title, content) {
  const sendKey = String(key || "").trim();
  if (!sendKey) throw new Error("Server酱 未配置");
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp: content }),
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) throw new Error("Server酱 推送失败: HTTP " + res.status);
  const data = await res.json().catch(() => ({}));
  if (data && data.code !== void 0 && Number(data.code) !== 0) {
    throw new Error("Server酱 推送失败: " + (data.message || data.error || data.code));
  }
}

export const NOTIFY_CHANNELS = {
  bark: { label: "Bark", send: pushBark },
  serverchan: { label: "Server酱", send: pushServerChan },
};

export function channelLabel(id) {
  return (NOTIFY_CHANNELS[id] || NOTIFY_CHANNELS.bark).label;
}

// 按渠道 id 发送, 凭据由调用方给出; 返回渠道名便于记录日志
export async function sendNotify(channelId, key, title, content) {
  const ch = NOTIFY_CHANNELS[channelId] || NOTIFY_CHANNELS.bark;
  const cred = String(key || "").trim();
  if (!cred) throw new Error(`${ch.label} 未配置`);
  await ch.send(cred, title, content);
  return ch.label;
}
