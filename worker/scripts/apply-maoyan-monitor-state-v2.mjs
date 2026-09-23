import { readFileSync } from "node:fs";

const STATE_SQL = readFileSync(new URL("../sql/maoyan-monitor-state-v2.sql", import.meta.url), "utf8");

/** Apply the v2 schema to a node:sqlite DatabaseSync or compatible D1 test DB. */
export function applyMaoyanMonitorStateV2(database) {
  const columns = database.prepare("PRAGMA table_info(monitor_subscriptions)").all();
  if (!columns.some((column) => column.name === "last_run_id")) {
    database.exec("ALTER TABLE monitor_subscriptions ADD COLUMN last_run_id TEXT");
  }
  database.exec(STATE_SQL);
}
