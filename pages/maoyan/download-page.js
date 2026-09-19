(async function () {
  const status = document.getElementById("download-status");
  const list = document.getElementById("download-list");
  try {
    const response = await fetch("/api/releases");
    if (!response.ok) throw new Error("release unavailable");
    const release = await response.json();
    const platform = await window.resolvePlatform(navigator);
    const selected = window.selectDownloadOptions(platform, release.assets, "");
    const assets = [selected.recommended, ...selected.alternatives]
      .filter(Boolean)
      .filter((asset) => /\.(?:dmg|exe)$/i.test(asset.name));
    if (!assets.length) throw new Error("no assets");
    status.textContent = `当前版本 v${release.version || "最新"} · 已识别为 ${platform.os}${platform.arch !== "unknown" ? ` · ${platform.arch}` : ""}`;
    for (const asset of assets) {
      const item = document.createElement("div"); item.className = `download-item${asset === selected.recommended ? " recommended" : ""}`;
      const label = document.createElement("div"); const name = document.createElement("strong"); name.textContent = asset.name;
      const badge = document.createElement("small"); badge.textContent = asset === selected.recommended ? "推荐版本" : "备用版本";
      label.append(name, badge); const link = document.createElement("a"); link.href = asset.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "下载";
      item.append(label, link); list.append(item);
    }
  } catch { status.textContent = "暂时无法读取最新版本，请稍后重试。"; }
})();
