import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createAccountEnv } from "./account-fixtures.js";

const REPOS = [
  {
    full_name: "alice/app-one",
    name: "app-one",
    description: "one",
    html_url: "https://github.com/alice/app-one",
    pushed_at: "2026-10-20T00:00:00Z",
    archived: false
  },
  {
    full_name: "alice/no-release",
    name: "no-release",
    description: "",
    html_url: "https://github.com/alice/no-release",
    pushed_at: "2026-10-19T00:00:00Z",
    archived: false
  }
];

const RELEASES = {
  "alice/app-one": [
    {
      tag_name: "v1.2.3",
      name: "1.2.3",
      published_at: "2026-10-18T00:00:00Z",
      draft: false,
      prerelease: false,
      html_url: "https://github.com/alice/app-one/releases/tag/v1.2.3",
      assets: [
        {
          name: "app-one.apk",
          size: 12_345_678,
          browser_download_url: "https://github.com/alice/app-one/releases/download/v1.2.3/app-one.apk",
          content_type: "application/vnd.android.package-archive"
        }
      ]
    }
  ],
  "alice/no-release": []
};

function installFetch(calls) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/users/alice/repos")) {
      return new Response(JSON.stringify(REPOS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const match = url.match(/repos\/([^/]+)\/([^/]+)\/releases/);
    if (match) {
      const key = `${match[1]}/${match[2]}`;
      return new Response(JSON.stringify(RELEASES[key] || []), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

test("扫描账号公开仓库的 releases 并返回下载地址", async () => {
  const env = await createAccountEnv();
  const calls = [];
  const originalFetch = globalThis.fetch;
  installFetch(calls);
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/store/api/github/releases?user=alice"), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user, "alice");
    assert.equal(body.repoCount, 1);
    assert.equal(body.repos[0].fullName, "alice/app-one");
    assert.equal(body.repos[0].releases[0].tag, "v1.2.3");
    assert.equal(body.repos[0].releases[0].assets[0].name, "app-one.apk");
    assert.match(body.repos[0].releases[0].assets[0].url, /releases\/download\/v1\.2\.3\/app-one\.apk$/);
    assertsCalls(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function assertsCalls(calls) {
  assert.ok(calls.some((url) => url.includes("/users/alice/repos")));
  assert.ok(calls.some((url) => url.includes("/repos/alice/app-one/releases")));
}

test("同一账号第二次请求命中 KV 缓存", async () => {
  const env = await createAccountEnv();
  const calls = [];
  const originalFetch = globalThis.fetch;
  installFetch(calls);
  try {
    const url = "https://worker.example/store/api/github/releases?user=alice";
    await worker.fetch(new Request(url), env);
    const first = calls.length;
    const cached = await worker.fetch(new Request(url), env);
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get("X-Cache"), "hit");
    assert.equal(calls.length, first, "缓存命中时不应再请求 GitHub");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("非法账号名直接拒绝", async () => {
  const env = await createAccountEnv();
  const response = await worker.fetch(
    new Request("https://worker.example/store/api/github/releases?user=bad%20name!"), env);
  assert.equal(response.status, 400);
});

test("GitHub 限流时返回错误而不是 500", async () => {
  const env = await createAccountEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) }
  });
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/store/api/github/releases?user=alice"), env);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /频率超限/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
