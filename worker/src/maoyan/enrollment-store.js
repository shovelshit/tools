import { accountStatus, getAccount, hashAccessKey } from "./accounts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVATION_MS = 5 * 60 * 1000;

class EnrollmentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new EnrollmentError(code, message);
}

function required(value, code = "INVALID_REQUEST") {
  const normalized = String(value || "").trim();
  if (!normalized) fail(code, "请求参数无效");
  return normalized;
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function translateDatabaseError(error) {
  const message = String(error?.message || error);
  if (message.includes("CAPACITY_FULL") || message.includes("CAPACITY_BELOW_USAGE")) {
    return new EnrollmentError("CAPACITY_FULL", "当前资源已用尽");
  }
  if (message.includes("fingerprint_bindings.fingerprint_digest")) {
    return new EnrollmentError("FINGERPRINT_IN_USE", "当前浏览器已有有效账号或待确认申请");
  }
  if (message.includes("mutation_guards.ok") || message.includes("CHECK constraint failed: ok = 1")) {
    return new EnrollmentError("CONFLICT", "请求状态已变化，请刷新后重试");
  }
  return error;
}

async function settings(DB) {
  const row = await DB.prepare(
    "SELECT max_users,default_valid_days FROM service_settings WHERE id=1"
  ).first();
  if (!row) fail("SERVICE_UNAVAILABLE", "账号容量尚未配置");
  return { maxUsers: Number(row.max_users), defaultValidDays: Number(row.default_valid_days) };
}

export async function readCapacity(DB, nowMs = Date.now()) {
  const config = await settings(DB);
  const users = await DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role='user' AND state!='revoked' AND expires_at>?"
  ).bind(nowMs).first();
  const reservations = await DB.prepare(
    "SELECT COUNT(*) AS n FROM enrollment_reservations WHERE expires_at>?"
  ).bind(nowMs).first();
  const used = Number(users?.n || 0) + Number(reservations?.n || 0);
  return { maxUsers: config.maxUsers, used, remaining: Math.max(0, config.maxUsers - used) };
}

async function reservationByRequest(DB, requestId) {
  return await DB.prepare(
    "SELECT reservation_id,request_id,user_id,token_hash,fingerprint_digest,fingerprint_version," +
    "initial_ip_digest,created_at,expires_at FROM enrollment_reservations WHERE request_id=?"
  ).bind(requestId).first();
}

async function claimByRequest(DB, requestId) {
  return await DB.prepare(
    "SELECT user_id,fingerprint_digest,fingerprint_version,initial_ip_digest,request_id,created_at " +
    "FROM enrollment_claims WHERE request_id=?"
  ).bind(requestId).first();
}

export async function reserveEnrollment(env, input) {
  const requestId = required(input?.requestId);
  const fingerprintDigest = required(input?.fingerprintDigest);
  const fingerprintVersion = required(input?.fingerprintVersion);
  const ipDigest = required(input?.ipDigest);
  const nowMs = Number(input?.nowMs ?? Date.now());
  const priorClaim = await claimByRequest(env.DB, requestId);
  if (priorClaim) {
    if (priorClaim.fingerprint_digest !== fingerprintDigest) fail("REQUEST_CONFLICT", "申请标识已被使用");
    return { status: "confirmed", userId: priorClaim.user_id };
  }
  const prior = await reservationByRequest(env.DB, requestId);
  if (prior) {
    if (prior.fingerprint_digest !== fingerprintDigest) fail("REQUEST_CONFLICT", "申请标识已被使用");
    if (Number(prior.expires_at) <= nowMs) fail("RESERVATION_EXPIRED", "领取预留已过期，请重新申请");
    return { status: "reserved", reservationId: prior.reservation_id, expiresAt: Number(prior.expires_at) };
  }

  const reservationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const key = randomKey();
  const tokenHash = await hashAccessKey(key);
  const expiresAt = nowMs + RESERVATION_MS;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM fingerprint_bindings WHERE fingerprint_digest=? AND bound_until<=?"
      ).bind(fingerprintDigest, nowMs),
      env.DB.prepare(
        "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN NOT EXISTS (" +
        "SELECT 1 FROM fingerprint_bindings WHERE fingerprint_digest=? AND bound_until>?) THEN 1 ELSE 0 END)"
      ).bind(requestId, fingerprintDigest, nowMs),
      env.DB.prepare(
        "INSERT INTO enrollment_reservations(reservation_id,request_id,user_id,token_hash," +
        "fingerprint_digest,fingerprint_version,initial_ip_digest,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)"
      ).bind(reservationId, requestId, userId, tokenHash, fingerprintDigest, fingerprintVersion, ipDigest, nowMs, expiresAt),
      env.DB.prepare(
        "INSERT INTO fingerprint_bindings(fingerprint_digest,fingerprint_version,reservation_id,bound_until,version) " +
        "VALUES (?,?,?,?,1)"
      ).bind(fingerprintDigest, fingerprintVersion, reservationId, expiresAt),
      env.DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId)
    ]);
  } catch (error) {
    const concurrent = await reservationByRequest(env.DB, requestId);
    if (concurrent?.fingerprint_digest === fingerprintDigest && Number(concurrent.expires_at) > nowMs) {
      return { status: "reserved", reservationId: concurrent.reservation_id, expiresAt: Number(concurrent.expires_at) };
    }
    const occupied = await env.DB.prepare(
      "SELECT 1 AS ok FROM fingerprint_bindings WHERE fingerprint_digest=? AND bound_until>?"
    ).bind(fingerprintDigest, nowMs).first();
    if (occupied) fail("FINGERPRINT_IN_USE", "当前浏览器已有有效账号或待确认申请");
    throw translateDatabaseError(error);
  }
  return { status: "reserved", reservationId, expiresAt, key };
}

