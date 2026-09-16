(function (root) {
  function detectPlatform({ userAgent = "", platform = "", maxTouchPoints = 0, userAgentData = null } = {}) {
    const ua = String(userAgent);
    const nativePlatform = String(platform);
    let os = "unknown";
    if (/Android/i.test(ua)) os = "android";
    else if (/iPhone|iPad|iPod/i.test(ua) || (nativePlatform === "MacIntel" && Number(maxTouchPoints) > 1)) os = "ios";
    else if (/Windows/i.test(ua) || /^Win/i.test(nativePlatform)) os = "windows";
    else if (/Macintosh|Mac OS X/i.test(ua) || /^Mac/i.test(nativePlatform)) os = "macos";
    else if (/Linux/i.test(ua) || /Linux/i.test(nativePlatform)) os = "linux";
    const architecture = String(userAgentData?.architecture || "").toLowerCase();
    const bitness = String(userAgentData?.bitness || "");
    const arch = /arm|aarch/.test(architecture) ? "arm64"
      : /x86|x64|amd/.test(architecture) && bitness !== "32" ? "x64" : "unknown";
    return { os, arch };
  }

  async function resolvePlatform(navigatorLike = {}) {
    let userAgentData = navigatorLike.userAgentData || null;
    if (typeof userAgentData?.getHighEntropyValues === "function") {
      try {
        const entropy = await userAgentData.getHighEntropyValues(["architecture", "bitness"]);
        userAgentData = { ...userAgentData, ...entropy };
      } catch {
        // Platform guidance is optional and must never block enrollment.
      }
    }
    return detectPlatform({
      userAgent: navigatorLike.userAgent,
      platform: navigatorLike.platform,
      maxTouchPoints: navigatorLike.maxTouchPoints,
      userAgentData
    });
  }

  function notificationAdvice({ platform, channel }) {
    const android = platform?.os === "android";
    return {
      recommendedChannel: android ? "serverchan" : channel === "serverchan" ? "serverchan" : "bark",
      message: android && channel === "bark" ? "Android 设备通常更适合使用 Server酱；Bark 仍可继续配置。" : "",
      blocking: false
    };
  }

  function selectDownloadOptions(platform, assets = [], webUrl = "") {
    const os = platform?.os;
    const arch = platform?.arch;
    const desktopAssets = assets.filter((asset) => /\.(dmg|zip|exe)$/i.test(String(asset.name || "")));
    const matching = desktopAssets.filter((asset) => {
      const name = String(asset.name || "").toLowerCase();
      if (os === "macos") return /\.(dmg|zip)$/.test(name) && /(arm64|aarch64|x64|x86_64)/.test(name);
      if (os === "windows") return /\.(exe|zip)$/.test(name) && /(x64|x86_64)/.test(name);
      return false;
    });
    const recommended = matching.find((asset) => {
      const name = String(asset.name || "").toLowerCase();
      if (os === "macos" && arch === "arm64") return /arm64|aarch64/.test(name);
      if (os === "macos" && arch === "x64") return /x64|x86_64/.test(name);
      return os === "windows" && /x64|x86_64/.test(name);
    }) || null;
    const useAllDesktopAssets = !["macos", "windows"].includes(os);
    return {
      recommended,
      alternatives: (useAllDesktopAssets ? desktopAssets : matching).filter((asset) => asset !== recommended),
      webUrl,
      defaultMode: recommended ? "download" : "web"
    };
  }

  const exported = { detectPlatform, resolvePlatform, notificationAdvice, selectDownloadOptions };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) Object.assign(root, exported);
})(typeof window !== "undefined" ? window : globalThis);
