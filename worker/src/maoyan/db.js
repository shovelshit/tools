// ---------------- D1 数据访问层(用户状态全链路) ----------------
// 所有用户运行状态(config/status/snapshot/changes/seatfb/lock-rule)存 D1;
// KV 仅保留 maoyan-session 加密会话与 cache:cinemas:* 影院缓存(见 api.js/lock-session.js)。
// 约定:
//   - 函数首参一律是 D1 数据库实例(env.DB), 与 env 解耦, 便于测试替身;
//   - 写入一律 UPSERT, 使 KV→D1 迁移端点可重复执行(幂等);
//   - API 返回形状与 KV 版完全一致(changes 仍返回最新 100 条、新在前)。

function nowIso() {
  return new Date().toISOString();
}

function configData(config) {
  const data = { ...(config || {}) };
  delete data.version;
  return data;
}

// ---------- config(每令牌一行 JSON) ----------

export async function getConfig(db, tokenId) {
  const row = await db.prepare("SELECT data,version FROM user_config WHERE token_id = ?").bind(tokenId).first();
  return row ? { ...JSON.parse(row.data), version: Number(row.version) } : null;
}

export async function getConfigRecord(db, tokenId) {
  const row = await db.prepare("SELECT data,version FROM user_config WHERE token_id = ?").bind(tokenId).first();
  return row ? { raw: row.data, config: { ...JSON.parse(row.data), version: Number(row.version) } } : null;
}

export async function putConfig(db, tokenId, config) {
  await db.prepare(
    "INSERT INTO user_config (token_id, data, updated_at, version) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT(token_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, version=user_config.version+1"
  ).bind(tokenId, JSON.stringify(configData(config)), nowIso()).run();
}

export async function putConfigVersioned(db, tokenId, config, expectedVersion) {
  const expected = Number(expectedVersion);
  const result = await db.prepare(
    "UPDATE user_config SET data=?,updated_at=?,version=version+1 WHERE token_id=? AND version=?"
  ).bind(JSON.stringify(configData(config)), nowIso(), tokenId, expected).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const error = new Error("配置已在其他设备更新，请刷新后重试");
    error.code = "CONFIG_CONFLICT";
    throw error;
  }
  return { ...configData(config), version: expected + 1 };
}

export async function replaceConfigIfUnchanged(db, tokenId, expectedRaw, config) {
  return await db.prepare(
    "UPDATE user_config SET data=?,updated_at=?,version=version+1 WHERE token_id=? AND data=?"
  ).bind(JSON.stringify(configData(config)), nowIso(), tokenId, expectedRaw).run();
}

export async function deleteConfig(db, tokenId) {
  await db.prepare("DELETE FROM user_config WHERE token_id = ?").bind(tokenId).run();
}

// ---------- encrypted session version pointer (payload remains in KV) ----------

export async function getSessionVersion(db, tokenId) {
  const row = await db.prepare(
    "SELECT active_version,updated_at FROM session_versions WHERE user_id=? AND active=1"
  ).bind(tokenId).first();
  return row ? { activeVersion: Number(row.active_version), updatedAt: Number(row.updated_at) } : null;
}

export async function activateSessionVersion(db, tokenId, version, previousVersion, nowMs = Date.now()) {
  if (previousVersion == null) {
    return await db.prepare(
      "INSERT INTO session_versions(user_id,active_version,active,updated_at) VALUES (?,?,1,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET active_version=excluded.active_version,active=1,updated_at=excluded.updated_at " +
      "WHERE session_versions.active=0"
    ).bind(tokenId, version, nowMs).run();
  }
  return await db.prepare(
    "UPDATE session_versions SET active_version=?,active=1,updated_at=? WHERE user_id=? AND active_version=? AND active=1"
  ).bind(version, nowMs, tokenId, previousVersion).run();
}

export async function deleteSessionVersion(db, tokenId, expectedVersion) {
  return await db.prepare(
    "DELETE FROM session_versions WHERE user_id=? AND active_version=? AND active=1"
  ).bind(tokenId, expectedVersion).run();
}

// ---------- revoked-session KV cleanup retry ledger ----------

export function enqueueRevocationCleanupStatement(db, userId, nowMs) {
  return db.prepare(
    "INSERT INTO revocation_cleanup(user_id,created_at,attempt_count,last_attempt_at,last_error) VALUES (?,?,0,NULL,NULL) " +
    "ON CONFLICT(user_id) DO NOTHING"
  ).bind(userId, nowMs);
}

