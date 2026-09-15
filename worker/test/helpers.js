import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as db from "../src/maoyan/db.js";

export class MemoryKV {
  constructor(entries = {}) {
    this.data = new Map(Object.entries(entries));
    // 写操作记录: [{op: "put"|"delete", key}], 供断言「某批次是否真的落盘」
    this.ops = [];
  }

  async get(key, type) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.ops.push({ op: "put", key });
    this.data.set(key, String(value));
  }

  async delete(key) {
    this.ops.push({ op: "delete", key });
    this.data.delete(key);
  }

  // 统计某 key 的写操作次数(put/delete 合计)
  writeCount(key) {
    return this.ops.filter((entry) => entry.key === key).length;
  }

  resetOps() {
    this.ops = [];
  }

  // 与 KV list 语义对齐的内存实现: 无分页, 一次性返回(list_complete: true)
  async list(options = {}) {
    const prefix = String(options.prefix || "");
    const keys = [...this.data.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

// ---------------- D1 测试替身(node:sqlite 实装真 SQL) ----------------
// 用真实 SQLite 执行 schema.sql + db.js 的全部语句, 保证测试对 SQL 本身有覆盖。
// 记录写语句供断言「哪些表被写过/写过几次」(对应 KV 版 MemoryKV.ops)。

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

export class MemoryD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(SCHEMA_SQL);
    // 写语句记录: [{table}], 仅 INSERT/UPDATE/DELETE
    this.writes = [];
  }

  prepare(sql) {
    const shim = this;
    const make = (params) => ({
      bind: (...next) => make(next),
      async first() {
        const stmt = shim.sqlite.prepare(sql);
        const row = params.length ? stmt.get(...params) : stmt.get();
        return row === undefined ? null : row;
      },
      async all() {
        const stmt = shim.sqlite.prepare(sql);
        const results = params.length ? stmt.all(...params) : stmt.all();
        return { results };
      },
      async run() {
        shim.record(sql);
        const stmt = shim.sqlite.prepare(sql);
        if (params.length) stmt.run(...params);
        else stmt.run();
        return { success: true };
      }
    });
    return make([]);
  }

  record(sql) {
    const match = /^\s*(?:INSERT|UPDATE|DELETE)\b/i.exec(sql);
    if (!match) return;
    const table = /\b(?:INTO|UPDATE|FROM)\s+([a-z_]+)/i.exec(sql);
    this.writes.push({ sql: sql.trim(), table: table ? table[1].toLowerCase() : null });
  }

  // 某张表的写语句次数
  writeCount(table) {
    return this.writes.filter((entry) => entry.table === String(table).toLowerCase()).length;
  }

  resetWrites() {
    this.writes = [];
  }
}

// D1 种子工厂: 复用 db.js 写入器构造测试夹具(同时验证写入器本身)。
// seeds: { tokens: [...], configs: {id: cfg}, snapshots: {id: {movieId: [seqNo]}},
//          statuses: {id: obj}, changes: {id: [新在前]}, lockRules: {id: rule} }
export async function createDB(seeds = {}) {
  const d1 = new MemoryD1();
  for (const token of seeds.tokens || []) await db.upsertToken(d1, token);
  for (const [tokenId, config] of Object.entries(seeds.configs || {})) await db.putConfig(d1, tokenId, config);
  for (const [tokenId, snapshot] of Object.entries(seeds.snapshots || {})) await db.saveSnapshot(d1, tokenId, snapshot);
  for (const [tokenId, status] of Object.entries(seeds.statuses || {})) await db.putStatus(d1, tokenId, status);
  for (const [tokenId, entries] of Object.entries(seeds.changes || {})) await db.replaceChanges(d1, tokenId, entries);
  for (const [tokenId, rule] of Object.entries(seeds.lockRules || {})) await db.putLockRuleRow(d1, tokenId, rule);
  for (const [key, record] of Object.entries(seeds.seatFeedback || {})) await db.putSeatFeedbackRow(d1, key, record);
  // 种子写入不计入写操作断言(writeCount 只度量被测代码的落盘)
  d1.writes = [];
  return d1;
}

export function testEncryptionKey() {
  return Buffer.alloc(32, 7).toString("base64");
}

export function validSession(overrides = {}) {
  return {
    cookies: [
      { name: "uid", value: "123456789", domain: ".maoyan.com" },
      { name: "_csrf", value: "csrf-value", domain: ".maoyan.com" },
      { name: "token", value: "cookie-secret", domain: ".maoyan.com" }
    ],
    csrf: "csrf-value",
    mtgsig: "signature-secret",
    create_order_query: { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" },
    user_agent: "Mozilla/5.0 Test",
    saved_at: "2026-09-11T00:00:00.000Z",
    ...overrides
  };
}

export async function captureConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  const entries = [];
  const capture = (...args) => entries.push(args);
  console.log = capture;
  console.error = capture;
  try {
    const result = await callback();
    return {
      result,
      entries,
      text: entries.flatMap((args) => args).map((value) =>
        typeof value === "string" ? value : JSON.stringify(value)
      ).join("\n")
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
