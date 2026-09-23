// ---------------- 监控核心: 场次快照对比 + 变化记录(D1 存储) ----------------

import * as db from "./db.js";
import { getUserConfig } from "./user.js";
import { fetchCinemaDetail } from "./api.js";
import { minBatchMinutes, resolveCronExprs } from "./cron.js";
import { monitorError } from "./log.js";
import { newShowsNotification } from "./notification-copy.js";
import { wakeNotificationDispatcher } from "./notification-outbox.js";

function fmtShow(s) {
  const parts = [`${s.showDate || s.dt || ""} ${s.tm || ""}`, s.lang || "", s.tp || "", s.th || ""];
  if (s.vipPrice) parts.push(`¥${s.vipPrice}${s.vipPriceSuffix || ""}`);
  return parts.filter(Boolean).join(" | ");
}

// status 心跳: 无变化批次不落盘, 最多间隔这么久补一次存活写(同时刷新 lastCheckTs 去抖锚点)。
// lastCheckTs 兼作「上次 status 写入锚点」, /api/status 返回字段与 KV 版一致。
const STATUS_HEARTBEAT_MS = 30 * 60e3;

// 追加一条变化记录(D1 追加式全量历史, /api/status 返回最新 100 条、新在前); config 变更等场景也需要留痕
export async function appendChange(env, tokenId, entry) {
  await db.appendChange(env.DB, tokenId, { time: new Date().toISOString(), ...entry });
}

