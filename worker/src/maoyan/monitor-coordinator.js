import { fetchCinemaDetail } from "./api.js";
import { newShowsNotification } from "./notification-copy.js";
import { wakeNotificationDispatcher } from "./notification-outbox.js";
import { advanceSubscriber, getCommittedCinemaBatch, listSubscribers, persistCinemaSnapshot } from "./monitor-store.js";
import { runScheduledLockAfterMonitor } from "./lock-runner.js";
import { allowManualOperation } from "./resource-budget.js";

function eventText(event) {
  const first = event.shows[0] || {};
  return `新增 ${event.shows.length} 场《${event.movieName}》: ${first.showDate || ""} ${first.tm || ""}`.trim();
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
  cinemaId, batchId, nowMs = Date.now(), fetchCinema = fetchCinemaDetail, runLock = runScheduledLockAfterMonitor
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
      if (subscription.lockRule?.state === "waiting_schedule" && typeof runLock === "function") {
        await runLock(env, subscription.userId, data);
      }
    }
    afterUserId = page.nextCursor || "";
  } while (afterUserId);
  if (notifications) await wakeNotificationDispatcher(env);
  return {
    ok: true,
    cinemaId: String(cinemaId),
    batchId: String(batchId),
    snapshotVersion: persisted.snapshot.version,
    replayed: persisted.replayed,
    subscribers,
    notifications
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
      const result = await this.exclusive(() => processCinemaBatch(this.env, { ...body, ...this.deps }));
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
