# Maoyan Cloud Seat Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Beta workflow to the existing monitoring page that uploads an encrypted Maoyan session, lets the user choose seats from a current show, and creates exactly one unpaid order when a future show appears at the same exact `HH:mm`.

**Architecture:** Keep the existing mobile cinema-detail API for schedules, and add focused Worker modules for encrypted session storage, authenticated `www.maoyan.com` requests, rule validation, and serialized execution. Store one encrypted session and one rule per random token namespace in KV; use one Durable Object per token to serialize create-order attempts and remember terminal rule IDs. Add a standalone `pages/maoyan/lock.js` controller and a single modal in the existing page.

**Tech Stack:** Cloudflare Workers ES modules, Workers KV, Durable Objects, Web Crypto AES-256-GCM, native Fetch API, plain HTML/CSS/JavaScript, Node.js built-in `node:test`.

## Global Constraints

- The feature creates an unpaid order only; it must never call a payment endpoint.
- A rule matches one cinema, one movie, one target date, and the exact template `HH:mm`; there is no time tolerance.
- The user selects one or more seats; the service never substitutes seats or changes the show time.
- Each access token may have at most one rule, and terminal or uncertain rules never retry automatically.
- The uploaded session is never stored in browser persistence, URLs, logs, errors, or plaintext KV.
- The Worker returns only a masked UID such as `UID 123***789`; it never returns cookies, `_csrf`, `mtgsig`, raw HTML, raw order responses, or a full UID.
- `SESSION_ENCRYPTION_KEY` is a Base64-encoded 32-byte Worker Secret; AES-GCM additional authenticated data binds ciphertext to the token namespace.
- `LOCK_AUTOMATION_ENABLED` defaults to `false`. Coding and automated verification do not create a real order or enable production automation.
- A real unpaid create-order verification and activation require a separate, explicit user authorization at that time.
- Existing uncommitted hardening and local CLI changes in the worktree must be preserved.

---

## File Map

- Create `worker/package.json`: declare ES-module test execution with native Node tests.
- Create `worker/test/helpers.js`: in-memory KV and deterministic fixture helpers.
- Create `worker/test/lock-session.test.js`: session normalization, masking, encryption, and deletion tests.
- Create `worker/test/lock-client.test.js`: seat-page parsing, host restriction, exact show matching, and order-result classification tests.
- Create `worker/test/lock-rule.test.js`: server-side rule validation and public response tests.
- Create `worker/test/lock-api.test.js`: sanitized schedule and lock-route response tests.
- Create `worker/test/lock-runner.test.js`: terminal-state, exact-time, seat-change, and no-retry tests.
- Create `worker/src/maoyan/lock-session.js`: normalize, encrypt, decrypt, inspect, and remove uploaded sessions.
- Create `worker/src/maoyan/lock-client.js`: authenticated Maoyan HTTP, seat parsing, exact schedule matching, and create-order.
- Create `worker/src/maoyan/lock-rule.js`: rule schema, validation, KV persistence, state transitions, and public projection.
- Create `worker/src/maoyan/lock-api.js`: authenticated `/api/lock/*` route handler.
- Create `worker/src/maoyan/lock-runner.js`: cron scan, one-rule execution, notifications, and Durable Object class.
- Modify `worker/src/maoyan/api.js`: export a sanitized schedule projection that includes `seqNo`.
- Modify `worker/src/maoyan/user.js`: delete session and rule data when an access token is revoked.
- Modify `worker/src/maoyan/cron.js`: separate the fixed lock cron from monitor cron reporting.
- Modify `worker/src/maoyan/index.js`: export lock route and schedule entry points.
- Modify `worker/src/index.js`: dispatch lock APIs, export the Durable Object, and route scheduled events.
- Modify `worker/wrangler.toml`: bind the Durable Object, add its migration, add the one-minute trigger, and default automation off.
- Create `pages/maoyan/lock.js`: modal state, session upload, template selection, seat selection, rule status, and cancellation.
- Modify `pages/maoyan/index.html`: add the Beta button/modal and load `lock.js`.
- Modify `pages/maoyan/app.js`: expose current cinema/movie context and keep the lock button state synchronized.
- Modify `pages/maoyan/style.css`: responsive modal and stable seat-grid styles.

---

### Task 1: Establish Worker Tests and Encrypted Session Storage

**Files:**
- Create: `worker/package.json`
- Create: `worker/test/helpers.js`
- Create: `worker/test/lock-session.test.js`
- Create: `worker/src/maoyan/lock-session.js`

**Interfaces:**
- Produces: `normalizeSession(raw) -> NormalizedSession`
- Produces: `maskUid(uid) -> string`
- Produces: `saveLockSession(env, tokenId, raw) -> PublicSessionStatus`
- Produces: `loadLockSession(env, tokenId) -> NormalizedSession`
- Produces: `getLockSessionStatus(env, tokenId) -> PublicSessionStatus`
- Produces: `removeLockSession(env, tokenId) -> void`

- [ ] **Step 1: Add the native Node test command and in-memory KV helper**

Create `worker/package.json`:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js"
  }
}
```

Create `worker/test/helpers.js` with `MemoryKV`, whose `get(key, "json")` parses JSON, `put` stores strings, and `delete` removes keys:

```js
export class MemoryKV {
  constructor(entries = {}) { this.data = new Map(Object.entries(entries)); }
  async get(key, type) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
}

export function testEncryptionKey() {
  return Buffer.alloc(32, 7).toString("base64");
}

