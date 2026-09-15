// ---------------- 猫眼用户数据(D1 存储 + KV 会话键名) ----------------
// 用户状态(config/snapshot/changes/status/lock-rule/seatfb)已迁移 D1(见 db.js),
// KV 仅保留加密会话(maoyan-session)。userKey 现在只服务会话键名。

import { getConfig, deleteUserData } from "./db.js";

export function userKey(tokenId, name) {
  return tokenId ? `u:${tokenId}:${name}` : `shared:${name}`;
}

export async function getUserConfig(env, tokenId) {
  return (await getConfig(env.DB, tokenId)) || {};
}

// 令牌注销: 清 D1 全部用户状态行 + KV 加密会话
export async function cleanupUserData(env, tokenId) {
  await deleteUserData(env.DB, tokenId);
  try {
    await env.MAOYAN_KV.delete(userKey(tokenId, "maoyan-session"));
  } catch (e) {
  }
}
