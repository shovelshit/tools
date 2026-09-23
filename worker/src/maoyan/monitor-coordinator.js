import { fetchCinemaDetail } from "./api.js";
import { newShowsNotification } from "./notification-copy.js";
import { wakeNotificationDispatcher } from "./notification-outbox.js";
import { advanceSubscriber, beginCinemaRun, completeCinemaRun, completeRunSubscriber, getCommittedCinemaBatch, listRunSubscribers, listSubscribers, persistCinemaSnapshot } from "./monitor-store.js";
import { diffCinemaSnapshot } from "./monitor-store.js";
import { chinaDate, resolveLockTarget, runScheduledLockAfterMonitor } from "./lock-runner.js";
import { orderLockCandidates, runBounded } from "./lock-lottery.js";
import { allowManualOperation } from "./resource-budget.js";
import { monitorError } from "./log.js";

function eventText(event) {
  const first = event.shows[0] || {};
  return `新增 ${event.shows.length} 场《${event.movieName}》: ${first.showDate || ""} ${first.tm || ""}`.trim();
}

function decodeData(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

// cinema_state stores the deterministic representation with a flat show list;
// the lock and diff helpers consume the provider's day/plist shape.
function providerCinemaData(data) {
  const movies = (data?.showData?.movies || []).map((movie) => {
    const shows = movie?.shows || [];
    const flat = shows.flatMap((entry) => Array.isArray(entry?.plist)
      ? entry.plist.map((show) => ({ ...show, showDate: entry.showDate || entry.dt || show.showDate || show.dt || "" }))
      : [entry]);
    const days = new Map();
    for (const show of flat) {
      const day = String(show?.showDate || show?.dt || "");
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ ...show });
    }
    return { ...movie, shows: [...days].map(([showDate, plist]) => ({ showDate, plist })) };
  });
  return { ...data, showData: { ...(data?.showData || {}), movies } };
}

async function markRunRetryable(DB, cinemaId, runId, nowMs) {
  await DB.prepare("UPDATE cinema_state SET run_state='retryable',updated_at=? WHERE cinema_id=? AND active_run_id=?")
    .bind(Number(nowMs), String(cinemaId), String(runId)).run();
}

async function advanceRunNotifications(DB, {
  userId, cinemaId, configVersion, baselineVersion, version, events, notifications, nowMs
}) {
  if (baselineVersion != null && Number(baselineVersion) >= Number(version)) return { advanced: false, notificationsCreated: 0 };
  const requestId = `subscriber:${userId}:${configVersion}:${version}`;
  const statements = [DB.prepare(
    "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM monitor_subscriptions WHERE user_id=? AND cinema_id=? AND config_version=? AND enabled=1 AND (baseline_version IS NULL OR baseline_version<?)) THEN 1 ELSE 0 END)"
  ).bind(requestId, userId, String(cinemaId), Number(configVersion), Number(version))];
  for (const event of events || []) statements.push(DB.prepare(
    "INSERT INTO change_log(token_id,time,type,text) VALUES (?,?,?,?)"
  ).bind(userId, new Date(Number(nowMs)).toISOString(), event.type || "new", event.text || "发现新增场次"));
  const notificationIndexes = [];
  for (const notification of notifications || []) {
    notificationIndexes.push(statements.length);
    const enqueuedAt = Number(nowMs);
    statements.push(DB.prepare(
      "INSERT OR IGNORE INTO notification_outbox(event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at,detected_at) VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?,?)"
    ).bind(String(notification.eventKey), userId, String(notification.kind), JSON.stringify({ title: String(notification.title), content: String(notification.content) }), Number(notification.credentialVersion || configVersion), enqueuedAt, enqueuedAt, enqueuedAt, Number(notification.detectedAt || enqueuedAt)));
  }
  statements.push(DB.prepare(
    "UPDATE monitor_subscriptions SET baseline_version=?,updated_at=? WHERE user_id=? AND cinema_id=? AND config_version=? AND enabled=1 AND (baseline_version IS NULL OR baseline_version<?)"
  ).bind(Number(version), Number(nowMs), userId, String(cinemaId), Number(configVersion), Number(version)));
  statements.push(DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId));
  const results = await DB.batch(statements);
  const update = results.at(-2);
  return {
    advanced: Number(update?.meta?.changes || 0) === 1,
    notificationsCreated: notificationIndexes.reduce((count, index) => count + (Number(results[index]?.meta?.changes || 0) === 1 ? 1 : 0), 0)
  };
}