export async function enqueueRevocationCleanupKey(db, userId, sessionKey, nowMs) {
  await db.batch([
    enqueueRevocationCleanupStatement(db, userId, nowMs),
    db.prepare(
      "INSERT INTO revocation_cleanup_keys(user_id,session_key) VALUES (?,?) ON CONFLICT(user_id,session_key) DO NOTHING"
    ).bind(userId, sessionKey)
  ]);
}

// Revocation is terminal, so a pointer CAS miss can safely classify it here.
export async function isAccountRevoked(db, userId) {
  const account = await db.prepare("SELECT state FROM users WHERE id=?").bind(userId).first();
  return account?.state === "revoked";
}

// Reserve the exact KV key before it is written. A revocation transaction
// promotes reservations to durable cleanup children before clearing pointers.
export async function reservePendingSessionSave(db, userId, sessionKey) {
  return await db.prepare(
    "INSERT INTO pending_session_saves(user_id,session_key,reservation_count) SELECT ?,?,1 " +
    "WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=? AND state='revoked') " +
    "ON CONFLICT(user_id,session_key) DO NOTHING"
  ).bind(userId, sessionKey, userId).run();
}

export async function retainPendingSessionSave(db, userId, sessionKey) {
  return await db.prepare(
    "INSERT INTO pending_session_saves(user_id,session_key,reservation_count) SELECT ?,?,1 " +
    "WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=? AND state='revoked') " +
    "ON CONFLICT(user_id,session_key) DO UPDATE SET reservation_count=pending_session_saves.reservation_count+1"
  ).bind(userId, sessionKey, userId).run();
}

export async function completePendingSessionSave(db, userId, sessionKey) {
  await db.batch([
    db.prepare(
      "DELETE FROM pending_session_saves WHERE user_id=? AND session_key=? AND reservation_count=1"
    ).bind(userId, sessionKey),
    db.prepare(
      "UPDATE pending_session_saves SET reservation_count=reservation_count-1 " +
      "WHERE user_id=? AND session_key=? AND reservation_count>1"
    ).bind(userId, sessionKey)
  ]);
}

export function promotePendingSessionSavesStatements(db, userId) {
  return [
    db.prepare(
      "INSERT INTO revocation_cleanup_keys(user_id,session_key) " +
      "SELECT user_id,session_key FROM pending_session_saves WHERE user_id=? " +
      "ON CONFLICT(user_id,session_key) DO NOTHING"
    ).bind(userId),
    db.prepare("DELETE FROM pending_session_saves WHERE user_id=?").bind(userId)
  ];
}

export function captureActiveSessionForRevocationStatement(db, userId) {
  return db.prepare(
    "INSERT INTO revocation_cleanup_keys(user_id,session_key) " +
    "SELECT user_id,'u:' || user_id || ':maoyan-session:v' || active_version " +
    "FROM session_versions WHERE user_id=? AND active=1 " +
    "ON CONFLICT(user_id,session_key) DO NOTHING"
  ).bind(userId);
}

export async function listRevocationCleanups(db, limit = 100) {
  const { results } = await db.prepare(
    "SELECT user_id FROM revocation_cleanup ORDER BY created_at ASC LIMIT ?"
  ).bind(Math.min(100, Math.max(1, Number(limit) || 100))).all();
  return results.map((row) => String(row.user_id));
}

export async function listRevocationCleanupKeys(db, userId) {
  const { results } = await db.prepare(
    "SELECT session_key FROM revocation_cleanup_keys WHERE user_id=?"
  ).bind(userId).all();
  return results.map((row) => String(row.session_key));
}

export async function recordRevocationCleanupAttempt(db, userId, nowMs, error) {
  await db.prepare(
    "UPDATE revocation_cleanup SET attempt_count=attempt_count+1,last_attempt_at=?,last_error=? WHERE user_id=?"
  ).bind(nowMs, error, userId).run();
}

export async function completeRevocationCleanup(db, userId, sessionKeys) {
  const statements = sessionKeys.map((sessionKey) => db.prepare(
    "DELETE FROM revocation_cleanup_keys WHERE user_id=? AND session_key=?"
  ).bind(userId, sessionKey));
  statements.push(db.prepare(
    "DELETE FROM revocation_cleanup WHERE user_id=? AND NOT EXISTS (" +
    "SELECT 1 FROM revocation_cleanup_keys WHERE user_id=?)"
  ).bind(userId, userId));
  await db.batch(statements);
}

