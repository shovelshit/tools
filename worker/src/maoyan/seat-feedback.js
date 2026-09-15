// ---------------- 座位解析失败反馈(D1 留档) ----------------
// 用户决策: 只存标识不存内容。record = {reportedAt, day, tokenId, cinemaId, movieId, seqNo, source},
// 管理员拿 cinemaId+movieId+seqNo 用 local/ 取证脚本现场重拉座位页复习(自行复习)。
// 主键 fb_key = seatfb:{cinemaId}:{seqNo||"na"}(沿用原 KV key), 同 key 覆盖更新不堆积; 管理端 DELETE 清理。

import * as db from "./db.js";

const PREFIX = "seatfb:";

function chinaDay(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value ? new Date(value) : new Date());
}

export function seatFeedbackKey(cinemaId, seqNo) {
  return `${PREFIX}${String(cinemaId || "na")}:${String(seqNo || "na")}`;
}

// 记录一条反馈。source: "manual"(用户按钮上报) | "auto"(cron/立即锁座解析失败自动留档)。
// 自动留档按中国日期当天去重(分钟级 cron 下同一场次一天只记一条); 手动反馈总是覆盖更新。
// 任何读写失败都静默返回 false, 绝不影响锁座主流程。
export async function recordSeatFeedback(env, input = {}) {
  try {
    const cinemaId = String(input.cinemaId || "").trim();
    if (!cinemaId || !env?.DB) return false;
    const seqNo = String(input.seqNo || "").trim();
    const record = {
      reportedAt: new Date(input.now || Date.now()).toISOString(),
      day: chinaDay(input.now),
      tokenId: String(input.tokenId || ""),
      cinemaId,
      movieId: String(input.movieId || ""),
      seqNo,
      source: input.source === "manual" ? "manual" : "auto"
    };
    const key = seatFeedbackKey(cinemaId, seqNo);
    if (record.source === "auto") {
      const existing = await db.getSeatFeedbackRow(env.DB, key).catch(() => null);
      if (existing?.source === "auto" && existing?.day === record.day) return false;
    }
    await db.putSeatFeedbackRow(env.DB, key, record);
    return true;
  } catch {
    return false;
  }
}

// 管理端全量列表(按 reportedAt 倒序)。单表查询, 替代 KV 版 list+逐 key get。
export async function listSeatFeedback(env) {
  return await db.listSeatFeedbackRows(env.DB);
}

export async function deleteSeatFeedback(env, key) {
  if (!String(key || "").startsWith(PREFIX)) return false;
  await db.deleteSeatFeedbackRow(env.DB, key);
  return true;
}

// 包装 fetchSeatMap: 解析失败(座位图格式无效)时自动留档后原样抛错, 其余错误不记。
// 传入的 deps/options.fetchSeats(mock)不经包装; 留档失败不影响主流程。
export function withSeatFeedback(base, env, context = {}) {
  if (typeof base !== "function") return base;
  return async (session, params) => {
    try {
      return await base(session, params);
    } catch (error) {
      // fetchSeatMap 会给该错误附加「（页面「…」…）」诊断后缀, 因此只按前缀匹配
      if (/^猫眼座位图格式无效/.test(String(error?.message || ""))) {
        await recordSeatFeedback(env, {
          tokenId: context.tokenId,
          cinemaId: params?.cinemaId ?? context.cinemaId,
          movieId: params?.movieId ?? context.movieId,
          seqNo: params?.seqNo,
          source: "auto"
        });
      }
      throw error;
    }
  };
}
