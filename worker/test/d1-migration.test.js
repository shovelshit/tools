// ---------------- KV → D1 迁移测试 ----------------
// 覆盖: 全量迁移(令牌/配置/状态/快照/变化/锁座规则/座位反馈) + 幂等重跑 + 会话留在 KV
//       + 鉴权点查 + changes 100 条上限语义 + 快照行级更新 + 令牌注销清理
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryD1, MemoryKV, createDB } from "./helpers.js";
import * as db from "../src/maoyan/db.js";
import { migrateKvToD1 } from "../src/maoyan/migrate.js";
import { migrateAccounts } from "../src/maoyan/account-migration.js";
import { getAccountByKey } from "../src/maoyan/accounts.js";
import { checkAuthFull } from "../src/maoyan/tokens.js";
import { userKey, cleanupUserData } from "../src/maoyan/user.js";

const tokenId = "44444444-4444-4444-8444-444444444444";
const SESSION_NAME = "maoyan-session";

function kvFixture() {
  return {
    "meta:tokens": JSON.stringify([
      { id: tokenId, token: "tok-123", remark: "主令牌", createdAt: "2026-09-01T00:00:00.000Z" }
    ]),
    [userKey(tokenId, "config")]: JSON.stringify({ cinemaId: "25428", enabled: true, selectedMovieIds: ["7"] }),
    [userKey(tokenId, "status")]: JSON.stringify({ lastCheckTs: 1700000000000, newTotal: 2, cinemaName: "测试影院" }),
    [userKey(tokenId, "snapshot")]: JSON.stringify({ "900": ["A1", "A2"], "901": ["B1"] }),
    [userKey(tokenId, "changes")]: JSON.stringify([
      { time: "2026-09-13T10:00:00.000Z", type: "ok", text: "已推送 bark(片X, 1 场)" },
      { time: "2026-09-13T09:59:00.000Z", type: "new", text: "新增 1 场《片X》: 2026-09-15 19:00" },
      { time: "2026-09-12T08:00:00.000Z", type: "warn", text: "监控已到期" }
    ]),
    [userKey(tokenId, "maoyan-lock-rule")]: JSON.stringify({ id: "rule-1", state: "waiting_schedule" }),
    [userKey(tokenId, SESSION_NAME)]: JSON.stringify({ v: 1, iv: "AAAA", data: "BBBB" }),
    "seatfb:25428:100": JSON.stringify({
      reportedAt: "2026-09-12T20:00:00.000Z", day: "2026-09-13", tokenId,
      cinemaId: "25428", movieId: "7", seqNo: "100", source: "auto"
    })
  };
}

async function migratedEnv() {
  const env = { MAOYAN_KV: new MemoryKV(kvFixture()), DB: new MemoryD1() };
  const summary = await migrateKvToD1(env);
  return { env, summary };
}

test("全量迁移: 令牌/配置/状态/快照/变化/规则/反馈各就各位", async () => {
  const { env, summary } = await migratedEnv();
  assert.deepEqual(summary, {
    tokens: 1, configs: 1, statuses: 1, snapshots: 2, changes: 3, lockRules: 1, seatFeedback: 1
  });

  assert.deepEqual(await db.listTokens(env.DB), [
    { id: tokenId, token: "tok-123", remark: "主令牌", createdAt: "2026-09-01T00:00:00.000Z" }
  ]);
  assert.deepEqual(await db.getConfig(env.DB, tokenId), { cinemaId: "25428", enabled: true, selectedMovieIds: ["7"] });
  assert.deepEqual(await db.getStatus(env.DB, tokenId), { lastCheckTs: 1700000000000, newTotal: 2, cinemaName: "测试影院" });
  assert.deepEqual(await db.getSnapshot(env.DB, tokenId), { "900": ["A1", "A2"], "901": ["B1"] });
  assert.deepEqual(await db.getLockRuleRow(env.DB, tokenId), { id: "rule-1", state: "waiting_schedule" });
  assert.deepEqual(await db.listSeatFeedbackRows(env.DB), [{
    key: "seatfb:25428:100",
    reportedAt: "2026-09-12T20:00:00.000Z", day: "2026-09-13", tokenId,
    cinemaId: "25428", movieId: "7", seqNo: "100", source: "auto"
  }]);
  // changes 顺序与 KV 数组一致(新在前)
  const changes = await db.listChanges(env.DB, tokenId);
  assert.equal(changes.length, 3);
  assert.equal(changes[0].type, "ok");
  assert.equal(changes[2].type, "warn");
});

test("重复迁移幂等: 计数不变, change_log 不翻倍", async () => {
  const { env, summary } = await migratedEnv();
  const again = await migrateKvToD1(env);
  assert.deepEqual(again, summary);
  assert.equal((await db.listChanges(env.DB, tokenId)).length, 3);
  assert.equal((await db.listTokens(env.DB)).length, 1);
});

test("迁移不删 KV: 会话信封原样保留(回滚无损)", async () => {
  const { env } = await migratedEnv();
  const session = await env.MAOYAN_KV.get(userKey(tokenId, SESSION_NAME), "json");
  assert.deepEqual(session, { v: 1, iv: "AAAA", data: "BBBB" });
  assert.equal(await env.MAOYAN_KV.get("meta:tokens", "json") !== null, true);
});

