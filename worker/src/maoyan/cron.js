// ---------------- cron 批次解析 ----------------
// 定时批次在两处定义: wrangler.toml [triggers].crons 与下面的 CRON_EXPRESSION
// 修改 crons 时请同步修改 CRON_EXPRESSION, 间隔对齐与前端选项生成都依赖它
// 配置了 CF_API_TOKEN + CF_ACCOUNT_ID 后, 会改为运行时调 Cloudflare API
// 查询真实调度, Dashboard 里改 cron 也能自动同步, 常量仅作回落

export const CRON_EXPRESSION = "*/10 * * * *";
const SCRIPT_NAME = "tools-api";
let cronCache = null; // { expr, ts }

// 运行时解析真实 cron: 优先 Cloudflare API, 失败/未配置回落常量, 结果缓存 5 分钟
export async function resolveCronExpr(env) {
  const now = Date.now();
  if (cronCache && now - cronCache.ts < 300e3) return cronCache.expr;
  let expr = CRON_EXPRESSION;
  try {
    if (env && env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules`,
        { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(8e3) }
      );
      const data = await res.json();
      const cron = data && data.success && Array.isArray(data.result) && data.result[0] && data.result[0].cron;
      if (cron) expr = cron;
    }
  } catch (e) {
    // 查询失败: 沿用常量
  }
  cronCache = { expr, ts: now };
  return expr;
}

// 解析 cron 的批次间隔(分钟):
//   "*/3 * * * *"  -> 3
//   "0 */2 * * *"  -> 120 (分钟固定 + 小时步进)
//   "* * * * *"    -> 1
// 复杂表达式无法用固定批次表达时回落 10(历史默认)
export function cronBatchMinutes(expr = CRON_EXPRESSION) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return 10;
  const min = f[0];
  const hour = f[1];
  if (min === "*" && hour === "*") return 1;
  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep) return Math.max(1, parseInt(minStep[1], 10) || 10);
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) return Math.max(60, (parseInt(hourStep[1], 10) || 1) * 60);
  return 10;
}

// 是否为分钟步进型 cron(每 N 分钟一批, 可精确推算下一批时间)
export function isMinuteStepCron(expr = CRON_EXPRESSION) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return false;
  return f[1] === "*" && (f[0] === "*" || /^\*\/\d+$/.test(f[0]));
}

// cron 表达式的人话描述, 供前端展示; 复杂表达式原样返回
export function describeCron(expr = CRON_EXPRESSION) {
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