export async function confirmEnrollment(env, input) {
  const requestId = required(input?.requestId);
  const key = required(input?.key);
  const nowMs = Number(input?.nowMs ?? Date.now());
  const tokenHash = await hashAccessKey(key);
  const claim = await claimByRequest(env.DB, requestId);
  if (claim) {
    const owned = await env.DB.prepare(
      "SELECT user_id FROM access_keys WHERE user_id=? AND token_hash=?"
    ).bind(claim.user_id, tokenHash).first();
    if (!owned) fail("INVALID_RESERVATION", "领取凭据无效");
    return { account: await getAccount(env.DB, claim.user_id), replayed: true };
  }
  const reservation = await reservationByRequest(env.DB, requestId);
  if (!reservation || reservation.token_hash !== tokenHash) fail("INVALID_RESERVATION", "领取凭据无效");
  if (Number(reservation.expires_at) <= nowMs) fail("RESERVATION_EXPIRED", "领取预留已过期，请重新申请");
  const config = await settings(env.DB);
  const expiresAt = nowMs + config.defaultValidDays * DAY_MS;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
        "SELECT 1 FROM enrollment_reservations WHERE request_id=? AND token_hash=? AND expires_at>?) THEN 1 ELSE 0 END)"
      ).bind(requestId, requestId, tokenHash, nowMs),
      env.DB.prepare(
        "DELETE FROM fingerprint_bindings WHERE fingerprint_digest=? AND reservation_id=?"
      ).bind(reservation.fingerprint_digest, reservation.reservation_id),
      env.DB.prepare("DELETE FROM enrollment_reservations WHERE request_id=?").bind(requestId),
      env.DB.prepare(
        "INSERT INTO users(id,role,state,created_at,expires_at,source,version) VALUES (?,'user','active',?,?,'public',1)"
      ).bind(reservation.user_id, nowMs, expiresAt),
      env.DB.prepare(
        "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
      ).bind(reservation.user_id, tokenHash, key.slice(0, 4), key.slice(-4), nowMs),
      env.DB.prepare(
        "INSERT INTO enrollment_claims(user_id,fingerprint_digest,fingerprint_version,initial_ip_digest,request_id,created_at) " +
        "VALUES (?,?,?,?,?,?)"
      ).bind(reservation.user_id, reservation.fingerprint_digest, reservation.fingerprint_version,
        reservation.initial_ip_digest, requestId, nowMs),
      env.DB.prepare(
        "INSERT INTO fingerprint_bindings(fingerprint_digest,fingerprint_version,user_id,bound_until,version) VALUES (?,?,?,?,1)"
      ).bind(reservation.fingerprint_digest, reservation.fingerprint_version, reservation.user_id, expiresAt),
      env.DB.prepare(
        "INSERT INTO audit_events(event_type,subject_user_id,request_id,data,created_at) VALUES ('enrollment_confirmed',?,?,?,?)"
      ).bind(reservation.user_id, requestId, "{}", nowMs),
      env.DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId)
    ]);
  } catch (error) {
    const completed = await claimByRequest(env.DB, requestId);
    if (completed) return { account: await getAccount(env.DB, completed.user_id), replayed: true };
    throw translateDatabaseError(error);
  }
  return { account: await getAccount(env.DB, reservation.user_id), replayed: false };
}

