import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_BINDINGS = [
  ["DB", /binding\s*=\s*["']DB["']/],
  ["MAOYAN_KV", /binding\s*=\s*["']MAOYAN_KV["']/],
  ["LOCK_COORDINATOR", /name\s*=\s*["']LOCK_COORDINATOR["']/],
  ["MONITOR_DISPATCHER", /name\s*=\s*["']MONITOR_DISPATCHER["']/],
  ["MONITOR_COORDINATOR", /name\s*=\s*["']MONITOR_COORDINATOR["']/],
  ["NOTIFICATION_DISPATCHER", /name\s*=\s*["']NOTIFICATION_DISPATCHER["']/]
];
const REQUIRED_SECRETS = ["ADMIN_TOKEN", "SESSION_ENCRYPTION_KEY", "ENROLLMENT_HMAC_KEY"];

function quotedVar(configText, name) {
  return new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']*)["']`, "m").exec(configText)?.[1] || "";
}

export function checkDeploymentConfig({ configText = "", secretNames = [], publicEnrollment = false } = {}) {
  const errors = [];
  for (const [name, pattern] of REQUIRED_BINDINGS) {
    if (!pattern.test(configText)) errors.push(`缺少 ${name} 绑定`);
  }
  const availableSecrets = new Set(secretNames);
  for (const name of REQUIRED_SECRETS) {
    if (!availableSecrets.has(name)) errors.push(`缺少 secret: ${name}`);
  }
  if (publicEnrollment) {
    if (!availableSecrets.has("TURNSTILE_SECRET_KEY")) errors.push("公开申请缺少 secret: TURNSTILE_SECRET_KEY");
    if (!quotedVar(configText, "ENROLLMENT_ORIGIN")) errors.push("公开申请缺少 ENROLLMENT_ORIGIN");
    if (!quotedVar(configText, "ENROLLMENT_HOSTNAME")) errors.push("公开申请缺少 ENROLLMENT_HOSTNAME");
    if (!quotedVar(configText, "TURNSTILE_SITE_KEY")) errors.push("公开申请缺少 TURNSTILE_SITE_KEY");
  }
  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const configIndex = argv.indexOf("--config");
  if (configIndex < 0 || !argv[configIndex + 1]) throw new Error("用法: deploy-preflight.mjs --config <wrangler.toml>");
  const secretsIndex = argv.indexOf("--secrets");
  return {
    configPath: resolve(argv[configIndex + 1]),
    publicEnrollment: argv.includes("--public-enrollment"),
    secretNames: secretsIndex >= 0 && argv[secretsIndex + 1]
      ? argv[secretsIndex + 1].split(",").map((value) => value.trim()).filter(Boolean)
      : REQUIRED_SECRETS.filter((name) => Boolean(process.env[name]))
        .concat(["TURNSTILE_SECRET_KEY"].filter((name) => Boolean(process.env[name])))
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { configPath, secretNames, publicEnrollment } = parseArgs(argv);
  const result = checkDeploymentConfig({ configText: await readFile(configPath, "utf8"), secretNames, publicEnrollment });
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }
  console.log("Deployment preflight passed; secret values were not inspected or printed.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
