import { json } from "../common/http.js";
import { publicAccount, serviceNow } from "./auth.js";
import { digestEnrollmentIdentity, ENROLLMENT_FINGERPRINT_VERSION } from "./enrollment-identity.js";
import {
  confirmEnrollment, readCapacity, readEnrollmentStatus, readServiceSettings, reserveEnrollment
} from "./enrollment-store.js";
import { readResourceSummary } from "./resource-budget.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class EnrollmentApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function allowedOrigin(env) {
  try { return new URL(String(env.ENROLLMENT_ORIGIN || "")).origin; } catch { return ""; }
}

function response(env, data, status = 200, origin = "") {
  const configured = allowedOrigin(env);
  return json(data, status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": configured || "null",
    Vary: "Origin"
  });
}

function requireOrigin(request, env) {
  const origin = String(request.headers.get("Origin") || "");
  if (!origin || origin !== allowedOrigin(env)) throw new EnrollmentApiError("FORBIDDEN", "申请来源无效", 403);
  return origin;
}

async function smallJson(request) {
  if (!String(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new EnrollmentApiError("INVALID_REQUEST", "请求格式无效");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > 4096) throw new EnrollmentApiError("INVALID_REQUEST", "请求内容过大", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 4096) throw new EnrollmentApiError("INVALID_REQUEST", "请求内容过大", 413);
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object");
    return body;
  } catch {
    throw new EnrollmentApiError("INVALID_REQUEST", "请求格式无效");
  }
}

function requestId(value) {
  const normalized = String(value || "").trim();
  if (!UUID.test(normalized)) throw new EnrollmentApiError("INVALID_REQUEST", "申请标识无效");
  return normalized;
}

function publicReservation(result) {
  return {
    status: result.status,
    ...(result.reservationId ? { reservationId: result.reservationId } : {}),
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    ...(result.key ? { key: result.key } : {})
  };
}

export async function verifyTurnstile(env, {
  token, edgeIp, requestId: id, hostname, action
}, fetchImpl = fetch, nowMs = Date.now()) {
  if (!env.TURNSTILE_SECRET_KEY || !token) throw new EnrollmentApiError("TURNSTILE_INVALID", "人机验证无效");
  let result;
  try {
    const body = new URLSearchParams({
      secret: String(env.TURNSTILE_SECRET_KEY), response: String(token), remoteip: String(edgeIp), idempotency_key: String(id)
    });
    const response = await fetchImpl(VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("http");
    result = await response.json();
  } catch {
    throw new EnrollmentApiError("TURNSTILE_UNAVAILABLE", "人机验证服务暂时不可用", 503);
  }
  const challengeAt = Date.parse(result.challenge_ts || "");
  if (result.success !== true || result.hostname !== hostname || result.action !== action ||
      !Number.isFinite(challengeAt) || Math.abs(nowMs - challengeAt) > 300_000) {
    throw new EnrollmentApiError("TURNSTILE_INVALID", "人机验证无效");
  }
}

function errorResponse(env, error, origin = "") {
  const code = error?.code || "INTERNAL_ERROR";
  const status = error?.status || (code === "CAPACITY_FULL" || code === "FINGERPRINT_IN_USE" || code === "REQUEST_CONFLICT" ? 409
    : code === "RESERVATION_EXPIRED" ? 410 : code === "SERVICE_UNAVAILABLE" ? 503
      : code === "INVALID_REQUEST" || code === "INVALID_RESERVATION" ? 400 : 500);
  return response(env, { ok: false, code, error: error?.message || "服务暂时不可用" }, status, origin);
}

export async function handleEnrollmentApi(request, env, url, { fetchImpl = fetch } = {}) {
  if (!url.pathname.startsWith("/api/enrollment/")) return null;
  let origin = "";
  try {
    if (request.method === "OPTIONS") {
      origin = requireOrigin(request, env);
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Token",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin"
        }
      });
    }
    if (url.pathname === "/api/enrollment/config" && request.method === "GET") {
      const settings = await readServiceSettings(env.DB);
      const capacity = await readCapacity(env.DB, serviceNow(env));
      return response(env, {
        ok: true,
        enabled: settings.publicSignupEnabled,
        capacity,
        validDays: settings.defaultValidDays,
        fingerprintVersion: ENROLLMENT_FINGERPRINT_VERSION,
        turnstileSiteKey: String(env.TURNSTILE_SITE_KEY || ""),
        workerUrl: String(env.PUBLIC_WORKER_URL || new URL(request.url).origin),
        webUrl: String(env.PUBLIC_WEB_URL || allowedOrigin(env)),
        sourceUrl: String(env.SOURCE_URL || "https://github.com/shovelshit/tools")
      });
    }
    if (url.pathname === "/api/enrollment/status" && request.method === "GET") {
      const id = requestId(url.searchParams.get("request_id"));
      return response(env, { ok: true, ...await readEnrollmentStatus(env.DB, id, serviceNow(env)) });
    }
    origin = requireOrigin(request, env);
    if (url.pathname === "/api/enrollment/reserve" && request.method === "POST") {
      const body = await smallJson(request);
      const id = requestId(body.requestId);
      const edgeIp = String(request.headers.get("CF-Connecting-IP") || "");
      const identity = await digestEnrollmentIdentity(env, {
        fingerprint: body.fingerprint, version: body.version, edgeIp
      });
      const existing = await readEnrollmentStatus(env.DB, id, serviceNow(env));
      if (existing.status !== "missing") {
        const replay = await reserveEnrollment(env, { requestId: id, ...identity, nowMs: serviceNow(env) });
        return response(env, { ok: true, ...publicReservation(replay) }, 200, origin);
      }
      const settings = await readServiceSettings(env.DB);
      if (!settings.publicSignupEnabled) throw new EnrollmentApiError("ENROLLMENT_DISABLED", "当前未开放申请", 403);
      const resources = await readResourceSummary(env, serviceNow(env));
      if (!resources.admissionAllowed) throw new EnrollmentApiError("RESOURCE_EXHAUSTED", "当前资源已用尽", 503);
      await verifyTurnstile(env, {
        token: body.turnstileToken,
        edgeIp,
        requestId: id,
        hostname: String(env.ENROLLMENT_HOSTNAME || ""),
        action: "enroll"
      }, fetchImpl, serviceNow(env));
      const result = await reserveEnrollment(env, { requestId: id, ...identity, nowMs: serviceNow(env) });
      return response(env, { ok: true, ...publicReservation(result) }, result.key ? 201 : 200, origin);
    }
    if (url.pathname === "/api/enrollment/confirm" && request.method === "POST") {
      const body = await smallJson(request);
      const result = await confirmEnrollment(env, {
        requestId: requestId(body.requestId),
        key: String(request.headers.get("X-Token") || ""),
        nowMs: serviceNow(env)
      });
      return response(env, {
        ok: true,
        account: publicAccount(result.account, serviceNow(env)),
        replayed: result.replayed === true
      }, 200, origin);
    }
    return response(env, { ok: false, code: "NOT_FOUND", error: "Not Found" }, 404, origin);
  } catch (error) {
    return errorResponse(env, error, origin);
  }
}