// ---------- status(每令牌一行 JSON, 字段与 KV 版一致) ----------

export async function getStatus(db, tokenId) {
  const row = await db.prepare("SELECT data FROM monitor_status WHERE token_id = ?").bind(tokenId).first();
  return row ? JSON.parse(row.data) : null;
}

export async function putStatus(db, tokenId, status) {
  await db.prepare(
    "INSERT INTO monitor_status (token_id, data, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(token_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(tokenId, JSON.stringify(status), nowIso()).run();
}

export async function deleteStatus(db, tokenId) {
  await db.prepare("DELETE FROM monitor_status WHERE token_id = ?").bind(tokenId).run();
}

// ---------- snapshot(按影片一行; 上游消失的影片旧行保留, 与 KV 版语义一致) ----------

export async function getSnapshot(db, tokenId) {
  const { results } = await db.prepare("SELECT movie_id, seq_nos FROM monitor_snapshot WHERE token_id = ?").bind(tokenId).all();
  const snapshot = {};
  for (const row of results) snapshot[row.movie_id] = JSON.parse(row.seq_nos);
  return snapshot;
}

export async function saveSnapshot(db, tokenId, snapshot) {
  const ts = nowIso();
  for (const [movieId, seqNos] of Object.entries(snapshot)) {
    await db.prepare(
      "INSERT INTO monitor_snapshot (token_id, movie_id, seq_nos, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(token_id, movie_id) DO UPDATE SET seq_nos = excluded.seq_nos, updated_at = excluded.updated_at"
    ).bind(tokenId, movieId, JSON.stringify(seqNos), ts).run();
  }
}

// 切影院时整份快照作废(与 KV 版 delete 行为一致)
export async function deleteSnapshot(db, tokenId) {
  await db.prepare("DELETE FROM monitor_snapshot WHERE token_id = ?").bind(tokenId).run();
}

// ---------- changes(追加式全量历史; 读取最新 N 条, 新在前) ----------

export async function listChanges(db, tokenId, limit = 100) {
  const { results } = await db.prepare(
    "SELECT time, type, text FROM change_log WHERE token_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(tokenId, limit).all();
  return results.map((row) => ({ time: row.time, type: row.type, text: row.text }));
}

export async function listChangesAfter(db, tokenId, { afterId, beforeId, limit = 20 } = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const after = afterId == null ? null : Number(afterId);
  const before = beforeId == null ? null : Number(beforeId);
  let results;
  if (Number.isInteger(after) && after >= 0) {
    ({ results } = await db.prepare(
      "SELECT id,time,type,text FROM change_log WHERE token_id=? AND id>? ORDER BY id ASC LIMIT ?"
    ).bind(tokenId, after, pageSize + 1).all());
  } else if (Number.isInteger(before) && before > 0) {
    ({ results } = await db.prepare(
      "SELECT id,time,type,text FROM change_log WHERE token_id=? AND id<? ORDER BY id DESC LIMIT ?"
    ).bind(tokenId, before, pageSize + 1).all());
    results = results.reverse();
  } else {
    ({ results } = await db.prepare(
      "SELECT id,time,type,text FROM change_log WHERE token_id=? ORDER BY id DESC LIMIT ?"
    ).bind(tokenId, pageSize + 1).all());
    results = results.reverse();
  }
  const hasMore = results.length > pageSize;
  if (hasMore) {
    if (after != null) results = results.slice(0, pageSize);
    else results = results.slice(results.length - pageSize);
  }
  const items = results.map((row) => ({
    id: Number(row.id), time: row.time, type: row.type, text: row.text
  }));
  return {
    items,
    nextAfterId: items.length ? items.at(-1).id : (after || null),
    nextBeforeId: items.length ? items[0].id : (before || null),
    hasMore
  };
}

export async function appendChange(db, tokenId, entry) {
  await db.prepare("INSERT INTO change_log (token_id, time, type, text) VALUES (?, ?, ?, ?)")
    .bind(tokenId, entry.time, entry.type ?? null, entry.text ?? null).run();
}

// 错误节流需要最近一条记录(与 KV 版 changes[0] 等价)
export async function getLatestChange(db, tokenId) {
  return await db.prepare("SELECT time, type, text FROM change_log WHERE token_id = ? ORDER BY id DESC LIMIT 1")
    .bind(tokenId).first();
}

// 迁移用: 整段替换某令牌的变化历史(entries 新在前, 与 KV 数组顺序一致)
export async function replaceChanges(db, tokenId, entries) {
  await db.prepare("DELETE FROM change_log WHERE token_id = ?").bind(tokenId).run();
  // 逆序插入: entries[0] 最新 → 最后插入 → id 最大, ORDER BY id DESC 即"新在前"
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] || {};
    await db.prepare("INSERT INTO change_log (token_id, time, type, text) VALUES (?, ?, ?, ?)")
      .bind(tokenId, entry.time || null, entry.type ?? null, entry.text ?? null).run();
  }
}