export async function processCinemaRun(env, {
  cinemaId, runId, nowMs = Date.now(), fetchCinema = fetchCinemaDetail,
  runLock = runScheduledLockAfterMonitor, lockConcurrency = 4
}) {
  const id = String(cinemaId), rid = String(runId), timestamp = Number(nowMs);
  let state = await env.DB.prepare("SELECT active_run_id,active_data,current_data,active_version,active_base_version,started_at,run_state FROM cinema_state WHERE cinema_id=?").bind(id).first();
  let fetched;
  if (!(state?.active_run_id === rid && state.active_data != null)) fetched = await fetchWithTimeout(fetchCinema, id);
  let run;
  try {
    run = await beginCinemaRun(env.DB, { cinemaId: id, runId: rid, nowMs: timestamp, fetchedData: fetched });
  } catch (error) {
    if (error?.code === "RUN_IN_PROGRESS") return { completed: false, retryable: true, runId: rid, subscribers: 0, notifications: 0, lockAttempts: 0, lockFailures: 0 };
    throw error;
  }
  state = state || await env.DB.prepare("SELECT current_data FROM cinema_state WHERE cinema_id=?").bind(id).first();
  const baseData = providerCinemaData(decodeData(state?.current_data));
  const providerData = providerCinemaData(run.data);
  const changes = run.changed ? diffCinemaSnapshot(baseData, providerData) : { additions: [] };
  // The due cutoff is the current attempt's time; a retry must see subscribers
  // whose next_due_at was advanced during an earlier attempt of the same run.
  const startedAt = timestamp;
  let afterUserId = "";
  let subscribers = 0;
  let notifications = 0;
  const candidates = [];
  const completedUsers = new Set();
  do {
    const page = await listRunSubscribers(env.DB, { cinemaId: id, runId: rid, startedAt, afterUserId, limit: 10 });
    for (const subscription of page.items) {
      const selected = new Set((subscription.config.selectedMovieIds || []).map(String));
      const relevant = subscription.baselineVersion == null ? [] : (changes.additions || []).filter((event) => selected.has(String(event.movieId)));
      const changeEvents = relevant.map((event) => ({ type: "new", text: eventText(event) }));
      const queuedNotifications = relevant.map((event) => {
        const n = newShowsNotification({ cinemaName: run.data?.showData?.cinemaName || "", movieName: event.movieName, shows: event.shows });
        return { eventKey: `cinema:${id}:${rid}:${subscription.userId}:${event.movieId}`, kind: "new-shows", detectedAt: timestamp, title: n.title, content: n.content, credentialVersion: subscription.configVersion };
      });
      const advanced = await advanceRunNotifications(env.DB, { userId: subscription.userId, cinemaId: id, configVersion: subscription.configVersion, baselineVersion: subscription.baselineVersion, version: run.version, events: changeEvents, notifications: queuedNotifications, nowMs: timestamp });
      notifications += Number(advanced.notificationsCreated || 0);
      if (advanced.notificationsCreated) {
        try { await wakeNotificationDispatcher(env, { kind: "new-shows", userId: subscription.userId }); } catch { monitorError("notification_wake", { state: "failed", reason: "dispatch_unavailable" }); }
      }
      subscribers += 1;
      let lockCandidate = null;
      if (subscription.lockRule?.state === "waiting_schedule" && typeof runLock === "function") {
        const target = resolveLockTarget(subscription.lockRule, providerData);
        if (target.status === "matched" || target.status === "ambiguous" || (target.status === "waiting" && subscription.lockRule.targetDate < chinaDate(new Date(timestamp)))) {
          lockCandidate = { userId: subscription.userId, lotteryKey: subscription.lockRule.lotteryKey, target };
        }
      }
      if (lockCandidate) candidates.push({ candidate: lockCandidate, subscription });
      else {
        const result = await completeRunSubscriber(env.DB, { userId: subscription.userId, cinemaId: id, runId: rid, configVersion: subscription.configVersion, nextDueAt: timestamp + 180_000, baselineVersion: run.version });
        if (result.applied) completedUsers.add(subscription.userId);
      }
    }
    afterUserId = page.nextCursor || "";
  } while (afterUserId);
  const queue = orderLockCandidates(candidates.map((item) => item.candidate), providerData);
  const byUser = new Map(candidates.map((item) => [item.candidate.userId, item.subscription]));
  const lockResults = await runBounded(queue, lockConcurrency, (candidate) => runLock(env, candidate.userId, providerData));
  let lockFailures = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const result = lockResults[index];
    const candidate = queue[index];
    if (result.status === "rejected") { lockFailures += 1; continue; }
    const subscription = byUser.get(candidate.userId);
    const completed = await completeRunSubscriber(env.DB, { userId: candidate.userId, cinemaId: id, runId: rid, configVersion: subscription.configVersion, nextDueAt: timestamp + 180_000, baselineVersion: run.version });
    if (completed.applied) completedUsers.add(candidate.userId);
  }
  if (lockFailures) {
    await markRunRetryable(env.DB, id, rid, timestamp);
    return { completed: false, retryable: true, runId: rid, subscribers, notifications, lockAttempts: queue.length, lockFailures };
  }
  const committed = await completeCinemaRun(env.DB, { cinemaId: id, runId: rid, nowMs: timestamp });
  return { completed: committed.status !== "skipped" && committed.status !== "conflict", retryable: false, runId: rid, subscribers, notifications, lockAttempts: queue.length, lockFailures };
}

