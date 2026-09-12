# Maoyan Unified Monitor And Lock Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make future seat locking a downstream action of a successful monitor run, using one configurable cron and privacy-safe structured logs.

**Architecture:** Keep immediate locking for target shows that already exist. For a waiting future rule, the scheduled monitor persists its snapshot and status first, then hands a sanitized copy of that same cinema response to the token's Durable Object; the object re-reads the current rule and serializes seat validation and order creation. Remove the dedicated lock cron and its all-token scan.

**Tech Stack:** Cloudflare Workers ES modules, Workers KV, Durable Objects, native Fetch API, Node.js `node:test`, Wrangler.

## Global Constraints

- Future locking may run only after a successful scheduled monitor fetch and persistence.
- A failed, stopped, or expired monitor run must not invoke future locking.
- Existing target shows continue to use the immediate locking path when the user creates the rule.
- Monitoring and future locking use the same configurable Cloudflare cron.
- Durable Object serialization and terminal/unknown no-retry behavior must remain intact.
- Logs must not contain authentication data or user/order/show/seat identifiers.

---

### Task 1: Make Monitoring Produce The Lock Handoff

**Files:**
- Modify: `worker/src/maoyan/check.js`
- Modify: `worker/src/maoyan/tokens.js`
- Test: `worker/test/tokens.test.js`

**Interfaces:**
- `runCheck(env, manual, tokenId, options = {})`
- `options.afterPersist(cinemaData)` runs only after snapshot and status writes succeed.
- `runScheduledChecks(env, afterMonitor)` invokes `afterMonitor(tokenId, cinemaData)` without turning a lock failure into a monitor failure.

- [x] Add a failing test proving the handoff occurs after persisted monitor state and is skipped for failed/stopped monitoring.
- [x] Run `node --test test/tokens.test.js` and confirm the new test fails for the missing handoff.
- [x] Add the minimal post-persistence callback and isolated lock-error handling.
- [x] Run `node --test test/tokens.test.js` and confirm it passes.

### Task 2: Consume Monitored Data Through The Coordinator

**Files:**
- Modify: `worker/src/maoyan/lock-runner.js`
- Modify: `worker/src/index.js`
- Modify: `worker/src/maoyan/index.js`
- Modify: `worker/src/maoyan/cron.js`
- Modify: `worker/wrangler.toml`
- Test: `worker/test/lock-runner.test.js`

**Interfaces:**
- `runScheduledLockAfterMonitor(env, tokenId, cinemaData)` sends one sanitized monitored snapshot to the token Durable Object.
- The coordinator `run` action injects that snapshot as `fetchCinema`, so `runOneLockRule` never independently fetches future schedules.
- The Worker `scheduled` handler always runs monitoring and uses its handoff for locking.

- [x] Add failing tests proving monitored data is used, no independent schedule fetch occurs, and monitor cron reporting has no special lock-cron exclusion.
- [x] Run `node --test test/lock-runner.test.js` and confirm the expected failures.
- [x] Implement the coordinator handoff and remove `LOCK_CRON_EXPRESSION` plus the all-token lock scan.
- [x] Reduce Wrangler triggers to the single default monitor cron.
- [x] Run `node --test test/lock-runner.test.js` and confirm it passes.

### Task 3: Replace Identifier Logs With Structured Events

**Files:**
- Modify: `worker/src/maoyan/lock-client.js`
- Modify: `worker/src/maoyan/lock-rule.js`
- Modify: `worker/src/maoyan/lock-runner.js`
- Test: `worker/test/lock-client.test.js`
- Test: `worker/test/lock-rule.test.js`
- Test: `worker/test/lock-runner.test.js`

**Interfaces:**
- Structured records use `scope: "maoyan-lock"` and stable `event`/`phase`/`state` fields.
- Only bounded provider error `name` and `message` fields may be retained.

- [x] Add failing tests with sentinel token, show, seat, order, query, URL, and header secrets and assert none appear in captured logs.
- [x] Run focused tests and confirm the sentinel values currently leak from rule logs.
- [x] Replace string logs with structured, identifier-free records.
- [x] Run focused tests, then `npm test`, `git diff --check`, and `npx wrangler deploy --dry-run`.
- [ ] Commit, push `master`, deploy with Wrangler, and verify the active version ID.