// ---------- 座位解析失败反馈(原 KV key 作主键) ----------

export async function getSeatFeedbackRow(db, key) {
  return await db.prepare(
    "SELECT fb_key, reported_at, day, token_id, cinema_id, movie_id, seq_no, source FROM seat_feedback WHERE fb_key = ?"
  ).bind(key).first();
}

export async function putSeatFeedbackRow(db, key, record) {
  await db.prepare(
    "INSERT INTO seat_feedback (fb_key, reported_at, day, token_id, cinema_id, movie_id, seq_no, source) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(fb_key) DO UPDATE SET reported_at = excluded.reported_at, day = excluded.day, " +
    "token_id = excluded.token_id, cinema_id = excluded.cinema_id, movie_id = excluded.movie_id, " +
    "seq_no = excluded.seq_no, source = excluded.source"
  ).bind(
    key, record.reportedAt, record.day || null, record.tokenId || null, record.cinemaId || null,
    record.movieId || null, record.seqNo || null, record.source || null
  ).run();
}

// 管理端列表: 形状与 KV 版一致 {key, reportedAt, day, tokenId, cinemaId, movieId, seqNo, source}, 按 reportedAt 倒序
export async function listSeatFeedbackRows(db) {
  const { results } = await db.prepare(
    "SELECT fb_key, reported_at, day, token_id, cinema_id, movie_id, seq_no, source " +
    "FROM seat_feedback ORDER BY reported_at DESC"
  ).all();
  return results.map((row) => ({
    key: row.fb_key,
    reportedAt: row.reported_at,
    day: row.day,
    tokenId: row.token_id,
    cinemaId: row.cinema_id,
    movieId: row.movie_id,
    seqNo: row.seq_no,
    source: row.source
  }));
}

export async function deleteSeatFeedbackRow(db, key) {
  await db.prepare("DELETE FROM seat_feedback WHERE fb_key = ?").bind(key).run();
}

// ---------- 锁座规则(每令牌一行 JSON 状态机) ----------

export async function getLockRuleRow(db, tokenId) {
  const row = await db.prepare("SELECT data FROM lock_rule WHERE token_id = ?").bind(tokenId).first();
  return row ? JSON.parse(row.data) : null;
}

export async function putLockRuleRow(db, tokenId, rule) {
  await db.prepare(
    "INSERT INTO lock_rule (token_id, data, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(token_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(tokenId, JSON.stringify(rule), nowIso()).run();
}

export async function deleteLockRuleRow(db, tokenId) {
  await db.prepare("DELETE FROM lock_rule WHERE token_id = ?").bind(tokenId).run();
}

// ---------- 令牌注销: 清空该令牌全部 D1 运行时行 ----------
// users/access_keys/audit_events 是生命周期记录，明确保留。KV 会话由 user.js 负责。

export function deleteUserDataStatements(db, tokenId) {
  return [
    db.prepare("DELETE FROM notification_outbox WHERE user_id = ?").bind(tokenId),
    db.prepare("DELETE FROM monitor_subscriptions WHERE user_id = ?").bind(tokenId),
    db.prepare("DELETE FROM user_config WHERE token_id = ?").bind(tokenId),
    db.prepare("DELETE FROM monitor_status WHERE token_id = ?").bind(tokenId),
    db.prepare("DELETE FROM monitor_snapshot WHERE token_id = ?").bind(tokenId),
    db.prepare("DELETE FROM change_log WHERE token_id = ?").bind(tokenId),
    db.prepare("DELETE FROM lock_rule WHERE token_id = ?").bind(tokenId),
    db.prepare("DELETE FROM session_versions WHERE user_id = ?").bind(tokenId),
    db.prepare("DELETE FROM store_sessions WHERE user_id = ?").bind(tokenId)
  ];
}

export async function deleteUserData(db, tokenId) {
  await db.batch(deleteUserDataStatements(db, tokenId));
}
