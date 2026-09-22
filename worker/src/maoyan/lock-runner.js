import { publicCinemaShows } from "./api.js";
import { findExactShows, findCompatibleShows, fetchSeatMap, createUnpaidOrder, OrderAttemptError } from "./lock-client.js";
import { getLockSessionStatus, loadLockSession, removeLockSession, saveLockSession } from "./lock-session.js";
import {
  createLockRule, getLockRule, isLockRuleTerminal, putLockRule, removeLockRule,
  RULE_KNOWN_ERRORS
} from "./lock-rule.js";
import { getUserConfig } from "./user.js";
import { pushNotify } from "./notify.js";
import { lockError, lockLog } from "./log.js";
import { withSeatFeedback } from "./seat-feedback.js";
import { lockNotification } from "./notification-copy.js";
import { requireActiveAccount } from "./auth.js";
import { persistTerminalNotification, wakeNotificationDispatcher } from "./notification-outbox.js";
import { allowManualOperation } from "./resource-budget.js";

const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function chinaDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function messageFor(error) {
  if (error instanceof OrderAttemptError) return "锁座失败，未获得有效订单";
  return "猫眼场次或座位信息暂时不可用";
}

function seatsMatch(rule, seatMap) {
  const future = new Map((seatMap?.seats || []).map((seat) => [String(seat.seatNo), seat]));
  return rule.seats.every((seat) => {
    const hit = future.get(String(seat.seatNo));
    return hit && hit.available === true && String(hit.rowId) === String(seat.rowId) && String(hit.columnId) === String(seat.columnId);
  });
}

function ruleTimeTolerance(value) {
  return Number.isInteger(value) && value >= 0 && value <= 180 ? value : 30;
}

export function resolveLockTarget(rule, cinema, deps = {}) {
  const exactShows = deps.findShows || findExactShows;
  const nearbyShows = deps.findCompatibleShows || findCompatibleShows;
  const exactMatches = exactShows(cinema, rule) || [];
  const matches = rule.hall
    ? exactMatches.filter((candidate) => String(candidate.th || "") === String(rule.hall))
    : exactMatches;
  if (matches.length === 1) {
    return { status: "matched", show: matches[0], matchMode: "exact", timeDeltaMinutes: 0 };
  }
  if (matches.length > 1) return { status: "ambiguous", reason: "exact" };
  if (!rule.hall) return { status: "waiting" };
  const candidates = nearbyShows(cinema, {
    movieId: rule.movieId,
    targetDate: rule.targetDate,
    templateTime: rule.templateTime,
    templateHall: rule.hall,
    maxMinutes: ruleTimeTolerance(rule.timeToleranceMinutes)
  }) || [];
  if (!candidates.length) return { status: "waiting" };
  const nearest = [...candidates].sort((left, right) =>
    Math.abs(Number(left.timeDeltaMinutes)) - Math.abs(Number(right.timeDeltaMinutes)) ||
    String(left.tm || "").localeCompare(String(right.tm || "")) ||
    String(left.seqNo || "").localeCompare(String(right.seqNo || ""))
  );
  return {
    status: "matched",
    show: nearest[0],
    matchMode: "fuzzy",
    timeDeltaMinutes: Number(nearest[0].timeDeltaMinutes)
  };
}

async function saveRule(env, tokenId, rule, changes, deps) {
  const next = { ...rule, ...changes, updatedAt: new Date((deps.now || (() => new Date()))()).toISOString() };
  await (deps.putRule || putLockRule)(env, tokenId, next);
  return next;
}

async function notifyTerminal(env, tokenId, rule, deps) {
  const config = await (deps.getConfig || getUserConfig)(env, tokenId);
  // 与立即锁座共用同一份正文(座位渲染成「几排几座」), 避免两处副本各自漂移
  const notification = lockNotification(rule);
  try {
    await (deps.notify || pushNotify)(config, notification.title, notification.content);
  } catch {
    if (rule.state === "locked") await saveRule(env, tokenId, rule, { notifyError: "通知发送失败" }, deps);
  }
}

