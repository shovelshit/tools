// ---------------- D1 数据访问层(用户状态全链路) ----------------
// 所有用户状态(tokens/config/status/snapshot/changes/seatfb/lock-rule)存 D1;
// KV 仅保留 maoyan-session 加密会话与 cache:cinemas:* 影院缓存(见 api.js/lock-session.js)。
// 约定:
//   - 函数首参一律是 D1 数据库实例(env.DB), 与 env 解耦, 便于测试替身;
//   - 写入一律 UPSERT, 使 KV→D1 迁移端点可重复执行(幂等);
//   - API 返回形状与 KV 版完全一致(changes 仍返回最新 100 条、新在前)。

function nowIso() {
  return new Date().toISOString();
}

// ---------- tokens ----------

export async function listTokens(db) {
  const { results } = await db.prepare("SELECT id, token, remark, created_at FROM tokens ORDER BY rowid").all();
  return results.map((row) => ({ id: row.id, token: row.token, remark: row.remark || "", createdAt: row.created_at || null }));
}

export async function upsertToken(db, token) {
  await db.prepare(
    "INSERT INTO tokens (id, token, remark, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET token = excluded.token, remark = excluded.remark, created_at = excluded.created_at"
  ).bind(token.id, token.token, token.remark || "", token.createdAt || null).run();
}

// 管理端整表替换: 与 KV 版「读数组-改-整写」语义对齐, 保留传入顺序(rowid 自增)
export async function saveTokens(db, list) {
  await db.prepare("DELETE FROM tokens").run();
  for (const token of list) {
    await db.prepare("INSERT INTO tokens (id, token, remark, created_at) VALUES (?, ?, ?, ?)")
      .bind(token.id, token.token, token.remark || "", token.createdAt || null).run();
  }
}

// 鉴权点查: 每次请求按 token 精确取一行, 替代 KV 版全量读数组
export async function findTokenByToken(db, token) {
  if (!token) return null;
  return await db.prepare("SELECT id, token, remark, created_at FROM tokens WHERE token = ?").bind(String(token)).first();
}

export async function getAccountMigration(db, name = "accounts-v1") {
  return await db.prepare("SELECT name, activated_at FROM account_migrations WHERE name=?")
    .bind(name).first();
}

// ---------- config(每令牌一行 JSON) ----------

export async function getConfig(db, tokenId) {
  const row = await db.prepare("SELECT data FROM user_config WHERE token_id = ?").bind(tokenId).first();
  return row ? JSON.parse(row.data) : null;
}

export async function putConfig(db, tokenId, config) {
  await db.prepare(
    "INSERT INTO user_config (token_id, data, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(token_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(tokenId, JSON.stringify(config), nowIso()).run();
}

export async function deleteConfig(db, tokenId) {
  await db.prepare("DELETE FROM user_config WHERE token_id = ?").bind(tokenId).run();
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

// ---------- 令牌注销: 清空该令牌全部 D1 行 ----------
// KV 侧的 maoyan-session 清理由调用方(user.js cleanupUserData)负责

export async function deleteUserData(db, tokenId) {
  await db.prepare("DELETE FROM user_config WHERE token_id = ?").bind(tokenId).run();
  await db.prepare("DELETE FROM monitor_status WHERE token_id = ?").bind(tokenId).run();
  await db.prepare("DELETE FROM monitor_snapshot WHERE token_id = ?").bind(tokenId).run();
  await db.prepare("DELETE FROM change_log WHERE token_id = ?").bind(tokenId).run();
  await db.prepare("DELETE FROM lock_rule WHERE token_id = ?").bind(tokenId).run();
}
