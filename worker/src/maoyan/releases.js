const API_URL = "https://api.github.com/repos/shovelshit/tools/releases/latest";
const GITEE_API_URL = "https://gitee.com/api/v5/repos/aka-ljf/tools/releases/latest";
const RELEASE_URL = "https://github.com/shovelshit/tools/releases";
const DOWNLOAD_PREFIX = "https://github.com/shovelshit/tools/releases/download/";
const GITEE_RELEASE_URL = "https://gitee.com/aka-ljf/tools/releases";
const GITEE_DOWNLOAD_PREFIX = "https://gitee.com/aka-ljf/tools/releases/download/";
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

export function resetReleaseCache() { cache = null; }

function safeAsset(asset) {
  const name = String(asset?.name || "");
  const url = String(asset?.browser_download_url || "");
  if (!/\.(?:dmg|zip|exe)$/i.test(name) || !/(?:arm64|aarch64|x64|x86_64)/i.test(name) || !(url.startsWith(DOWNLOAD_PREFIX) || url.startsWith(GITEE_DOWNLOAD_PREFIX))) return null;
  return { name, url, size: Number(asset.size || 0), checksumUrl: null };
}

function normalizeRelease(release, apiUrl) {
  if (!release || release.draft === true || release.prerelease === true) throw new Error("release unavailable");
  const releaseUrl = String(release.html_url || (apiUrl === GITEE_API_URL && release.tag_name
    ? `${GITEE_RELEASE_URL}/tag/${encodeURIComponent(release.tag_name)}` : ""));
  if (!(releaseUrl.startsWith(`${RELEASE_URL}/tag/`) || releaseUrl.startsWith(`${GITEE_RELEASE_URL}/tag/`))) throw new Error("release URL invalid");
  const rawAssets = Array.isArray(release.assets) ? release.assets : [];
  const checksums = new Map(rawAssets.filter((asset) => String(asset?.name || "").endsWith(".sha256"))
    .filter((asset) => {
      const url = String(asset?.browser_download_url || "");
      return url.startsWith(DOWNLOAD_PREFIX) || url.startsWith(GITEE_DOWNLOAD_PREFIX);
    })
    .map((asset) => [String(asset.name).slice(0, -7), String(asset.browser_download_url)]));
  const assets = rawAssets.map(safeAsset).filter(Boolean).map((asset) => ({
    ...asset,
    checksumUrl: checksums.get(asset.name) || null
  }));
  if (!assets.length) throw new Error("release has no desktop installers");
  return { releaseUrl, version: String(release.tag_name || "").replace(/^v/, ""), assets, stale: false };
}

export async function getReleaseDownloads(_env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (cache && cache.fetchImpl === fetchImpl && nowMs - cache.measuredAt < CACHE_MS) return { ...cache.value, stale: false };
  try {
    let lastError;
    for (const apiUrl of [GITEE_API_URL, API_URL]) {
      try {
        const response = await fetchImpl(apiUrl, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "shovelshit-tools-worker" },
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new Error(`release request failed: HTTP ${response.status}`);
        const value = normalizeRelease(await response.json(), apiUrl);
        cache = { measuredAt: nowMs, value, fetchImpl };
        return value;
      } catch (error) {
        console.warn("release source unavailable", { source: new URL(apiUrl).hostname, reason: error.message });
        lastError = error;
      }
    }
    throw lastError || new Error("release request failed");
  } catch {
    if (cache) return { ...cache.value, stale: true };
    return { releaseUrl: RELEASE_URL, version: null, assets: [], stale: true };
  }
}