async function terminal(env, tokenId, rule, state, changes, deps) {
  if (!deps.putRule && !deps.notify && env.NOTIFICATION_DISPATCHER) {
    const now = (deps.now || (() => new Date()))();
    const next = { ...rule, ...changes, state, updatedAt: new Date(now).toISOString() };
    const config = await (deps.getConfig || getUserConfig)(env, tokenId);
    const notification = lockNotification(next);
    await persistTerminalNotification(env, {
      userId: tokenId,
      rule: next,
      title: notification.title,
      content: notification.content,
      failureDetail: changes.failureDetail,
      credentialVersion: config.version,
      nowMs: new Date(now).getTime()
    });
    try { await wakeNotificationDispatcher(env); } catch {}
    lockLog("scheduled_rule", { phase: "complete", state });
    return { ok: true, state };
  }
  const next = state === "locked"
    ? await saveRule(env, tokenId, rule, { ...changes, state }, deps)
    : { ...rule, ...changes, state };
  if (state !== "locked") await (deps.removeRule || removeLockRule)(env, tokenId);
  lockLog("scheduled_rule", { phase: "complete", state });
  await notifyTerminal(env, tokenId, next, deps);
  return { ok: true, state };
}

export async function runOneLockRule(env, tokenId, deps = {}) {
  if (String(env.LOCK_SERVICE_ENABLED) !== "true") return { ok: true, skipped: true, disabled: true };
  const getRule = deps.getRule || getLockRule;
  const rule = await getRule(env, tokenId);
  if (!rule || rule.state === "matching" || rule.state === "unknown" || isLockRuleTerminal(rule.state)) {
    return { ok: true, skipped: true };
  }

  const now = (deps.now || (() => new Date()))();
  if (rule.targetDate < chinaDate(now)) return await terminal(env, tokenId, rule, "expired", { lastError: "目标场次已过期" }, deps);

  const fetchCinema = deps.fetchCinema;
  if (typeof fetchCinema !== "function") {
    return { ok: true, skipped: true, missingMonitorData: true };
  }
  const loadSession = deps.loadSession || loadLockSession;
  // 默认的取图入口包一层解析失败自动留档(只写标识 KV, 失败静默); 测试注入的 deps.fetchSeats 不经包装
  const fetchSeats = deps.fetchSeats || withSeatFeedback(fetchSeatMap, env, { tokenId, cinemaId: rule.cinemaId, movieId: rule.movieId });
  const createOrder = deps.createOrder || createUnpaidOrder;
  let show;
  let session;
  let seatMap;
  let matching;
  const shouldCancel = deps.shouldCancel || (() => false);
  try {
    const cinema = await fetchCinema(rule.cinemaId);
    if (shouldCancel()) return { ok: true, skipped: true };
    const target = resolveLockTarget(rule, cinema, deps);
    if (target.status === "waiting") return { ok: true, waiting: true };
    if (target.status === "ambiguous") {
      const lastError = target.reason === "fuzzy"
        ? "目标日期存在多个同厅型且时间相近场次"
        : "目标日期存在多个相同时间场次";
      return await terminal(env, tokenId, rule, "failed", { lastError }, deps);
    }
    show = target.show;
    const matchMode = target.matchMode;
    const matchingChanges = {
      state: "matching",
      attemptStartedAt: new Date(now).toISOString(),
      seqNo: String(show.seqNo),
      targetSeqNo: String(show.seqNo),
      targetTime: String(show.tm || rule.templateTime),
      matchMode,
      timeDeltaMinutes: target.timeDeltaMinutes,
      lastError: null,
      hall: String(show.th || rule.hall || "")
    };
    // Fuzzy candidates must become terminal if preparation fails, so persist the
    // actual show before loading the session or seat map. Exact matching retains
    // the legacy waiting/seat-feedback behavior until preparation succeeds.
    if (matchMode === "fuzzy") {
      matching = await saveRule(env, tokenId, rule, matchingChanges, deps);
      if (shouldCancel()) return { ok: true, skipped: true };
      const currentRule = await getRule(env, tokenId);
      if (shouldCancel() || !currentRule || currentRule.id !== matching.id || currentRule.state !== "matching") {
        return { ok: true, skipped: true };
      }
    }
    session = await loadSession(env, tokenId);
    if (shouldCancel()) return { ok: true, skipped: true };
    seatMap = await fetchSeats(session, { cinemaId: rule.cinemaId, movieId: rule.movieId, seqNo: String(show.seqNo) });
    if (shouldCancel()) return { ok: true, skipped: true };
    if (String(seatMap?.seqNo) !== String(show.seqNo) || !seatsMatch(rule, seatMap)) {
      const error = new Error("所选未来座位不可用或影厅布局已变化");
      if (matchMode === "exact") {
        return await terminal(env, tokenId, rule, "failed", { lastError: error.message }, deps);
      }
      throw error;
    }
    if (!matching) {
      matching = await saveRule(env, tokenId, rule, matchingChanges, deps);
      if (shouldCancel()) return { ok: true, skipped: true };
      const currentRule = await getRule(env, tokenId);
      if (shouldCancel() || !currentRule || currentRule.id !== matching.id || currentRule.state !== "matching") {
        return { ok: true, skipped: true };
      }
    }
  } catch (error) {
    if (matching) {
      lockError("scheduled_rule", { phase: "prepare", state: "failed", reason: "provider_data_unavailable" });
      return await terminal(env, tokenId, matching, "failed", { lastError: messageFor(error) }, deps);
    }
    lockError("scheduled_rule", { phase: "prepare", state: "waiting_schedule", reason: "provider_data_unavailable" });
    await saveRule(env, tokenId, rule, { lastError: messageFor(error) }, deps);
    return { ok: false, waiting: true };
  }

  await (deps.requireActive || requireActiveAccount)(env, tokenId);
  let order;
  try {
    order = await createOrder(session, seatMap, matching.seats.map((seat) => seat.seatNo));
  } catch (error) {
    return await terminal(env, tokenId, matching, "failed", {
      lastError: "锁座失败，未获得有效订单",
      failureDetail: error?.failureDetail || null
    }, deps);
  }
  return await terminal(env, tokenId, matching, "locked", {
    orderId: String(order.orderId), payLeftSecond: order.payLeftSecond ?? null, lockedAt: new Date(now).toISOString(), lastError: null
  }, deps);
}

