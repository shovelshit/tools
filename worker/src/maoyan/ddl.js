// ---------------- 监控截止日期(DDL) ----------------
// 防止"设完就不管": 每次开始监控刷新一次截止时间, 到期由 cron 自动停止

export const MONITOR_DDL_DAYS = 30;

export function ddlFromNow() {
  return new Date(Date.now() + MONITOR_DDL_DAYS * 86400e3).toISOString();
}

// 只有「明确开启了监控」的配置才谈得上到期:
//   enabled 未设置(只选好影院、从未点「开始监控」)/ 已手动停止(enabled=false) 都不算到期。
// 否则前端加载影院时自动保存的 {cinemaId,...} 会被 cron 误判为到期并写入误导性告警。
export function isExpired(cfg) {
  if (cfg.enabled !== true) return false;
  if (!cfg.monitorDdl) return true;
  return Date.now() > Date.parse(cfg.monitorDdl);
}
