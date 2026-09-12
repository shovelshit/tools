// 错误语义回归测试: 覆盖 BUG-7 / BUG-8 / BUG-9
// - BUG-8: 上游(猫眼)明确拒绝经 DO 传递时保留原文案与 502 语义, 不再降级成笼统 500
// - BUG-7: 会话无法解密时返回可操作状态(409), 且不吞掉"格式错误/不完整"的具体提示
// - BUG-9: 缺失资源的文案保持具体; 已知路径方法不符返回 405(带 Allow)
import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole, MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import { createLockRule, RULE_KNOWN_ERRORS } from "../src/maoyan/lock-rule.js";
import { LockCoordinator, createLockRuleThroughCoordinator } from "../src/maoyan/lock-runner.js";
import { handleLockApi } from "../src/maoyan/lock-api.js";
import { OrderAttemptError, ORDER_REJECTED_SESSION, ORDER_REJECTED_SEATS } from "../src/maoyan/lock-client.js";
import { loadLockSession } from "../src/maoyan/lock-session.js";
import { userKey } from "../src/maoyan/user.js";

const now = new Date("2026-09-11T04:00:00.000Z");
const tokenId = "11111111-1111-4111-8111-111111111111";
const SESSION_NAME = "maoyan-session";

// ---------------- 通用脚手架 ----------------

function envWithConfig() {
  return {
    LOCK_SERVICE_ENABLED: "true",
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    MAOYAN_KV: new MemoryKV({
      [userKey("token-a", "config")]: JSON.stringify({ cinemaId: "25428", selectedMovieIds: ["7"] })
    })
  };
}

function ruleInput(overrides = {}) {
  return {
    cinemaId: "25428",
    movieId: "7",
    templateSeqNo: "100",
    targetDate: "2026-09-11",
    seatNos: ["1-6-18"],
    riskAccepted: true,
    ...overrides
  };
}

// 目标日期与模板日期相同 -> 目标场次真实存在 -> 直接进入下单路径
function orderDependencies(placeOrder) {
  return {
    now,
    loadSession: async () => validSession(),
    fetchCinema: async () => ({ showData: {
      cinemaName: "测试影院",
      movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-11", plist: [
        { seqNo: "100", tm: "20:00", ticketStatus: 0 }
      ] }] }]
    } }),
    fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: [
      { seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true }
    ] }),
    placeOrder,
    notify: async () => {}
  };
}

function coordinatorState() {
  const data = new Map();
  return { storage: { get: async (key) => data.get(key), put: async (key, value) => data.set(key, value) } };
}

function coordinatorRequest(body) {
  return new Request("https://lock-coordinator/", {
    method: "POST", headers: { "X-Lock-Action": body.action }, body: JSON.stringify(body)
  });
}

function lockApiEnv(overrides = {}) {
  return {
    MAOYAN_KV: new MemoryKV({
      [userKey(tokenId, "config")]: JSON.stringify({ cinemaId: "25428", selectedMovieIds: ["7"] })
    }),
    SESSION_ENCRYPTION_KEY: testEncryptionKey(),
    LOCK_SERVICE_ENABLED: "true",
    ...overrides
  };
}

async function callLockApi(path, options, env = lockApiEnv()) {
  return await handleLockApi(
    new Request(`https://worker.example${path}`, options),
    env,
    new URL(`https://worker.example${path}`),
    tokenId
  );
}

function coordinatorStub(reply) {
  return { idFromName: (id) => id, get: () => ({ fetch: async () => reply }) };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// 手工构造加密信封(绕过 saveLockSession 的校验), 以便注入"能解密但内容不合法/密钥不匹配"的场景
async function encryptedEnvelope(token, plaintext, keyBase64 = testEncryptionKey()) {
  const key = await crypto.subtle.importKey("raw", base64ToBytes(keyBase64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`maoyan-session:${token}`) },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext))
  );
  return {
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(data)),
    uploadedAt: "2026-09-11T00:00:00.000Z",
    uidMasked: "UID 123***789",
    sourceSavedAt: ""
  };
}

