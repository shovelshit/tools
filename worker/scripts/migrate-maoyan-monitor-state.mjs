import { hashCinemaData, normalizeCinemaData } from "../src/maoyan/monitor-store.js";

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

async function rows(DB, sql, ...params) {
  return (await DB.prepare(sql).bind(...params).all()).results || [];
}

/**
 * Copy the active user's latest public cinema state into the v2 state table.
 * Cron and dispatcher must be paused by the caller before invoking this function.
 */
export async function migrateActiveMonitorState(DB, { nowMs = Date.now(), userId = null } = {}) {
  const timestamp = Number(nowMs);
  const subscriptions = await rows(DB,
    "SELECT s.user_id,s.cinema_id,s.enabled,s.baseline_version " +
    "FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id " +
    "WHERE s.enabled=1 AND s.cinema_id<>'' AND u.business_line='maoyan' " +
    "AND u.role='user' AND u.state='active' AND u.archived_at IS NULL " +
    "AND (u.expires_at IS NULL OR u.expires_at>?) " +
    (userId == null ? "" : "AND s.user_id=?") +
    " ORDER BY s.user_id,s.cinema_id",
    ...(userId == null ? [timestamp] : [timestamp, String(userId)])
  );

  const cinemaIds = new Set();
  let resetBaselines = 0;
  let preservedOutbox = 0;
  for (const subscription of subscriptions) {
    const uid = String(subscription.user_id);
    const cinemaId = String(subscription.cinema_id);
    cinemaIds.add(cinemaId);
    const latest = await DB.prepare(
      "SELECT version,public_data,captured_at FROM cinema_batches " +
      "WHERE cinema_id=? AND status='committed' ORDER BY captured_at DESC,version DESC LIMIT 1"
    ).bind(cinemaId).first();

    if (latest) {
      const normalized = normalizeCinemaData(parseJson(latest.public_data));
      const version = Number(latest.version);
      await DB.prepare(
        "INSERT INTO cinema_state(" +
        "cinema_id,current_version,current_hash,current_data,run_state,completed_at,updated_at" +
        ") VALUES (?,?,?,?,?,?,?) ON CONFLICT(cinema_id) DO UPDATE SET " +
        "current_version=excluded.current_version,current_hash=excluded.current_hash," +
        "current_data=excluded.current_data,active_run_id=NULL,active_base_version=NULL," +
        "active_base_hash=NULL,active_data=NULL,active_version=NULL,run_state='completed'," +
        "subscriber_cursor=NULL,completed_at=excluded.completed_at,updated_at=excluded.updated_at"
      ).bind(cinemaId, version, hashCinemaData(normalized), JSON.stringify(normalized), "completed", Number(latest.captured_at), timestamp).run();
      const result = await DB.prepare(
        "UPDATE monitor_subscriptions SET baseline_version=?,last_run_id=NULL,updated_at=? " +
        "WHERE user_id=? AND cinema_id=? AND enabled=1"
      ).bind(version, timestamp, uid, cinemaId).run();
      if (Number(result?.meta?.changes || 0) > 0) resetBaselines += 1;
    } else {
      await DB.prepare(
        "INSERT INTO cinema_state(cinema_id,current_version,current_hash,current_data,run_state,updated_at) " +
        "VALUES (?,0,NULL,NULL,'idle',?) ON CONFLICT(cinema_id) DO UPDATE SET " +
        "current_version=0,current_hash=NULL,current_data=NULL,active_run_id=NULL," +
        "active_base_version=NULL,active_base_hash=NULL,active_data=NULL,active_version=NULL," +
        "run_state='idle',subscriber_cursor=NULL,completed_at=NULL,updated_at=excluded.updated_at"
      ).bind(cinemaId, timestamp).run();
      await DB.prepare(
        "UPDATE monitor_subscriptions SET baseline_version=NULL,last_run_id=NULL,updated_at=? " +
        "WHERE user_id=? AND cinema_id=? AND enabled=1"
      ).bind(timestamp, uid, cinemaId).run();
    }

    const pending = await DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id=? AND state IN ('pending','sending','failed')"
    ).bind(uid).first();
    preservedOutbox += Number(pending?.n || 0);
  }

  return {
    migratedUsers: new Set(subscriptions.map((row) => String(row.user_id))).size,
    migratedCinemas: cinemaIds.size,
    preservedOutbox,
    resetBaselines
  };
}