async function fetchWithTimeout(fetchCinema, cinemaId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetchCinema(cinemaId, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function processCinemaBatch(env, {
  cinemaId, batchId, nowMs = Date.now(), fetchCinema = fetchCinemaDetail,
  runLock = runScheduledLockAfterMonitor, lockConcurrency = 4
}) {
  let persisted = await getCommittedCinemaBatch(env.DB, String(cinemaId), String(batchId));
  if (persisted) persisted = { ...persisted, replayed: true };
  else {
    const fetched = await fetchWithTimeout(fetchCinema, String(cinemaId));
    persisted = await persistCinemaSnapshot(env.DB, {
      cinemaId: String(cinemaId), batchId: String(batchId), data: fetched, capturedAt: Number(nowMs)
    });
  }
  const data = persisted.data;
  let afterUserId = "";
  let subscribers = 0;
  let notifications = 0;
  const lockCandidates = [];
  const terminalCandidates = [];
  do {
    const page = await listSubscribers(env.DB, {
      cinemaId: String(cinemaId), afterUserId, limit: 10, nowMs: Number(nowMs)
    });
    for (const subscription of page.items) {
      const selected = new Set((subscription.config.selectedMovieIds || []).map(String));
      const relevant = subscription.baselineVersion == null ? []
        : persisted.events.filter((event) => selected.has(String(event.movieId)));
      const changeEvents = relevant.map((event) => ({ type: "new", text: eventText(event) }));
      const queuedNotifications = relevant.map((event) => {
        const notification = newShowsNotification({
          cinemaName: data?.showData?.cinemaName || "",
          movieName: event.movieName,
          shows: event.shows
        });
        return {
          eventKey: `cinema:${cinemaId}:${batchId}:${subscription.userId}:${event.movieId}`,
          kind: "new-shows",
          detectedAt: Date.now(),
          title: notification.title,
          content: notification.content,
          credentialVersion: subscription.configVersion
        };
      });
      const advanced = await advanceSubscriber(env.DB, {
        userId: subscription.userId,
        cinemaId: String(cinemaId),
        configVersion: subscription.configVersion,
        snapshotVersion: persisted.snapshot.version,
        events: changeEvents,
        notifications: queuedNotifications,
        nowMs: Number(nowMs)
      });
      if (!advanced.applied) continue;
      subscribers += 1;
      notifications += Number(advanced.notificationsCreated || 0);
      if (advanced.notificationsCreated) {
        try {
          await wakeNotificationDispatcher(env, { kind: "new-shows", userId: subscription.userId });
        } catch {
          monitorError("notification_wake", { state: "failed", reason: "dispatch_unavailable" });
        }
      }
      if (subscription.lockRule?.state === "waiting_schedule" && typeof runLock === "function") {
        const target = resolveLockTarget(subscription.lockRule, data);
        const candidate = {
          userId: subscription.userId,
          lotteryKey: subscription.lockRule.lotteryKey,
          target
        };
        if (target.status === "matched") lockCandidates.push(candidate);
        else if (target.status === "ambiguous" ||
          (target.status === "waiting" && subscription.lockRule.targetDate < chinaDate(new Date(Number(nowMs))))) {
          terminalCandidates.push(candidate);
        }
      }
    }
    afterUserId = page.nextCursor || "";
  } while (afterUserId);
  const queue = [...orderLockCandidates(lockCandidates, data), ...terminalCandidates];
  const lockResults = await runBounded(queue, lockConcurrency, (candidate) => runLock(env, candidate.userId, data));
  const lockFailures = lockResults.filter((result) => result.status === "rejected").length;
  return {
    ok: true,
    cinemaId: String(cinemaId),
    batchId: String(batchId),
    snapshotVersion: persisted.snapshot.version,
    replayed: persisted.replayed,
    subscribers,
    notifications,
    lockAttempts: queue.length,
    lockFailures
  };
}

export class MonitorCoordinator {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps;
    this.tail = Promise.resolve();
    this.manualFetch = null;
  }

  async exclusive(operation) {
    const prior = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/internal/manual-check") {
      try {
        const body = await request.json();
        const rate = await allowManualOperation(this.state.storage, {
          userId: body.userId,
          cinemaId: body.cinemaId,
          kind: "check",
          nowMs: body.nowMs
        });
        if (!rate.allowed) return Response.json({ ok: false, code: "RATE_LIMITED", ...rate }, {
          status: 429,
          headers: { "Retry-After": String(rate.retryAfterSeconds) }
        });
        if (!this.manualFetch) {
          const fetchCinema = this.deps.fetchCinema || fetchCinemaDetail;
          this.manualFetch = fetchWithTimeout(fetchCinema, String(body.cinemaId))
            .finally(() => { this.manualFetch = null; });
        }
        return Response.json({ ok: true, data: await this.manualFetch });
      } catch {
        return Response.json({ ok: false, error: "影院场次暂时不可用" }, { status: 502 });
      }
    }
    if (request.method !== "POST" || pathname !== "/internal/batch") {
      return Response.json({ error: "Not Found" }, { status: 404 });
    }
    try {
      const body = await request.json();
      const operation = body.runId ? processCinemaRun : processCinemaBatch;
      const result = await this.exclusive(() => operation(this.env, { ...body, ...this.deps }));
      return Response.json(result);
    } catch {
      return Response.json({ ok: false, error: "影院批次处理失败" }, { status: 502 });
    }
  }
}

export async function fetchManualCinemaThroughCoordinator(env, { userId, cinemaId, nowMs }) {
  if (!env.MONITOR_COORDINATOR) return null;
  const stub = env.MONITOR_COORDINATOR.get(env.MONITOR_COORDINATOR.idFromName(String(cinemaId)));
  const response = await stub.fetch(new Request("https://internal/internal/manual-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, cinemaId, nowMs })
  }));
  const body = await response.json().catch(() => ({}));
  if (response.status === 429) return {
    allowed: false,
    retryAfterSeconds: Number(response.headers.get("Retry-After") || body.retryAfterSeconds || 30)
  };
  if (!response.ok || !body.data) throw new Error("影院场次暂时不可用");
  return { allowed: true, retryAfterSeconds: 0, data: body.data };
}
