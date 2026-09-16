import test from "node:test";
import assert from "node:assert/strict";
import { serveMaoyanAsset, serveStoreAsset } from "../src/index.js";

function assets(contentType) {
  return {
    async fetch(request) {
      return new Response(new URL(request.url).pathname, { headers: { "Content-Type": contentType } });
    }
  };
}

test("maoyan HTML is no-store and gets a constrained CSP", async () => {
  const request = new Request("https://example.test/maoyan/claim.html");
  const response = await serveMaoyanAsset(request, { ASSETS: assets("text/html; charset=utf-8") });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Security-Policy"), /challenges\.cloudflare\.com/);
  assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /unsafe-eval/);
});

test("versioned files are immutable and unrelated paths are not intercepted", async () => {
  const request = new Request("https://example.test/maoyan/app.js?v=1");
  const response = await serveMaoyanAsset(request, { ASSETS: assets("text/javascript") });
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(await serveMaoyanAsset(new Request("https://example.test/store/"), { ASSETS: assets("text/html") }), null);
});

test("Store assets use an isolated CSP and the bare path redirects", async () => {
  const redirect = await serveStoreAsset(new Request("https://example.test/store"), { ASSETS: assets("text/html") });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("Location"), "https://example.test/store/");

  const response = await serveStoreAsset(
    new Request("https://example.test/store/"),
    { ASSETS: assets("text/html; charset=utf-8") }
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'self'/);
  assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /challenges\.cloudflare\.com/);

  const maoyan = await serveMaoyanAsset(
    new Request("https://example.test/maoyan/"),
    { ASSETS: assets("text/html; charset=utf-8") }
  );
  assert.match(maoyan.headers.get("Content-Security-Policy"), /challenges\.cloudflare\.com/);
});
