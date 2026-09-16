function mapAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    remark: row.remark || "",
    state: row.state,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    archiveReason: row.archive_reason || null,
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    source: row.source,
    version: Number(row.version)
  };
}

export function accountStatus(account, nowMs = Date.now()) {
  if (account?.state === "revoked") return "revoked";
  if (account?.role !== "admin" && (!Number.isFinite(account?.expiresAt) || nowMs >= account.expiresAt)) {
    return "expired";
  }
  return account?.state === "suspended" ? "suspended" : "active";
}

export async function hashAccessKey(raw) {
  const bytes = new TextEncoder().encode(String(raw || ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ACCOUNT_COLUMNS = "id,role,remark,state,created_at,expires_at,archived_at,archive_reason,revoked_at,source,version";

export async function getAccount(DB, userId) {
  const row = await DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id=?`).bind(String(userId || "")).first();
  return mapAccount(row);
}

export async function getAccountByKey(DB, raw) {
  if (!raw) return null;
  const tokenHash = await hashAccessKey(raw);
  const row = await DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS.split(",").map((column) => `u.${column}`).join(",")} ` +
    "FROM users u JOIN access_keys k ON k.user_id=u.id WHERE k.token_hash=?"
  ).bind(tokenHash).first();
  return mapAccount(row);
}