test("鉴权点查: 有效 token 返回令牌 id, 无效返回 null", async () => {
  const { env } = await migratedEnv();
  const valid = new Request("https://worker.example/api/status", { headers: { "X-Token": "tok-123" } });
  assert.equal(await checkAuthFull(valid, env), tokenId);
  const invalid = new Request("https://worker.example/api/status", { headers: { "X-Token": "nope" } });
  assert.equal(await checkAuthFull(invalid, env), null);
});

test("changes 读取上限 100 条: 150 条历史返回最新 100 条、新在前", async () => {
  const DB = await createDB();
  // entries[0] 最新(KV changes 数组语义)
  const entries = Array.from({ length: 150 }, (_, i) => ({
    time: new Date(Date.parse("2026-09-01T00:00:00.000Z") + (150 - i) * 1000).toISOString(),
    type: "new",
    text: `第 ${i} 条`
  }));
  await db.replaceChanges(DB, tokenId, entries);
  const listed = await db.listChanges(DB, tokenId);
  assert.equal(listed.length, 100);
  assert.equal(listed[0].text, "第 0 条");
  assert.equal(listed[99].text, "第 99 条");
  const latest = await db.getLatestChange(DB, tokenId);
  assert.equal(latest.text, "第 0 条");
});

test("快照行级更新: 新影片增行, 上游消失影片旧行保留(与 KV 版一致), 切影院整份清空", async () => {
  const DB = await createDB({ snapshots: { [tokenId]: { "900": ["A1"] } } });
  await db.saveSnapshot(DB, tokenId, { "900": ["A1", "A2"], "901": ["B1"] });
  assert.deepEqual(await db.getSnapshot(DB, tokenId), { "900": ["A1", "A2"], "901": ["B1"] });
  // 901 从上游消失: 旧行保留(KV 版行为), 不误报为"首次出现"
  await db.saveSnapshot(DB, tokenId, { "900": ["A1", "A2"] });
  assert.deepEqual(await db.getSnapshot(DB, tokenId), { "900": ["A1", "A2"], "901": ["B1"] });
  await db.deleteSnapshot(DB, tokenId);
  assert.deepEqual(await db.getSnapshot(DB, tokenId), {});
});

test("令牌注销: D1 各表行清除 + KV 加密会话删除", async () => {
  const { env } = await migratedEnv();
  await cleanupUserData(env, tokenId);
  assert.equal(await db.getConfig(env.DB, tokenId), null);
  assert.equal(await db.getStatus(env.DB, tokenId), null);
  assert.deepEqual(await db.getSnapshot(env.DB, tokenId), {});
  assert.deepEqual(await db.listChanges(env.DB, tokenId), []);
  assert.equal(await db.getLockRuleRow(env.DB, tokenId), null);
  assert.equal(await env.MAOYAN_KV.get(userKey(tokenId, SESSION_NAME)), null);
});

test("未绑定 D1 时迁移报清晰错误", async () => {
  await assert.rejects(
    () => migrateKvToD1({ MAOYAN_KV: new MemoryKV(kvFixture()) }),
    /未绑定 D1/
  );
});

test("saveTokens 整表替换保留传入顺序(管理端语义)", async () => {
  const DB = await createDB({
    tokens: [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" }
    ]
  });
  await db.saveTokens(DB, [{ id: "b", token: "tok-b2" }, { id: "c", token: "tok-c" }]);
  assert.deepEqual((await db.listTokens(DB)).map((t) => t.id), ["b", "c"]);
  assert.equal(await db.findTokenByToken(DB, "tok-a"), null); // 旧 token 已随整表替换失效
  const c = await db.findTokenByToken(DB, "tok-c");
  assert.equal(c.id, "c");
});

test("账号迁移后 KV 导入只写摘要账号且不重建明文 tokens", async () => {
  const env = { MAOYAN_KV: new MemoryKV(kvFixture()), DB: new MemoryD1() };
  const activatedAt = Date.UTC(2026, 8, 16);
  await migrateAccounts(env, { nowMs: activatedAt });

  const summary = await migrateKvToD1(env);
  const account = await getAccountByKey(env.DB, "tok-123");

  assert.equal(summary.tokens, 1);
  assert.equal(account.id, tokenId);
  assert.equal(account.expiresAt, activatedAt + 15 * 86400000);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first()).n, 0);
});

test("账号迁移后 KV 导入不会复活已撤销账号", async () => {
  const env = { MAOYAN_KV: new MemoryKV(kvFixture()), DB: new MemoryD1() };
  await migrateAccounts(env, { nowMs: Date.UTC(2026, 8, 16) });
  await env.DB.prepare(
    "INSERT INTO users(id,role,state,created_at,expires_at,revoked_at,source,version) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(tokenId, "user", "revoked", 1, 2, 2, "test", 1).run();

  const summary = await migrateKvToD1(env);

  assert.equal(summary.tokens, 0);
  assert.equal(await getAccountByKey(env.DB, "tok-123"), null);
  assert.equal((await env.DB.prepare("SELECT state FROM users WHERE id=?").bind(tokenId).first()).state, "revoked");
});