export function validSession(overrides = {}) {
  return {
    cookies: [
      { name: "uid", value: "123456789", domain: ".maoyan.com" },
      { name: "_csrf", value: "csrf-value", domain: ".maoyan.com" },
      { name: "token", value: "cookie-secret", domain: ".maoyan.com" }
    ],
    csrf: "csrf-value",
    mtgsig: "signature-secret",
    create_order_query: { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" },
    user_agent: "Mozilla/5.0 Test",
    saved_at: "2026-09-11T00:00:00.000Z",
    ...overrides
  };
}
```

- [ ] **Step 2: Write failing tests for validation, masking, encryption, and removal**

In `worker/test/lock-session.test.js`, cover these exact assertions:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, testEncryptionKey, validSession } from "./helpers.js";
import {
  getLockSessionStatus, loadLockSession, maskUid,
  normalizeSession, removeLockSession, saveLockSession
} from "../src/maoyan/lock-session.js";

test("normalizes a local session and masks its uid", () => {
  const session = normalizeSession(validSession());
  assert.equal(session.uid, "123456789");
  assert.equal(maskUid(session.uid), "UID 123***789");
  assert.deepEqual(session.createOrderQuery, {
    yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0"
  });
});

test("rejects a session without uid or mtgsig", () => {
  assert.throws(() => normalizeSession(validSession({ mtgsig: "" })), /会话不完整/);
  assert.throws(() => normalizeSession(validSession({ cookies: [] })), /会话不完整/);
});

test("stores ciphertext bound to the token namespace", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  const status = await saveLockSession(env, "token-a", validSession());
  const stored = env.MAOYAN_KV.data.get("u:token-a:maoyan-session");
  assert.equal(status.uidMasked, "UID 123***789");
  assert.equal(stored.includes("cookie-secret"), false);
  assert.equal(stored.includes("signature-secret"), false);
  assert.equal((await loadLockSession(env, "token-a")).uid, "123456789");
  await assert.rejects(() => loadLockSession(env, "token-b"), /未上传猫眼会话/);
});

test("status and removal never return credentials", async () => {
  const env = { MAOYAN_KV: new MemoryKV(), SESSION_ENCRYPTION_KEY: testEncryptionKey() };
  await saveLockSession(env, "token-a", validSession());
  const status = await getLockSessionStatus(env, "token-a");
  assert.deepEqual(Object.keys(status).sort(), ["sourceSavedAt", "uidMasked", "uploaded", "uploadedAt"]);
  await removeLockSession(env, "token-a");
  assert.deepEqual(await getLockSessionStatus(env, "token-a"), { uploaded: false });
});
```

- [ ] **Step 3: Run the tests and confirm they fail because the module is absent**

Run: `cd worker && node --test --test-name-pattern="session|uid|ciphertext|removal" test/*.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lock-session.js`.

- [ ] **Step 4: Implement strict normalization and AES-256-GCM storage**

Implement `lock-session.js` with these rules and signatures:

```js
import { userKey } from "./user.js";

const QUERY_KEYS = ["yodaReady", "csecplatform", "csecversion"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function maskUid(uid) {
  const value = String(uid || "");
  if (value.length <= 6) return `UID ${"*".repeat(Math.max(3, value.length))}`;
  return `UID ${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") throw new Error("猫眼会话格式错误");
  const cookies = (Array.isArray(raw.cookies) ? raw.cookies : [])
    .filter((c) => c && /^\.?([a-z0-9-]+\.)*maoyan\.com$/i.test(String(c.domain || ".maoyan.com")))
    .map((c) => ({ name: String(c.name || "").trim(), value: String(c.value || "") }))
    .filter((c) => /^[A-Za-z0-9_-]{1,128}$/.test(c.name) && c.value.length <= 4096)
    .slice(0, 64);
  const uid = cookies.find((c) => c.name === "uid")?.value || "";
  const csrf = String(raw.csrf || "");
  const mtgsig = String(raw.mtgsig || "");
  const userAgent = String(raw.user_agent || "");
  if (!cookies.length || !/^\d+$/.test(uid) || !csrf || !mtgsig || !userAgent) {
    throw new Error("猫眼会话不完整，请重新登录后上传");
  }
  const sourceQuery = raw.create_order_query && typeof raw.create_order_query === "object"
    ? raw.create_order_query : {};
  const createOrderQuery = Object.fromEntries(
    QUERY_KEYS.map((key) => [key, String(sourceQuery[key] || "")]).filter(([, value]) => value)
  );
  return {
    cookies, uid, csrf, mtgsig, userAgent, createOrderQuery,
    sourceSavedAt: String(raw.saved_at || "")
  };
}
```

Use `atob`/`btoa` byte conversion helpers. Import exactly 32 decoded key bytes with `crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])`. Encrypt JSON with a random 12-byte IV and `additionalData: encoder.encode("maoyan-session:" + tokenId)`. Store only this envelope:

```js
{
  v: 1,
  iv: "base64-iv",
  data: "base64-ciphertext",
  uploadedAt: "ISO timestamp",
  uidMasked: "UID 123***789",
  sourceSavedAt: "ISO timestamp"
}
```

`loadLockSession` must decrypt with the same additional data and return the normalized payload. `getLockSessionStatus` must read only envelope metadata, and `removeLockSession` must delete `userKey(tokenId, "maoyan-session")`. Missing or malformed `SESSION_ENCRYPTION_KEY` must throw `锁座服务尚未配置加密密钥` without echoing the value.

- [ ] **Step 5: Run session tests and the full Worker test command**

Run: `cd worker && npm test`

Expected: all four tests PASS and no credential text appears in failure output.

- [ ] **Step 6: Commit the encrypted session unit**

```bash
git add worker/package.json worker/test/helpers.js worker/test/lock-session.test.js worker/src/maoyan/lock-session.js
git commit -m "feat: store encrypted maoyan sessions"
```

---

### Task 2: Implement the Authenticated Seat and Order Client

**Files:**
- Create: `worker/test/lock-client.test.js`
- Create: `worker/src/maoyan/lock-client.js`

**Interfaces:**
- Consumes: normalized session from `loadLockSession`
- Produces: `parseSeatPage(html) -> { sectionId, sectionName, seqNo, seats }`
- Produces: `findExactShows(cinemaData, { movieId, targetDate, templateTime }) -> Show[]`
- Produces: `fetchSeatMap(session, { cinemaId, movieId, seqNo }) -> SeatMap`
- Produces: `createUnpaidOrder(session, seatMap, seats) -> { orderId, payLeftSecond }`
- Produces: `OrderAttemptError` with boolean property `uncertain`

- [ ] **Step 1: Write failing parser, matcher, host, and create-order tests**

Create fixtures inline in `worker/test/lock-client.test.js` so tests contain no real session values:

```js
const seatHtml = `
  <div class="seats-block" data-section-id="88" data-section-name="1号厅" data-seq-no="2026091201">
    <span class="seat selectable" data-row-id="6" data-column-id="18" data-no="1-6-18" data-st="N"></span>
    <span class="seat sold" data-row-id="6" data-column-id="19" data-no="1-6-19" data-st="N"></span>
  </div>`;

