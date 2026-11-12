import { decryptGithubToken, encryptGithubToken } from "./credentials.js";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const TTL = 1800;
const HEADERS = {
  "User-Agent": "ltools-apk-store/1.0",
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28"
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
  });
}

function name(value) {
  return String(value || "").trim();
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function github(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }
  });
  if (response.status >= 300 && response.status < 400 && init.redirect === "manual") return response;
  if (response.status === 401) fail("GitHub Token 无效或已过期，请重新配置", 401);
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset") || 0) * 1000;
      const minutes = reset > Date.now() ? Math.ceil((reset - Date.now()) / 60000) : 60;
      fail(`GitHub API 频率超限，约 ${minutes} 分钟后恢复`, 429);
    }
  }
  if (response.status === 404) fail("仓库或资源不存在，或当前 Token 无权访问", 404);
  if (!response.ok) fail(`GitHub API ${response.status}`, 502);
  return response;
}

async function config(env, userId) {
  const row = await env.DB.prepare(
    "SELECT data,version FROM user_config WHERE token_id=? AND business_line='store'"
  ).bind(userId).first();
  return row ? { value: JSON.parse(row.data), version: Number(row.version) } : { value: {}, version: 0 };
}

async function updateConfig(env, userId, modify) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await config(env, userId);
    const value = { ...current.value, githubAccounts: { ...(current.value.githubAccounts || {}) } };
    await modify(value.githubAccounts);
    const serialized = JSON.stringify(value);
    const stamp = new Date().toISOString();
    const statement = current.version
      ? env.DB.prepare("UPDATE user_config SET data=?,updated_at=?,version=version+1 WHERE token_id=? AND business_line='store' AND version=?")
        .bind(serialized, stamp, userId, current.version)
      : env.DB.prepare("INSERT INTO user_config(token_id,business_line,data,updated_at,version) VALUES (?,'store',?,?,1) ON CONFLICT(token_id,business_line) DO NOTHING")
        .bind(userId, serialized, stamp);
    const result = await statement.run();
    if (Number(result.meta?.changes) === 1) return value.githubAccounts;
  }
  fail("配置已被其他设备更新，请重试", 409);
}

function publicAccounts(accounts) {
  return Object.entries(accounts).map(([login, entry]) => ({ login: entry.login || login, hasToken: !!entry.token, tokenHint: entry.tokenHint || "" }));
}

async function account(env, userId, login) {
  const entry = (await config(env, userId)).value.githubAccounts?.[login.toLowerCase()];
  return { entry, token: entry?.token ? await decryptGithubToken(env, userId, login, entry.token) : "" };
}

async function listRepos(login, token, page) {
  const path = token
    ? `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=pushed&visibility=all`
    : `/users/${encodeURIComponent(login)}/repos?per_page=100&page=${page}&type=owner&sort=pushed`;
  const response = await github(path, token);
  const batch = await response.json();
  const repos = batch.filter((item) => item.owner?.login?.toLowerCase() === login.toLowerCase());
  const visible = repos.filter((item) => !item.archived);
  const scopes = response.headers.get("x-oauth-scopes");
  return { hasMore: batch.length === 100, ...(token ? { diagnostics: {
    upstreamPrivateCount: batch.filter((item) => item.private).length,
    accountPrivateCount: visible.filter((item) => item.private).length,
    classicRepoScopeMissing: !token.startsWith("ghp_") || scopes === null
      ? null : !scopes.split(",").some((scope) => scope.trim() === "repo")
  } } : {}), repos: visible.map((item) => ({
    name: item.name, fullName: item.full_name, description: item.description || "",
    htmlUrl: item.html_url, pushedAt: item.pushed_at, private: !!item.private
  })) };
}

function releaseOf(item, isPrivate) {
  return {
    tag: item.tag_name, name: item.name || item.tag_name, publishedAt: item.published_at,
    prerelease: item.prerelease === true, htmlUrl: item.html_url,
    assets: (item.assets || []).map((asset) => ({
      id: asset.id, name: asset.name, size: asset.size,
      url: isPrivate ? null : asset.browser_download_url,
      contentType: asset.content_type || ""
    }))
  };
}

