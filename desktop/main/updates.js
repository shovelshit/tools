const GITHUB_RELEASES_API = "https://api.github.com/repos/shovelshit/tools/releases/latest";
const GITHUB_RELEASE_PREFIX = "/shovelshit/tools/releases/tag/";
const MAX_RELEASE_NOTES_LENGTH = 4 * 1024;
const CLAIM_URL = "https://ltools.asia/maoyan/claim.html";
const SETUP_URLS = new Set(["https://apps.apple.com/cn/app/id1403753865", "https://sct.ftqq.com/sendkey", CLAIM_URL]);

function normalizeVersion(value) {
  const match = typeof value === "string" && value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function isOfficialReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      (url.origin === "https://github.com" && url.pathname.startsWith(GITHUB_RELEASE_PREFIX)) &&
      url.pathname.length > GITHUB_RELEASE_PREFIX.length;
  } catch {
    return false;
  }
}

function isFixedApiResponse(response) {
  if (!response?.url) return true;
  try {
    const finalUrl = new URL(response.url);
    return finalUrl.protocol === "https:" && !finalUrl.username && !finalUrl.password &&
      finalUrl.origin === "https://api.github.com" && finalUrl.pathname === "/repos/shovelshit/tools/releases/latest" && !finalUrl.search && !finalUrl.hash;
  } catch {
    return false;
  }
}

async function checkForUpdates({ currentVersion, fetchImpl = globalThis.fetch } = {}) {
  try {
    const current = normalizeVersion(currentVersion);
    if (!current || typeof fetchImpl !== "function") throw new Error("invalid version");
    const response = await fetchImpl(GITHUB_RELEASES_API, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response?.ok || !isFixedApiResponse(response)) throw new Error("request failed");
    const release = await response.json();
    const version = normalizeVersion(release?.tag_name);
    const releaseUrl = typeof release?.html_url === "string" ? release.html_url : "";
    if (!version || !isOfficialReleaseUrl(releaseUrl) || release.draft || release.prerelease) throw new Error("invalid release");
    if (compareVersions(version, current) <= 0) return { available: false };
    return { available: true, version: version.join("."), notes: typeof release.body === "string" ? release.body.slice(0, MAX_RELEASE_NOTES_LENGTH) : "", releaseUrl };
  } catch {
    return { available: false, error: "unavailable" };
  }
}

function validateExternalUrl(value, { approvedUrls = [], workerProfile } = {}) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  const normalized = url.toString();
  const approved = isOfficialReleaseUrl(normalized) || SETUP_URLS.has(normalized) || approvedUrls.includes(normalized);
  if (!approved) return null;
  if (workerProfile?.baseUrl && normalized !== CLAIM_URL) {
    try {
      const workerUrl = new URL(workerProfile.baseUrl);
      if (url.origin === workerUrl.origin && (url.pathname === workerUrl.pathname || url.pathname.startsWith(`${workerUrl.pathname.replace(/\/$/, "")}/`))) return null;
    } catch { return null; }
  }
  return normalized;
}

async function openExternal(url, { shell, approvedUrls, workerProfile } = {}) {
  const approved = validateExternalUrl(url, { approvedUrls, workerProfile });
  if (!approved || typeof shell?.openExternal !== "function") return { opened: false };
  await shell.openExternal(approved);
  return { opened: true };
}

module.exports = {
  GITHUB_RELEASES_API,
  checkForUpdates,
  isOfficialReleaseUrl,
  normalizeVersion,
  validateExternalUrl,
  openExternal
};
