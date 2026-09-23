const FIELDS = ["monitorStartMinute", "monitorEndMinute", "maintenanceStartMinute", "maintenanceEndMinute"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validate(values) {
  if (FIELDS.some((key) => !Number.isInteger(values[key]) || values[key] < 0 || values[key] > 1439) ||
    values.monitorStartMinute === values.monitorEndMinute ||
    values.maintenanceStartMinute >= values.maintenanceEndMinute ||
    values.maintenanceEndMinute - values.maintenanceStartMinute < 3) {
    fail("INVALID_REQUEST", "业务时间窗口无效；维护窗口不能跨自然日且至少持续三分钟");
  }
  for (let minute = values.maintenanceStartMinute; minute < values.maintenanceEndMinute; minute++) {
    const monitor = values.monitorStartMinute < values.monitorEndMinute
      ? minute >= values.monitorStartMinute && minute < values.monitorEndMinute
      : minute >= values.monitorStartMinute || minute < values.monitorEndMinute;
    if (monitor) fail("INVALID_REQUEST", "监控和维护窗口不能重叠");
  }
}

function fromRow(row) {
  if (!row) fail("SERVICE_UNAVAILABLE", "猫眼业务时间配置缺失，请先完成数据库迁移");
  const policy = {
    monitorStartMinute: Number(row.monitor_start_minute),
    monitorEndMinute: Number(row.monitor_end_minute),
    maintenanceStartMinute: Number(row.maintenance_start_minute),
    maintenanceEndMinute: Number(row.maintenance_end_minute),
    version: Number(row.version),
    updatedAt: Number(row.updated_at)
  };
  try { validate(policy); } catch { fail("SERVICE_UNAVAILABLE", "猫眼业务时间配置无效"); }
  return policy;
}

export async function readBusinessPolicy(DB) {
  const row = await DB.prepare(
    "SELECT monitor_start_minute,monitor_end_minute,maintenance_start_minute,maintenance_end_minute,version,updated_at " +
    "FROM maoyan_business_policy WHERE id=1"
  ).first();
  return fromRow(row);
}

export async function updateBusinessPolicy(DB, input) {
  const values = Object.fromEntries(FIELDS.map((key) => [key, input?.[key]]));
  validate(values);
  const expectedVersion = input?.expectedVersion;
  const nowMs = input?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail("INVALID_REQUEST", "业务时间设置参数无效");
  }
  const change = DB.prepare(
    "UPDATE maoyan_business_policy SET monitor_start_minute=?,monitor_end_minute=?," +
    "maintenance_start_minute=?,maintenance_end_minute=?,version=version+1,updated_at=? WHERE id=1 AND version=?"
  ).bind(values.monitorStartMinute, values.monitorEndMinute, values.maintenanceStartMinute, values.maintenanceEndMinute, nowMs, expectedVersion);
  const audit = DB.prepare(
    "INSERT INTO audit_events(event_type,actor_user_id,data,created_at) " +
    "SELECT 'maoyan_business_policy_updated',?,?,? WHERE changes()=1"
  ).bind(input?.actorUserId || null, JSON.stringify({ beforeVersion: expectedVersion, ...values }), nowMs);
  const [result] = await DB.batch([change, audit]);
  if (Number(result?.meta?.changes || 0) !== 1) fail("VERSION_CONFLICT", "业务时间设置已变化，请刷新后重试");
  return readBusinessPolicy(DB);
}
