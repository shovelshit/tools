import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("wrangler routes HTML through the Worker while leaving versioned files on Static Assets", async () => {
  const config = await readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8");
  assert.match(config, /run_worker_first[^\n]+\/maoyan\/[^\n]+\/maoyan\/\*\.html/);
  assert.doesNotMatch(config, /"\/maoyan\/\*"/);
});

test("Worker configuration routes Store browser auth through the Worker", async () => {
  const [config, example] = await Promise.all([
    readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8")
  ]);

  for (const text of [config, example]) {
    assert.match(text, /run_worker_first[^\n]+\/store\/auth\/\*/);
    assert.match(text, /run_worker_first[^\n]+\/store[^\n]+\/store\/[^\n]+\/store\/\*\.html/);
  }
  assert.match(config, /ltools\.asia\/store\/auth\/\*/);
  assert.match(config, /www\.ltools\.asia\/store\/auth\/\*/);
  assert.match(config, /ltools\.asia\/store\/\*/);
  assert.match(config, /www\.ltools\.asia\/store\/\*/);
});