// ---------------- BUG-8: 上游错误语义 ----------------

test("白名单与客户端文案保持同步, 杜绝文案漂移", () => {
  assert.ok(RULE_KNOWN_ERRORS.includes(ORDER_REJECTED_SESSION));
  assert.ok(RULE_KNOWN_ERRORS.includes(`${ORDER_REJECTED_SEATS}：座位可能已被抢占`));
  // 旧的过期文案不应再出现
  assert.equal(RULE_KNOWN_ERRORS.some((item) => item.includes("会话或签名可能已过期")), false);
});

test("上游拒绝下单时错误带 upstream 标记并保留原文案", async () => {
  await assert.rejects(
    createLockRule(envWithConfig(), "token-a", ruleInput(), orderDependencies(async () => {
      throw new OrderAttemptError(ORDER_REJECTED_SESSION, false);
    })),
    (error) => {
      assert.equal(error.kind, "upstream");
      assert.equal(error.message, ORDER_REJECTED_SESSION);
      return true;
    }
  );
});

test("座位被抢占时补充为更具体的提示", async () => {
  await assert.rejects(
    createLockRule(envWithConfig(), "token-a", ruleInput(), orderDependencies(async () => {
      throw new OrderAttemptError(ORDER_REJECTED_SEATS, false);
    })),
    (error) => {
      assert.equal(error.kind, "upstream");
      assert.equal(error.message, `${ORDER_REJECTED_SEATS}：座位可能已被抢占`);
      return true;
    }
  );
});

test("下单结果不确定时不标记为上游拒绝(仍走待确认路径)", async () => {
  const rule = await createLockRule(envWithConfig(), "token-a", ruleInput(), orderDependencies(async () => {
    throw new OrderAttemptError("创建订单结果不确定，请在猫眼订单中确认", true);
  }));
  assert.equal(rule.state, "unknown");
});

test("协调器把上游拒绝映射为 502 并保留原文案", async () => {
  const coordinator = new LockCoordinator(coordinatorState(), { MAOYAN_KV: new MemoryKV(), LOCK_SERVICE_ENABLED: "true" }, {
    createRule: async () => {
      const error = new Error(ORDER_REJECTED_SESSION);
      error.kind = "upstream";
      throw error;
    }
  });
  const response = await coordinator.fetch(coordinatorRequest({ action: "create", tokenId, input: {} }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: ORDER_REJECTED_SESSION });
});

test("协调器仍把已知参数错误映射为 400", async () => {
  const coordinator = new LockCoordinator(coordinatorState(), { MAOYAN_KV: new MemoryKV(), LOCK_SERVICE_ENABLED: "true" }, {
    createRule: async () => { throw new Error("所选座位不可用"); }
  });
  const response = await coordinator.fetch(coordinatorRequest({ action: "create", tokenId, input: {} }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "所选座位不可用");
});

test("协调器对未知错误仍返回 500 且不泄露内部信息", async () => {
  const coordinator = new LockCoordinator(coordinatorState(), { MAOYAN_KV: new MemoryKV(), LOCK_SERVICE_ENABLED: "true" }, {
    createRule: async () => { throw new Error("internal stack detail"); }
  });
  const { result } = await captureConsole(async () =>
    await coordinator.fetch(coordinatorRequest({ action: "create", tokenId, input: {} }))
  );
  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { ok: false, error: "锁座服务暂时不可用" });
});

test("协调器调用端把 502 还原为 upstream 错误", async () => {
  const env = {
    LOCK_COORDINATOR: coordinatorStub(Response.json({ ok: false, error: ORDER_REJECTED_SESSION }, { status: 502 }))
  };
  await assert.rejects(
    createLockRuleThroughCoordinator(env, tokenId, {}),
    (error) => {
      assert.equal(error.kind, "upstream");
      assert.equal(error.message, ORDER_REJECTED_SESSION);
      return true;
    }
  );
});

