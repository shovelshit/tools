import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv, seedAccount } from "./account-fixtures.js";
import { testEncryptionKey } from "./helpers.js";
import { updateManagedAccount } from "../src/maoyan/enrollment-store.js";

const REPOS = [
  {
    id: 1, name: "app-one", full_name: "alice/app-one", owner: { login: "alice" },
    description: "one", html_url: "https://github.com/alice/app-one",
    pushed_at: "2026-10-20T00:00:00Z", private: false, archived: false
  },
  {
    id: 2, name: "private-app", full_name: "alice/private-app", owner: { login: "alice" },
    description: "private", html_url: "https://github.com/alice/private-app",
    pushed_at: "2026-10-19T00:00:00Z", private: true, archived: false
  }
];

const RELEASES = {
  "alice/app-one": [{
    tag_name: "v1.2.3", name: "1.2.3", published_at: "2026-10-18T00:00:00Z",
    draft: false, prerelease: false,
    html_url: "https://github.com/alice/app-one/releases/tag/v1.2.3",
    assets: [{
      name: "app-one.apk", size: 12_345_678,
      browser_download_url: "https://github.com/alice/app-one/releases/download/v1.2.3/app-one.apk",
      content_type: "application/vnd.android.package-archive"
    }]
  }],
  "alice/private-app": [{
    tag_name: "v9.0.0", name: "9.0.0", published_at: "2026-10-17T00:00:00Z",
    draft: false, prerelease: false,
    html_url: "https://github.com/alice/private-app/releases/tag/v9.0.0", assets: []
  }]
};

async function storeCookie(env) {
  const { key } = await seedAccount(env, { businessLine: "store", expiresAt: Date.now() + 86_400_000 });
  const login = await worker.fetch(new Request("https://worker.example/store/auth/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key })
  }), env);
  return login.headers.get("Set-Cookie").split(";")[0];
}

function request(path, cookie, options = {}) {
  return new Request(`https://worker.example${path}`, {
    ...options, headers: { Cookie: cookie, ...(options.headers || {}) }
  });
}

function installGithubFetch(calls) {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers || {}) });
    if (url.includes("/user/repos")) {
      return new Response(JSON.stringify(REPOS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/users/alice/repos")) {
      return new Response(JSON.stringify(REPOS.filter((repo) => !repo.private)), { status: 200 });
    }
    const match = url.match(/repos\/([^/]+\/[^/]+)\/releases/);
    if (match) return new Response(JSON.stringify(RELEASES[match[1]] || []), { status: 200 });
    if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "alice" }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}