function checkedTokenId(tokenId) {
  if (!TOKEN_ID.test(String(tokenId || ""))) throw new Error("Bad Request");
  return String(tokenId);
}

export class LockCoordinator {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps;
    this.running = false;
    this.cancelRequested = false;
    this.current = null;
  }

  async fetch(request) {
    if (request.method !== "POST") return Response.json({ error: "Method Not Allowed" }, { status: 405 });
    if (request.headers.get("X-Lock-Action") === "manual-rate") return await this.handle(request);
    if (this.running) {
      if (["cancel", "remove-session", "save-session", "prepare-cleanup"].includes(request.headers.get("X-Lock-Action"))) {
        this.cancelRequested = true;
        await this.current;
        return await this.fetch(request);
      }
      if (request.headers.get("X-Lock-Action") === "create") {
        return Response.json({ ok: false, error: "已有进行中的锁座规则" }, { status: 409 });
      }
      return Response.json({ ok: true, skipped: true }, { status: 202 });
    }
    this.running = true;
    this.cancelRequested = false;
    const operation = this.handle(request);
    this.current = operation;
    try {
      return await operation;
    } finally {
      this.current = null;
      this.running = false;
    }
  }

  async handle(request) {
    try {
      const { action, tokenId, input } = await request.json();
      checkedTokenId(tokenId);
      if (action === "create") {
        const createRule = this.deps.createRule || createLockRule;
        const rule = await createRule(this.env, tokenId, input, this.deps);
        return Response.json({ ok: true, rule }, { status: 201 });
      }
      if (action === "cancel") {
        const getRule = this.deps.getRule || getLockRule;
        if (!await getRule(this.env, tokenId)) return Response.json({ ok: false, error: "未找到锁座规则" }, { status: 404 });
        await (this.deps.removeRule || removeLockRule)(this.env, tokenId);
        return Response.json({ ok: true, removed: true });
      }
      if (action === "remove-session") {
        const sessionStatus = await (this.deps.getSessionStatus || getLockSessionStatus)(this.env, tokenId);
        if (!sessionStatus?.uploaded) return Response.json({ ok: false, error: "未找到锁座资源" }, { status: 404 });
        await (this.deps.removeSession || removeLockSession)(this.env, tokenId);
        await (this.deps.removeRule || removeLockRule)(this.env, tokenId);
        return Response.json({ ok: true, removed: true });
      }
      if (action === "save-session") {
        const session = await (this.deps.saveSession || saveLockSession)(this.env, tokenId, input);
        return Response.json({ ok: true, session });
      }
      if (action === "prepare-cleanup") {
        return Response.json({ ok: true, ready: true });
      }
      if (action === "manual-rate") {
        return Response.json({ ok: true, ...await allowManualOperation(this.state.storage, {
          userId: tokenId,
          cinemaId: input?.cinemaId,
          kind: input?.kind,
          nowMs: input?.nowMs
        }) });
      }
      if (action !== "run") return Response.json({ error: "Bad Request" }, { status: 400 });
      const getRule = this.deps.getRule || getLockRule;
      const rule = await getRule(this.env, tokenId);
      if (rule && await this.state.storage.get("terminalRuleId") === rule.id) return Response.json({ ok: true, skipped: true });
      const monitoredCinema = input?.monitoredCinema;
      const runDeps = monitoredCinema && typeof monitoredCinema === "object"
        ? { ...this.deps, fetchCinema: async () => monitoredCinema }
        : this.deps;
      const result = await runOneLockRule(this.env, tokenId, { ...runDeps, shouldCancel: () => this.cancelRequested });
      const latest = await getRule(this.env, tokenId);
      if (latest && isLockRuleTerminal(latest.state)) await this.state.storage.put("terminalRuleId", latest.id);
      return Response.json(result);
    } catch (error) {
      const message = String(error?.message || "");
      if (message === "已有进行中的锁座规则") {
        return Response.json({ ok: false, error: message }, { status: 409 });
      }
      // 上游(猫眼)明确拒绝: 保留原文案并返回 502, 与 /template-seats 的语义保持一致
      if (error?.kind === "upstream") {
        return Response.json({ ok: false, error: message }, { status: 502 });
      }
      if (RULE_KNOWN_ERRORS.includes(message)) {
        return Response.json({ ok: false, error: message }, { status: 400 });
      }
      lockError("coordinator", { phase: "request", state: "failed", reason: "internal_error" });
      return Response.json({ ok: false, error: "锁座服务暂时不可用" }, { status: 500 });
    }
  }
}

