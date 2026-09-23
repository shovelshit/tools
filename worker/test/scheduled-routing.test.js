import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createDB } from "./helpers.js";
import worker from "../src/index.js";

test("late cron callback uses execution time instead of scheduled time to admit monitoring", async () => {
  const env = {
    DB: await createDB(),
    MONITOR_COORDINATOR: {},
    MONITOR_DISPATCHER: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => { throw new Error("monitor must remain closed"); } })
    }
  };
  const clock = mock.method(Date, "now", () => Date.parse("2026-09-14T15:01:00.000Z"));
  try {
    await worker.scheduled({ cron: "*/3 * * * *", scheduledTime: Date.parse("2026-09-14T14:59:00.000Z") }, env);
  } finally {
    clock.mock.restore();
  }
  assert.equal(env.DB.queries.some(({ sql }) => sql.includes("FROM users u LEFT JOIN user_config")), false);
});
