const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCredentialStore } = require("../main/credential-store");

function makeTempApp() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-credentials-"));
  return {
    app: { getPath: () => userData },
    userData,
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true })
  };
}

function encryptedStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`),
    decryptString: (value) => {
      const decoded = value.toString();
      if (!decoded.startsWith("protected:")) throw new Error("malformed");
      return decoded.slice("protected:".length);
    }
  };
}

test("credential store persists encrypted tokens without writing plaintext", () => {
  const fixture = makeTempApp();
  try {
    const store = createCredentialStore({ app: fixture.app, safeStorage: encryptedStorage() });
    store.setToken("https://worker.example/api", "secret-token");

    const persisted = fs.readFileSync(path.join(fixture.userData, "worker-credentials.json"), "utf8");
    assert.doesNotMatch(persisted, /secret-token/);
    assert.equal(createCredentialStore({ app: fixture.app, safeStorage: encryptedStorage() }).getToken("https://worker.example/api"), "secret-token");
    assert.equal(store.isPersistent(), true);
  } finally {
    fixture.cleanup();
  }
});

test("credential store keeps tokens in memory when encryption is unavailable", () => {
  const fixture = makeTempApp();
  try {
    const safeStorage = { isEncryptionAvailable: () => false };
    const store = createCredentialStore({ app: fixture.app, safeStorage });
    store.setToken("https://worker.example", "memory-only-token");

    assert.equal(store.getToken("https://worker.example"), "memory-only-token");
    assert.equal(store.isPersistent(), false);
    assert.equal(fs.existsSync(path.join(fixture.userData, "worker-credentials.json")), false);
    assert.equal(createCredentialStore({ app: fixture.app, safeStorage }).getToken("https://worker.example"), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("credential store treats malformed encrypted values as missing", () => {
  const fixture = makeTempApp();
  try {
    fs.writeFileSync(path.join(fixture.userData, "worker-credentials.json"), JSON.stringify({
      tokens: { "https://worker.example": "bm90LWFuLWVuY3J5cHRlZC10b2tlbg==" }
    }));

    const store = createCredentialStore({ app: fixture.app, safeStorage: encryptedStorage() });
    assert.equal(store.getToken("https://worker.example"), undefined);
  } finally {
    fixture.cleanup();
  }
});
