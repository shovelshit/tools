import test from "node:test";
import assert from "node:assert/strict";
import { serveMaoyanApiAsset, serveMaoyanAsset, serveStoreAsset } from "../src/index.js";

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
  assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'self' https: http:/);
});

test("versioned files are immutable and unrelated paths are not intercepted", async () => {
  const request = new Request("https://example.test/maoyan/app.js?v=1");
  const response = await serveMaoyanAsset(request, { ASSETS: assets("text/javascript") });
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(await serveMaoyanAsset(new Request("https://example.test/store/"), { ASSETS: assets("text/html") }), null);
});

test("Thumbmark is served through the Worker API route when the frontend is hosted separately", async () => {
  let fetchedPath = "";
  const env = {
    ASSETS: {
      async fetch(request) {
        fetchedPath = new URL(request.url).pathname;
        return new Response("thumbmark bundle", { headers: { "Content-Type": "application/javascript" } });
      }
    }
  };
  const response = await serveMaoyanApiAsset(
    new Request("https://example.test/api/assets/thumbmark.umd.js?v=1.11.0"), env
  );
  assert.equal(fetchedPath, "/maoyan/vendor/thumbmark.umd.js");
  assert.equal(response.headers.get("Content-Type"), "application/javascript");
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(await response.text(), "thumbmark bundle");
});

test("missing Thumbmark assets cannot cache HTML as a successful script", async () => {
  const response = await serveMaoyanApiAsset(
    new Request("https://example.test/api/assets/thumbmark.umd.js?v=1.11.0"),
    { ASSETS: assets("text/html") }
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
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
