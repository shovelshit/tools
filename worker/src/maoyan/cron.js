// ---------------- cron 批次解析 ----------------
// 定时批次在两处定义: wrangler.toml [triggers].crons 与下面的 CRON_EXPRESSION
// 配置了 CF_API_TOKEN + CF_ACCOUNT_ID 后, 会改为运行时调 Cloudflare API
// 查询真实调度(支持多个 cron), Dashboard 里改 cron 也能自动同步, 常量仅作回落

export const CRON_EXPRESSION = "*/3 * * * *";
// 监控窗口(北京时间, 无夏令时): 仅 07:00~22:59 执行 cron 批次(上游抓取+锁座),
// 23:00~次日 06:59 的批次在 runScheduledChecks 入口整体跳过(手动「立即检查」不受限)。
// cron 表达式本身保持分钟步进型: check.js 的去抖与前端下批次推算依赖 minBatchMinutes 解析,
// 若用 "*/3 23 * * *" 这类窗口表达式, 解析会失败回落 10 分钟, 把 3 分钟批次误杀。
export const MONITOR_WINDOW = { startHour: 7, endHour: 23 }; // [7, 23) 北京时间小时
export const MONITOR_WINDOW_LABEL = "监控时段 07:00~22:59";
export function inMonitorWindow(nowMs) {
  const bjHour = new Date((Number(nowMs) || Date.now()) + 8 * 3600e3).getUTCHours();
  return bjHour >= MONITOR_WINDOW.startHour && bjHour < MONITOR_WINDOW.endHour;
}
const SCRIPT_NAME = "tools-api";
let cronCache = null; // { exprs, ts }

// 运行时解析真实 cron 列表: 优先 Cloudflare API, 失败/未配置回落常量, 结果缓存 5 分钟
export async function resolveCronExprs(env) {
  const now = Date.now();
  if (cronCache && now - cronCache.ts < 300e3) return cronCache.exprs;
  let exprs = [CRON_EXPRESSION];
  try {
    if (env && env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules`,
        { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(8e3) }
      );
      const data = await res.json();
      const list = data && data.success && Array.isArray(data.result)
        ? data.result.map((s) => s && s.cron).filter(Boolean)
        : [];
      if (list.length) exprs = list;
    }
  } catch (e) {
    // 查询失败: 沿用常量
  }
  if (!exprs.length) exprs = [CRON_EXPRESSION];
  cronCache = { exprs, ts: now };
  return exprs;
}

// 单个表达式的批次间隔(分钟); 复杂表达式返回 null
//   "*/3 * * * *"  -> 3
//   "30 */2 * * *" -> 120 (分钟固定 + 小时步进)
//   "0 8 * * *"    -> 1440 (每天一次)
export function parseBatchMinutes(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (min === "*" && hour === "*") return 1;
  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*") return Math.max(1, parseInt(minStep[1], 10) || 1);
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep && /^\d+$/.test(min)) return Math.max(60, (parseInt(hourStep[1], 10) || 1) * 60);
  if (
    /^\d+$/.test(min) && /^\d+$/.test(hour) &&
    dom === "*" && mon === "*" && dow === "*"
  ) return 1440;
  return null;
}

// 多个 cron 中最短批次间隔(分钟); 全部无法解析时回落 10
export function minBatchMinutes(exprs) {
  const vals = (exprs || []).map(parseBatchMinutes).filter((v) => v !== null);
  return vals.length ? Math.min(...vals) : 10;
}

// cron 表达式的人话描述, 供前端展示; 复杂表达式原样返回
export function describeCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return String(expr || "");
  const [min, hour, dom, mon, dow] = f;
  const hm = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  const isNum = (s) => /^\d+$/.test(s);
  if (min === "*" && hour === "*") return "每分钟一批";
  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*") return `每 ${minStep[1]} 分钟一批`;
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep && isNum(min)) return `每 ${hourStep[1]} 小时的第 ${min} 分钟一批`;
  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*" && dow === "*") {
    return `每天 ${hm} 一批`;
  }
  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*" && isNum(dow)) {
    const week = ["日", "一", "二", "三", "四", "五", "六"];
    return `每周${week[Number(dow) % 7]} ${hm} 一批`;
  }
  return `批次表达式 ${expr}`;
}

// 多个 cron 的描述拼接(去重)
export function describeCrons(exprs) {
  const seen = new Set();
  const out = [];
  for (const e of exprs || []) {
    const d = describeCron(e);
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join("；");
}

// 单个表达式是否为分钟步进型(可精确推算下一批时间)
export function isMinuteStepCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return false;
  return f[1] === "*" && (f[0] === "*" || /^\*\/\d+$/.test(f[0]));
}

// 是否所有表达式都是分钟步进型(前端据此决定是否显示下批次检查时间)
export function isMinuteStepCrons(exprs) {
  return (exprs || []).length > 0 && exprs.every(isMinuteStepCron);
}
