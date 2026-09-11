// ---------------- 猫眼用户数据(KV 键名隔离) ----------------
// 每个令牌使用独立随机 namespace ID，避免散列碰撞与令牌重命名问题。

export function userKey(tokenId, name) {
  return tokenId ? `u:${tokenId}:${name}` : `shared:${name}`;
}

export async function getUserConfig(env, tokenId) {
  return (await env.MAOYAN_KV.get(userKey(tokenId, "config"), "json")) || {};
}

export async function cleanupUserData(env, tokenId) {
  for (const name of [
    "config", "snapshot", "changes", "status",
    "maoyan-session", "maoyan-lock-rule"
  ]) {
    try {
      await env.MAOYAN_KV.delete(userKey(tokenId, name));
    } catch (e) {
    }
  }
}
