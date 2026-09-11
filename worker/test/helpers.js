export class MemoryKV {
  constructor(entries = {}) {
    this.data = new Map(Object.entries(entries));
  }

  async get(key, type) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.data.set(key, String(value));
  }

  async delete(key) {
    this.data.delete(key);
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
