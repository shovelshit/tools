const DEFAULT_BATCH_MS = 3 * 60 * 1000;

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
}

function movieMap(data) {
  const map = new Map();
  for (const movie of data?.showData?.movies || []) {
    const shows = [];
    for (const day of movie.shows || []) {
      for (const show of day.plist || []) {
        if (show?.seqNo === undefined || show?.seqNo === null) continue;
        shows.push({
          seqNo: String(show.seqNo),
          showDate: String(day.showDate || day.dt || show.dt || ""),
          tm: String(show.tm || ""),
          th: String(show.th || ""),
          lang: String(show.lang || ""),
          tp: String(show.tp || ""),
          ticketStatus: Number.isFinite(Number(show.ticketStatus)) ? Number(show.ticketStatus) : null
        });
      }
    }
    const unique = new Map(shows.map((show) => [show.seqNo, show]));
    map.set(String(movie.id), {
      movieId: String(movie.id),
      movieName: String(movie.nm || ""),
      shows: [...unique.values()],
      seqNos: [...unique.keys()]
    });
  }
  return map;
}

function safeCinemaData(data) {
  const movies = [];
  for (const movie of movieMap(data).values()) {
    const days = new Map();
    for (const show of movie.shows) {
      const day = show.showDate || "";
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ ...show });
    }
    movies.push({
      id: movie.movieId,
      nm: movie.movieName,
      shows: [...days].map(([showDate, plist]) => ({ showDate, plist }))
    });
  }
  return { showData: { cinemaName: String(data?.showData?.cinemaName || ""), movies } };
}

function snapshotMap(rows) {
  return new Map(rows.map((row) => {
    const seqNos = JSON.parse(row.seq_nos || "[]").map(String);
    return [String(row.movie_id), {
      movieId: String(row.movie_id), movieName: String(row.movie_name || ""), seqNos,
      shows: seqNos.map((seqNo) => ({ seqNo }))
    }];
  }));
}

function compareMaps(previous, current) {
  const changedMovieIds = [];
  const additions = [];
  for (const [movieId, movie] of current) {
    const prior = previous.get(movieId);
    if (!prior) {
      changedMovieIds.push(movieId);
      continue;
    }
    const before = new Set(prior.seqNos.map(String));
    const after = new Set(movie.seqNos.map(String));
    const added = movie.shows.filter((show) => !before.has(String(show.seqNo)));
    if (added.length || [...before].some((seqNo) => !after.has(seqNo))) changedMovieIds.push(movieId);
    if (added.length) additions.push({ movieId, movieName: movie.movieName, shows: added });
  }
  return { changedMovieIds, additions };
}

export function diffCinemaSnapshot(previous, current) {
  return compareMaps(movieMap(previous), movieMap(current));
}

export async function syncSubscription(DB, userId, config, configVersion, nowMs = Date.now()) {
  const cinemaId = String(config?.cinemaId || "").trim();
  const enabled = config?.enabled === true && Boolean(cinemaId) ? 1 : 0;
  const version = Number(configVersion);
  const current = await DB.prepare(
    "SELECT cinema_id,enabled,config_version,baseline_version,next_due_at FROM monitor_subscriptions WHERE user_id=?"
  ).bind(userId).first();
  const resetBaseline = !current || current.cinema_id !== cinemaId || Number(current.enabled) !== enabled;
  await DB.prepare(
    "INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,baseline_version,next_due_at,updated_at) " +
    "SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND business_line='maoyan') " +
    "ON CONFLICT(user_id) DO UPDATE SET cinema_id=excluded.cinema_id,enabled=excluded.enabled," +
    "config_version=excluded.config_version,baseline_version=excluded.baseline_version," +
    "next_due_at=excluded.next_due_at,updated_at=excluded.updated_at"
  ).bind(
    userId, cinemaId, enabled, version,
    resetBaseline ? null : current.baseline_version,
    enabled ? Number(nowMs) : Number(current?.next_due_at || nowMs),
    Number(nowMs), userId
  ).run();
  return {
    userId, cinemaId, enabled: enabled === 1, configVersion: version,
    baselineVersion: resetBaseline ? null : (current?.baseline_version == null ? null : Number(current.baseline_version)),
    nextDueAt: enabled ? Number(nowMs) : Number(current?.next_due_at || nowMs)
  };
}

