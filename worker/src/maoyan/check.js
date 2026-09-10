// ---------------- 监控核心: 场次快照对比 + 变化记录 ----------------

import { userKey, getUserConfig } from "../common/user.js";
import { fetchCinemaDetail } from "./api.js";
import { pushNotify } from "./push.js";

function fmtShow(s) {
  const parts = [`${s.dt || ""} ${s.tm || ""}`, s.lang || "", s.tp || "", s.th || ""];
  if (s.vipPrice) parts.push(`¥${s.vipPrice}${s.vipPriceSuffix || ""}`);
  return parts.filter(Boolean).join(" | ");
}

export async function runCheck(env, manual, token) {
  const cfg = await getUserConfig(env, token);
  if (!cfg.cinemaId) return { ok: false, error: "未配置影院" };
  if (cfg.enabled === false) {
    return manual ? { ok: false, error: "监控已停止，请先在界面恢复监控" } : { ok: true, skipped: true, stopped: true };
  }
  const selected = new Set((cfg.selectedMovieIds || []).map(String));
  const stKey = userKey(token, "status");
  const st = await env.MAOYAN_KV.get(stKey, "json") || {};
  const now = Date.now();
  const intervalMs = Math.max(1, Number(cfg.intervalMinutes) || 10) * 60 * 1e3;
  if (!manual && st.lastCheckTs && now - st.lastCheckTs < intervalMs * 0.9) {
    return { ok: true, skipped: true };
  }
  const data = await fetchCinemaDetail(cfg.cinemaId);
  const cinemaName = data.showData.cinemaName || "";
  const snapKey = userKey(token, "snapshot");
  const chKey = userKey(token, "changes");
  const snapshot = await env.MAOYAN_KV.get(snapKey, "json") || {};
  const changes = await env.MAOYAN_KV.get(chKey, "json") || [];
  let newTotal = 0;
  for (const movie of data.showData.movies || []) {
    const idStr = String(movie.id);
    const shows = [];
    for (const day of movie.shows || []) for (const p of day.plist || []) shows.push(p);
    const isFirst = !Object.prototype.hasOwnProperty.call(snapshot, idStr);
    const prev = new Set(snapshot[idStr] || []);
    const added = shows.filter((s) => !prev.has(s.seqNo));
    if (selected.has(idStr) && !isFirst && added.length > 0) {
      newTotal += added.length;
      const lines = added.slice(0, 20).map(fmtShow);
      if (added.length > 20) lines.push(`...等共 ${added.length} 场`);
      const title = `🎬新增场次: ${movie.nm}`;
      const content = `【${cinemaName}】\n${lines.join("\n")}`;
      changes.unshift({ time: new Date().toISOString(), type: "new", text: `新增 ${added.length} 场《${movie.nm}》: ${lines[0]}` });
      try {
        const label = await pushNotify(cfg, title, content);
        changes.unshift({ time: new Date().toISOString(), type: "ok", text: `已推送 ${label}(${movie.nm}, ${added.length} 场)` });
      } catch (e) {
        changes.unshift({ time: new Date().toISOString(), type: "error", text: "推送失败: " + e.message });
      }
    }
    snapshot[idStr] = shows.map((s) => s.seqNo);
  }
  while (changes.length > 100) changes.pop();
  await env.MAOYAN_KV.put(snapKey, JSON.stringify(snapshot));
  await env.MAOYAN_KV.put(chKey, JSON.stringify(changes));
  await env.MAOYAN_KV.put(
    stKey,
    JSON.stringify({ lastCheckTs: now, lastCheck: new Date().toISOString(), cinemaName, newTotal, enabled: cfg.enabled !== false })
  );
  return { ok: true, cinemaName, newTotal, enabled: cfg.enabled !== false };
}
