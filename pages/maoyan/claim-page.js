(async function () {
  const $ = (id) => document.getElementById(id);
  const workerUrl = location.origin.replace(/\/$/, "");
  const views = ["loading", "idle", "working", "active", "unavailable", "error"];
  let config = null;
  let turnstileToken = "";
  let controller = null;
  let downloadsLoaded = false;

  function show(name) {
    for (const view of views) $(`claim-${view}`).classList.toggle("hidden", view !== name);
  }

  async function api(path, options = {}) {
    const response = await fetch(workerUrl + path, {
      method: options.method || "GET",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { "X-Token": options.token } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "服务暂时不可用");
      error.code = data.code || "";
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function fmtTime(value) {
    return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
  }

  function onState(state) {
    if (["verifying", "reserving", "pending-confirmation"].includes(state.name) && !state.keyUnavailable) {
      $("claim-working-text").textContent = state.name === "verifying" ? "正在生成浏览器标识..."
        : state.name === "reserving" ? "正在预留名额..." : "正在激活账号...";
      show("working");
      return;
    }
    if (state.name === "active") {
      show("active");
      $("claim-key").textContent = state.key || "已使用本机保存的密钥";
      $("btn-copy-key").classList.toggle("hidden", !state.key);
      $("claim-expiry").textContent = state.expiresAt ? `有效期至 ${fmtTime(state.expiresAt)}` : "账号已生效";
      $("claim-storage-warning").classList.toggle("hidden", !state.ephemeral);
      $("claim-storage-warning").textContent = state.ephemeral ? "浏览器无法安全保存密钥，请立即复制；关闭页面后无法找回。" : "";
      void loadDownloads();
      return;
    }
    if (state.name === "full") { show("unavailable"); return; }
    if (state.name === "unavailable") { show("unavailable"); return; }
    if (state.name === "pending-confirmation" && state.keyUnavailable) {
      show("error");
      $("claim-error-text").textContent = state.message;
      return;
    }
    if (state.name === "error") {
      show("error");
      $("claim-error-text").textContent = state.message || "服务暂时不可用";
    }
  }

  async function loadDownloads() {
    if (downloadsLoaded || !window.selectDownloadOptions) return;
    downloadsLoaded = true;
    try {
      const release = await api("/api/releases");
      const platform = window.resolvePlatform
        ? await window.resolvePlatform(navigator)
        : window.detectPlatform({ userAgent: navigator.userAgent, platform: navigator.platform });
      const selected = window.selectDownloadOptions(platform, release.assets, config?.webUrl || "");
      const assets = [selected.recommended, ...selected.alternatives].filter(Boolean);
      if (!assets.length) return;
      const wrap = $("claim-downloads");
      wrap.innerHTML = "";
      for (const [index, asset] of assets.entries()) {
        const link = document.createElement("a");
        link.href = asset.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const recommended = selected.recommended === asset;
        link.textContent = `${recommended ? "推荐下载" : "桌面版本"}：${asset.name}`;
        wrap.append(link);
      }
      wrap.classList.remove("hidden");
    } catch { downloadsLoaded = false; }
  }

  function loadTurnstile(siteKey) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => {
        window.turnstile.render("#turnstile-slot", {
          sitekey: siteKey,
          action: "enroll",
          callback(token) { turnstileToken = token; $("btn-claim").disabled = false; },
          "expired-callback"() { turnstileToken = ""; $("btn-claim").disabled = true; }
        });
        resolve();
      };
      script.onerror = () => reject(new Error("人机验证组件加载失败"));
      document.head.append(script);
    });
  }

  async function init() {
    try {
      config = await api("/api/enrollment/config");
      $("claim-subtitle").textContent = `${config.validDays} 天有效，名额有限`;
      $("claim-capacity").textContent = `剩余 ${config.capacity.remaining} / ${config.capacity.maxUsers} 个名额`;
      controller = window.createClaimController({
        api,
        secureGet: window.secureGet,
        secureSet: window.secureSet,
        workerUrl: config.workerUrl || workerUrl,
        collectFingerprint: () => window.collectEnrollmentFingerprint({ ThumbmarkClass: window.ThumbmarkJS?.Thumbmark }),
        onState,
        navigate: (url) => {
          localStorage.setItem("workerUrl", config.workerUrl || workerUrl);
          location.href = url;
        }
      });
      const restored = await controller.restorePending();
      if (restored) return;
      if (!config.claimable) { show("unavailable"); return; }
      show("idle");
      await loadTurnstile(config.turnstileSiteKey);
    } catch (error) {
      show("error");
      $("claim-error-text").textContent = error.message || "服务暂时不可用";
    }
  }

  $("btn-claim").addEventListener("click", () => controller?.start(turnstileToken).catch(() => {}));
  $("btn-claim-retry").addEventListener("click", () => location.reload());
  $("btn-copy-key").addEventListener("click", async () => {
    const key = $("claim-key").textContent;
    try { await navigator.clipboard.writeText(key); $("btn-copy-key").textContent = "已复制"; }
    catch { $("claim-storage-warning").textContent = "复制失败，请手动选择密钥复制。"; $("claim-storage-warning").classList.remove("hidden"); }
  });
  $("btn-enter-web").addEventListener("click", () => controller?.enterWeb(config?.webUrl || new URL("index.html", location.href).href));
  $("btn-use-existing").addEventListener("click", async () => {
    const key = $("existing-key").value.trim();
    if (!key || !config) return;
    try {
      await api("/api/auth/session", { method: "POST", token: key });
      await window.secureSet(window.webTokenKey(config.workerUrl || workerUrl), key);
      localStorage.setItem("workerUrl", config.workerUrl || workerUrl);
      location.href = config.webUrl || new URL("index.html", location.href).href;
    } catch (error) {
      show("error");
      $("claim-error-text").textContent = error.message || "访问密钥无效";
    }
  });
  await init();
})();