export async function runCheck(env, manual, token, options = {}) {
  const cfg = await getUserConfig(env, token);
  if (!cfg.cinemaId) {
    return manual ? { ok: false, error: "未配置影院", status: 400 } : { ok: true, skipped: true };
  }
  // 只有「明确开启监控」的配置才需要检查:
  //   从未点过「开始监控」的配置(enabled 未设置)与已手动停止(enabled=false)一样直接跳过,
  //   既不会被误判成"已到期", 也不会让 cron 为没在监控的用户做无意义抓取。
  if (cfg.enabled !== true) {
    if (manual) {
      return cfg.enabled === false
        ? { ok: false, error: "监控已停止，请先在界面恢复监控", status: 409 }
        : { ok: false, error: "尚未开始监控，请先在界面点「开始监控」", status: 409 };
    }
    return { ok: true, skipped: true, stopped: cfg.enabled === false };
  }
  const selected = new Set((cfg.selectedMovieIds || []).map(String));
  const st = await db.getStatus(env.DB, token) || {};
  const now = Date.now();
  // 检查频率完全跟随 cron 批次: 每个触发点都检查一次, 半个最短批次的容差吸收触发时间抖动
  const cronExprs = await resolveCronExprs(env);
  const batchMinutes = minBatchMinutes(cronExprs);
  const batchMs = batchMinutes * 60 * 1e3;
  if (!manual && st.lastCheckTs && now - st.lastCheckTs < batchMs / 2) {
    return { ok: true, skipped: true };
  }
  const snapshot = await db.getSnapshot(env.DB, token);
  try {
    const fetchCinema = options.fetchCinema || fetchCinemaDetail;
    const data = await fetchCinema(cfg.cinemaId);
    const cinemaName = data.showData.cinemaName || "";
    let newTotal = 0;
    let snapshotDirty = false;
    const writes = [];
    const notificationIndexes = [];
  for (const movie of data.showData.movies || []) {
    const idStr = String(movie.id);
    const shows = [];
    for (const day of movie.shows || []) {
      for (const p of day.plist || []) shows.push({ ...p, showDate: day.showDate || day.dt || p.dt || "" });
    }
    const isFirst = !Object.prototype.hasOwnProperty.call(snapshot, idStr);
    const prev = snapshot[idStr] || [];
    const prevSet = new Set(prev);
    const currentSeqNos = shows.map((s) => s.seqNo);
    const currentSet = new Set(currentSeqNos);
    const added = shows.filter((s) => !prevSet.has(s.seqNo));
    // 影片首次出现/新增场次/有场次从上游消失才视为快照变化; 仅顺序变化(集合相同)不算,
    // 让无变化批次跳过 snapshot 落盘
    const changed = isFirst || added.length > 0 || prev.some((seqNo) => !currentSet.has(seqNo));
    if (changed) {
      snapshotDirty = true;
      writes.push(env.DB.prepare(
        "INSERT INTO monitor_snapshot(token_id,movie_id,seq_nos,updated_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(token_id,movie_id) DO UPDATE SET seq_nos=excluded.seq_nos,updated_at=excluded.updated_at"
      ).bind(token, idStr, JSON.stringify(currentSeqNos), new Date(now).toISOString()));
    }
    if (selected.has(idStr) && !isFirst && added.length > 0) {
      const lines = added.slice(0, 20).map(fmtShow);
      if (added.length > 20) lines.push(`...等共 ${added.length} 场`);
      const notification = newShowsNotification({ cinemaName, movieName: movie.nm, shows: added });
      const showIds = added.map((show) => `${show.showDate || ""}:${show.seqNo}`).sort();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(showIds)));
      const fingerprint = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
      const eventKey = `legacy:new-shows:${token}:${cfg.cinemaId}:${idStr}:${Math.floor(now / batchMs)}:${fingerprint}`;
      writes.push(env.DB.prepare("INSERT INTO change_log(token_id,time,type,text) VALUES (?,?,?,?)")
        .bind(token, new Date(now).toISOString(), "new", `新增 ${added.length} 场《${movie.nm}》: ${lines[0]}（待发送）`));
      notificationIndexes.push(writes.length);
      writes.push(env.DB.prepare(
        "INSERT OR IGNORE INTO notification_outbox(" +
        "event_key,user_id,kind,payload,credential_version,state,attempts,next_attempt_at,lease_until,created_at,updated_at,detected_at" +
        ") VALUES (?,?,?,?,?,'pending',0,?,NULL,?,?,?)"
      ).bind(eventKey, token, "new-shows", JSON.stringify({ title: notification.title, content: notification.content }),
        Number(cfg.version || 0), now, now, now, Date.now()));
      newTotal += added.length;
    }
    snapshot[idStr] = currentSeqNos;
  }
  if (snapshotDirty) {
    const committed = await env.DB.batch(writes);
    if (notificationIndexes.some((index) => Number(committed[index]?.meta?.changes || 0) === 1)) {
      try {
        await wakeNotificationDispatcher(env, { kind: "new-shows", userId: token });
      } catch {
        monitorError("notification_wake", { state: "failed", reason: "dispatch_unavailable" });
      }
    }
  }
  // status 心跳写: 有新场次/需清除上次错误/心跳到期/手动检查 才落盘
  if (newTotal > 0 || st.lastError || now - (st.lastCheckTs || 0) >= STATUS_HEARTBEAT_MS || manual) {
    delete st.lastError;
    await db.putStatus(env.DB, token, { lastCheckTs: now, lastCheck: new Date(now).toISOString(), cinemaName, newTotal, enabled: cfg.enabled !== false });
  }
  if (typeof options.afterPersist === "function") {
    try {
      await options.afterPersist(data);
    } catch {
      monitorError("downstream", { state: "failed", reason: "lock_handoff_failed" });
    }
  }
  return { ok: true, cinemaName, newTotal, enabled: cfg.enabled !== false };
  } catch (e) {
    // 失败也要留痕: 更新 lastCheck/lastError, 让界面能看出定时检查发生过但失败了
    monitorError("check", { state: "failed", reason: "provider_data_unavailable" });
    // status 心跳节流: 同一错误 30 分钟内不重写 status(错误信息变化/超时/手动检查才写),
    // 避免上游持续故障时每批都消耗写额度
    const sameErrorPending = !manual && st.lastError === e.message && now - (st.lastCheckTs || 0) < STATUS_HEARTBEAT_MS;
    if (!sameErrorPending) {
      st.lastCheckTs = now;
      st.lastCheck = new Date(now).toISOString();
      st.lastError = e.message;
      await db.putStatus(env.DB, token, st);
    }
    // 变化记录节流: 同一错误 1 小时内只记一次, 避免刷屏(与 KV 版语义一致, 取最近一条比对)
    const lastEntry = await db.getLatestChange(env.DB, token);
    const recentSame =
      lastEntry && lastEntry.type === "error" &&
      lastEntry.text === `定时检查失败: ${e.message}` &&
      now - Date.parse(lastEntry.time) < 3600e3;
    if (!recentSame) {
      await appendChange(env, token, { type: "error", text: `定时检查失败: ${e.message}` });
    }
    throw e;
  }
}
