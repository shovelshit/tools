const test = require("node:test");
const assert = require("node:assert/strict");
const { detectPlatform, resolvePlatform, notificationAdvice, selectDownloadOptions } = require("./platform.js");

test("Android Bark remains allowed but recommends ServerChan", () => {
  const platform = detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 15)", platform: "Linux armv8l", maxTouchPoints: 5 });
  const advice = notificationAdvice({ platform, channel: "bark" });
  assert.equal(platform.os, "android");
  assert.equal(advice.blocking, false);
  assert.equal(advice.recommendedChannel, "serverchan");
});

test("iPad desktop UA is not misclassified as macOS", () => {
  assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 Macintosh", platform: "MacIntel", maxTouchPoints: 5 }).os, "ios");
});

test("platform resolution uses high entropy architecture without blocking fallback", async () => {
  const platform = await resolvePlatform({
    userAgent: "Mozilla/5.0 Macintosh",
    platform: "MacIntel",
    maxTouchPoints: 0,
    userAgentData: {
      async getHighEntropyValues() { return { architecture: "arm", bitness: "64" }; }
    }
  });
  assert.deepEqual(platform, { os: "macos", arch: "arm64" });
});

test("release options recommend exact platform assets without inventing mobile packages", () => {
  const assets = [
    { name: "Maoyan-arm64.dmg", url: "arm" },
    { name: "Maoyan-x64.dmg", url: "intel" },
    { name: "Maoyan-x64.exe", url: "win" }
  ];
  const mac = selectDownloadOptions({ os: "macos", arch: "arm64" }, assets);
  assert.equal(mac.recommended.url, "arm");
  const android = selectDownloadOptions({ os: "android", arch: "arm64" }, assets);
  assert.equal(android.recommended, null);
  assert.equal(android.defaultMode, "web");
  assert.deepEqual(android.alternatives.map((asset) => asset.name), assets.map((asset) => asset.name));
  assert.equal(android.alternatives.some((asset) => /apk|android/i.test(asset.name)), false);
});
