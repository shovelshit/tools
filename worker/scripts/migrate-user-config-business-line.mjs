import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const migrationFile = fileURLToPath(new URL("../sql/user-config-business-line.sql", import.meta.url));

function migrationState(columns) {
  if (!columns.some((column) => column.name === "token_id")) throw new Error("user_config table missing");
  const line = columns.find((column) => column.name === "business_line");
  if (!line) return "legacy";
  const id = columns.find((column) => column.name === "token_id");
  if (id.pk === 1 && line.pk === 2) return "migrated";
  throw new Error("user_config has an unexpected partial schema; stop and inspect before retrying");
}

export function migrateUserConfigBusinessLine(sqlite) {
  const state = migrationState(sqlite.prepare("PRAGMA table_info(user_config)").all());
  if (state === "migrated") return { applied: false };
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM user_config").get().n;
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(readFileSync(migrationFile, "utf8"));
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  const after = sqlite.prepare("SELECT COUNT(*) AS n FROM user_config WHERE business_line='maoyan'").get().n;
  if (before !== after) throw new Error("config row count mismatch after migration");
  return { applied: true, rows: after };
}

function wrangler(args) {
  const output = execFileSync("npx", ["--no-install", "wrangler", "d1", "execute", "tools-db", "--remote", "--json", "--config", "wrangler.toml", ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  const start = output.indexOf("[");
  if (start < 0) throw new Error("wrangler did not return JSON");
  return JSON.parse(output.slice(start));
}

function rows(sql) {
  return wrangler(["--command", sql]).flatMap((item) => item.results || []);
}

export function migrateRemote({ apply = false, paused = false } = {}) {
  const state = migrationState(rows("PRAGMA table_info(user_config)"));
  const before = rows("SELECT COUNT(*) AS n FROM user_config")[0]?.n;
  if (state === "migrated") return { applied: false, rows: before };
  if (!apply) return { applied: false, pending: true, rows: before };
  if (!paused) throw new Error("--apply requires --paused after backup and actual Worker write/cron pause");
  try {
    wrangler(["--file", migrationFile]);
  } catch (error) {
    // A client failure can follow a successful remote commit. Check real state before retrying.
    if (migrationState(rows("PRAGMA table_info(user_config)")) !== "migrated") throw error;
  }
  const after = rows("SELECT COUNT(*) AS n FROM user_config WHERE business_line='maoyan'")[0]?.n;
  if (Number(before) !== Number(after)) throw new Error(`config row count mismatch: before=${before}, after=${after}`);
  return { applied: true, rows: after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = migrateRemote({ apply: process.argv.includes("--apply"), paused: process.argv.includes("--paused") });
  console.log(JSON.stringify(result));
}
