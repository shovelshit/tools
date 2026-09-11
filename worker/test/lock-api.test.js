import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import { publicCinemaShows } from "../src/maoyan/api.js";
import { handleLockApi } from "../src/maoyan/lock-api.js";
import { userKey } from "../src/maoyan/user.js";

const secretValues = ["cookie-secret", "signature-secret", "csrf-value", "123456789"];

function env() {
  return {
    MAOYAN_KV: new MemoryKV({
      [userKey("token-a", "config")]: JSON.stringify({ cinemaId: "25428", selectedMovieIds: ["7"] })
    }),
    SESSION_ENCRYPTION_KEY: testEncryptionKey()
  };
}

function request(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

async function body(response) {
  const result = await response.json();
  const serialized = JSON.stringify(result);
  for (const value of secretValues) assert.equal(serialized.includes(value), false);
  return result;
}

test("projection includes only public show identifiers", () => {
  const projected = publicCinemaShows({ showData: {
    cinemaName: "测试影院",
    privateProviderData: "nope",
    movies: [{ id: 7, nm: "测试电影", showCount: 1, secret: "nope", shows: [{ showDate: "2026-09-12", plist: [{
      seqNo: 100, tm: "20:00", lang: "国语", tp: "2D", th: "1号厅",
      vipPrice: "40", vipPriceSuffix: "起", ticketStatus: 0, rawProviderData: "nope"
    }] }] }]
  } });

  assert.deepEqual(projected, {
    cinemaName: "测试影院",
    movies: [{
      id: 7, nm: "测试电影", showCount: 1, shows: [{ showDate: "2026-09-12", plist: [{
        seqNo: "100", tm: "20:00", lang: "国语", tp: "2D", th: "1号厅",
        vipPrice: "40", vipPriceSuffix: "起", ticketStatus: 0
      }] }]
    }]
  });
});

test("API response secrecy: session routes expose only masked session status", async () => {
  const runtime = env();
  const upload = await handleLockApi(request("/api/lock/session", {
    method: "POST",
    body: JSON.stringify(validSession())
  }), runtime, new URL("https://worker.example/api/lock/session"), "token-a");
  assert.equal(upload.status, 200);
  assert.deepEqual(Object.keys(await body(upload)).sort(), ["ok", "session"]);

  const status = await handleLockApi(request("/api/lock/session/status"), runtime, new URL("https://worker.example/api/lock/session/status"), "token-a");
  assert.equal(status.status, 200);
  assert.deepEqual((await body(status)).session, {
    uploaded: true,
    uploadedAt: (await runtime.MAOYAN_KV.get(userKey("token-a", "maoyan-session"), "json")).uploadedAt,
    uidMasked: "UID 123***789",
    sourceSavedAt: "2026-09-11T00:00:00.000Z"
  });
});

test("API response secrecy: template seats expose the sanitized seat map only", async () => {
  const runtime = env();
  await handleLockApi(request("/api/lock/session", { method: "POST", body: JSON.stringify(validSession()) }), runtime, new URL("https://worker.example/api/lock/session"), "token-a");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <div class="seats-block" data-section-id="1" data-section-name="1号厅" data-seq-no="100">
      <span class="seat selectable" data-row-id="6" data-column-id="18" data-no="1-6-18" data-st="N"></span>
    </div>`, { status: 200 });
  try {
    const response = await handleLockApi(
      request("/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100"),
      runtime,
      new URL("https://worker.example/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100"),
      "token-a"
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await body(response)).seatMap, {
      seqNo: "100", sectionId: "1", sectionName: "1号厅",
      seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true }]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API response secrecy: input, missing session, and active rule errors use safe status codes", async () => {
  const runtime = env();
  const invalid = await handleLockApi(request("/api/lock/template-seats?cinemaId=x&movieId=7&seqNo=100"), runtime, new URL("https://worker.example/api/lock/template-seats?cinemaId=x&movieId=7&seqNo=100"), "token-a");
  assert.equal(invalid.status, 400);
  await body(invalid);

  const missing = await handleLockApi(request("/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100"), runtime, new URL("https://worker.example/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100"), "token-a");
  assert.equal(missing.status, 404);
  await body(missing);
});

test("API response secrecy: malformed lock rules are client errors", async () => {
  const runtime = env();
  const response = await handleLockApi(request("/api/lock/rule", {
    method: "POST",
    body: JSON.stringify({ cinemaId: "invalid" })
  }), runtime, new URL("https://worker.example/api/lock/rule"), "token-a");
  assert.equal(response.status, 400);
  await body(response);
});

test("API response secrecy: provider redirects are upstream errors", async () => {
  const runtime = env();
  await handleLockApi(request("/api/lock/session", { method: "POST", body: JSON.stringify(validSession()) }), runtime, new URL("https://worker.example/api/lock/session"), "token-a");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://passport.maoyan.com/" } });
  try {
    const response = await handleLockApi(
      request("/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100"),
      runtime,
      new URL("https://worker.example/api/lock/template-seats?cinemaId=25428&movieId=7&seqNo=100"),
      "token-a"
    );
    assert.equal(response.status, 502);
    await body(response);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
