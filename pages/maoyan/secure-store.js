// ---------------- 加密存储: localStorage 中的令牌 AES-GCM 加密 ----------------
// 防护目标: 设备上直接翻 localStorage / 浏览器同步/备份文件时看不到明文令牌
// 局限说明: 密钥派生素材仍在本地, 无法防御已注入页面的 XSS 脚本(它们能直接调页面函数)
// 兼容性: 不兼容存量明文, 非密文读取时直接清除

(function () {
  // 应用内固定干扰因子 + 每设备随机盐, 派生 AES-256 密钥
  const APP_PEPPER = "tools::maoyan::secure-store::v1";
  const SALT_KEY = "_ss_ks";
  const PREFIX = "enc:v1:";

  let cachedKey = null;

  async function getKey() {
    if (cachedKey) return cachedKey;
    let salt = localStorage.getItem(SALT_KEY);
    if (!salt) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      salt = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(SALT_KEY, salt);
    }
    const material = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(APP_PEPPER + ":" + salt)
    );
    cachedKey = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return cachedKey;
  }

  function toB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  function fromB64(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  }

  window.secureGet = async function (name) {
    const stored = localStorage.getItem(name);
    if (!stored) return "";
    if (!stored.startsWith(PREFIX)) {
      // 不兼容存量明文: 非密文一律清除, 需重新填写令牌
      localStorage.removeItem(name);
      return "";
    }
    try {
      const raw = fromB64(stored.slice(PREFIX.length));
      const iv = raw.slice(0, 12);
      const data = raw.slice(12);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        await getKey(),
        data
      );
      return new TextDecoder().decode(plain);
    } catch (e) {
      localStorage.removeItem(name); // 密文损坏(如换盐): 当作无值
      return "";
    }
  };

  window.secureSet = async function (name, value) {
    if (!value) {
      localStorage.removeItem(name);
      return;
    }
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value)
    );
    localStorage.setItem(name, PREFIX + toB64([...iv, ...new Uint8Array(data)]));
  };
})();
