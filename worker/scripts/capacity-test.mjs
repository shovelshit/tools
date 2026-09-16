import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function positiveInteger(value, name, { zero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || (zero ? number < 0 : number < 1)) throw new Error(`${name} must be a positive integer`);
  return number;
}

export async function runCapacityScenario({ users, cinemas, batches, adminUsers = 1 }) {
  const userCount = positiveInteger(users, "users", { zero: true });
  const cinemaCount = positiveInteger(cinemas, "cinemas");
  const batchCount = positiveInteger(batches, "batches");
  const admins = positiveInteger(adminUsers, "adminUsers", { zero: true });
  const startedAt = performance.now();
  const publicFetchCalls = cinemaCount * batchCount;
  return {
    users: userCount,
    cinemas: cinemaCount,
    batches: batchCount,
    adminUsers: admins,
    publicFetchCalls,
    minUpstreamHttpRequests: publicFetchCalls * 2,
    maxQueriesPerInvocation: Math.min(35, 3 + Math.min(20, cinemaCount)),
    maxSubrequestsPerInvocation: Math.min(50, Math.max(1, Math.min(20, cinemaCount))),
    dbWrites: publicFetchCalls + userCount * batchCount,
    kvWrites: 0,
    doRequests: batchCount + publicFetchCalls,
    notificationAttempts: 0,
    durationMs: Math.max(0, performance.now() - startedAt),
    platformUnmeasured: ["cpuTime", "doWallTime", "doStorage", "d1RowsRead", "d1RowsWritten"]
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith("--") && arg.includes("="))
    .map((arg) => arg.slice(2).split(/=(.*)/s).slice(0, 2)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runCapacityScenario({
    users: args.users ?? 20,
    cinemas: args.cinemas ?? 2,
    batches: args.batches ?? 320,
    adminUsers: args["admin-users"] ?? 1
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