export async function renewAccount(env, input) {
  const userId = required(input?.userId);
  const requestId = required(input?.requestId);
  const expectedVersion = Number(input?.expectedVersion);
  const nowMs = Number(input?.nowMs ?? Date.now());
  const operation = await env.DB.prepare(
    "SELECT result_expires_at FROM account_operations WHERE user_id=? AND request_id=? AND kind='renew'"
  ).bind(userId, requestId).first();
  if (operation) return { account: await getAccount(env.DB, userId), replayed: true };

  const account = await getAccount(env.DB, userId);
  if (!account) fail("ACCOUNT_NOT_FOUND", "账号不存在");
  if (account.role !== "user") fail("ACCOUNT_NOT_RENEWABLE", "管理员账号无需续期");
  if (account.state === "suspended") fail("ACCOUNT_SUSPENDED", "账号已暂停");
  if (account.state === "revoked") fail("ACCOUNT_REVOKED", "账号已撤销");
  if (accountStatus(account, nowMs) !== "expired") fail("ACCOUNT_NOT_EXPIRED", "账号尚未到期");
  if (account.version !== expectedVersion) fail("VERSION_CONFLICT", "账号状态已变化");

  const config = await settings(env.DB);
  const expiresAt = nowMs + config.defaultValidDays * DAY_MS;
  const claim = await env.DB.prepare(
    "SELECT fingerprint_digest,fingerprint_version FROM enrollment_claims WHERE user_id=? " +
    "AND fingerprint_digest IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
  const guardSql = claim
    ? "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
      "SELECT 1 FROM users WHERE id=? AND role='user' AND state='active' AND version=? AND expires_at<=?" +
      ") AND NOT EXISTS (SELECT 1 FROM fingerprint_bindings WHERE fingerprint_digest=? AND user_id!=? AND bound_until>?) THEN 1 ELSE 0 END)"
    : "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
      "SELECT 1 FROM users WHERE id=? AND role='user' AND state='active' AND version=? AND expires_at<=?" +
      ") THEN 1 ELSE 0 END)";
  const statements = [
    claim
      ? env.DB.prepare(guardSql).bind(requestId, userId, expectedVersion, nowMs, claim.fingerprint_digest, userId, nowMs)
      : env.DB.prepare(guardSql).bind(requestId, userId, expectedVersion, nowMs)
  ];
  if (claim) {
    statements.push(env.DB.prepare(
      "DELETE FROM fingerprint_bindings WHERE fingerprint_digest=? AND (user_id=? OR bound_until<=?)"
    ).bind(claim.fingerprint_digest, userId, nowMs));
  }
  statements.push(
    env.DB.prepare(
      "UPDATE users SET expires_at=?,archived_at=NULL,archive_reason=NULL,version=version+1 " +
      "WHERE id=? AND role='user' AND state='active' AND version=? AND expires_at<=?"
    ).bind(expiresAt, userId, expectedVersion, nowMs)
  );
  if (claim) {
    statements.push(env.DB.prepare(
      "INSERT INTO fingerprint_bindings(fingerprint_digest,fingerprint_version,user_id,bound_until,version) VALUES (?,?,?,?,1)"
    ).bind(claim.fingerprint_digest, claim.fingerprint_version, userId, expiresAt));
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO account_operations(user_id,request_id,kind,original_version,result_expires_at,created_at) " +
      "VALUES (?,?,'renew',?,?,?)"
    ).bind(userId, requestId, expectedVersion, expiresAt, nowMs),
    env.DB.prepare(
      "INSERT INTO audit_events(event_type,actor_user_id,subject_user_id,request_id,data,created_at) " +
      "VALUES ('account_renewed',?,?,?,?,?)"
    ).bind(userId, userId, requestId, "{}", nowMs),
    env.DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId)
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const replay = await env.DB.prepare(
      "SELECT 1 AS ok FROM account_operations WHERE user_id=? AND request_id=? AND kind='renew'"
    ).bind(userId, requestId).first();
    if (replay) return { account: await getAccount(env.DB, userId), replayed: true };
    throw translateDatabaseError(error);
  }
  return { account: await getAccount(env.DB, userId), replayed: false };
}

export async function createManagedAccount(env, input) {
  const requestId = required(input?.requestId);
  const nowMs = Number(input?.nowMs ?? Date.now());
  const prior = await claimByRequest(env.DB, requestId);
  if (prior) return { account: await getAccount(env.DB, prior.user_id), replayed: true };
  const config = await settings(env.DB);
  const userId = crypto.randomUUID();
  const key = randomKey();
  const tokenHash = await hashAccessKey(key);
  const expiresAt = nowMs + config.defaultValidDays * DAY_MS;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id,role,remark,state,created_at,expires_at,source,version) VALUES (?,'user',?,'active',?,?,'managed',1)"
      ).bind(userId, String(input?.remark || "").trim(), nowMs, expiresAt),
      env.DB.prepare(
        "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
      ).bind(userId, tokenHash, key.slice(0, 4), key.slice(-4), nowMs),
      env.DB.prepare(
        "INSERT INTO enrollment_claims(user_id,request_id,created_at) VALUES (?,?,?)"
      ).bind(userId, requestId, nowMs),
      env.DB.prepare(
        "INSERT INTO audit_events(event_type,subject_user_id,request_id,data,created_at) VALUES ('managed_account_created',?,?,?,?)"
      ).bind(userId, requestId, "{}", nowMs)
    ]);
  } catch (error) {
    const concurrent = await claimByRequest(env.DB, requestId);
    if (concurrent) return { account: await getAccount(env.DB, concurrent.user_id), replayed: true };
    throw translateDatabaseError(error);
  }
  return { account: await getAccount(env.DB, userId), key, replayed: false };
}