test("parses available and unavailable seats without losing layout", () => {
  const map = parseSeatPage(seatHtml);
  assert.deepEqual(map.seats, [
    { rowId: "6", columnId: "18", seatNo: "1-6-18", type: "N", available: true },
    { rowId: "6", columnId: "19", seatNo: "1-6-19", type: "N", available: false }
  ]);
});

test("matches only the exact target date and HH:mm", () => {
  const data = { showData: { movies: [{ id: 7, shows: [{ showDate: "2026-09-12", plist: [
    { seqNo: "1", tm: "19:59" }, { seqNo: "2", tm: "20:00" }, { seqNo: "3", tm: "20:05" }
  ] }] }] } };
  assert.deepEqual(findExactShows(data, {
    movieId: "7", targetDate: "2026-09-12", templateTime: "20:00"
  }).map((show) => show.seqNo), ["2"]);
});

test("refuses redirects and requests outside www.maoyan.com", async () => {
  await assert.rejects(
    () => requestMaoyan({}, "https://example.com/xseats/1"),
    /请求目标不受信任/
  );
});
```

Mock `globalThis.fetch` for create-order and assert:

- the URL path is `/ajax/createOrder` and query keys are the three allowlisted keys;
- the request is POST form data with `sectionId`, `sectionName`, `seqNo`, and JSON `seats`;
- headers include `Cookie`, `mtgsig`, `Origin`, `Referer`, and the stored User-Agent;
- a 200 JSON response containing `data.data.id` returns `{ orderId, payLeftSecond }`;
- a returned JSON rejection creates `OrderAttemptError({ uncertain: false })`;
- a fetch timeout, network rejection, invalid JSON, or ambiguous 200 response creates `OrderAttemptError({ uncertain: true })`.

- [ ] **Step 2: Run client tests and confirm missing exports fail**

Run: `cd worker && node --test --test-name-pattern="seat|exact|redirect|order" test/*.test.js`

Expected: FAIL because `lock-client.js` does not exist.

- [ ] **Step 3: Implement strict authenticated requests and seat parsing**

In `lock-client.js`, define fixed constants and never accept a caller-provided origin:

```js
const ORIGIN = "https://www.maoyan.com";
const HOST = "www.maoyan.com";
const TIMEOUT_MS = 15000;
const DEFAULT_ORDER_QUERY = { yodaReady: "h5", csecplatform: "4", csecversion: "2.6.0" };

export class OrderAttemptError extends Error {
  constructor(message, uncertain) {
    super(message);
    this.name = "OrderAttemptError";
    this.uncertain = uncertain;
  }
}

function assertTrustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== HOST) {
    throw new Error("猫眼请求目标不受信任");
  }
  return url;
}

function cookieHeader(session) {
  return session.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}
```

`requestMaoyan` must use `redirect: "manual"`, `AbortSignal.timeout(TIMEOUT_MS)`, `cf: { cacheTtl: 0 }`, and reject every 3xx rather than following it. Error messages must contain only status/category information.

Parse every `<span>` whose class contains `seat`, not just `selectable`. Decode `&amp;`, `&quot;`, `&#39;`, `&lt;`, and `&gt;` in attributes. Mark a seat available only when the class list contains the complete token `selectable`. Require decimal `section-id`, `seq-no`, `row-id`, and `column-id`, and require `seatNo` to match `^\d+-\d+-\d+$`.

- [ ] **Step 4: Implement exact matching and unpaid create-order classification**

Flatten only the requested movie and date:

```js
export function findExactShows(data, { movieId, targetDate, templateTime }) {
  const movie = (data?.showData?.movies || []).find((item) => String(item.id) === String(movieId));
  if (!movie) return [];
  return (movie.shows || []).flatMap((day) => {
    const showDate = String(day.showDate || day.dt || "");
    if (showDate !== targetDate) return [];
    return (day.plist || [])
      .filter((show) => String(show.tm || "") === templateTime)
      .map((show) => ({ ...show, showDate }));
  });
}
```

`fetchSeatMap` constructs only:

```js
const url = `${ORIGIN}/xseats/${seqNo}?movieId=${movieId}&cinemaId=${cinemaId}`;
```

`createUnpaidOrder` constructs only `${ORIGIN}/ajax/createOrder?...` and sends:

```js
new URLSearchParams({
  sectionId: seatMap.sectionId,
  sectionName: seatMap.sectionName,
  seqNo: seatMap.seqNo,
  seats: JSON.stringify({ count: seats.length, list: seats })
})
```

Parse a successful response from `response.data.data.id`; expose only `String(id)` and numeric-or-null `payLeftSecond`. A response received with an explicit provider rejection is certain failure. Once the POST has started, network/timeout/invalid/ambiguous responses are uncertain because an order may already exist.

- [ ] **Step 5: Run all Worker tests**

Run: `cd worker && npm test`

Expected: all session and client tests PASS.

- [ ] **Step 6: Commit the Maoyan client**

```bash
git add worker/test/lock-client.test.js worker/src/maoyan/lock-client.js
git commit -m "feat: add authenticated maoyan lock client"
```

---

### Task 3: Validate and Persist One Lock Rule per Token

**Files:**
- Create: `worker/test/lock-rule.test.js`
- Create: `worker/src/maoyan/lock-rule.js`
- Modify: `worker/src/maoyan/user.js:12-18`

**Interfaces:**
- Consumes: `fetchCinemaDetail`, `fetchSeatMap`, `loadLockSession`, and `userKey`
- Produces: `createLockRule(env, tokenId, input, options = {}) -> PublicRule`, where `options` may provide `now`, `loadSession`, `fetchCinema`, and `fetchSeats`
- Produces: `getLockRule(env, tokenId) -> Rule|null`
- Produces: `putLockRule(env, tokenId, rule) -> void`
- Produces: `removeLockRule(env, tokenId) -> void`
- Produces: `publicLockRule(rule, automationEnabled) -> PublicRule|null`

- [ ] **Step 1: Write failing tests for authoritative rule creation**

In `lock-rule.test.js`, inject fixed time, cinema data, and a fixed seat map through the final `options` argument to `createLockRule`:

```js
const deps = {
  now: new Date("2026-09-11T04:00:00.000Z"),
  loadSession: async () => validSession(),
  fetchCinema: async () => ({ showData: {
    cinemaName: "测试影院",
    movies: [{ id: 7, nm: "测试电影", shows: [{ showDate: "2026-09-11", plist: [
      { seqNo: "100", tm: "20:00", ticketStatus: 0 }
    ] }] }]
  } }),
  fetchSeats: async () => ({ sectionId: "1", sectionName: "1号厅", seqNo: "100", seats: [
    { seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N", available: true },
    { seatNo: "1-6-19", rowId: "6", columnId: "19", type: "N", available: false }
  ] })
};
```

Assert that a valid request stores server-derived `cinemaName`, `movieName`, `templateDate`, `templateTime`, and full selected seat objects. Assert rejection when:

- `riskAccepted` is not exactly `true`;
- any ID is not decimal;
- the movie is not in the user's `selectedMovieIds`;
- the template `seqNo` does not belong to that cinema/movie;
- a selected seat is missing or unavailable;
- no seat is selected;
- target date is not later than template date or is more than 30 China-calendar days after creation;
- a non-terminal rule already exists.

- [ ] **Step 2: Run rule tests and verify they fail**

Run: `cd worker && node --test --test-name-pattern="rule|risk|target date|selected seat" test/*.test.js`

Expected: FAIL because `lock-rule.js` does not exist.

- [ ] **Step 3: Implement the rule schema and server-side revalidation**

Use this stored shape:

```js
{
  id: crypto.randomUUID(),
  cinemaId: "25428",
  cinemaName: "影院名称",
  movieId: "1510281",
  movieName: "影片名称",
  targetDate: "2026-09-12",
  templateDate: "2026-09-11",
  templateTime: "20:00",
  templateSeqNo: "100",
  seats: [{ seatNo: "1-6-18", rowId: "6", columnId: "18", type: "N" }],
  state: "waiting_schedule",
  createdAt: "ISO timestamp",
  updatedAt: "ISO timestamp",
  lastError: null,
  orderId: null,
  payLeftSecond: null
}
```

`createLockRule` must accept only:

```js
{
  cinemaId, movieId, templateSeqNo, targetDate,
  seatNos: ["1-6-18"],
  riskAccepted: true
}
```

Read the existing monitor config and require `config.cinemaId === cinemaId` plus `selectedMovieIds.includes(movieId)`. Re-fetch cinema schedules and the authenticated template seat map, then derive all names, dates, time, section data, and seat objects on the server. Deduplicate `seatNos`; do not trust row/column/type from the browser.

Use China-calendar helpers based on `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", ... })` and UTC calendar arithmetic to measure the 30-day range without local-host timezone drift.

- [ ] **Step 4: Implement public projection and cleanup**

`publicLockRule` returns rule metadata, seats, state, timestamps, `lastError`, `orderId`, `payLeftSecond`, and `automationEnabled`; it excludes internal attempt markers. `removeLockRule` deletes `userKey(tokenId, "maoyan-lock-rule")`.

Extend the cleanup list in `worker/src/maoyan/user.js` exactly as follows:

```js
for (const name of [
  "config", "snapshot", "changes", "status",
  "maoyan-session", "maoyan-lock-rule"
]) {
```

- [ ] **Step 5: Run all Worker tests**

Run: `cd worker && npm test`

Expected: all tests PASS, including deletion of both new token-scoped keys.

- [ ] **Step 6: Commit rule persistence and cleanup**

```bash
git add worker/test/lock-rule.test.js worker/src/maoyan/lock-rule.js worker/src/maoyan/user.js
git commit -m "feat: validate maoyan lock rules"
```

---

### Task 4: Add the Lock APIs and Sanitized Show Identifiers

**Files:**
- Create: `worker/test/lock-api.test.js`
- Create: `worker/src/maoyan/lock-api.js`
- Modify: `worker/src/maoyan/api.js`
- Modify: `worker/src/maoyan/index.js`
- Modify: `worker/src/index.js:3-7,40-159`

**Interfaces:**
- Consumes: session and rule interfaces from Tasks 1 and 3
- Produces: `handleLockApi(request, env, url, tokenId) -> Response|null`
- Produces: `publicCinemaShows(data) -> { cinemaName, movies }`

- [ ] **Step 1: Add tests for the public show projection and API response secrecy**

In `worker/test/lock-api.test.js`, add a test proving `publicCinemaShows` includes only these show fields:

```js
{
  seqNo: "100", tm: "20:00", lang: "国语", tp: "2D", th: "1号厅",
  vipPrice: "40", vipPriceSuffix: "起", ticketStatus: 0
}
```

Add handler tests using `MemoryKV`, read each response with `await response.json()`, and assert `JSON.stringify(body)` does not contain `cookie-secret`, `signature-secret`, `csrf-value`, or the full UID.

- [ ] **Step 2: Run the focused tests and verify missing handler/projection failures**

Run: `cd worker && node --test --test-name-pattern="projection|API response" test/*.test.js`

Expected: FAIL for missing `publicCinemaShows` and `handleLockApi`.

- [ ] **Step 3: Centralize `/api/shows` projection and include `seqNo`**

Export `publicCinemaShows(data)` from `worker/src/maoyan/api.js`; move the current mapping from `worker/src/index.js` into it and add `seqNo: String(p.seqNo || "")`. In `/api/shows`, return:

```js
const data = await fetchCinemaDetail(cinemaId);
return json({ ok: true, cinemaId, ...publicCinemaShows(data) });
```

- [ ] **Step 4: Implement the lock API handler with exact methods and status codes**

`handleLockApi` returns `null` when the path does not begin `/api/lock/`. Implement:

```text
POST /api/lock/session          -> 200 session status
GET  /api/lock/session/status   -> 200 session status
POST /api/lock/session/remove   -> 200 and remove session plus rule
GET  /api/lock/template-seats   -> 200 sanitized seat map
POST /api/lock/rule             -> 201 public rule
GET  /api/lock/rule             -> 200 public rule or null
POST /api/lock/rule/cancel      -> 200 and remove rule
```

For upload, read `request.text()` first and reject UTF-8 payloads over 256 KiB before `JSON.parse`. For template seats, validate all three query IDs with `^\d+$`, load/decrypt the session, fetch the map, and return only:

```js
{
  ok: true,
  seatMap: {
    seqNo, sectionId, sectionName,
    seats: seats.map(({ seatNo, rowId, columnId, type, available }) =>
      ({ seatNo, rowId, columnId, type, available }))
  }
}
```

Map input/validation errors to 400, missing sessions/rules to 404 where applicable, existing active rules to 409, provider authentication/redirect failures to 502, and unexpected errors to a fixed `锁座服务暂时不可用` 500 response. Never return `error.stack` or provider response bodies.

- [ ] **Step 5: Dispatch lock routes only after existing `X-Token` authentication**

Export `handleLockApi` from `worker/src/maoyan/index.js`. In `worker/src/index.js`, immediately inside the authenticated `try` block add:

```js
const lockResponse = await handleLockApi(request, env, url, token);
if (lockResponse) return lockResponse;
```

This placement guarantees `/api/lock/*` cannot bypass `checkAuthFull`.

- [ ] **Step 6: Run tests and syntax checks**

Run: `cd worker && npm test`

Run: `node --check worker/src/index.js && node --check worker/src/maoyan/lock-api.js`

Expected: all tests PASS and both syntax checks exit 0.

- [ ] **Step 7: Commit the API surface**

```bash
git add worker/src/maoyan/api.js worker/src/maoyan/index.js worker/src/maoyan/lock-api.js worker/src/index.js worker/test/lock-api.test.js
git commit -m "feat: expose maoyan lock APIs"
```

---

### Task 5: Serialize Automatic Lock Attempts and Separate Cron Roles

**Files:**
- Create: `worker/test/lock-runner.test.js`
- Create: `worker/src/maoyan/lock-runner.js`
- Modify: `worker/src/maoyan/cron.js`
- Modify: `worker/src/maoyan/index.js`
- Modify: `worker/src/index.js:165-168`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Consumes: `getManagedTokens`, `fetchCinemaDetail`, `findExactShows`, `fetchSeatMap`, `createUnpaidOrder`, session/rule persistence, and `pushNotify`
- Produces: `runOneLockRule(env, tokenId, deps = {}) -> RunResult`, where tests may replace time, cinema, seat, order, session, and notification functions
- Produces: `runScheduledLocks(env) -> void`
- Produces: `createLockRuleThroughCoordinator(env, tokenId, input) -> PublicRule`
- Produces: `LockCoordinator` Durable Object class
- Produces: `LOCK_CRON_EXPRESSION = "* * * * *"`

- [ ] **Step 1: Write failing state-machine tests**

In `worker/test/lock-runner.test.js`, create a stored `waiting_schedule` rule and inject fake dependencies. Assert these outcomes:

```text
LOCK_AUTOMATION_ENABLED != "true"     -> skipped; rule unchanged
target date before China today        -> expired; no seat/order request
no exact HH:mm match                   -> waiting_schedule; no seat/order request
two exact HH:mm matches                -> failed; no seat/order request
selected future seat missing/sold      -> failed; no order request
successful create-order                -> locked with orderId/payLeftSecond
certain provider rejection             -> failed
network/timeout/ambiguous POST result   -> unknown
state locked/failed/expired/unknown     -> skipped forever
```

Add a concurrency test where two `LockCoordinator.fetch()` calls target the same object. The injected order function waits on a promise; assert it is called exactly once and the second response reports `skipped: true`.

Add a second concurrency test for rule creation. Send two `action: "create"` requests for the same token and a valid input while the injected `createRule` function is delayed. Assert only one creation function call occurs; the second response is HTTP 409. This is the enforcement point for the one-active-rule contract: KV alone does not provide a compare-and-set operation.

- [ ] **Step 2: Run runner tests and verify they fail**

Run: `cd worker && node --test --test-name-pattern="automation|exact HH:mm|unknown|concurrency" test/*.test.js`

Expected: FAIL because `lock-runner.js` does not exist.

- [ ] **Step 3: Implement the conservative lock state machine**

Start `runOneLockRule` with these guards:

```js
if (String(env.LOCK_AUTOMATION_ENABLED) !== "true") return { ok: true, skipped: true, disabled: true };
const rule = await getLockRule(env, tokenId);
if (!rule || ["locked", "failed", "expired", "unknown", "matching"].includes(rule.state)) {
  return { ok: true, skipped: true };
}
```

Then:

1. Compute China today; mark past target dates `expired`.
2. Fetch the cinema detail and call `findExactShows`.
3. Keep waiting when there is no match; mark `failed` if more than one exact match exists.
4. Load the encrypted session and future seat map.
5. Match every stored `seatNo`, `rowId`, and `columnId`; mark `failed` if any differs or is unavailable.
6. Write state `matching`, `attemptStartedAt`, and the future `seqNo` before calling create-order.
7. On success write `locked`, `orderId`, `payLeftSecond`, and `lockedAt`.
8. On `OrderAttemptError.uncertain === true` write `unknown`; on certain rejection write `failed`.

Pre-order network failures may leave the rule `waiting_schedule` with a sanitized `lastError` for retry. No exception after the create-order POST begins may return the rule to a retryable state.

After persisting a terminal state, attempt notification separately. Notification failure updates only `notifyError`; it never changes or retries order state. Use titles `猫眼锁座成功` and `猫眼锁座失败`, with cinema/movie/date/time/seat labels and, on success, payment remaining seconds. Do not include a payment URL.

- [ ] **Step 4: Implement Durable Object serialization and terminal memory**

Use a synchronous check-and-set before the first `await`:

```js
export class LockCoordinator {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps;
    this.running = false;
  }

  async fetch(request) {
    if (request.method !== "POST") return Response.json({ error: "Method Not Allowed" }, { status: 405 });
    if (this.running) return Response.json({ ok: true, skipped: true }, { status: 202 });
    this.running = true;
    try {
      const { action, tokenId, input } = await request.json();
      if (action === "create") {
        const rule = await createLockRule(this.env, tokenId, input, this.deps);
        return Response.json({ ok: true, rule }, { status: 201 });
      }
      if (action !== "run") return Response.json({ error: "Bad Request" }, { status: 400 });
      const rule = await getLockRule(this.env, tokenId);
      const terminalRuleId = await this.state.storage.get("terminalRuleId");
      if (rule && terminalRuleId === rule.id) return Response.json({ ok: true, skipped: true });
      const result = await runOneLockRule(this.env, tokenId, this.deps);
      const latest = await getLockRule(this.env, tokenId);
      if (latest && ["locked", "failed", "expired", "unknown"].includes(latest.state)) {
        await this.state.storage.put("terminalRuleId", latest.id);
      }
      return Response.json(result);
    } finally {
      this.running = false;
    }
  }
}
```

Validate `tokenId` against `^[0-9a-f-]{36}$` inside the object. `runScheduledLocks` returns immediately while disabled; otherwise it loops `getManagedTokens()`, creates `env.LOCK_COORDINATOR.idFromName(token.id)`, and POSTs `{ tokenId: token.id }` to the stub. One token failure must not stop the remaining tokens.

Implement `createLockRuleThroughCoordinator(env, tokenId, input)` by resolving that same token's Durable Object name and POSTing `{ action: "create", tokenId, input }`. Parse only `{ ok, rule, error }`; turn non-201 responses into fixed API-safe errors. `runScheduledLocks` must POST `{ action: "run", tokenId }`.

- [ ] **Step 5: Separate lock cron from monitor cron reporting**

In `cron.js` add:

```js
export const LOCK_CRON_EXPRESSION = "* * * * *";
```

When the Cloudflare schedules API returns expressions, filter `LOCK_CRON_EXPRESSION` out of the list returned to monitor frequency calculations. If filtering leaves no monitor expression, fall back to `[CRON_EXPRESSION]`. Export both constants.

Route scheduled events in `worker/src/index.js`:

```js
async scheduled(event, env) {
  if (event.cron === LOCK_CRON_EXPRESSION) {
    await runScheduledLocks(env);
    return;
  }
  await runScheduledChecks(env);
}
```

Export the class at module scope:

```js
export { LockCoordinator } from "./maoyan/lock-runner.js";
```

- [ ] **Step 5a: Route interactive rule creation through the same coordinator**

Modify `worker/src/maoyan/lock-api.js` after Task 4 has created it. Replace its direct `createLockRule` call for `POST /api/lock/rule` with `createLockRuleThroughCoordinator(env, tokenId, body)`. Preserve its existing 400/409 response mapping and public response shape. Add an API-level test that issues two concurrent rule-creation requests with the same token and verifies one `201` and one `409`; neither request may reach a direct KV write outside the Durable Object.

- [ ] **Step 6: Add safe Worker configuration**

Update `worker/wrangler.toml`:

```toml
[triggers]
crons = ["*/30 * * * *", "* * * * *"]

