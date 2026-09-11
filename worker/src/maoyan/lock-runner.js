import { fetchCinemaDetail } from "./api.js";
import { findExactShows, fetchSeatMap, createUnpaidOrder, OrderAttemptError } from "./lock-client.js";
import { loadLockSession } from "./lock-session.js";
import { createLockRule, getLockRule, putLockRule, publicLockRule } from "./lock-rule.js";
import { getManagedTokens } from "./tokens.js";
import { getUserConfig } from "./user.js";
import { pushNotify } from "./notify.js";

const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKIPPED_STATES = new Set(["locked", "failed", "expired", "unknown", "matching"]);
const TERMINAL_STATES = new Set(["locked", "failed", "expired", "unknown"]);

function chinaDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function messageFor(error) {
  if (error instanceof OrderAttemptError) return error.uncertain ? "创建订单结果不确定" : "猫眼拒绝创建订单";
  return "猫眼场次或座位信息暂时不可用";
}

function seatsMatch(rule, seatMap) {
  const future = new Map((seatMap?.seats || []).map((seat) => [String(seat.seatNo), seat]));
  return rule.seats.every((seat) => {
    const hit = future.get(String(seat.seatNo));
    return hit && hit.available === true && String(hit.rowId) === String(seat.rowId) && String(hit.columnId) === String(seat.columnId);
  });
}

async function saveRule(env, tokenId, rule, changes, deps) {
  const next = { ...rule, ...changes, updatedAt: new Date((deps.now || (() => new Date()))()).toISOString() };
  await (deps.putRule || putLockRule)(env, tokenId, next);
  return next;
}

async function notifyTerminal(env, tokenId, rule, deps) {
  const notify = deps.notify || pushNotify;
  const config = await (deps.getConfig || getUserConfig)(env, tokenId);
  const labels = rule.seats.map((seat) => seat.seatNo).join("、");
  const content = `${rule.cinemaName} ${rule.movieName}\n${rule.targetDate} ${rule.templateTime}\n${labels}` +
    (rule.state === "locked" && rule.payLeftSecond !== null ? `\n剩余支付时间 ${rule.payLeftSecond} 秒` : "");
  try {
    await notify(config, rule.state === "locked" ? "猫眼锁座成功" : "猫眼锁座失败", content);
  } catch {
    await saveRule(env, tokenId, rule, { notifyError: "通知发送失败" }, deps);
  }
}

async function terminal(env, tokenId, rule, state, changes, deps) {
  const next = await saveRule(env, tokenId, rule, { ...changes, state }, deps);
  await notifyTerminal(env, tokenId, next, deps);
  return { ok: true, state };
}

export async function runOneLockRule(env, tokenId, deps = {}) {
  if (String(env.LOCK_AUTOMATION_ENABLED) !== "true") return { ok: true, skipped: true, disabled: true };
  const getRule = deps.getRule || getLockRule;
  const rule = await getRule(env, tokenId);
  if (!rule || SKIPPED_STATES.has(rule.state)) return { ok: true, skipped: true };

  const now = (deps.now || (() => new Date()))();
  if (rule.targetDate < chinaDate(now)) return await terminal(env, tokenId, rule, "expired", { lastError: "目标场次已过期" }, deps);

  const fetchCinema = deps.fetchCinema || fetchCinemaDetail;
  const exactShows = deps.findShows || findExactShows;
  const loadSession = deps.loadSession || loadLockSession;
  const fetchSeats = deps.fetchSeats || fetchSeatMap;
  const createOrder = deps.createOrder || createUnpaidOrder;
  let show;
  let session;
  let seatMap;
  try {
    const cinema = await fetchCinema(rule.cinemaId);
    const matches = exactShows(cinema, rule);
    if (!matches.length) return { ok: true, waiting: true };
    if (matches.length !== 1) return await terminal(env, tokenId, rule, "failed", { lastError: "目标日期存在多个相同时间场次" }, deps);
    show = matches[0];
    session = await loadSession(env, tokenId);
    seatMap = await fetchSeats(session, { cinemaId: rule.cinemaId, movieId: rule.movieId, seqNo: String(show.seqNo) });
    if (String(seatMap?.seqNo) !== String(show.seqNo) || !seatsMatch(rule, seatMap)) {
      return await terminal(env, tokenId, rule, "failed", { lastError: "所选未来座位不可用或影厅布局已变化" }, deps);
    }
  } catch (error) {
    await saveRule(env, tokenId, rule, { lastError: messageFor(error) }, deps);
    return { ok: false, waiting: true };
  }

  const matching = await saveRule(env, tokenId, rule, {
    state: "matching", attemptStartedAt: new Date(now).toISOString(), seqNo: String(show.seqNo), lastError: null
  }, deps);
  try {
    const order = await createOrder(session, seatMap, matching.seats.map((seat) => seat.seatNo));
    return await terminal(env, tokenId, matching, "locked", {
      orderId: String(order.orderId), payLeftSecond: order.payLeftSecond ?? null, lockedAt: new Date(now).toISOString(), lastError: null
    }, deps);
  } catch (error) {
    const uncertain = !(error instanceof OrderAttemptError) || error.uncertain === true;
    return await terminal(env, tokenId, matching, uncertain ? "unknown" : "failed", { lastError: messageFor(error) }, deps);
  }
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
  }

  async fetch(request) {
    if (request.method !== "POST") return Response.json({ error: "Method Not Allowed" }, { status: 405 });
    if (this.running) {
      if (request.headers.get("X-Lock-Action") === "create") {
        return Response.json({ ok: false, error: "已有进行中的锁座规则" }, { status: 409 });
      }
      return Response.json({ ok: true, skipped: true }, { status: 202 });
    }
    this.running = true;
    try {
      const { action, tokenId, input } = await request.json();
      checkedTokenId(tokenId);
      if (action === "create") {
        const createRule = this.deps.createRule || createLockRule;
        const rule = await createRule(this.env, tokenId, input, this.deps);
        return Response.json({ ok: true, rule }, { status: 201 });
      }
      if (action !== "run") return Response.json({ error: "Bad Request" }, { status: 400 });
      const getRule = this.deps.getRule || getLockRule;
      const rule = await getRule(this.env, tokenId);
      if (rule && await this.state.storage.get("terminalRuleId") === rule.id) return Response.json({ ok: true, skipped: true });
      const result = await runOneLockRule(this.env, tokenId, this.deps);
      const latest = await getRule(this.env, tokenId);
      if (latest && TERMINAL_STATES.has(latest.state)) await this.state.storage.put("terminalRuleId", latest.id);
      return Response.json(result);
    } catch (error) {
      return Response.json({ ok: false, error: error.message === "已有进行中的锁座规则" ? error.message : "Bad Request" }, {
        status: error.message === "已有进行中的锁座规则" ? 409 : 400
      });
    } finally {
      this.running = false;
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
  if (response.status === 400) throw new Error("锁座参数无效");
  throw new Error("锁座服务暂时不可用");
}

export async function runScheduledLocks(env) {
  if (String(env.LOCK_AUTOMATION_ENABLED) !== "true") return;
  for (const token of await getManagedTokens(env)) {
    try {
      const stub = env.LOCK_COORDINATOR.get(env.LOCK_COORDINATOR.idFromName(token.id));
      await stub.fetch(lockRequest("run", token.id));
    } catch {
    }
  }
}