export async function saveConfigWithSubscription(DB, {
  userId, storedConfig, config, expectedVersion, nowMs = Date.now()
}) {
  const configRow = await DB.prepare("SELECT version FROM user_config WHERE token_id=?").bind(userId).first();
  const currentVersion = configRow ? Number(configRow.version) : 0;
  const expected = expectedVersion === undefined ? currentVersion : Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 0) {
    const error = new Error("配置版本无效");
    error.code = "CONFIG_CONFLICT";
    throw error;
  }
  const subscription = await DB.prepare(
    "SELECT cinema_id,enabled,baseline_version,next_due_at FROM monitor_subscriptions WHERE user_id=?"
  ).bind(userId).first();
  const cinemaId = String(config?.cinemaId || "").trim();
  const enabled = config?.enabled === true && Boolean(cinemaId) ? 1 : 0;
  const resetBaseline = !subscription || subscription.cinema_id !== cinemaId || Number(subscription.enabled) !== enabled;
  const nextVersion = expected === 0 ? 1 : expected + 1;
  const requestId = `config:${userId}:${expected}:${crypto.randomUUID()}`;
  const statements = [
    DB.prepare(
      "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=?) " +
      "AND ((?=0 AND NOT EXISTS (SELECT 1 FROM user_config WHERE token_id=?)) OR " +
      "EXISTS (SELECT 1 FROM user_config WHERE token_id=? AND version=?)) THEN 1 ELSE 0 END)"
    ).bind(requestId, userId, expected, userId, userId, expected),
    DB.prepare(
      "INSERT INTO user_config(token_id,data,updated_at,version) VALUES (?,?,?,?) " +
      "ON CONFLICT(token_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,version=excluded.version"
    ).bind(userId, JSON.stringify(storedConfig || {}), new Date(nowMs).toISOString(), nextVersion),
    DB.prepare(
      "INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,baseline_version,next_due_at,updated_at) " +
      "VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET cinema_id=excluded.cinema_id," +
      "enabled=excluded.enabled,config_version=excluded.config_version,baseline_version=excluded.baseline_version," +
      "next_due_at=excluded.next_due_at,updated_at=excluded.updated_at"
    ).bind(
      userId, cinemaId, enabled, nextVersion,
      resetBaseline ? null : subscription.baseline_version,
      enabled ? Number(nowMs) : Number(subscription?.next_due_at || nowMs), Number(nowMs)
    ),
    DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId)
  ];
  try {
    await DB.batch(statements);
  } catch (error) {
    if (/mutation_guards\.ok|CHECK constraint failed: ok = 1/.test(String(error?.message || error))) {
      const conflict = new Error("配置已在其他设备更新，请刷新后重试");
      conflict.code = "CONFIG_CONFLICT";
      throw conflict;
    }
    throw error;
  }
  return { ...(storedConfig || {}), version: nextVersion };
}

export async function listDueCinemas(DB, { nowMs = Date.now(), afterCinemaId = "", limit = 20 } = {}) {
  const pageSize = clampLimit(limit, 20, 20);
  const { results } = await DB.prepare(
    "SELECT DISTINCT s.cinema_id FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id " +
    "WHERE s.enabled=1 AND s.next_due_at<=? AND s.cinema_id>? AND u.state='active' " +
    "AND u.business_line='maoyan' AND (u.role='admin' OR u.expires_at>?) ORDER BY s.cinema_id LIMIT ?"
  ).bind(Number(nowMs), String(afterCinemaId || ""), Number(nowMs), pageSize + 1).all();
  const items = results.slice(0, pageSize).map((row) => String(row.cinema_id));
  return { items, nextCursor: results.length > pageSize ? items.at(-1) : null };
}