[vars]
CF_ACCOUNT_ID = "4872db2724154d6cbee0709216b70a01"
LOCK_AUTOMATION_ENABLED = "false"

[[durable_objects.bindings]]
name = "LOCK_COORDINATOR"
class_name = "LockCoordinator"

[[migrations]]
tag = "v1-maoyan-lock"
new_sqlite_classes = ["LockCoordinator"]
```

Keep `SESSION_ENCRYPTION_KEY` out of TOML; document it only as a Worker Secret set with `wrangler secret put SESSION_ENCRYPTION_KEY`.

- [ ] **Step 7: Run all tests and validate Wrangler configuration without deploying**

Run: `cd worker && npm test`

Run: `cd worker && npx wrangler deploy --dry-run`

Expected: tests PASS; dry run recognizes `MAOYAN_KV`, `LOCK_COORDINATOR`, two cron triggers, and the Durable Object migration. It must not contact Maoyan or create an order.

- [ ] **Step 8: Commit runner and infrastructure wiring**

```bash
git add worker/test/lock-runner.test.js worker/src/maoyan/lock-runner.js worker/src/maoyan/cron.js worker/src/maoyan/index.js worker/src/index.js worker/wrangler.toml
git commit -m "feat: schedule serialized maoyan locks"
```

---

### Task 6: Build the Monitoring-Page Lock Modal

**Files:**
- Create: `pages/maoyan/lock.js`
- Modify: `pages/maoyan/index.html:72-103,146-148`
- Modify: `pages/maoyan/app.js:8-51,598-715`
- Modify: `pages/maoyan/style.css`

**Interfaces:**
- Consumes: existing `api`, `showToast`, `showConfirm`, `withButtonLoading`, `cinemaMovies`, selected cinema ID/name, and selected movie IDs
- Produces: `createMaoyanLockController({ api, getContext, onLog }) -> { syncAvailability, open }`

- [ ] **Step 1: Add the Beta button and static modal structure**

In the monitoring controls row, add an icon-plus-text command button before the monitor toggle:

```html
<button id="btn-lock-seats" class="btn small ghost" disabled title="配置自动锁座">
  <span aria-hidden="true">🔒</span><span>锁座 Beta</span>
