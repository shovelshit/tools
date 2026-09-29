const SAFE_FIELDS = new Set([
  "phase", "state", "seatCount", "httpStatus",
  "errorName", "errorMessage", "reason", "contentType", "server",
  "mitigation", "bodyLength", "responseHint",
  "responseBody",
  "attemptId", "endpoint", "seqNo", "durationMs", "responseType",
  "runId", "batchId", "nowMs", "pageSize", "processed", "pending",
  "cursor", "nextCursor", "cinemaId", "subscribers", "notifications",
  "lockAttempts", "lockFailures", "completed", "retryable", "cinemaCount",
  "pageReadDurationMs", "dispatchDurationMs", "fetchDurationMs",
  "subscriberDurationMs", "lockDurationMs", "commitDurationMs"
]);

function clean(value, max = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function record(scope, event, fields) {
  const result = { scope, event: clean(event, 80) };
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
    result[key] = typeof value === "number" || typeof value === "boolean" ? value : clean(value);
  }
  return result;
}

export function lockLog(event, fields = {}) {
  console.log(record("maoyan-lock", event, fields));
}

export function lockError(event, fields = {}) {
  console.error(record("maoyan-lock", event, fields));
}

export function monitorError(event, fields = {}) {
  try {
    console.error(record("maoyan-monitor", event, fields));
  } catch {
    // 诊断日志不能改变监控任务结果。
  }
}

export function monitorLog(event, fields = {}) {
  try {
    console.log(record("maoyan-monitor", event, fields));
  } catch {
    // 诊断日志不能改变监控任务结果。
  }
}