test("锁座规则创建遇上游拒绝时 API 返回 502 与真实原因", async () => {
  const env = lockApiEnv({
    LOCK_COORDINATOR: coordinatorStub(Response.json({ ok: false, error: ORDER_REJECTED_SESSION }, { status: 502 }))
  });
  const response = await callLockApi("/api/lock/rule", {
    method: "POST", body: JSON.stringify(ruleInput({ targetDate: "2026-09-12" }))
  }, env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, ORDER_REJECTED_SESSION);
});

// ---------------- BUG-7: 会话不可用 ----------------

test("解密成功但会话字段不完整时保留可操作提示", async () => {
  const env = { SESSION_ENCRYPTION_KEY: testEncryptionKey(), MAOYAN_KV: new MemoryKV() };
  const envelope = await encryptedEnvelope(tokenId, {
    cookies: [{ name: "uid", value: "123456789", domain: ".maoyan.com" }],
    csrf: "csrf-value",
    mtgsig: "",
    userAgent: "Mozilla/5.0 Test"
  });
  await env.MAOYAN_KV.put(userKey(tokenId, SESSION_NAME), JSON.stringify(envelope));
  await assert.rejects(loadLockSession(env, tokenId), (error) => {
    assert.match(error.message, /猫眼会话不完整/);
    assert.doesNotMatch(error.message, /不可用/);
    return true;
  });
});

test("加密密钥轮换后旧会话解密失败时 API 返回 409 而非 500", async () => {
  const envelope = await encryptedEnvelope(tokenId, {
    cookies: [{ name: "uid", value: "123456789", domain: ".maoyan.com" }],
    csrf: "csrf-value",
    mtgsig: "signature-secret",
    userAgent: "Mozilla/5.0 Test"
  });
  const env = lockApiEnv({
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    MAOYAN_KV: new MemoryKV({
      [userKey(tokenId, "config")]: JSON.stringify({ cinemaId: "25428", selectedMovieIds: ["7"] }),
      [userKey(tokenId, SESSION_NAME)]: JSON.stringify(envelope)
    })
  });
  const response = await callLockApi("/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100", undefined, env);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /重新上传/);
});

test("会话信封损坏(非法 iv)时同样按 409 处理", async () => {
  const env = lockApiEnv({
    MAOYAN_KV: new MemoryKV({
      [userKey(tokenId, "config")]: JSON.stringify({ cinemaId: "25428", selectedMovieIds: ["7"] }),
      [userKey(tokenId, SESSION_NAME)]: JSON.stringify({
        v: 1, iv: "AAAA", data: "BBBB",
        uploadedAt: "2026-09-11T00:00:00.000Z", uidMasked: "UID 1**", sourceSavedAt: ""
      })
    })
  });
  const response = await callLockApi("/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100", undefined, env);
  assert.equal(response.status, 409);
});

// ---------------- BUG-9: 缺失文案与 405 ----------------

test("取消锁座规则时保留「未找到锁座规则」的文案", async () => {
  const env = lockApiEnv({
    LOCK_COORDINATOR: coordinatorStub(Response.json({ ok: false, error: "未找到锁座规则" }, { status: 404 }))
  });
  const response = await callLockApi("/api/lock/rule/cancel", { method: "POST" }, env);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "未找到锁座规则");
});

test("删除锁座资源时保留「未找到锁座资源」的文案", async () => {
  const env = lockApiEnv({
    LOCK_COORDINATOR: coordinatorStub(Response.json({ ok: false, error: "未找到锁座资源" }, { status: 404 }))
  });
  const response = await callLockApi("/api/lock/session/remove", { method: "POST" }, env);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "未找到锁座资源");
});

test("未上传会话时提示「未上传猫眼会话」而不是「未找到锁座资源」", async () => {
  const response = await callLockApi("/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "未上传猫眼会话");
});

test("已知路径的方法不符返回 405 并给出 Allow", async () => {
  const response = await callLockApi("/api/lock/session/status", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
});

test("多方法路径的 Allow 列出全部允许方法", async () => {
  const response = await callLockApi("/api/lock/rule", { method: "DELETE" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST, GET");
});

test("未知锁座子路径仍返回 404 而不是 405", async () => {
  const response = await callLockApi("/api/lock/nope", { method: "POST" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Unknown API");
});