</button>
```

Add one `.lock-overlay.hidden` after `#main-page`, with a single `.lock-dialog` containing:

- header title `自动锁座 Beta` and an icon close button with `aria-label="关闭"`;
- session status, file input accepting `.json,application/json`, upload/replace, and delete buttons;
- read-only cinema name, selected-movie `<select>`, template-show `<select>`, and target-date input;
- seat legend, screen label, scrollable seat grid, and selected-seat count;
- the exact Beta risk copy from the design spec and an unchecked `riskAccepted` checkbox;
- existing-rule status area plus cancel button;
- footer buttons `取消` and `启用自动锁座`.

Load scripts in this order with a new cache-busting suffix:

```html
<script src="secure-store.js?v=20260911n"></script>
<script src="ui.js?v=20260911n"></script>
<script src="lock.js?v=20260911n"></script>
<script src="app.js?v=20260911n"></script>
```

- [ ] **Step 2: Implement modal state and upload without browser persistence**

Wrap `lock.js` in an IIFE and expose only `window.createMaoyanLockController`. Keep this state in memory:

```js
const state = {
  context: null,
  session: { uploaded: false },
  movieId: "",
  templateSeqNo: "",
  seatMap: null,
  selectedSeatNos: new Set(),
  rule: null,
  automationEnabled: false
};
```

