import { access, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WORKER_ROOT, "..");
const MOVIE_ROOT = join(REPO_ROOT, "modules", "movie");
const STORE_ROOT = join(REPO_ROOT, "modules", "store");

const PAGE_FILES = [
  "index.html", "admin.html", "claim.html", "download.html",
  "style.css", "claim.css", "maoyan-seat.css", "download.css",
  "account.js", "admin.js", "admin-dashboard.js", "app.js", "claim-page.js", "claim.js", "download-page.js",
  "connection-profile.js", "fingerprint.js", "seat-layout.js", "lock.js", "platform.js",
  "polling.js", "runtime.js", "secure-store.js", "ui.js", "workflow.js"
];

export const STATIC_ASSET_FILES = [
  ...PAGE_FILES.map((name) => ({
    source: join(MOVIE_ROOT, "pages", "maoyan", name),
    target: `maoyan/${name}`
  })),
  {
    source: join(MOVIE_ROOT, "pages", "maoyan", "assets", "cinema-background.webp"),
    target: "maoyan/assets/cinema-background.webp"
  },
  {
    source: join(WORKER_ROOT, "node_modules", "@thumbmarkjs", "thumbmarkjs", "dist", "thumbmark.umd.js"),
    target: "maoyan/vendor/thumbmark.umd.js"
  },
  {
    source: join(WORKER_ROOT, "node_modules", "@thumbmarkjs", "thumbmarkjs", "LICENSE"),
    target: "maoyan/vendor/THUMBMARK-LICENSE"
  },
  ...["index.html", "auth.js", "auth.css"].map((name) => ({
    source: join(STORE_ROOT, "pages", "store", name),
    target: `store/${name}`
  }))
];

function assertControlledTarget(target) {
  const normalized = resolve(target);
  if (basename(normalized) !== "public" || normalized === resolve("/")) {
    throw new Error("asset target must be a dedicated directory named public");
  }
  return normalized;
}

export async function buildAssets({ target = join(WORKER_ROOT, "public") } = {}) {
  const output = assertControlledTarget(target);
  for (const item of STATIC_ASSET_FILES) {
    try {
      await access(item.source);
    } catch {
      throw new Error(`missing static asset source: ${item.source}. Initialize submodules with git submodule update --init --recursive`);
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), ".public-build-"));
  try {
    for (const item of STATIC_ASSET_FILES) {
      const destination = join(staging, item.target);
      await mkdir(dirname(destination), { recursive: true });
      await cp(item.source, destination);
    }
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { target: output, files: STATIC_ASSET_FILES.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildAssets();
  console.log(`Built ${result.files} static assets in ${result.target}`);
}