test("绑定 GitHub 账号后可以加载账号仓库列表", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  const calls = [];
  installGithubFetch(calls);
  try {
    const save = await worker.fetch(request("/store/api/github/accounts", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "alice", token: "ghp-private-token" })
    }), env);
    assert.equal(save.status, 200);
    const response = await worker.fetch(request("/store/api/github/repos?account=alice", cookie), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.repos.length, 2);
    assert.equal(body.repos[1].private, true);
    assert.equal(response.headers.get("X-Cache"), "private");
    assert.match(calls[0].url, /\/user\/repos\?per_page=100&page=1&affiliation=owner,collaborator,organization_member&sort=pushed/);
    assert.equal(calls.some((call) => call.headers.get("Authorization") === "Bearer ghp-private-token"), true);
    assert.doesNotMatch(JSON.stringify(body), /ghp-private-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub 私有仓库缺失时区分上游权限与账号归属过滤", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer ghp_public-only-token");
    return new Response(JSON.stringify([
      REPOS[0], { ...REPOS[1], owner: { login: "other" }, full_name: "other/private-app" }
    ]), { headers: { "x-oauth-scopes": "read:user, public_repo" } });
  };
  try {
    await worker.fetch(request("/store/api/github/accounts", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "alice", token: "ghp_public-only-token" })
    }), env);
    const response = await worker.fetch(request("/store/api/github/repos?account=alice", cookie), env);
    const body = await response.json();
    assert.equal(response.headers.get("X-Cache"), "private");
    assert.deepEqual(body.repos.map((repo) => repo.fullName), ["alice/app-one"]);
    assert.deepEqual(body.diagnostics, {
      upstreamPrivateCount: 1, accountPrivateCount: 0, classicRepoScopeMissing: true
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("fine-grained PAT 没有 OAuth scope 头时不误报缺少 classic repo 权限", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([REPOS[0]]), {
    headers: { "x-oauth-scopes": "" }
  });
  try {
    await worker.fetch(request("/store/api/github/accounts", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "alice", token: "github_pat_public-only-token" })
    }), env);
    const response = await worker.fetch(request("/store/api/github/repos?account=alice", cookie), env);
    assert.equal((await response.json()).diagnostics.classicRepoScopeMissing, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("只在用户请求具体仓库时加载 Release", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  const calls = [];
  installGithubFetch(calls);
  try {
    await worker.fetch(request("/store/api/github/repos?account=alice", cookie), env);
    assert.equal(calls.some((call) => call.url.includes("/releases")), false);
    const response = await worker.fetch(request("/store/api/github/releases?account=alice&repo=alice/app-one", cookie), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.releases[0].tag, "v1.2.3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub 账号配置列表只返回账号和 Token 状态", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  installGithubFetch([]);
  try {
    await worker.fetch(request("/store/api/github/accounts", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "alice", token: "ghp-secret-value" })
    }), env);
    const response = await worker.fetch(request("/store/api/github/accounts", cookie), env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.accounts.map(({ login, hasToken }) => ({ login, hasToken })), [{ login: "alice", hasToken: true }]);
    assert.doesNotMatch(JSON.stringify(body), /ghp-secret-value/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("未登录不能访问 GitHub 账号接口", async () => {
  const env = await createAccountEnv();
  const response = await worker.fetch(new Request("https://worker.example/store/api/github/repos?account=alice"), env);
  assert.equal(response.status, 401);
});

test("不同 Store 用户的 GitHub Token 不会互相读取", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const first = await storeCookie(env);
  const second = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  const calls = [];
  installGithubFetch(calls);
  try {
    await worker.fetch(request("/store/api/github/accounts", first, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "alice", token: "first-only-secret" })
    }), env);
    const other = await worker.fetch(request("/store/api/github/accounts", second), env);
    assert.deepEqual((await other.json()).accounts, []);
    await worker.fetch(request("/store/api/github/repos?account=alice", second), env);
    assert.equal(calls.some((call) => call.headers.get("Authorization")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("私有附件通过同源接口传输，重定向时不向下载域名发送 Token", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers || {}) });
    if (url.endsWith("/releases?per_page=30")) return new Response(JSON.stringify([{
      assets: [{ id: 42, name: "private-app.apk", content_type: "application/vnd.android.package-archive" }]
    }]));
    if (url.endsWith("/releases/assets/42")) return new Response(null, {
      status: 302, headers: { Location: "https://release-assets.githubusercontent.com/a-signed-link" }
    });
    if (url.includes("release-assets.githubusercontent.com")) return new Response("apk-binary");
    return new Response("{}", { status: 404 });
  };
  try {
    await worker.fetch(request("/store/api/github/accounts", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "alice", token: "ghp-private-token" })
    }), env);
    const response = await worker.fetch(request("/store/api/github/asset?account=alice&repo=alice/private-app&id=42", cookie), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "apk-binary");
    assert.equal(calls.at(-1).headers.has("Authorization"), false);
    assert.match(response.headers.get("Content-Disposition"), /private-app\.apk/);
  } finally { globalThis.fetch = originalFetch; }
});

test("撤销 Store 用户时删除该用户的加密 GitHub Token", async () => {
  const env = await createAccountEnv();
  env.GITHUB_TOKEN_ENCRYPTION_KEY = testEncryptionKey();
  const cookie = await storeCookie(env);
  await worker.fetch(request("/store/api/github/accounts", cookie, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "alice", token: "ghp-revoke-me" })
  }), env);
  const row = await env.DB.prepare("SELECT token_id FROM user_config WHERE business_line='store'").first();
  assert.ok(row);
  await updateManagedAccount(env, { userId: row.token_id, expectedVersion: 1, patch: { state: "revoked" } });
  assert.equal(await env.DB.prepare("SELECT data FROM user_config WHERE token_id=?").bind(row.token_id).first(), null);
});
