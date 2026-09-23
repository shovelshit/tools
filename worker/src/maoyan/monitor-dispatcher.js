import { listDueCinemas } from "./monitor-store.js";

const PAGE_SIZE = 20;

export async function dispatchCinema(env, input) {
  const stub = env.MONITOR_COORDINATOR.get(env.MONITOR_COORDINATOR.idFromName(String(input.cinemaId)));
  const response = await stub.fetch(new Request("https://internal/internal/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  }));
  if (!response.ok) throw new Error("影院批次处理失败");
  const result = await response.json().catch(() => null);
  if (!result || typeof result.completed !== "boolean") throw new Error("影院批次处理结果无效");
  return result;
}

export class MonitorDispatcher {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps;
    this.tail = Promise.resolve();
  }

  async exclusive(operation) {
    const prior = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  async drain() {
    const storage = this.state.storage;
    const current = await storage.get("currentBatch");
    if (!current) return { processed: 0, pending: false };
    const page = await listDueCinemas(this.env.DB, {
      nowMs: Number(current.nowMs),
      afterCinemaId: current.cursor || "",
      limit: PAGE_SIZE
    });
    const dispatch = this.deps.dispatchCinema || dispatchCinema;
    await storage.setAlarm(Date.now() + 30_000);
    let cursor = current.cursor || "";
    let processed = 0;
    for (const cinemaId of page.items) {
      let result;
      try {
        result = await dispatch(this.env, { cinemaId, runId: current.runId || current.batchId, nowMs: current.nowMs });
      } catch (error) {
        await storage.put("currentBatch", { ...current, cursor });
        throw error;
      }
      if (result && (result.completed === false || result.retryable === true)) {
        await storage.put("currentBatch", { ...current, cursor });
        return { processed, pending: true };
      }
      cursor = cinemaId;
      processed += 1;
    }
    if (page.nextCursor) {
      await storage.put("currentBatch", { ...current, cursor: page.nextCursor });
      await storage.setAlarm(Date.now() + 1000);
      return { processed, pending: true };
    }
    await storage.delete("currentBatch");
    const pending = await storage.get("pendingBatch");
    if (pending) {
      await storage.delete("pendingBatch");
      await storage.put("currentBatch", pending);
      await storage.setAlarm(Date.now() + 1000);
      return { processed, pending: true };
    }
    await storage.deleteAlarm();
    return { processed, pending: false };
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/internal/batch") {
      return Response.json({ error: "Not Found" }, { status: 404 });
    }
    const body = await request.json().catch(() => ({}));
    const runId = body.runId || body.batchId;
    if (!runId || !Number.isFinite(Number(body.nowMs))) {
      return Response.json({ error: "Bad Request" }, { status: 400 });
    }
    const storage = this.state.storage;
    const incoming = { runId: String(runId), batchId: String(runId), nowMs: Number(body.nowMs), cursor: "" };
    return await this.exclusive(async () => {
      const current = await storage.get("currentBatch");
      if (!current) await storage.put("currentBatch", incoming);
      else if ((current.runId || current.batchId) !== incoming.runId) {
        const pending = await storage.get("pendingBatch");
        if (!pending || incoming.nowMs >= Number(pending.nowMs)) await storage.put("pendingBatch", incoming);
      }
      return Response.json({ ok: true, accepted: true, ...await this.drain() }, { status: 202 });
    });
  }

  async alarm() {
    await this.exclusive(() => this.drain());
  }
}

export async function dispatchMonitorBatch(env, { runId, batchId, nowMs }) {
  if (!env.MONITOR_DISPATCHER) return { accepted: false };
  const stub = env.MONITOR_DISPATCHER.get(env.MONITOR_DISPATCHER.idFromName("main"));
  const response = await stub.fetch(new Request("https://internal/internal/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: String(runId || batchId), nowMs: Number(nowMs) })
  }));
  return { accepted: response.ok };
}
