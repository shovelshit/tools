import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCinemaData, normalizeCinemaData } from "../src/maoyan/monitor-store.js";

const REQUIRED_TABLES = ["monitor_subscriptions", "cinema_batches", "cinema_state", "notification_outbox", "lock_rule"];
const REQUIRED_STATE_COLUMNS = ["cinema_id", "current_version", "current_data", "active_run_id", "run_state"];

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNullableText(value) {
  return value == null ? "NULL" : sqlText(value);
}

function asRows(payload) {
  if (Array.isArray(payload)) {
    const wrapped = payload.some((item) => item && (Array.isArray(item.results) || Array.isArray(item.result?.results)));
    return wrapped ? payload.flatMap((item) => asRows(item)) : payload;
  }
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.result?.results)) return payload.result.results;
  return [];
}

export function parseWranglerJson(output) {
  const text = String(output || "").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch {}
  let last;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack.pop() !== expected) break;
        if (!stack.length) {
          if (last === undefined) {
            try { last = JSON.parse(text.slice(start, index + 1)); } catch {}
          }
          break;
        }
      }
    }
  }
  if (last !== undefined) return last;
  throw new Error("wrangler returned non-JSON output");
}

export function commandRunner({ database, config, command, file }) {
  const args = ["d1", "execute", database, "--remote", "--json"];
  if (config) args.push("--config", config);
  if (command) args.push("--command", command);
  if (file) args.push("--file", file);
  const output = execFileSync("npx", ["wrangler", ...args], {
    cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return parseWranglerJson(output);
}

async function queryRemote(run, sql) {
  return asRows(await run(sql));
}

export async function readRemoteSnapshot(run, { nowMs = Date.now() } = {}) {
  const tables = await queryRemote(run, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('monitor_subscriptions','cinema_batches','cinema_state','notification_outbox','lock_rule')");
  const tableSet = new Set(tables.map((row) => String(row.name)));
  const missingTables = REQUIRED_TABLES.filter((name) => !tableSet.has(name));
  if (missingTables.length) throw new Error(`required tables missing: ${missingTables.join(",")}`);
  const stateColumns = await queryRemote(run, "PRAGMA table_info(cinema_state)");
  const missingStateColumns = REQUIRED_STATE_COLUMNS.filter((name) => !stateColumns.some((row) => row.name === name));
  if (missingStateColumns.length) throw new Error(`v2 schema incomplete: cinema_state.${missingStateColumns.join(",")}`);
  const subscriptionColumns = await queryRemote(run, "PRAGMA table_info(monitor_subscriptions)");
  if (!subscriptionColumns.some((row) => row.name === "last_run_id")) {
    throw new Error("v2 schema incomplete: monitor_subscriptions.last_run_id");
  }

  const subscriptions = await queryRemote(run,
    "SELECT s.user_id,s.cinema_id,s.enabled,s.baseline_version,s.last_run_id,s.config_version " +
    "FROM monitor_subscriptions s JOIN users u ON u.id=s.user_id " +
    "WHERE s.enabled=1 AND s.cinema_id<>'' AND u.business_line='maoyan' AND u.role IN ('user','admin') " +
    "AND u.state='active' AND u.archived_at IS NULL AND (u.expires_at IS NULL OR u.expires_at>" + Number(nowMs) + ") " +
    "ORDER BY s.cinema_id,s.user_id");
  const cinemas = [...new Set(subscriptions.map((row) => String(row.cinema_id)))];
  const states = cinemas.length ? await queryRemote(run,
    `SELECT cinema_id,current_version,current_data,active_run_id,run_state FROM cinema_state WHERE cinema_id IN (${cinemas.map(sqlText).join(",")})`) : [];
  const latest = cinemas.length ? await queryRemote(run,
    `SELECT b.cinema_id,b.version,b.public_data,b.captured_at FROM cinema_batches b JOIN (SELECT cinema_id,MAX(captured_at) AS captured_at FROM cinema_batches WHERE status='committed' AND cinema_id IN (${cinemas.map(sqlText).join(",")}) GROUP BY cinema_id) x ON x.cinema_id=b.cinema_id AND x.captured_at=b.captured_at WHERE b.status='committed'`) : [];
  const activeRuns = states.filter((row) => row.run_state === "processing" || row.run_state === "retryable");
  const outbox = await queryRemote(run, "SELECT state,COUNT(*) AS count FROM notification_outbox WHERE state IN ('pending','sending','failed') GROUP BY state");
  const lockRules = await queryRemote(run, "SELECT COUNT(*) AS count FROM lock_rule");
  return { nowMs: Number(nowMs), subscriptions, states, latest, activeRuns, outbox, lockRules };
}

function latestByCinema(rows) {
  const map = new Map();
  for (const row of rows) {
    const old = map.get(String(row.cinema_id));
    if (!old || Number(row.captured_at) > Number(old.captured_at) || (Number(row.captured_at) === Number(old.captured_at) && Number(row.version) > Number(old.version))) map.set(String(row.cinema_id), row);
  }
  return map;
}

export function buildMigrationPlan(snapshot, { nowMs = snapshot.nowMs, paused = false } = {}) {
  if (!paused) throw new Error("refusing migration: cron/dispatcher pause confirmation is required (--paused)");
  if (snapshot.activeRuns?.length) throw new Error("refusing migration: active cinema runs still exist");
  const stateByCinema = new Map((snapshot.states || []).map((row) => [String(row.cinema_id), row]));
  const latest = latestByCinema(snapshot.latest || []);
  const cinemas = [...new Set((snapshot.subscriptions || []).map((row) => String(row.cinema_id)))].sort();
  const statements = [];
  let inserted = 0;
  let baselineUpdates = 0;
  for (const cinemaId of cinemas) {
    const state = stateByCinema.get(cinemaId);
    if (!state) {
      const batch = latest.get(cinemaId);
      if (batch) {
        const data = normalizeCinemaData(parseJson(batch.public_data));
        statements.push(`INSERT INTO cinema_state(cinema_id,current_version,current_hash,current_data,run_state,completed_at,updated_at) VALUES (${sqlText(cinemaId)},${Number(batch.version)},${sqlText(hashCinemaData(data))},${sqlText(JSON.stringify(data))},'completed',${Number(batch.captured_at)},${Number(nowMs)}) ON CONFLICT(cinema_id) DO NOTHING;`);
      } else {
        statements.push(`INSERT INTO cinema_state(cinema_id,current_version,run_state,updated_at) VALUES (${sqlText(cinemaId)},0,'idle',${Number(nowMs)}) ON CONFLICT(cinema_id) DO NOTHING;`);
      }
      inserted += 1;
    }
    const currentVersion = state ? Number(state.current_version || 0) : Number(latest.get(cinemaId)?.version || 0);
    for (const sub of (snapshot.subscriptions || []).filter((row) => String(row.cinema_id) === cinemaId)) {
      if (sub.baseline_version == null && sub.last_run_id == null) {
        statements.push(`UPDATE monitor_subscriptions SET baseline_version=${currentVersion},last_run_id=NULL,updated_at=${Number(nowMs)} WHERE user_id=${sqlText(sub.user_id)} AND cinema_id=${sqlText(cinemaId)} AND enabled=1 AND baseline_version IS NULL AND last_run_id IS NULL;`);
        baselineUpdates += 1;
      }
    }
  }
  return { sql: statements.join("\n"), statements, summary: { cinemas: cinemas.length, insertedStates: inserted, baselineUpdates, preservedOutbox: (snapshot.outbox || []).reduce((sum, row) => sum + Number(row.count || 0), 0), lockRuleRows: Number(snapshot.lockRules?.[0]?.count || 0) } };
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export async function executeRemoteMigration({ database, config, apply = false, paused = false, nowMs = Date.now(), run = null } = {}) {
  if (!database) throw new Error("database is required");
  const runner = run || ((sql) => commandRunner({ database, config, command: sql }));
  const snapshot = await readRemoteSnapshot(runner, { nowMs });
  const plan = buildMigrationPlan(snapshot, { nowMs, paused });
  if (!apply) return { mode: "dry-run", ...plan };
  if (!paused) throw new Error("apply requires --paused");
  const directory = mkdtempSync(join(tmpdir(), "maoyan-state-v2-"));
  const file = join(directory, "migration.sql");
  try {
    writeFileSync(file, `${plan.sql}\n`, "utf8");
    const applied = await (run ? run(plan.sql) : commandRunner({ database, config, file }));
    const verification = await readRemoteSnapshot(runner, { nowMs });
    return { mode: "apply", ...plan, applied, verification: { activeRuns: verification.activeRuns.length, states: verification.states.length } };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { apply: false, paused: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--paused") options.paused = true;
    else if (arg === "--database") options.database = argv[++i];
    else if (arg === "--config") options.config = argv[++i];
    else if (arg === "--now-ms") options.nowMs = Number(argv[++i]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.database) {
    console.log("Usage: node scripts/migrate-maoyan-monitor-state-remote.mjs --database <name> [--config <file>] [--paused] [--apply]");
    process.exit(options.help ? 0 : 2);
  }
  executeRemoteMigration(options).then((result) => {
    console.log(JSON.stringify({ mode: result.mode, summary: result.summary, statements: result.statements.length, verification: result.verification }, null, 2));
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