On upload, read the selected file with `await file.text()`, reject files over 256 KiB in the browser, POST the text directly to `/api/lock/session`, then immediately clear `fileInput.value` and the local text variable. Do not use `localStorage`, `sessionStorage`, IndexedDB, URL parameters, console logging, or DOM data attributes for file content.

Show only `session.uidMasked`, `sourceSavedAt`, and `uploadedAt`. Deleting a session must require `showConfirm`, call `/api/lock/session/remove`, clear the in-memory seat/rule state, and rerender.

- [ ] **Step 3: Populate context, templates, and the authenticated seat grid**

`getContext()` returns:

```js
{
  cinemaId: els.cinemaInput.value.trim(),
  cinemaName: selectedCinema?.name || els.cinemaName.textContent,
  movies: cinemaMovies.filter((movie) => movie.checked)
}
```

Flatten each selected movie's shows into template options containing `movieId`, `movieName`, `showDate`, `tm`, `seqNo`, `lang`, `tp`, and `th`. Disable sold-out shows and entries without decimal `seqNo`. When a template changes, GET `/api/lock/template-seats?cinemaId=...&movieId=...&seqNo=...`, clear prior selections, and render all seats.

Render one stable row per numeric `rowId`. Use a fixed `28px` grid track and `grid-column: Number(columnId)` for seats, with row labels outside the grid. Available seats are buttons; unavailable seats are disabled. Button text is the final numeric segment of `seatNo`; `title` is the full `seatNo`. Clicking toggles `.selected` and updates `已选 N 座：seatNo...`.