export async function listSubscribers(DB, { cinemaId, afterUserId = "", limit = 10, nowMs = Date.now() } = {}) {
  const pageSize = clampLimit(limit, 10, 10);
  const { results } = await DB.prepare(
    "SELECT s.user_id,s.cinema_id,s.enabled,s.config_version,s.baseline_version,s.next_due_at,c.data,l.data AS lock_data " +
    "FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id " +
    "JOIN user_config c ON c.token_id=s.user_id AND c.version=s.config_version " +
    "LEFT JOIN lock_rule l ON l.token_id=s.user_id " +
    "WHERE s.cinema_id=? AND s.enabled=1 AND s.next_due_at<=? AND s.user_id>? AND u.state='active' " +
    "AND u.business_line='maoyan' AND (u.role='admin' OR u.expires_at>?) ORDER BY s.user_id LIMIT ?"
  ).bind(String(cinemaId), Number(nowMs), String(afterUserId || ""), Number(nowMs), pageSize + 1).all();
  const items = results.slice(0, pageSize).map((row) => {
    let config = {};
    try { config = JSON.parse(row.data || "{}"); } catch {}
    return {
      userId: row.user_id, cinemaId: row.cinema_id, enabled: Number(row.enabled) === 1,
      configVersion: Number(row.config_version),
      baselineVersion: row.baseline_version == null ? null : Number(row.baseline_version),
      nextDueAt: Number(row.next_due_at), config,
      lockRule: (() => { try { return row.lock_data ? JSON.parse(row.lock_data) : null; } catch { return null; } })()
    };
  });
  return { items, nextCursor: results.length > pageSize ? items.at(-1)?.userId || null : null };
}

export async function getCommittedCinemaBatch(DB, cinemaId, batchId) {
  const batch = await DB.prepare(
    "SELECT version,public_data,captured_at FROM cinema_batches WHERE cinema_id=? AND batch_id=? AND status='committed'"
  ).bind(cinemaId, batchId).first();
  if (!batch) return null;
  const { results: rows } = await DB.prepare(
    "SELECT movie_id,movie_name,seq_nos,version,updated_at FROM cinema_snapshots WHERE cinema_id=? ORDER BY movie_id"
  ).bind(cinemaId).all();
  const { results: eventRows } = await DB.prepare(
    "SELECT payload FROM cinema_events WHERE cinema_id=? AND batch_id=? ORDER BY id"
  ).bind(cinemaId, batchId).all();
  return {
    snapshot: {
      cinemaId, version: Number(batch.version), capturedAt: Number(batch.captured_at),
      data: Object.fromEntries(rows.map((row) => [String(row.movie_id), JSON.parse(row.seq_nos || "[]")]))
    },
    events: eventRows.map((row) => JSON.parse(row.payload)),
    data: JSON.parse(batch.public_data || "{}")
  };
}

export async function persistCinemaSnapshot(DB, { cinemaId, batchId, data, capturedAt = Date.now() }) {
  const id = String(cinemaId);
  const batch = String(batchId);
  const committed = await getCommittedCinemaBatch(DB, id, batch);
  if (committed) return { ...committed, replayed: true };
  const { results: rows } = await DB.prepare(
    "SELECT movie_id,movie_name,seq_nos,version,updated_at FROM cinema_snapshots WHERE cinema_id=? ORDER BY movie_id"
  ).bind(id).all();
  const previous = snapshotMap(rows);
  const current = movieMap(data);
  const diff = compareMaps(previous, current);
  const priorVersion = rows.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0);
  const version = priorVersion + (diff.changedMovieIds.length ? 1 : 0) || 1;
  const statements = [];
  for (const movieId of diff.changedMovieIds) {
    const movie = current.get(movieId);
    statements.push(DB.prepare(
      "INSERT INTO cinema_snapshots(cinema_id,movie_id,movie_name,seq_nos,version,updated_at) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(cinema_id,movie_id) DO UPDATE SET movie_name=excluded.movie_name,seq_nos=excluded.seq_nos," +
      "version=excluded.version,updated_at=excluded.updated_at"
    ).bind(id, movieId, movie.movieName, JSON.stringify(movie.seqNos), version, Number(capturedAt)));
  }
  for (const event of diff.additions) {
    statements.push(DB.prepare(
      "INSERT INTO cinema_events(cinema_id,batch_id,movie_id,payload,created_at) VALUES (?,?,?,?,?)"
    ).bind(id, batch, event.movieId, JSON.stringify(event), Number(capturedAt)));
  }
  statements.push(DB.prepare(
    "INSERT INTO cinema_batches(cinema_id,batch_id,status,version,public_data,captured_at) VALUES (?,?,'committed',?,?,?)"
  ).bind(id, batch, version, JSON.stringify(safeCinemaData(data)), Number(capturedAt)));
  try {
    await DB.batch(statements);
  } catch (error) {
    const concurrent = await getCommittedCinemaBatch(DB, id, batch);
    if (concurrent) return { ...concurrent, replayed: true };
    throw error;
  }
  const committedResult = await getCommittedCinemaBatch(DB, id, batch);
  return { ...committedResult, replayed: false };
}

