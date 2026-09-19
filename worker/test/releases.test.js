import test from "node:test";
import assert from "node:assert/strict";
import { getReleaseDownloads, resetReleaseCache } from "../src/maoyan/releases.js";

const RELEASE = {
  draft: false,
  prerelease: false,
  html_url: "https://github.com/shovelshit/tools/releases/tag/v1.2.3",
  tag_name: "v1.2.3",
  assets: [
    { name: "Maoyan-arm64.dmg", browser_download_url: "https://github.com/shovelshit/tools/releases/download/v1.2.3/Maoyan-arm64.dmg", size: 10 },
    { name: "Maoyan-arm64.dmg.sha256", browser_download_url: "https://github.com/shovelshit/tools/releases/download/v1.2.3/Maoyan-arm64.dmg.sha256", size: 64 },
    { name: "evil.exe", browser_download_url: "https://evil.example/evil.exe", size: 1 }
  ]
};

test("downloads query only GitHub and reject source-only releases", async () => {
  resetReleaseCache();
  const calls = [];
  const result = await getReleaseDownloads({}, { fetchImpl: async url => {
    calls.push(url);
    return Response.json({ ...RELEASE, assets: [] });
  } });
  assert.deepEqual(calls, ["https://api.github.com/repos/shovelshit/tools/releases/latest"]);
  assert.equal(result.stale, true);
  assert.equal(result.assets.length, 0);
});

test("release metadata accepts only official stable assets and pairs checksums", async () => {
  resetReleaseCache();
  const result = await getReleaseDownloads({}, {
    nowMs: 1000,
    fetchImpl: async () => Response.json(RELEASE)
  });
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].name, "Maoyan-arm64.dmg");
  assert.match(result.assets[0].checksumUrl, /\.sha256$/);
  assert.equal(JSON.stringify(result).includes("evil.example"), false);
});

test("GitHub failure reuses the last verified list as stale", async () => {
  resetReleaseCache();
  await getReleaseDownloads({}, { nowMs: 10_000, fetchImpl: async () => Response.json(RELEASE) });
  const stale = await getReleaseDownloads({}, {
    nowMs: 400_001,
    fetchImpl: async () => new Response("limited", { status: 403 })
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.assets.length, 1);
});

test("GitHub outage returns a release-page fallback without alternate providers", async () => {
  resetReleaseCache();
  const calls = [];
  const result = await getReleaseDownloads({}, {
    nowMs: 900_000,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response("down", { status: 503 });
    }
  });
  assert.equal(result.version, null);
  assert.equal(result.releaseUrl, "https://github.com/shovelshit/tools/releases");
  assert.equal(calls.length, 1);
});
