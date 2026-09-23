const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function minuteInWindow(minute, start, end) {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function businessTime(nowMs, policy) {
  const local = new Date(nowMs + BEIJING_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return {
    localDate: local.toISOString().slice(0, 10),
    monitorOpen: minuteInWindow(minute, policy.monitorStartMinute, policy.monitorEndMinute),
    maintenanceOpen: minuteInWindow(minute, policy.maintenanceStartMinute, policy.maintenanceEndMinute)
  };
}

export function nextMaintenanceStart(nowMs, policy) {
  const localDayStart = Math.floor((nowMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;
  const today = localDayStart + policy.maintenanceStartMinute * 60_000;
  return today > nowMs ? today : today + DAY_MS;
}

function hhmm(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function formatMonitorWindowLabel(policy) {
  const nextDay = policy.monitorStartMinute > policy.monitorEndMinute ? "次日 " : "";
  const end = (policy.monitorEndMinute + 1439) % 1440;
  return `监控时段 ${hhmm(policy.monitorStartMinute)}~${nextDay}${hhmm(end)}`;
}