export async function advanceSubscriber(DB, {
  userId, cinemaId, configVersion, snapshotVersion, events = [], notifications = [], nowMs = Date.now(), batchMs = DEFAULT_BATCH_MS
}) {
  const version = Number(snapshotVersion);
  const current = await DB.prepare(
    "SELECT 1 AS ok FROM monitor_subscriptions WHERE user_id=? AND cinema_id=? AND config_version=? AND enabled=1 " +
    "AND (baseline_version IS NULL OR baseline_version<?)"
  ).bind(userId, String(cinemaId), Number(configVersion), version).first();
  if (!current) return { applied: false };
  const requestId = `subscriber:${userId}:${configVersion}:${version}`;
  const statements = [DB.prepare(
    "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
    "SELECT 1 FROM monitor_subscriptions WHERE user_id=? AND cinema_id=? AND config_version=? AND enabled=1 " +
    "AND (baseline_version IS NULL OR baseline_version<?)) THEN 1 ELSE 0 END)"
  ).bind(requestId, userId, String(cinemaId), Number(configVersion), version)];
  for (const event of events) {
    statements.push(DB.prepare(
      "INSERT INTO change_log(token_id,time,type,text) VALUES (?,?,?,?)"
    ).bind(userId, new Date(nowMs).toISOString(), event.type || "new", event.text || "发现新增场次"));
  }
  const notificationIndexes = [];
  for (const notification of notifications) {
    notificationIndexes.push(statements.length);
    const enqueuedAt = Date.now();
    statements.push(DB.prepare(
      "INSERT OR IGNORE INTO notification_outbox(" +
      "event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at,detected_at" +
      ") VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?,?)"
    ).bind(
      String(notification.eventKey), userId, String(notification.kind),
      JSON.stringify({ title: String(notification.title), content: String(notification.content) }),
      Number(notification.credentialVersion || configVersion), enqueuedAt, enqueuedAt, enqueuedAt,
      Number(notification.detectedAt || enqueuedAt)
    ));
  }
  statements.push(DB.prepare(
    "UPDATE monitor_subscriptions SET baseline_version=?,next_due_at=?,updated_at=? " +
    "WHERE user_id=? AND cinema_id=? AND config_version=? AND enabled=1 " +
    "AND (baseline_version IS NULL OR baseline_version<?)"
  ).bind(version, Number(nowMs) + Number(batchMs), Number(nowMs), userId, String(cinemaId), Number(configVersion), version));
  statements.push(DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId));
  try {
    const results = await DB.batch(statements);
    const update = results.at(-2);
    return {
      applied: Number(update?.meta?.changes || 0) === 1,
      notificationsCreated: notificationIndexes.reduce((count, index) =>
        count + (Number(results[index]?.meta?.changes || 0) === 1 ? 1 : 0), 0)
    };
  } catch (error) {
    if (/mutation_guards\.ok|CHECK constraint failed: ok = 1/.test(String(error?.message || error))) return { applied: false };
    throw error;
  }
}
