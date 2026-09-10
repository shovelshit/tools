// ---------------- 消息推送渠道 ----------------
// 支持 Bark 与 Server酱, 同一时刻只使用一个渠道(cfg.notifyChannel)

export async function pushBark(barkKey, title, content) {
  let base = String(barkKey || "").trim();
  if (!base) throw new Error("Bark 未配置");
  if (!/^https?:\/\//i.test(base)) base = "https://api.day.app/" + base;
  base = base.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}?group=maoyan`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error("Bark 推送失败: HTTP " + res.status);
}

// Server酱(Server酱³): POST https://sctapi.ftqq.com/<SENDKEY>.send
export async function pushServerChan(sendKey, title, content) {
  const key = String(sendKey || "").trim();
  if (!key) throw new Error("Server酱 未配置");
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
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

export const PUSH_CHANNELS = {
  bark: { label: "Bark", getKey: (cfg) => cfg.barkKey, send: pushBark },
  serverchan: { label: "Server酱", getKey: (cfg) => cfg.serverChanKey, send: pushServerChan },
};

// 旧配置只有 barkKey 没有 notifyChannel, 默认回落 bark
export function currentChannel(cfg) {
  const c = String((cfg && cfg.notifyChannel) || "").trim();
  return PUSH_CHANNELS[c] ? c : "bark";
}

export function channelLabel(key) {
  return (PUSH_CHANNELS[key] || PUSH_CHANNELS.bark).label;
}

export async function pushNotify(cfg, title, content) {
  const ch = currentChannel(cfg);
  const { getKey, send, label } = PUSH_CHANNELS[ch];
  const key = String(getKey(cfg) || "").trim();
  if (!key) throw new Error(`${label} 未配置`);
  await send(key, title, content);
  return label;
}
