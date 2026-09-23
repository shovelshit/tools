const DEFAULT_BATCH_MS = 3 * 60 * 1000;

function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const words = new Uint32Array(64);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bytes.length * 8);
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + words[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      [a,b,c,d,e,f,g,h] = [ (t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g ];
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function normalizeCinemaData(data) {
  const movies = (data?.showData?.movies || []).map((movie) => ({
    id: String(movie?.id ?? ""), nm: String(movie?.nm || ""),
    shows: (movie?.shows || []).flatMap((day) => (day?.plist || (day?.seqNo != null ? [day] : [])).map((show) => ({
      seqNo: String(show?.seqNo ?? ""), showDate: String(day?.showDate || day?.dt || show?.dt || ""),
      tm: String(show?.tm || ""), th: String(show?.th || ""), lang: String(show?.lang || ""),
      tp: String(show?.tp || ""), ticketStatus: show?.ticketStatus == null ? null : (Number.isFinite(Number(show.ticketStatus)) ? Number(show.ticketStatus) : null)
    }))).filter((show) => show.seqNo)
  })).sort((a, b) => a.id.localeCompare(b.id));
  for (const movie of movies) {
    const unique = new Map(movie.shows.map((show) => [`${show.showDate}\u0000${show.seqNo}`, show]));
    movie.shows = [...unique.values()].sort((a, b) => `${a.showDate}\u0000${a.seqNo}`.localeCompare(`${b.showDate}\u0000${b.seqNo}`));
  }
  return { showData: { cinemaName: String(data?.showData?.cinemaName || ""), movies } };
}

export function hashCinemaData(data) {
  return sha256Hex(JSON.stringify(normalizeCinemaData(data)));
}

function decodeCinemaData(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export async function beginCinemaRun(DB, { cinemaId, runId, nowMs = Date.now(), fetchedData }) {
  const id = String(cinemaId), rid = String(runId), timestamp = Number(nowMs);
  const existing = await DB.prepare("SELECT * FROM cinema_state WHERE cinema_id=?").bind(id).first();
  if (existing?.active_run_id === rid && existing.active_data != null) {
    return { runId: rid, baseVersion: Number(existing.active_base_version || 0), version: Number(existing.active_version || existing.current_version || 0), data: decodeCinemaData(existing.active_data), changed: Number(existing.active_version || 0) !== Number(existing.active_base_version || 0) };
  }
  if (existing?.active_run_id && existing.active_run_id !== rid &&
      ["processing", "retryable"].includes(String(existing.run_state))) {
    const error = new Error("影院已有运行中的监控任务");
    error.code = "RUN_IN_PROGRESS";
    error.activeRunId = String(existing.active_run_id);
    throw error;
  }
  const data = normalizeCinemaData(fetchedData);
  const hash = hashCinemaData(data);
  const baseVersion = Number(existing?.current_version || 0);
  const changed = !existing?.current_hash || existing.current_hash !== hash;
  const version = baseVersion + (changed ? 1 : 0) || 1;
  const statement = existing
    ? DB.prepare("UPDATE cinema_state SET active_run_id=?,active_base_version=?,active_base_hash=?,active_data=?,active_version=?,run_state='processing',subscriber_cursor=NULL,attempt_count=attempt_count+1,started_at=?,completed_at=NULL,updated_at=? WHERE cinema_id=? AND (active_run_id IS NULL OR active_run_id=? OR run_state IN ('completed','idle','retryable'))").bind(rid, baseVersion, existing.current_hash || null, JSON.stringify(data), version, timestamp, timestamp, id, rid)
    : DB.prepare("INSERT INTO cinema_state(cinema_id,current_version,current_hash,current_data,active_run_id,active_base_version,active_base_hash,active_data,active_version,run_state,attempt_count,started_at,updated_at) VALUES (?,?,?,?,?,?,?,? ,?,'processing',1,?,?)").bind(id, 0, null, null, rid, baseVersion, null, JSON.stringify(data), version, timestamp, timestamp);
  const results = await DB.batch([statement]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    const error = new Error("影院监控任务竞争冲突");
    error.code = "RUN_CONFLICT";
    throw error;
  }
  return { runId: rid, baseVersion, version, data, changed };
}

export async function listRunSubscribers(DB, { cinemaId, runId, startedAt, afterUserId = "", limit = 10 } = {}) {
  const pageSize = clampLimit(limit, 10, 20);
  const { results } = await DB.prepare(
    "SELECT s.user_id,s.cinema_id,s.enabled,s.config_version,s.baseline_version,s.next_due_at,s.last_run_id,c.data,l.data AS lock_data " +
    "FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id JOIN user_config c ON c.token_id=s.user_id AND c.version=s.config_version " +
    "LEFT JOIN lock_rule l ON l.token_id=s.user_id WHERE s.cinema_id=? AND s.enabled=1 AND s.next_due_at<=? AND s.updated_at<=? " +
    "AND (s.last_run_id IS NULL OR s.last_run_id<>?) AND s.user_id>? AND u.state='active' AND u.business_line='maoyan' " +
    "AND (u.role='admin' OR u.expires_at>?) ORDER BY s.user_id LIMIT ?"
  ).bind(String(cinemaId), Number(startedAt), Number(startedAt), String(runId), String(afterUserId || ""), Number(startedAt), pageSize + 1).all();
  const items = results.slice(0, pageSize).map((row) => ({
    userId: row.user_id, cinemaId: row.cinema_id, enabled: Number(row.enabled) === 1,
    configVersion: Number(row.config_version), baselineVersion: row.baseline_version == null ? null : Number(row.baseline_version),
    nextDueAt: Number(row.next_due_at), config: decodeCinemaData(row.data),
    lockRule: row.lock_data ? decodeCinemaData(row.lock_data) : null
  }));
  return { items, nextCursor: results.length > pageSize ? items.at(-1)?.userId || null : null };
}

export async function completeRunSubscriber(DB, { userId, cinemaId, runId, configVersion, nextDueAt, baselineVersion }) {
  const baselineClause = baselineVersion == null ? "baseline_version IS NULL" : "baseline_version=?";
  const sql = "UPDATE monitor_subscriptions SET last_run_id=?,next_due_at=?,updated_at=updated_at WHERE user_id=? AND cinema_id=? AND config_version=? AND enabled=1 AND " + baselineClause + " AND (last_run_id IS NULL OR last_run_id<>?)";
  const adjusted = baselineVersion == null
    ? DB.prepare(sql).bind(String(runId), Number(nextDueAt), userId, String(cinemaId), Number(configVersion), String(runId))
    : DB.prepare(sql).bind(String(runId), Number(nextDueAt), userId, String(cinemaId), Number(configVersion), Number(baselineVersion), String(runId));
  const results = await DB.batch([adjusted]);
  return { applied: Number(results[0]?.meta?.changes || 0) === 1 };
}

export async function completeCinemaRun(DB, { cinemaId, runId, nowMs = Date.now() }) {
  const id = String(cinemaId), rid = String(runId), timestamp = Number(nowMs);
  const row = await DB.prepare("SELECT active_base_version,active_version,active_data,active_run_id FROM cinema_state WHERE cinema_id=? AND active_run_id=? AND active_data IS NOT NULL").bind(id, rid).first();
  if (!row) return { status: "skipped", runId: rid };
  const data = decodeCinemaData(row.active_data);
  const statement = DB.prepare(
    "UPDATE cinema_state SET current_version=active_version,current_hash=?,current_data=active_data,active_run_id=NULL,active_base_version=NULL,active_base_hash=NULL,active_data=NULL,active_version=NULL,run_state='completed',subscriber_cursor=NULL,completed_at=?,updated_at=? WHERE cinema_id=? AND active_run_id=?"
  ).bind(hashCinemaData(data), timestamp, timestamp, id, rid);
  const results = await DB.batch([statement]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    return { status: "conflict", runId: rid };
  }
  return { runId: rid, version: Number(row.active_version), data, changed: Number(row.active_version) !== Number(row.active_base_version || 0) };
}

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
