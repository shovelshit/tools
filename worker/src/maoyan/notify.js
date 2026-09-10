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

export async function pushNotify(cfg, title, content) {
  const channelId = currentChannel(cfg);
  return sendNotify(channelId, (cfg || {})[CREDENTIAL_FIELD[channelId]], title, content);
}