- [ ] **Step 4: Validate and create a rule**

Set the date input minimum to China tomorrow and maximum to China today plus 30 calendar days. Enable the submit button only when session exists, a template exists, at least one seat is selected, a valid date is entered, and the risk checkbox is checked.

POST exactly:

```js
{
  cinemaId: state.context.cinemaId,
  movieId: state.movieId,
  templateSeqNo: state.templateSeqNo,
  targetDate: targetDateInput.value,
  seatNos: [...state.selectedSeatNos],
  riskAccepted: riskCheckbox.checked
}
```

After 201, render cinema/movie, target date, exact time, seat labels, state, and `automationEnabled`. When `automationEnabled` is false, show `规则已保存，等待服务验证，当前不会自动建单`. Cancellation calls `/api/lock/rule/cancel` after confirmation and does not delete the uploaded session.

Map states to Chinese text:

```js
const RULE_LABELS = {
  waiting_schedule: "等待目标场次",
  matching: "正在锁座",
  locked: "已锁座，等待支付",
  failed: "锁座失败",
  expired: "目标日期已过期",
  unknown: "订单结果待人工确认"
};
```

- [ ] **Step 5: Integrate current monitoring context**

In `app.js`, create the controller after `api` is defined. Call `lockController.syncAvailability()` from `loadCinema` success/failure, `syncCount`, connect/logout, and monitor page restore. The Beta button is enabled only when connected, a cinema ID is loaded, and at least one movie is checked.

