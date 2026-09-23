const LEASE_MS = 120_000;

export async function claimMaintenanceDay(DB, { job, localDate, nowMs }) {
  await DB.prepare(
    "INSERT OR IGNORE INTO maoyan_maintenance_runs(job_id,local_date,lease_until,updated_at) VALUES (?,?,0,?)"
  ).bind(job, localDate, nowMs).run();
  const leaseUntil = nowMs + LEASE_MS;
  const result = await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET lease_until=? " +
    "WHERE job_id=? AND local_date=? AND lease_until<=?"
  ).bind(leaseUntil, job, localDate, nowMs).run();
  return Number(result?.meta?.changes || 0) === 1 ? { leaseUntil } : null;
}

export async function finishMaintenanceDay(DB, { job, localDate, nowMs, leaseUntil, complete }) {
  const current = await DB.prepare(
    "SELECT updated_at FROM maoyan_maintenance_runs WHERE job_id=? AND local_date=? AND lease_until=?"
  ).bind(job, localDate, leaseUntil).first();
  if (!current) throw new Error("维护任务租约已失效");
  const updatedAt = Math.max(nowMs, Number(current.updated_at) + 1);
  const result = await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET completed_at=CASE WHEN ? THEN ? ELSE completed_at END," +
    "lease_until=0,updated_at=? " +
    "WHERE job_id=? AND local_date=? AND lease_until=? AND lease_until>?"
  ).bind(complete ? 1 : 0, nowMs, updatedAt, job, localDate, leaseUntil, nowMs).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new Error("维护任务租约已失效");
  return updatedAt;
}

export async function completeMaintenanceDay(DB, input) {
  return finishMaintenanceDay(DB, { ...input, complete: true });
}

export async function releaseMaintenanceDay(DB, { job, localDate, nowMs, leaseUntil }) {
  const current = await DB.prepare(
    "SELECT updated_at FROM maoyan_maintenance_runs WHERE job_id=? AND local_date=? AND lease_until=?"
  ).bind(job, localDate, leaseUntil).first();
  if (!current) return null;
  const updatedAt = Math.max(nowMs, Number(current.updated_at) + 1);
  const result = await DB.prepare(
    "UPDATE maoyan_maintenance_runs SET lease_until=0,updated_at=? " +
    "WHERE job_id=? AND local_date=? AND lease_until=?"
  ).bind(updatedAt, job, localDate, leaseUntil).run();
  return Number(result?.meta?.changes || 0) === 1 ? updatedAt : null;
}