function lockRequest(action, tokenId, input) {
  return new Request("https://lock-coordinator/internal", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Lock-Action": action },
    body: JSON.stringify({ action, tokenId, input })
  });
}

export async function createLockRuleThroughCoordinator(env, tokenId, input) {
  checkedTokenId(tokenId);
  const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(tokenId));
  const response = await stub.fetch(lockRequest("create", tokenId, input));
  const body = await response.json().catch(() => ({}));
  if (response.status === 201 && body?.ok === true && body.rule) return body.rule;
  if (response.status === 409) throw new Error("已有进行中的锁座规则");
  if (response.status === 400 && body?.error) throw new Error(body.error);
  // 上游拒绝(502): 保留真实原因与语义, 交给 API 边界映射为 502, 不降级成笼统的 500
  if (response.status === 502 && body?.error) {
    const error = new Error(body.error);
    error.kind = "upstream";
    throw error;
  }
  throw new Error("锁座服务暂时不可用");
}

async function removeThroughCoordinator(env, tokenId, action, missingMessage) {
  checkedTokenId(tokenId);
  const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(tokenId));
  const response = await stub.fetch(lockRequest(action, tokenId));
  const body = await response.json().catch(() => ({}));
  if (response.status === 200 && body?.ok === true && body.removed === true) return true;
  if (response.status === 404) throw new Error(missingMessage);
  throw new Error("锁座服务暂时不可用");
}

export async function cancelLockRuleThroughCoordinator(env, tokenId) {
  return await removeThroughCoordinator(env, tokenId, "cancel", "未找到锁座规则");
}

export async function removeLockSessionThroughCoordinator(env, tokenId) {
  return await removeThroughCoordinator(env, tokenId, "remove-session", "未找到锁座资源");
}

export async function saveLockSessionThroughCoordinator(env, tokenId, input) {
  checkedTokenId(tokenId);
  const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(tokenId));
  const response = await stub.fetch(lockRequest("save-session", tokenId, input));
  const body = await response.json().catch(() => ({}));
  if (response.status === 200 && body?.ok === true && body.session) return body.session;
  throw new Error("锁座服务暂时不可用");
}

export async function prepareAccountCleanupThroughCoordinator(env, tokenId) {
  checkedTokenId(tokenId);
  const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(tokenId));
  const response = await stub.fetch(lockRequest("prepare-cleanup", tokenId));
  const body = await response.json().catch(() => ({}));
  if (response.status === 200 && body?.ok === true && body.ready === true) return true;
  throw new Error("锁座协调器清理准备失败");
}

export async function checkManualOperationThroughCoordinator(env, tokenId, input) {
  checkedTokenId(tokenId);
  if (!env.LOCK_COORDINATOR) return { allowed: true, retryAfterSeconds: 0 };
  const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(tokenId));
  const response = await stub.fetch(lockRequest("manual-rate", tokenId, input));
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.allowed !== "boolean") throw new Error("操作限流服务暂时不可用");
  return { allowed: body.allowed, retryAfterSeconds: Number(body.retryAfterSeconds || 0) };
}

export async function runScheduledLockAfterMonitor(env, tokenId, cinemaData) {
  if (String(env.LOCK_SERVICE_ENABLED) !== "true") return { ok: true, skipped: true, disabled: true };
  const monitoredCinema = { showData: publicCinemaShows(cinemaData) };
  const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(tokenId));
  const response = await stub.fetch(lockRequest("run", tokenId, { monitoredCinema }));
  if (!response.ok) throw new Error("锁座协调器执行失败");
  return response;
}
