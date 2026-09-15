const fs = require("node:fs");
const path = require("node:path");

function readEncryptedTokens(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed.tokens).filter(([, value]) => typeof value === "string"));
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function createCredentialStore({ app, safeStorage }) {
  const credentialsPath = path.join(app.getPath("userData"), "worker-credentials.json");
  const persistent = Boolean(safeStorage?.isEncryptionAvailable?.());
  const encryptedTokens = persistent ? readEncryptedTokens(credentialsPath) : {};
  const memoryTokens = new Map();

  function persist() {
    writeJson(credentialsPath, { tokens: encryptedTokens });
  }

  return {
    getToken(profileKey) {
      if (!persistent) return memoryTokens.get(profileKey);
      const encryptedToken = encryptedTokens[profileKey];
      if (typeof encryptedToken !== "string") return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
      } catch {
        return undefined;
      }
    },
    setToken(profileKey, token) {
      if (typeof profileKey !== "string" || typeof token !== "string") throw new TypeError("凭据格式无效");
      if (!persistent) {
        memoryTokens.set(profileKey, token);
        return;
      }
      encryptedTokens[profileKey] = safeStorage.encryptString(token).toString("base64");
      persist();
    },
    clearToken(profileKey) {
      if (!persistent) {
        memoryTokens.delete(profileKey);
        return;
      }
      if (Object.hasOwn(encryptedTokens, profileKey)) {
        delete encryptedTokens[profileKey];
        persist();
      }
    },
    isPersistent() {
      return persistent;
    }
  };
}

module.exports = { createCredentialStore };