async function cached(env, key, token, load) {
  if (token) return { payload: await load(), cache: "private" };
  const previous = await env.MAOYAN_KV?.get(key, "json").catch(() => null);
  if (previous) return { payload: previous, cache: "hit" };
  const payload = await load();
  await env.MAOYAN_KV?.put(key, JSON.stringify(payload), { expirationTtl: TTL }).catch(() => null);
  return { payload, cache: "miss" };
}

async function assetResponse(login, repo, assetId, token) {
  if (!token) fail("私有仓库下载需要 GitHub Token", 403);
  if (!/^\d+$/.test(assetId)) fail("资源编号无效");
  const releases = await (await github(`/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/releases?per_page=30`, token)).json();
  const asset = releases.flatMap((release) => release.assets || []).find((candidate) => String(candidate.id) === assetId);
  if (!asset) fail("资源不存在或无权访问", 404);
  const response = await github(`/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`, token, {
    redirect: "manual", headers: { Accept: "application/octet-stream" }
  });
  // GitHub may redirect to a signed, short-lived asset URL. Never forward Authorization.
  if (response.status >= 300 && response.status < 400) {
    const target = new URL(response.headers.get("Location") || "");
    if (target.protocol !== "https:" || target.hostname !== "release-assets.githubusercontent.com") fail("下载地址无效", 502);
    const download = await fetch(target, { redirect: "error" });
    if (!download.ok) fail("下载失败", 502);
    return new Response(download.body, {
      headers: { "Content-Type": asset.content_type || "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`, "Cache-Control": "private, no-store" }
    });
  }
  return new Response(response.body, {
    headers: { "Content-Type": asset.content_type || "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`, "Cache-Control": "private, no-store" }
  });
}

export async function handleGithubReleases(request, url, env, principal) {
  if (!url.pathname.startsWith("/store/api/github/")) return null;
  const userId = principal.userId;
  const path = url.pathname.slice("/store/api/github/".length);
  try {
    if (path === "accounts") {
      if (request.method === "GET") return json({ accounts: publicAccounts((await config(env, userId)).value.githubAccounts || {}) });
      if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
      const body = await request.json().catch(() => null);
      const login = name(body?.login);
      if (!LOGIN.test(login)) fail("GitHub 账号格式不正确");
      if (request.method === "POST" && (typeof body.token !== "string" || body.token.length > 512)) fail("Token 格式无效");
      const entries = await updateConfig(env, userId, async (accounts) => {
        const key = login.toLowerCase();
        if (request.method === "DELETE") { delete accounts[key]; return; }
        const previous = accounts[key] || {};
        accounts[key] = {
          login,
          token: body.token ? await encryptGithubToken(env, userId, login, body.token) : previous.token,
          tokenHint: body.token ? `****${body.token.slice(-4)}` : previous.tokenHint || ""
        };
      });
      return json({ accounts: publicAccounts(entries) });
    }
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const login = name(url.searchParams.get("account"));
    if (!LOGIN.test(login)) fail("GitHub 账号格式不正确");
    const { token } = await account(env, userId, login);
    if (path === "repos") {
      const page = Number(url.searchParams.get("page") || 1);
      if (!Number.isInteger(page) || page < 1 || page > 1000) fail("页码无效");
      const { payload, cache } = await cached(env, `gh:repos:${login.toLowerCase()}:${page}`, token,
        async () => ({ account: login, page, ...await listRepos(login, token, page) }));
      return json(payload, 200, { "X-Cache": cache });
    }
    const repoPath = name(url.searchParams.get("repo"));
    const [owner, repo, extra] = repoPath.split("/");
    if (!owner || owner.toLowerCase() !== login.toLowerCase() || !REPO.test(repo) || repo === "." || repo === ".." || extra) fail("仓库名称无效");
    if (path === "asset") return await assetResponse(login, repo, name(url.searchParams.get("id")), token);
    if (path !== "releases") return json({ error: "not found" }, 404);
    const { payload, cache } = await cached(env, `gh:release:${login.toLowerCase()}/${repo.toLowerCase()}`, token, async () => {
      const releases = await (await github(`/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/releases?per_page=10`, token)).json();
      return { repo: `${login}/${repo}`, private: !!token,
        releases: releases.filter((item) => !item.draft).map((item) => releaseOf(item, !!token)) };
    });
    return json(payload, 200, { "X-Cache": cache });
  } catch (error) {
    return json({ error: error.message || "GitHub 请求失败" }, error.status || 502);
  }
}
