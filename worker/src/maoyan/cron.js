// ---------------- cron 批次解析 ----------------
// 定时批次在两处定义: wrangler.toml [triggers].crons 与下面的 CRON_EXPRESSION
// 修改 crons 时请同步修改 CRON_EXPRESSION, 间隔对齐与前端选项生成都依赖它

export const CRON_EXPRESSION = "*/10 * * * *";

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
