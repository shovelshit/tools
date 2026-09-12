# Maoyan Worker Order Request Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Worker create-order request equivalent to the known-good local request without changing session storage or lock scheduling.

**Architecture:** Preserve the existing `createUnpaidOrder(session, seatMap, seatNos)` API. Resolve seat numbers to provider seat objects inside `lock-client.js`, retain movie/cinema context on fetched seat maps, and add the local client's AJAX headers at the outbound request boundary.

**Tech Stack:** Cloudflare Workers, JavaScript ES modules, Node.js built-in test runner

## Global Constraints

- Do not call the payment API.
- Do not perform a real create-order request during tests.
- Do not expose cookies, signatures, tokens, or provider-internal URLs in logs or errors.
- Do not change the uploaded session schema or cron behavior.

---

### Task 1: Align Worker create-order request

**Files:**
- Modify: `worker/test/lock-client.test.js`
- Modify: `worker/src/maoyan/lock-client.js`

**Interfaces:**
- Consumes: `createUnpaidOrder(session, seatMap, seatNos)` and `fetchSeatMap(session, { cinemaId, movieId, seqNo })`
- Produces: a form-encoded create-order request whose `seats.list` contains `{ rowId, columnId, seatNo, type }` objects and whose referrer contains `movieId` and `cinemaId`

- [ ] **Step 1: Write the failing request-parity assertions**

Update the create-order test to expect:

```js
assert.equal(init.headers.Accept, "application/json, text/plain, */*");
assert.equal(init.headers["Accept-Language"], "zh-CN,zh;q=0.9");
assert.equal(init.headers["X-Requested-With"], "XMLHttpRequest");
assert.equal(init.headers.Referer, "https://www.maoyan.com/xseats/2026091201?movieId=7&cinemaId=25428");
assert.equal(payload.get("seats"), '{"count":1,"list":[{"rowId":"6","columnId":"18","seatNo":"1-6-18","type":"N"}]}');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/lock-client.test.js`

Expected: FAIL because the Worker still sends a string-only seat list and incomplete request context.

- [ ] **Step 3: Implement minimal request parity**

Change `selectedSeats` to resolve and return provider seat objects, return `movieId` and `cinemaId` from `fetchSeatMap`, construct the complete referrer, and add the three AJAX headers. Change the provider-error message to `猫眼拒绝当前下单请求，请稍后重试或重新上传会话`.

- [ ] **Step 4: Verify focused and complete tests**

Run: `node --test test/lock-client.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: all Worker tests pass with zero failures.

- [ ] **Step 5: Review and commit**

Run: `git diff --check && git diff -- worker/src/maoyan/lock-client.js worker/test/lock-client.test.js`

Commit only the request-parity implementation and its tests after verification.
