// ---------------- 监控截止日期(DDL) ----------------
// 防止"设完就不管": 每次开始监控刷新一次截止时间, 到期由 cron 自动停止

export const MONITOR_DDL_DAYS = 30;

export function ddlFromNow() {
  return new Date(Date.now() + MONITOR_DDL_DAYS * 86400e3).toISOString();
}

// 已手动停止(enabled=false)不算到期; 未设置截止或已过期视为到期, 需重新开始
export function isExpired(cfg) {
  if (cfg.enabled === false) return false;
  if (!cfg.monitorDdl) return true;
  return Date.now() > Date.parse(cfg.monitorDdl);
}
