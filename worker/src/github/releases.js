// 扫描 GitHub 账号下所有公开仓库的 releases（无需登录）
// 结果缓存在 KV，避免无 token 时 60 次/小时的 API 限制被很快打满。

const USER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CACHE_TTL_SECONDS = 30 * 60;
const MAX_REPOS = 60;
const RELEASES_PER_REPO = 10;
const CONCURRENCY = 5;

const GITHUB_HEADERS = {
  "User-Agent": "ltools-apk-store/1.0",
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28"
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra
    }
  });
}

async function github(url) {
  const response = await fetch(url, { headers: GITHUB_HEADERS });
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset") || 0) * 1000;
      const minutes = reset > Date.now() ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : 60;
      const error = new Error(`GitHub API 频率超限，约 ${minutes} 分钟后恢复`);
      error.code = "RATE_LIMITED";
      throw error;
    }
  }
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}`);
    error.code = "GITHUB_ERROR";
    throw error;
  }
  return response.json();
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function assetOf(asset) {
  return {
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
    contentType: asset.content_type || ""
  };
}

function releaseOf(release) {
  return {
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at,
    prerelease: release.prerelease === true,
    draft: release.draft === true,
    htmlUrl: release.html_url,
    assets: (release.assets || []).map(assetOf)
  };
}

async function collect(user) {
  const repos = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = await github(
      `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&page=${page}&type=owner&sort=pushed`
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  // 按最近推送排序，限制请求数量（每个仓库需要一次 releases 请求）
  const candidates = repos
    .filter((repo) => !repo.archived)
    .sort((a, b) => String(b.pushed_at || "").localeCompare(String(a.pushed_at || "")))
    .slice(0, MAX_REPOS);

  const detailed = await mapLimit(candidates, CONCURRENCY, async (repo) => {
    let releases = [];
    try {
      releases = await github(
        `https://api.github.com/repos/${repo.full_name}/releases?per_page=${RELEASES_PER_REPO}`
      );
    } catch (error) {
      if (error.code === "RATE_LIMITED") throw error;
      releases = [];
    }
    const visible = releases.filter((release) => !release.draft);
    if (!visible.length) return null;
    return {
      fullName: repo.full_name,
      name: repo.name,
      description: repo.description || "",
      htmlUrl: repo.html_url,
      pushedAt: repo.pushed_at,
      releases: visible.map(releaseOf)
    };
  });

  const withReleases = detailed.filter(Boolean);
  withReleases.sort((a, b) => {
    const left = a.releases[0]?.publishedAt || "";
    const right = b.releases[0]?.publishedAt || "";
    return right.localeCompare(left);
  });

  return {
    user,
    fetchedAt: new Date().toISOString(),
    repoCount: withReleases.length,
    truncated: repos.length > MAX_REPOS,
    repos: withReleases
  };
}

export async function handleGithubReleases(request, url, env) {
  if (url.pathname !== "/store/api/github/releases") return null;
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  const user = String(url.searchParams.get("user") || "").trim();
  if (!USER_PATTERN.test(user)) return json({ error: "GitHub 账号格式不正确" }, 400);

  const cacheKey = `gh:releases:${user.toLowerCase()}`;
  const kv = env.MAOYAN_KV;

  if (url.searchParams.get("refresh") !== "1") {
    try {
      const cached = await kv?.get(cacheKey, "json");
      if (cached) return json(cached, 200, { "X-Cache": "hit" });
    } catch (error) {
      // 缓存不可用时继续实时拉取
    }
  }

  try {
    const payload = await collect(user);
    try {
      await kv?.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    } catch (error) {
      // 缓存写入失败不影响返回
    }
    return json(payload, 200, { "X-Cache": "miss" });
  } catch (error) {
    try {
      const stale = await kv?.get(cacheKey, "json");
      if (stale) return json({ ...stale, stale: true }, 200, { "X-Cache": "stale" });
    } catch (ignored) {
      // 忽略缓存读取失败
    }
    return json({ error: error.message || "拉取 GitHub releases 失败" }, 502);
  }
}
