// ---------------- 猫眼用户数据(KV 键名隔离) ----------------
// 每个令牌独立数据空间: u:<fnv1a(token)>:<name>
// name: config(影院/推送配置) / snapshot(场次快照) / changes(变化记录) / status(检查状态)

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function userKey(token, name) {
  return token ? `u:${fnv1a(token)}:${name}` : `shared:${name}`;
}

export async function getUserConfig(env, token) {
  const key = userKey(token, "config");
  const cfg = await env.MAOYAN_KV.get(key, "json");
  return cfg || {};
}

// 删除令牌时级联清理其用户数据
export async function cleanupUserData(env, token) {
  for (const name of ["config", "snapshot", "changes", "status"]) {
    try {
      await env.MAOYAN_KV.delete(userKey(token, name));
    } catch (e) {
    }
  }
}
