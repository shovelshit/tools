import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { buildAssets, STATIC_ASSET_FILES } from "../scripts/build-assets.mjs";

async function walk(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, relative));
    else files.push(relative.split("\\").join("/"));
  }
  return files.sort();
}

test("static asset build emits only the explicit application whitelist", async () => {
  const root = await mkdtemp(join(tmpdir(), "maoyan-assets-"));
  const target = join(root, "public");
  await buildAssets({ target });
  assert.deepEqual(await walk(target), STATIC_ASSET_FILES.map((item) => item.target).sort());
  const allText = (await Promise.all((await walk(target)).map((file) => readFile(join(target, file), "utf8")))).join("\n");
  assert.equal(allText.includes("maoyan-lock-session"), false);
  assert.equal((await walk(target)).some((file) => /\.test\.|node_modules|wrangler|\.dev\.vars/.test(file)), false);
});

test("built pages contain the local Thumbmark bundle and license", async () => {
  const root = await mkdtemp(join(tmpdir(), "maoyan-assets-"));
  const target = join(root, "public");
  await buildAssets({ target });
  assert.match(await readFile(join(target, "maoyan/vendor/thumbmark.umd.js"), "utf8"), /Thumbmark/);
  assert.match(await readFile(join(target, "maoyan/vendor/THUMBMARK-LICENSE"), "utf8"), /MIT License/);
});

test("built monitor page includes its cinema background image", async () => {
  const root = await mkdtemp(join(tmpdir(), "maoyan-assets-"));
  const target = join(root, "public");
  await buildAssets({ target });
  assert.match(await readFile(join(target, "maoyan/index.html"), "utf8"), /assets\/cinema-background\.webp/);
  const image = await readFile(join(target, "maoyan/assets/cinema-background.webp"));
  assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
  assert.ok(image.length > 10000);
});

test("static asset build includes the isolated Store browser application", async () => {
  const root = await mkdtemp(join(tmpdir(), "store-assets-"));
  const target = join(root, "public");
  await buildAssets({ target });
  assert.match(await readFile(join(target, "store/index.html"), "utf8"), /auth\.js/);
  assert.match(await readFile(join(target, "store/auth.js"), "utf8"), /store:authenticated/);
  assert.ok((await walk(target)).includes("store/auth.css"));
});

test("parsed Worker configurations keep custom routes at the top level", async () => {
  const [configText, exampleText] = await Promise.all([
    readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8")
  ]);
  const expectedRouteSuffixes = [
    "/api/*", "/api/*",
    "/store", "/store",
    "/store/*", "/store/*",
    "/store/auth/*", "/store/auth/*",
    "/store/api/*", "/store/api/*",
    "/store/file*", "/store/file*"
  ];

  for (const text of [configText, exampleText]) {
    const config = parseToml(text);
    assert.equal(config.assets.routes, undefined);
    assert.equal(Array.isArray(config.routes), true);
    assert.deepEqual(
      config.routes.map((route) => route.pattern.slice(route.pattern.indexOf("/"))),
      expectedRouteSuffixes
    );
    assert.ok(config.assets.run_worker_first.includes("/store/auth/*"));
    assert.ok(config.assets.run_worker_first.includes("/store/*.html"));
    assert.ok(config.assets.run_worker_first.includes("/maoyan/*.html"));
    assert.equal(config.assets.run_worker_first.includes("/maoyan/*"), false);
  }
});
