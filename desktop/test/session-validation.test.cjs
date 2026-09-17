const assert = require("node:assert/strict");
const test = require("node:test");
const { captureSession, normalizeUploadedSession, sanitizeError, publicSessionStatus } = require("../main/session-validation");

const input = () => ({
  cookies: [{ domain: ".maoyan.com", name: "uid", value: "123456789" }, { domain: ".maoyan.com", name: "_csrf", value: "csrf-secret" }],
  requestHeaders: { MTGSIG: "signature-secret", Cookie: "drop" },
  requestUrl: "https://www.maoyan.com/ajax/createOrder?yodaReady=h5&csecplatform=4&csecversion=2.6.0&secret=drop",
  userAgent: "Mozilla/5.0"
});

test("capture and manual import preserve uid.sig", () => {
  const raw = input();
  raw.cookies.push({ domain: "www.maoyan.com", name: "uid.sig", value: "signed-uid" });
  const captured = captureSession(raw);
  assert.equal(captured.cookies.find(c => c.name === "uid.sig")?.value, "signed-uid");
  assert.equal(normalizeUploadedSession(captured).cookies.find(c => c.name === "uid.sig")?.value, "signed-uid");
});

test("capture retains only Worker-compatible fields and safe query values", () => {
  const result = captureSession(input());
  assert.deepEqual(Object.keys(result).sort(), ["cookies", "create_order_query", "csrf", "mtgsig", "saved_at", "user_agent"]);
  assert.deepEqual(result.create_order_query, { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" });
  assert.deepEqual(result.cookies[0], { name: "uid", value: "123456789" });
  assert.equal(result.csrf, "csrf-secret");
  assert.equal(result.mtgsig, "signature-secret");
  assert.match(result.saved_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const raw = input();
  raw.requestUrl = "https://www.maoyan.com/ajax/test?yodaReady=x%26evil&csecversion=2.6.0";
  raw.cookies.push({ domain: "evilmaoyan.com", name: "secret", value: "drop" }, { domain: ".maoyan.com", name: "bad=name", value: "drop" }, { domain: ".maoyan.com", name: "large", value: "x".repeat(4097) });
  assert.deepEqual(captureSession(raw).create_order_query, { csecversion: "2.6.0" });
  assert.equal(captureSession(raw).cookies.length, 2);
});

test("capture rejects missing login material, invalid origins and header injection safely", () => {
  for (const changes of [ { cookies: [] }, { requestHeaders: {} }, { userAgent: " " }, { userAgent: "Mozilla\r\nCookie: stolen" }, { requestUrl: "https://www.maoyan.com.evil.example/" }, { requestHeaders: { mtgsig: "sig\r\nCookie: stolen" } } ]) {
    assert.throws(() => captureSession({ ...input(), ...changes }), (e) => e.code === "validation" && !/stolen|secret|Cookie/.test(e.message));
  }
  for (const value of ["not-numeric", ""]) {
    const raw = input(); raw.cookies[0].value = value;
    assert.throws(() => captureSession(raw), { code: "validation" });
  }
});

test("imported Python sessions use the same strict credential validation", () => {
  const exported = {
    cookies: [{ domain: ".maoyan.com", name: "uid", value: "123456789" }, { domain: ".maoyan.com", name: "_csrf", value: "csrf-secret" }],
    csrf: "csrf-secret",
    mtgsig: "signature-secret",
    user_agent: "Mozilla/5.0",
    create_order_query: { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0", extra: "drop" },
    saved_at: "2026-09-15T00:00:00.000Z"
  };
  assert.deepEqual(normalizeUploadedSession(exported), {
    cookies: [{ name: "uid", value: "123456789" }, { name: "_csrf", value: "csrf-secret" }],
    csrf: "csrf-secret",
    mtgsig: "signature-secret",
    user_agent: "Mozilla/5.0",
    create_order_query: { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" },
    saved_at: "2026-09-15T00:00:00.000Z"
  });

  for (const changes of [
    { mtgsig: "bad\r\nheader" }, { csrf: "\u0000" }, { csrf: " " }, { mtgsig: " " }, { user_agent: " " },
    { csrf: "x".repeat(4097) }, { mtgsig: "x".repeat(16385) }, { user_agent: "x".repeat(4097) },
    { saved_at: "not-a-date" }, { saved_at: "x".repeat(65) }
  ]) {
    assert.throws(() => normalizeUploadedSession({ ...exported, ...changes }), { code: "validation" });
  }
});

test("errors and public status cannot echo untrusted sensitive strings", () => {
  const secret = "Token=tok Cookie: uid=123456789; _csrf=csrf-secret mtgsig=signature-secret https://worker.example/api?token=tok body=secret";
  assert.doesNotMatch(JSON.stringify(sanitizeError(new Error(secret))), /tok|Cookie|123456789|csrf|mtgsig|body|\?/);
  assert.deepEqual(publicSessionStatus({ uploaded: true, uidMasked: secret, uploadedAt: secret, sourceSavedAt: secret, cookies: secret }), { uploaded: true });
  assert.deepEqual(publicSessionStatus({ uploaded: true, uidMasked: "UID 123***789", uploadedAt: "2026-09-15T00:00:00.000Z" }), { uploaded: true, uidMasked: "UID 123***789", uploadedAt: "2026-09-15T00:00:00.000Z" });
});