export async function updateManagedAccount(env, input) {
  const userId = required(input?.userId);
  const expectedVersion = Number(input?.expectedVersion);
  const nowMs = Number(input?.nowMs ?? Date.now());
  const account = await getAccount(env.DB, userId);
  if (!account) fail("ACCOUNT_NOT_FOUND", "账号不存在");
  if (account.version !== expectedVersion) fail("VERSION_CONFLICT", "账号状态已变化");
  const patch = input?.patch || {};
  const state = patch.state === undefined ? account.state : String(patch.state);
  if (!['active', 'suspended', 'revoked'].includes(state)) fail("INVALID_REQUEST", "账号状态无效");
  if (account.state === "revoked" && state !== "revoked") fail("ACCOUNT_REVOKED", "已撤销账号不能恢复");
  const remark = patch.remark === undefined ? account.remark : String(patch.remark).trim();
  const expiresAt = patch.expiresAt === undefined ? account.expiresAt : Number(patch.expiresAt);
  const revokedAt = state === "revoked" ? (account.revokedAt || nowMs) : null;
  const requestId = `manage:${userId}:${expectedVersion}`;
  const claim = account.role === "user" ? await env.DB.prepare(
    "SELECT fingerprint_digest,fingerprint_version FROM enrollment_claims WHERE user_id=? " +
    "AND fingerprint_digest IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first() : null;
  const needsBinding = Boolean(claim && state !== "revoked" && Number.isFinite(expiresAt) && expiresAt > nowMs);
  if (needsBinding) {
    const occupied = await env.DB.prepare(
      "SELECT 1 AS ok FROM fingerprint_bindings WHERE fingerprint_digest=? AND user_id!=? AND bound_until>?"
    ).bind(claim.fingerprint_digest, userId, nowMs).first();
    if (occupied) fail("FINGERPRINT_IN_USE", "当前浏览器已有有效账号或待确认申请");
  }
  const guard = needsBinding
    ? env.DB.prepare(
      "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
      "SELECT 1 FROM users WHERE id=? AND version=?) AND NOT EXISTS (" +
      "SELECT 1 FROM fingerprint_bindings WHERE fingerprint_digest=? AND user_id!=? AND bound_until>?) THEN 1 ELSE 0 END)"
    ).bind(requestId, userId, expectedVersion, claim.fingerprint_digest, userId, nowMs)
    : env.DB.prepare(
      "INSERT INTO mutation_guards(request_id,ok) VALUES (?,CASE WHEN EXISTS (" +
      "SELECT 1 FROM users WHERE id=? AND version=?) THEN 1 ELSE 0 END)"
    ).bind(requestId, userId, expectedVersion);
  const statements = [guard];
  if (needsBinding) {
    statements.push(env.DB.prepare(
      "DELETE FROM fingerprint_bindings WHERE fingerprint_digest=? AND (user_id=? OR bound_until<=?)"
    ).bind(claim.fingerprint_digest, userId, nowMs));
  }
  statements.push(
    env.DB.prepare(
      "UPDATE users SET remark=?,state=?,expires_at=?,revoked_at=?,version=version+1 WHERE id=? AND version=?"
    ).bind(remark, state, expiresAt, revokedAt, userId, expectedVersion)
  );
  if (needsBinding) {
    statements.push(env.DB.prepare(
      "INSERT INTO fingerprint_bindings(fingerprint_digest,fingerprint_version,user_id,bound_until,version) VALUES (?,?,?,?,1)"
    ).bind(claim.fingerprint_digest, claim.fingerprint_version, userId, expiresAt));
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO audit_events(event_type,subject_user_id,data,created_at) VALUES ('account_updated',?,?,?)"
    ).bind(userId, JSON.stringify({ state }), nowMs),
    env.DB.prepare("DELETE FROM mutation_guards WHERE request_id=?").bind(requestId)
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (needsBinding) {
      const occupied = await env.DB.prepare(
        "SELECT 1 AS ok FROM fingerprint_bindings WHERE fingerprint_digest=? AND user_id!=? AND bound_until>?"
      ).bind(claim.fingerprint_digest, userId, nowMs).first();
      if (occupied) fail("FINGERPRINT_IN_USE", "当前浏览器已有有效账号或待确认申请");
    }
    throw translateDatabaseError(error);
  }
  return await getAccount(env.DB, userId);
}