Opening the modal fetches session status and current rule in parallel. A saved rule is shown even if the current page cinema/movie selection has since changed.

- [ ] **Step 6: Add responsive, non-overlapping styles**

Add stable constraints:

```css
.lock-overlay { position: fixed; inset: 0; z-index: 2500; display: grid; place-items: center; padding: 16px; background: rgba(20, 24, 31, .48); }
.lock-dialog { width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: #fff; border-radius: 8px; border: 1px solid var(--border); }
.lock-seat-scroll { overflow-x: auto; padding: 12px 4px; }
.lock-seat-row { display: grid; grid-template-columns: 30px max-content; align-items: center; min-height: 32px; }
.lock-seat-grid { display: grid; grid-auto-columns: 28px; gap: 4px; min-width: max-content; }
.lock-seat { width: 28px; height: 28px; padding: 0; font-size: 10px; }
```

Use existing red, green, neutral, and warning colors rather than introducing a single-hue palette. At `max-width: 640px`, make modal form rows single-column, keep footer actions visible without covering seat rows, and ensure long cinema/movie/status text wraps.

- [ ] **Step 7: Run static checks and browser verification**

Run:

```bash
node --check pages/maoyan/lock.js
node --check pages/maoyan/app.js
```

Start a static server from `pages` on an unused localhost port. Verify desktop `1440x900` and mobile `390x844` in a browser:

- button placement remains inside the monitoring card;
- modal fits the viewport and scrolls internally;
- upload file content never appears in DOM text or browser storage;
- seat rows remain aligned and horizontally scroll instead of resizing;
- all long text wraps without overlap;
- submit remains disabled until every required condition is true.

Capture one desktop and one mobile screenshot for visual review. Before loading `app.js`, use browser request interception for `/api/status`, `/api/config`, `/api/cities`, `/api/shows`, `/api/lock/session/status`, `/api/lock/rule`, and `/api/lock/template-seats`; return the same fixed cinema/show/seat fixtures used by Worker tests. Abort `/api/lock/session` and `/api/lock/rule` POST requests during this visual pass so it cannot upload a real session or create an order.

- [ ] **Step 8: Commit the page workflow**

```bash
git add pages/maoyan/index.html pages/maoyan/app.js pages/maoyan/lock.js pages/maoyan/style.css
git commit -m "feat: add maoyan lock configuration modal"
```

---

### Task 7: End-to-End Safety Verification and Deployment Handoff

**Files:**
- Modify only if checks reveal a defect: files introduced or touched in Tasks 1-6

**Interfaces:**
- Verifies the complete user flow without authorizing payment or production automation

- [ ] **Step 1: Run the complete automated suite and syntax checks**

Run:

```bash
cd worker && npm test
node --check src/index.js
node --check src/maoyan/lock-session.js
node --check src/maoyan/lock-client.js
node --check src/maoyan/lock-rule.js
node --check src/maoyan/lock-api.js
node --check src/maoyan/lock-runner.js
cd ..
node --check pages/maoyan/app.js
node --check pages/maoyan/lock.js
git diff --check
```

Expected: all tests PASS, all syntax checks exit 0, and `git diff --check` prints nothing.

- [ ] **Step 2: Verify secrets cannot leak through public projections**

Run the test suite with fixture credential markers, then search generated source responses and page persistence calls:

```bash
rg -n "cookie-secret|signature-secret|csrf-value" worker/src pages/maoyan
rg -n "localStorage|sessionStorage|indexedDB|console\." pages/maoyan/lock.js
```

Expected: the first command has no matches; the second has no matches.

- [ ] **Step 3: Validate Worker packaging without deployment**

Run: `cd worker && npx wrangler deploy --dry-run`

Expected: build succeeds with the KV and Durable Object bindings. Confirm output does not indicate an actual deployment.

- [ ] **Step 4: Review the final diff against every design requirement**

Confirm in the diff:

- UID is masked in every response and the complete session exists only inside AES-GCM ciphertext/decrypted runtime memory;
- the server re-fetches and validates template seats before storing a rule;
- future matching is exact `targetDate + HH:mm`;
- every selected seat must match `seatNo + rowId + columnId` and remain available;
- create-order has no payment call, no automatic substitution, and no retry after uncertainty;
- `LOCK_AUTOMATION_ENABLED` remains `false` in committed configuration;
- token revocation and session removal delete the associated sensitive data/rule;
- ordinary monitor cron text still reports `*/30`, not the one-minute lock cron.

- [ ] **Step 5: Commit only corrective changes found during verification**

If verification required edits, stage only those exact files and commit:

```bash
git commit -m "fix: harden maoyan cloud lock flow"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Stop before production mutation and request explicit authorization**

Report that implementation is ready with `LOCK_AUTOMATION_ENABLED=false`. Do not run `wrangler deploy`, set `SESSION_ENCRYPTION_KEY`, upload the user's real session, perform a real create-order, or enable automation in this task. Those actions require a new explicit instruction because they mutate Cloudflare state and may create an unpaid order.
