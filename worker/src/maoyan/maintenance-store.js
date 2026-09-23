const LEASE_MS = 120_000;

export async function claimMaintenanceDay(DB, { job, localDate, nowMs }) {
  await DB.prepare(
    "INSERT OR IGNORE INTO maoyan_maintenance_runs(job_id,local_date,lease_until,updated_at) VALUES (?,?,0,?)"
  ).bind(job, localDate, nowMs).run();
  const result = await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET lease_until=?,updated_at=? " +
    "WHERE job_id=? AND local_date=? AND completed_at IS NULL AND lease_until<=?"
  ).bind(nowMs + LEASE_MS, nowMs, job, localDate, nowMs).run();
  if (Number(result?.meta?.changes || 0) !== 1) return null;
  const row = await DB.prepare("SELECT cursor FROM maoyan_maintenance_runs WHERE job_id=? AND local_date=?")
    .bind(job, localDate).first();
  return { cursor: row?.cursor || null, leaseUntil: nowMs + LEASE_MS };
}

export async function saveMaintenanceCursor(DB, { job, localDate, cursor, nowMs, leaseUntil }) {
  const result = await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET cursor=?,updated_at=? " +
    "WHERE job_id=? AND local_date=? AND completed_at IS NULL AND lease_until=? AND lease_until>?"
  ).bind(cursor, nowMs, job, localDate, leaseUntil, nowMs).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new Error("维护任务租约已失效");
}

export async function completeMaintenanceDay(DB, { job, localDate, nowMs, leaseUntil }) {
  const result = await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET completed_at=?,lease_until=0,updated_at=? " +
    "WHERE job_id=? AND local_date=? AND completed_at IS NULL AND lease_until=? AND lease_until>?"
  ).bind(nowMs, nowMs, job, localDate, leaseUntil, nowMs).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new Error("维护任务租约已失效");
}

export async function releaseMaintenanceDay(DB, { job, localDate, nowMs, leaseUntil }) {
  await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET lease_until=0,updated_at=? " +
    "WHERE job_id=? AND local_date=? AND completed_at IS NULL AND lease_until=?"
  ).bind(nowMs, job, localDate, leaseUntil).run();
}
