export class MemoryKV {
  constructor(entries = {}) {
    this.data = new Map(Object.entries(entries));
    // 写操作记录: [{op: "put"|"delete", key}], 供断言「某批次是否真的落盘」(KV 写额度去重优化)
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
