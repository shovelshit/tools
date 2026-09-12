// ---------------- 监控核心: 场次快照对比 + 变化记录 ----------------

import { userKey, getUserConfig } from "./user.js";
import { fetchCinemaDetail } from "./api.js";
import { pushNotify } from "./notify.js";
import { minBatchMinutes, resolveCronExprs } from "./cron.js";
import { isExpired } from "./ddl.js";
import { monitorError } from "./log.js";

function fmtShow(s) {
  const parts = [`${s.showDate || s.dt || ""} ${s.tm || ""}`, s.lang || "", s.tp || "", s.th || ""];
  if (s.vipPrice) parts.push(`¥${s.vipPrice}${s.vipPriceSuffix || ""}`);
  return parts.filter(Boolean).join(" | ");
}

const MAX_CHANGES = 100;

// 追加一条变化记录(新在前, 只保留最近 100 条); config 变更等场景也需要留痕
export async function appendChange(env, tokenId, entry) {
  const chKey = userKey(tokenId, "changes");
  const changes = await env.MAOYAN_KV.get(chKey, "json") || [];
  changes.unshift({ time: new Date().toISOString(), ...entry });
  while (changes.length > MAX_CHANGES) changes.pop();
  await env.MAOYAN_KV.put(chKey, JSON.stringify(changes));
  return changes;
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
  // 到期自动停止: 每次开始监控刷新截止时间, 防止设完就不管
  if (isExpired(cfg)) {
    cfg.enabled = false;
    await env.MAOYAN_KV.put(userKey(token, "config"), JSON.stringify(cfg));
    await appendChange(env, token, {
      type: "warn",
      text: `监控已到期（截止 ${(cfg.monitorDdl || "").slice(0, 10) || "未设置"}），已自动停止；在监控页点「开始监控」可再续 ${30} 天`,
    });
    if (manual) return { ok: false, error: "监控已到期，已自动停止；点「开始监控」可再续 30 天", status: 409 };
    return { ok: true, stopped: true, expired: true };
  }
  const selected = new Set((cfg.selectedMovieIds || []).map(String));
  const stKey = userKey(token, "status");
  const st = await env.MAOYAN_KV.get(stKey, "json") || {};
  const now = Date.now();
  // 检查频率完全跟随 cron 批次: 每个触发点都检查一次, 半个最短批次的容差吸收触发时间抖动
  const cronExprs = await resolveCronExprs(env);
  const batchMinutes = minBatchMinutes(cronExprs);
  const batchMs = batchMinutes * 60 * 1e3;
  if (!manual && st.lastCheckTs && now - st.lastCheckTs < batchMs / 2) {
    return { ok: true, skipped: true };
  }
  const snapKey = userKey(token, "snapshot");
  const chKey = userKey(token, "changes");
  const snapshot = await env.MAOYAN_KV.get(snapKey, "json") || {};
  const changes = await env.MAOYAN_KV.get(chKey, "json") || [];
  try {
    const fetchCinema = options.fetchCinema || fetchCinemaDetail;
    const data = await fetchCinema(cfg.cinemaId);
    const cinemaName = data.showData.cinemaName || "";
    let newTotal = 0;
  for (const movie of data.showData.movies || []) {
    const idStr = String(movie.id);
    const shows = [];
    for (const day of movie.shows || []) {
      for (const p of day.plist || []) shows.push({ ...p, showDate: day.showDate || day.dt || p.dt || "" });
    }
    const isFirst = !Object.prototype.hasOwnProperty.call(snapshot, idStr);
    const prev = new Set(snapshot[idStr] || []);
    const added = shows.filter((s) => !prev.has(s.seqNo));
    if (selected.has(idStr) && !isFirst && added.length > 0) {
      const lines = added.slice(0, 20).map(fmtShow);
      if (added.length > 20) lines.push(`...等共 ${added.length} 场`);
      const title = `🎬新增场次: ${movie.nm}`;
      const content = `【${cinemaName}】\n${lines.join("\n")}`;
      changes.unshift({ time: new Date().toISOString(), type: "new", text: `新增 ${added.length} 场《${movie.nm}》: ${lines[0]}` });
      try {
        const label = await pushNotify(cfg, title, content);
        newTotal += added.length;
        changes.unshift({ time: new Date().toISOString(), type: "ok", text: `已推送 ${label}(${movie.nm}, ${added.length} 场)` });
      } catch (e) {
        changes.unshift({ time: new Date().toISOString(), type: "error", text: "推送失败: " + e.message });
        continue;
      }
    }
    snapshot[idStr] = shows.map((s) => s.seqNo);
  }
  while (changes.length > MAX_CHANGES) changes.pop();
  await env.MAOYAN_KV.put(snapKey, JSON.stringify(snapshot));
  await env.MAOYAN_KV.put(chKey, JSON.stringify(changes));
  delete st.lastError;
  await env.MAOYAN_KV.put(
    stKey,
    JSON.stringify({ lastCheckTs: now, lastCheck: new Date().toISOString(), cinemaName, newTotal, enabled: cfg.enabled !== false })
  );
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
    st.lastCheckTs = now;
    st.lastCheck = new Date(now).toISOString();
    st.lastError = e.message;
    await env.MAOYAN_KV.put(stKey, JSON.stringify(st));
    // 变化记录节流: 同一错误 1 小时内只记一次, 避免刷屏和 KV 写入放大
    const lastEntry = changes[0];
    const recentSame =
      lastEntry && lastEntry.type === "error" &&
      lastEntry.text === `定时检查失败: ${e.message}` &&
      now - Date.parse(lastEntry.time) < 3600e3;
    if (!recentSame) {
      changes.unshift({ time: new Date(now).toISOString(), type: "error", text: `定时检查失败: ${e.message}` });
      while (changes.length > MAX_CHANGES) changes.pop();
      await env.MAOYAN_KV.put(chKey, JSON.stringify(changes));
    }
    throw e;
  }
}
