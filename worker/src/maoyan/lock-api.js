import { json } from "../common/http.js";
import { fetchSeatMap } from "./lock-client.js";
import { recordSeatFeedback } from "./seat-feedback.js";
import {
  getLockSessionStatus,
  loadLockSession,
  saveLockSession
} from "./lock-session.js";
import { getLockRule, publicLockRule, RULE_KNOWN_ERRORS, validateLockRuleInput } from "./lock-rule.js";
import { cancelLockRuleThroughCoordinator, createLockRuleThroughCoordinator, removeLockSessionThroughCoordinator } from "./lock-runner.js";

const MAX_UPLOAD_BYTES = 256 * 1024;
const DECIMAL = /^\d+$/;
// 已知路径 -> 允许的方法: 用于区分"路径不存在(404)"与"方法不允许(405)"
const LOCK_ROUTES = new Map([
  ["/api/lock/session", ["POST"]],
  ["/api/lock/session/status", ["GET"]],
  ["/api/lock/session/remove", ["POST"]],
  ["/api/lock/template-seats", ["GET"]],
  ["/api/lock/rule", ["POST", "GET"]],
  ["/api/lock/rule/cancel", ["POST"]],
  ["/api/lock/seat-feedback", ["POST"]]
]);

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
  return RULE_KNOWN_ERRORS.includes(String(error?.message || ""));
}

function safeError(error) {
  const message = String(error?.message || "");
  if (error?.kind === "input") return response({ error: message }, 400);
  if (/^猫眼会话(格式错误|不完整)/.test(message)) {
    return response({ error: message }, 400);
  }
  // 会话无法解密(密钥轮换/数据损坏/上传文件异常): 属可操作状态, 提示重新上传, 而非笼统 500
  if (/^猫眼会话不可用/.test(message)) {
    return response({ error: "猫眼会话不可用，请重新上传会话" }, 409);
  }
  if (message === "锁座服务尚未配置加密密钥") return response({ error: message }, 500);
  // 上游(猫眼)明确拒绝: 与 /template-seats 语义一致返回 502, 并保留真实原因
  if (error?.kind === "upstream") return response({ error: message }, 502);
  if (ruleInputError(error)) return response({ error: message }, 400);
  if (error?.kind === "missing" || /未上传猫眼会话|未找到锁座规则|未找到锁座资源/.test(message)) {
    // 保留具体文案(未上传会话 / 未找到锁座规则 / 未找到锁座资源), 不再统一写成"未找到锁座资源"
    return response({ error: message || "未找到锁座资源" }, 404);
  }
  if (/已有进行中的锁座规则/.test(message)) {
    return response({ error: "已有进行中的锁座规则" }, 409);
  }
  if (providerError(error)) return response({ error: "猫眼会话验证失败" }, 502);
  // 猫眼接口网络/状态错误: 透传真实原因, 便于用户判断(场次失效/接口波动等)
  if (/^猫眼请求失败：/.test(message)) {
    return response({ error: message }, 502);
  }
  if (/^猫眼座位图格式无效$/.test(message)) {
    return response({ error: "座位图获取失败，场次可能已失效或暂无座位图" }, 502);
  }
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
  if (env.LOCK_SERVICE_ENABLED !== "true") {
    return response({ error: "锁座服务暂时不可用" }, 503);
  }
  try {
    if (url.pathname === "/api/lock/session" && request.method === "POST") {
      return response({ session: await saveLockSession(env, tokenId, await uploadBody(request)) });
    }
    if (url.pathname === "/api/lock/session/status" && request.method === "GET") {
      return response({ session: await getLockSessionStatus(env, tokenId) });
    }
    if (url.pathname === "/api/lock/session/remove" && request.method === "POST") {
      await removeLockSessionThroughCoordinator(env, tokenId);
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
      return response({
        rule: publicLockRule(await getLockRule(env, tokenId), String(env.LOCK_SERVICE_ENABLED) === "true")
      });
    }
    if (url.pathname === "/api/lock/seat-feedback" && request.method === "POST") {
      // 只收标识: 用户在座位图旁点「反馈」上报当前影院/影片/场次。
      // 服务端只写 KV 不拉页面, 因此不要求已上传会话; 无内容存储(用户决策)。
      let body;
      try {
        body = await request.json();
      } catch {
        throw inputError("反馈参数无效");
      }
      const cinemaId = exactDecimal(body?.cinemaId, "cinemaId");
      const movieId = exactDecimal(body?.movieId, "movieId");
      const seqNo = body?.seqNo == null ? "" : String(body.seqNo);
      if (seqNo && !DECIMAL.test(seqNo)) throw inputError("seqNo 无效");
      await recordSeatFeedback(env, { tokenId, cinemaId, movieId, seqNo, source: "manual" });
      return response({ recorded: true });
    }
    if (url.pathname === "/api/lock/rule/cancel" && request.method === "POST") {
      await cancelLockRuleThroughCoordinator(env, tokenId);
      return response({ removed: true });
    }
    const allowed = LOCK_ROUTES.get(url.pathname);
    if (allowed) {
      // 路径存在但方法不符
      return json({ ok: false, error: "Method Not Allowed" }, 405, { Allow: allowed.join(", ") });
    }
    return response({ error: "Unknown API" }, 404);
  } catch (error) {
    return safeError(error);
  }
}
