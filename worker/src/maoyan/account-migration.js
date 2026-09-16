import { getAccount, hashAccessKey } from "./accounts.js";
import { getAccountMigration } from "./db.js";

const MIGRATION_NAME = "accounts-v1";
const DAY_MS = 24 * 60 * 60 * 1000;

function createdAtMillis(value, fallback) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function migrateAccounts(env, { nowMs = Date.now() } = {}) {
  if (!env?.DB) throw new Error("未绑定 D1 数据库(DB)");
  if (!Number.isFinite(nowMs)) throw new Error("迁移时间无效");

  const applied = await getAccountMigration(env.DB, MIGRATION_NAME);
  if (applied) {
    return { activatedAt: Number(applied.activated_at), migrated: 0, alreadyApplied: true };
  }

  const settings = await env.DB.prepare(
    "SELECT max_users,default_valid_days FROM service_settings WHERE id=1"
  ).first();
  if (!settings) throw new Error("账号容量尚未配置");
  const { results: legacy } = await env.DB.prepare(
    "SELECT id,token,remark,created_at FROM tokens ORDER BY rowid"
  ).all();
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role='user' AND state!='revoked' AND expires_at>?"
  ).bind(nowMs).first();
  if (Number(existing?.n || 0) + legacy.length > Number(settings.max_users)) {
    throw new Error(`存量普通账号超过账号上限 ${settings.max_users}`);
  }

  const validDays = Number(settings.default_valid_days);
  const rows = await Promise.all(legacy.map(async (entry) => ({
    id: entry.id,
    remark: entry.remark || "",
    createdAt: createdAtMillis(entry.created_at, nowMs),
    expiresAt: nowMs + validDays * DAY_MS,
    tokenHash: await hashAccessKey(entry.token),
    keyPrefix: String(entry.token).slice(0, 4),
    keySuffix: String(entry.token).slice(-4)
  })));
  const payload = JSON.stringify(rows);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO account_migrations(name,activated_at) VALUES (?,?)").bind(MIGRATION_NAME, nowMs),
    env.DB.prepare(
      "INSERT INTO users(id,role,remark,state,created_at,expires_at,source,version) " +
      "SELECT json_extract(value,'$.id'),'user',json_extract(value,'$.remark'),'active'," +
      "json_extract(value,'$.createdAt'),json_extract(value,'$.expiresAt'),'migration',1 " +
      "FROM json_each(?) WHERE true"
    ).bind(payload),
    env.DB.prepare(
      "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) " +
      "SELECT json_extract(value,'$.id'),json_extract(value,'$.tokenHash')," +
      "json_extract(value,'$.keyPrefix'),json_extract(value,'$.keySuffix'),? " +
      "FROM json_each(?) WHERE true"
    ).bind(nowMs, payload),
    env.DB.prepare(
      "INSERT INTO audit_events(event_type,subject_user_id,data,created_at) " +
      "SELECT 'account_migrated',json_extract(value,'$.id'),'{}',? FROM json_each(?) WHERE true"
    ).bind(nowMs, payload),
    env.DB.prepare(
      "INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,baseline_version,next_due_at,updated_at) " +
      "SELECT u.id,COALESCE(json_extract(c.data,'$.cinemaId'),'')," +
      "CASE WHEN json_extract(c.data,'$.enabled')=1 AND COALESCE(json_extract(c.data,'$.cinemaId'),'')!='' THEN 1 ELSE 0 END," +
      "c.version,NULL,?,? FROM users u JOIN user_config c ON c.token_id=u.id " +
      "ON CONFLICT(user_id) DO NOTHING"
    ).bind(nowMs, nowMs),
    env.DB.prepare("DELETE FROM tokens")
  ]);

  return { activatedAt: nowMs, migrated: rows.length, alreadyApplied: false };
}

export async function importLegacyAccount(env, token) {
  const migration = await getAccountMigration(env.DB, MIGRATION_NAME);
  if (!migration) return { imported: false, accountMigrationApplied: false };
  if (!token?.id || !token?.token) return { imported: false, accountMigrationApplied: true };

  const existing = await getAccount(env.DB, token.id);
  if (existing?.state === "revoked") return { imported: false, accountMigrationApplied: true };
  const existingKey = await env.DB.prepare("SELECT user_id FROM access_keys WHERE user_id=?").bind(token.id).first();
  if (existingKey) return { imported: true, accountMigrationApplied: true };

  const settings = await env.DB.prepare(
    "SELECT max_users,default_valid_days FROM service_settings WHERE id=1"
  ).first();
  if (!settings) throw new Error("账号容量尚未配置");
  const activatedAt = Number(migration.activated_at);
  const expiresAt = activatedAt + Number(settings.default_valid_days) * DAY_MS;
  if (!existing) {
    const used = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role='user' AND state!='revoked' AND expires_at>?"
    ).bind(Date.now()).first();
    if (Number(used?.n || 0) >= Number(settings.max_users)) throw new Error("存量普通账号超过账号上限");
  }

  const tokenHash = await hashAccessKey(token.token);
  const createdAt = createdAtMillis(token.createdAt, activatedAt);
  const statements = [];
  if (!existing) {
    statements.push(env.DB.prepare(
      "INSERT INTO users(id,role,remark,state,created_at,expires_at,source,version) VALUES (?,?,?,?,?,?,?,1)"
    ).bind(token.id, "user", token.remark || "", "active", createdAt, expiresAt, "migration"));
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO access_keys(user_id,token_hash,key_prefix,key_suffix,created_at) VALUES (?,?,?,?,?)"
    ).bind(token.id, tokenHash, String(token.token).slice(0, 4), String(token.token).slice(-4), activatedAt),
    env.DB.prepare(
      "INSERT INTO audit_events(event_type,subject_user_id,data,created_at) VALUES ('account_migrated',?,'{}',?)"
    ).bind(token.id, activatedAt),
    env.DB.prepare(
      "INSERT INTO monitor_subscriptions(user_id,cinema_id,enabled,config_version,baseline_version,next_due_at,updated_at) " +
      "SELECT u.id,COALESCE(json_extract(c.data,'$.cinemaId'),'')," +
      "CASE WHEN json_extract(c.data,'$.enabled')=1 AND COALESCE(json_extract(c.data,'$.cinemaId'),'')!='' THEN 1 ELSE 0 END," +
      "c.version,NULL,?,? FROM users u JOIN user_config c ON c.token_id=u.id WHERE u.id=? " +
      "ON CONFLICT(user_id) DO NOTHING"
    ).bind(activatedAt, activatedAt, token.id)
  );
  await env.DB.batch(statements);
  return { imported: true, accountMigrationApplied: true };
}
