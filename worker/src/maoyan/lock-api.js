import { json } from "../common/http.js";
import { fetchSeatMap } from "./lock-client.js";
import {
  getLockSessionStatus,
  loadLockSession,
  removeLockSession,
  saveLockSession
} from "./lock-session.js";
import {
  getLockRule,
  publicLockRule,
  removeLockRule,
  validateLockRuleInput
} from "./lock-rule.js";
import { createLockRuleThroughCoordinator } from "./lock-runner.js";

const MAX_UPLOAD_BYTES = 256 * 1024;
const DECIMAL = /^\d+$/;

function response(body, status = 200) {
  return json({ ok: status < 400, ...body }, status);
}

function inputError(message) {
  const error = new Error(message);
  error.kind = "input";
  return error;
}

function missingError(message) {
  const error = new Error(message);
  error.kind = "missing";
  return error;
}

function providerError(error) {
  return /猫眼请求失败：HTTP (?:30[0-9]|401|403)|猫眼请求目标不受信任|猫眼接口异常: HTTP (?:30[0-9]|401|403)/.test(String(error?.message || ""));
}

function ruleInputError(error) {
  return /^(锁座参数无效|请确认锁座风险提示|所选座位(?:无效|不可用)|影片未在当前影院监控配置中选择|模板场次不属于当前影院影片|目标日期必须晚于模板场次且在未来 30 天内|猫眼场次数据无效|猫眼座位图场次无效)$/.test(String(error?.message || ""));
}

function safeError(error) {
  if (error?.kind === "input") return response({ error: error.message }, 400);
  if (ruleInputError(error)) return response({ error: error.message }, 400);
  if (error?.kind === "missing" || /未上传猫眼会话/.test(String(error?.message || ""))) {
    return response({ error: "未找到锁座资源" }, 404);
  }
  if (/已有进行中的锁座规则/.test(String(error?.message || ""))) {
    return response({ error: "已有进行中的锁座规则" }, 409);
  }
  if (providerError(error)) return response({ error: "猫眼会话验证失败" }, 502);
  return response({ error: "锁座服务暂时不可用" }, 500);
}

function exactDecimal(value, name) {
  const result = String(value || "");
  if (!DECIMAL.test(result)) throw inputError(`${name} 无效`);
  return result;
}

async function uploadBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_UPLOAD_BYTES) {
    throw inputError("会话文件不能超过 256KiB");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw inputError("猫眼会话格式错误");
  }
}

function publicSeatMap(seatMap) {
  return {
    seqNo: String(seatMap.seqNo),
    sectionId: String(seatMap.sectionId),
    sectionName: String(seatMap.sectionName),
    seats: (seatMap.seats || []).map(({ seatNo, rowId, columnId, type, available }) => ({
      seatNo: String(seatNo),
      rowId: String(rowId),
      columnId: String(columnId),
      type: String(type || ""),
      available: available === true
    }))
  };
}

async function requireSession(env, tokenId) {
  try {
    return await loadLockSession(env, tokenId);
  } catch (error) {
    if (/未上传猫眼会话/.test(String(error?.message || ""))) throw missingError("未上传猫眼会话");
    throw error;
  }
}

export async function handleLockApi(request, env, url, tokenId) {
  if (!url.pathname.startsWith("/api/lock/")) return null;
  try {
    if (url.pathname === "/api/lock/session" && request.method === "POST") {
      return response({ session: await saveLockSession(env, tokenId, await uploadBody(request)) });
    }
    if (url.pathname === "/api/lock/session/status" && request.method === "GET") {
      return response({ session: await getLockSessionStatus(env, tokenId) });
    }
    if (url.pathname === "/api/lock/session/remove" && request.method === "POST") {
      const status = await getLockSessionStatus(env, tokenId);
      if (!status.uploaded) throw missingError("未上传猫眼会话");
      await Promise.all([removeLockSession(env, tokenId), removeLockRule(env, tokenId)]);
      return response({ removed: true });
    }
    if (url.pathname === "/api/lock/template-seats" && request.method === "GET") {
      const cinemaId = exactDecimal(url.searchParams.get("cinemaId"), "cinemaId");
      const movieId = exactDecimal(url.searchParams.get("movieId"), "movieId");
      const seqNo = exactDecimal(url.searchParams.get("seqNo"), "seqNo");
      const session = await requireSession(env, tokenId);
      return response({ seatMap: publicSeatMap(await fetchSeatMap(session, { cinemaId, movieId, seqNo })) });
    }
    if (url.pathname === "/api/lock/rule" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        throw inputError("锁座参数无效");
      }
      validateLockRuleInput(body);
      return response({ rule: await createLockRuleThroughCoordinator(env, tokenId, body) }, 201);
    }
    if (url.pathname === "/api/lock/rule" && request.method === "GET") {
      return response({ rule: publicLockRule(await getLockRule(env, tokenId), false) });
    }
    if (url.pathname === "/api/lock/rule/cancel" && request.method === "POST") {
      const rule = await getLockRule(env, tokenId);
      if (!rule) throw missingError("未找到锁座规则");
      await removeLockRule(env, tokenId);
      return response({ removed: true });
    }
    return response({ error: "Unknown API" }, 404);
  } catch (error) {
    return safeError(error);
  }
}
