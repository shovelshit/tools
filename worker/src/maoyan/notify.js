// ---------------- 猫眼: 推送渠道适配 ----------------
// 渠道实现在 common/notify.js(与业务无关)
// 这里只做一件事: 把用户配置映射成 (渠道 id, 凭据)

import { NOTIFY_CHANNELS, sendNotify } from "../common/notify.js";

// 各渠道凭据在用户配置里的字段名
const CREDENTIAL_FIELD = {
  bark: "barkKey",
  serverchan: "serverChanKey",
};

// 旧配置只有 barkKey 没有 notifyChannel, 默认回落 bark
export function currentChannel(cfg) {
  const c = String((cfg && cfg.notifyChannel) || "").trim();
  return NOTIFY_CHANNELS[c] ? c : "bark";
}

export function currentCredential(cfg) {
  const channelId = currentChannel(cfg);
  return String((cfg || {})[CREDENTIAL_FIELD[channelId]] || "").trim();
}

async function credentialFingerprint(channelId, credential) {
  if (!credential) return "";
  const data = new TextEncoder().encode(`${channelId}\u0000${credential}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function isNotificationVerified(cfg) {
  const channelId = currentChannel(cfg);
  const fingerprint = await credentialFingerprint(channelId, currentCredential(cfg));
  return Boolean(
    fingerprint &&
    cfg?.notifyVerification?.channel === channelId &&
    cfg.notifyVerification.fingerprint === fingerprint
  );
}

export async function notificationVerification(cfg) {
  const channelId = currentChannel(cfg);
  const fingerprint = await credentialFingerprint(channelId, currentCredential(cfg));
  if (!fingerprint) throw new Error(`${NOTIFY_CHANNELS[channelId].label} 未配置`);
  return { channel: channelId, fingerprint, testedAt: new Date().toISOString() };
}

export async function pushNotify(cfg, title, content) {
  const channelId = currentChannel(cfg);
  return sendNotify(channelId, (cfg || {})[CREDENTIAL_FIELD[channelId]], title, content);
}
