// ---------------- 通用消息推送渠道 ----------------
// 与具体业务无关: 只负责把 (标题, 内容) 发到某个渠道
// 用哪个渠道、凭据从哪读取, 由业务模块(如 maoyan)自己决定

function providerError(channel, response) {
  const error = new Error(`${channel} 推送失败: HTTP ${response.status}`);
  if (response.status === 429) {
    const value = response.headers.get("Retry-After");
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = delay;
  }
  return error;
}

export async function pushBark(key, title, content, { fetchImpl = fetch } = {}) {
  let base = String(key || "").trim();
  if (!base) throw new Error("Bark 未配置");
  if (!/^https?:\/\//i.test(base)) base = "https://api.day.app/" + base;
  base = base.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}?group=maoyan`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw providerError("Bark", res);
  const data = await res.json().catch(() => null);
  if (!data || Number(data.code) !== 200) throw new Error("Bark 推送失败: 服务未接受消息");
}

export function serverChanEndpoint(key) {
  const sendKey = String(key || "").trim();
  if (!sendKey) throw new Error("Server酱 未配置");
  if (!/^[A-Za-z0-9_-]+$/.test(sendKey)) throw new Error("Server酱密钥格式无效");
  const match = /^sctp(\d+)t/.exec(sendKey);
  return match ? `https://${match[1]}.push.ft07.com/send/${sendKey}.send`
    : `https://sctapi.ftqq.com/${sendKey}.send`;
}

export async function pushServerChan(key, title, content, { fetchImpl = fetch } = {}) {
  const url = serverChanEndpoint(key);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp: content }),
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) throw providerError("Server酱", res);
  const data = await res.json().catch(() => null);
  if (!data || !(Number(data.code) === 0 || data.success === true)) throw new Error("Server酱 推送失败: 服务未接受消息");
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
