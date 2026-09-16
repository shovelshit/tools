// ---------------- KV → D1 一次性迁移 ----------------
// 管理端点 POST /api/admin/migrate-kv-to-d1 触发。设计原则:
//   - 全程 UPSERT: 重复执行幂等(change_log 按 token 整段替换), 不会产生重复行;
//   - 不删任何 KV 数据: 回滚 = 重新部署 KV 版(main 分支), 数据无损;
//   - maoyan-session 加密信封与 cache:cinemas:* 缓存不迁移(继续留在 KV)。

import * as db from "./db.js";
import { importLegacyAccount } from "./account-migration.js";

const USER_KEY = /^u:([^:]+):(.+)$/;

// KV changes 数组新在前, 迁移时原样交给 replaceChanges(内部会反转插入, 保持 id 顺序一致)
async function migrateUserKey(env, summary, key, value) {
  const match = USER_KEY.exec(key);
  if (!match) return;
  const [, tokenId, name] = match;
  const parsed = JSON.parse(value);
  switch (name) {
    case "config":
      await db.putConfig(env.DB, tokenId, parsed);
      summary.configs += 1;
      break;
    case "status":
      await db.putStatus(env.DB, tokenId, parsed);
      summary.statuses += 1;
      break;
    case "snapshot":
      await db.saveSnapshot(env.DB, tokenId, parsed);
      summary.snapshots += Object.keys(parsed || {}).length;
      break;
    case "changes":
      await db.replaceChanges(env.DB, tokenId, Array.isArray(parsed) ? parsed : []);
      summary.changes += Array.isArray(parsed) ? parsed.length : 0;
      break;
    case "maoyan-lock-rule":
      await db.putLockRuleRow(env.DB, tokenId, parsed);
      summary.lockRules += 1;
      break;
    default:
      break; // maoyan-session 等留在 KV, 不迁移
  }
}

export async function migrateKvToD1(env) {
  if (!env.DB) throw new Error("未绑定 D1 数据库(DB), 请先完成 wrangler d1 建库与绑定");
  const summary = { tokens: 0, configs: 0, statuses: 0, snapshots: 0, changes: 0, lockRules: 0, seatFeedback: 0 };

  // 1) 令牌注册表
  const tokens = await env.MAOYAN_KV.get("meta:tokens", "json");
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token || !token.id || !token.token) continue;
    const accountImport = await importLegacyAccount(env, token);
    if (accountImport.accountMigrationApplied) {
      if (accountImport.imported) summary.tokens += 1;
    } else {
      await db.upsertToken(env.DB, token);
      summary.tokens += 1;
    }
  }

  // 2) 用户状态(u:{tokenId}:{name})
  let cursor;
  const userKeys = [];
  do {
    const page = await env.MAOYAN_KV.list({ prefix: "u:", cursor });
    for (const item of page.keys || []) userKeys.push(item.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  for (const key of userKeys) {
    const value = await env.MAOYAN_KV.get(key);
    if (value !== null) await migrateUserKey(env, summary, key, value);
  }

  // 3) 座位反馈(seatfb:*)
  const feedbackKeys = [];
  cursor = null;
  do {
    const page = await env.MAOYAN_KV.list({ prefix: "seatfb:", cursor });
    for (const item of page.keys || []) feedbackKeys.push(item.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  for (const key of feedbackKeys) {
    const record = await env.MAOYAN_KV.get(key, "json");
    if (record) {
      await db.putSeatFeedbackRow(env.DB, key, record);
      summary.seatFeedback += 1;
    }
  }

  return summary;
}
