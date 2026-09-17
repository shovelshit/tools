function validHmacKey(value) {
  try {
    return Uint8Array.from(atob(String(value || "")), (character) => character.charCodeAt(0)).length >= 32;
  } catch {
    return false;
  }
}

function enrollmentOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.origin === "null" ? null : url;
  } catch {
    return null;
  }
}

export function enrollmentDeploymentReadiness(env) {
  const missing = [];
  const origin = enrollmentOrigin(env.ENROLLMENT_ORIGIN);
  if (!String(env.TURNSTILE_SITE_KEY || "").trim()) missing.push("TURNSTILE_SITE_KEY");
  if (!String(env.TURNSTILE_SECRET_KEY || "").trim()) missing.push("TURNSTILE_SECRET_KEY");
  if (!validHmacKey(env.ENROLLMENT_HMAC_KEY)) missing.push("ENROLLMENT_HMAC_KEY");
  if (!origin) missing.push("ENROLLMENT_ORIGIN");
  if (!origin || String(env.ENROLLMENT_HOSTNAME || "").trim().toLowerCase() !== origin.hostname) {
    missing.push("ENROLLMENT_HOSTNAME");
  }
  return { ready: missing.length === 0, missing };
}

export function assertEnrollmentDeploymentReady(env) {
  const readiness = enrollmentDeploymentReadiness(env);
  if (readiness.ready) return readiness;
  const error = new Error(`公开申请部署配置不完整: ${readiness.missing.join(", ")}`);
  error.code = "ENROLLMENT_NOT_READY";
  error.missing = readiness.missing;
  throw error;
}
