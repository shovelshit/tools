# 猫眼同厅近时场次自动锁座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 D1 迁移分支上，让推断锁座规则对同一具体 `th` 影厅、模板时间前后 30 分钟以内的目标场次自动尝试锁座，并保证所有已尝试失败都发送通知。

**Architecture:** 保留创建规则时的模板推断和 `waiting_schedule` 状态；由成功监控后的 Durable Object 锁座流程调用新的兼容场次匹配器。匹配器只返回同电影、同日期、同 `th` 且时间差最小的唯一候选；候选确定后锁座流程进入终态，复用现有终态通知，不再把准备阶段错误静默留在等待态。

**Tech Stack:** Cloudflare Workers ES modules, D1/SQLite persistence on `d1-migrate`, native Fetch API, Node.js `node:test`, Wrangler.

## Global Constraints

- 时间容差固定为 30 分钟，边界包含 30 分钟。
- “同厅型”定义为模板 `th` 与目标场次 `th` 字符串完全一致。
- 没有兼容候选时继续 `waiting_schedule`，不发送锁座尝试结果通知。
- 一旦兼容候选确定，任何锁座失败都进入 `failed` 或 `unknown` 并发送一次终态通知。
- 精确目标场次立即锁座路径保持现有行为。
- D1 分支既有数据访问层和公共 API 形状保持兼容；新增字段需通过 `publicLockRule` 安全投影。
- 保留当前工作区的座位图响应 `Cache-Control: no-store` 修复，不把它回退。

---

### Task 1: Add A Tested Compatible-Show Matcher

**Files:**
- Modify: `worker/src/maoyan/lock-client.js`
- Test: `worker/test/lock-client.test.js`

**Interfaces:**
- Produces `findCompatibleShows(data, { movieId, targetDate, templateTime, templateHall, maxMinutes = 30 })`.
- Returns target shows decorated with `showDate`, `timeDeltaMinutes`, and `matchMode: "fuzzy"`, sorted by absolute time difference then `seqNo`.
- Returns no candidate for a missing/invalid hall, mismatched `th`, invalid time, non-matching date/movie, or difference greater than 30 minutes.

- [ ] **Step 1: Write failing tests**

Add literal fixtures covering: same hall at `18:10` for template `18:40` (accepted), same hall at `18:09` (rejected), same hall at `19:10` (accepted at the upper boundary), `19:11` (rejected), another `th` at an otherwise valid time (rejected), and two equal-distance candidates (both returned for the runner to classify as ambiguous).

- [ ] **Step 2: Run focused tests to verify red**

Run: `node --test test/lock-client.test.js --test-name-pattern='compatible|近时|同厅'`

Expected: FAIL because the matcher export does not exist.

- [ ] **Step 3: Implement the minimal matcher**

Parse `HH:mm` into minutes, filter the movie/date/hall fields, accept `Math.abs(candidate - template) <= 30`, reject explicit nonzero `ticketStatus`, decorate accepted shows, and sort deterministically. Keep `findExactShows` unchanged for existing callers.

- [ ] **Step 4: Run focused tests to verify green**

Run: `node --test test/lock-client.test.js --test-name-pattern='compatible|近时|同厅'`

Expected: all new matcher tests pass.

- [ ] **Step 5: Commit the matcher**

```bash
git add worker/src/maoyan/lock-client.js worker/test/lock-client.test.js
git commit -m "feat(maoyan): match same-hall shows within thirty minutes"
```

### Task 2: Persist Actual Fuzzy-Matched Show Details

**Files:**
- Modify: `worker/src/maoyan/lock-rule.js`
- Test: `worker/test/lock-rule.test.js`

**Interfaces:**
- `PUBLIC_FIELDS` includes `targetTime`, `matchMode`, and `timeDeltaMinutes` when present.
- `lockNotificationContent(rule)` uses `targetTime || templateTime` and appends the template/actual time delta for `matchMode === "fuzzy"`.

- [ ] **Step 1: Write failing tests**

Construct a public rule with template `18:40`, actual `18:50`, `matchMode: "fuzzy"`, `timeDeltaMinutes: 10`, and assert the projected rule retains the three fields and the notification contains the actual time plus `+10` minutes. Assert an exact rule still renders its existing message shape.

- [ ] **Step 2: Run the focused rule tests to verify red**

Run: `node --test test/lock-rule.test.js --test-name-pattern='实际场次|模糊|notification|通知'`

Expected: FAIL because the fields/message are not yet projected or rendered.

- [ ] **Step 3: Implement projection and message formatting**

Add only the new public fields and use the actual hall/time in the shared notification builder. Keep legacy rules compatible by falling back to `templateTime` and omitting fuzzy text when fields are absent.

- [ ] **Step 4: Run the focused rule tests to verify green**

Run: `node --test test/lock-rule.test.js --test-name-pattern='实际场次|模糊|notification|通知'`

Expected: all focused rule tests pass.

- [ ] **Step 5: Commit the rule message change**

```bash
git add worker/src/maoyan/lock-rule.js worker/test/lock-rule.test.js
git commit -m "feat(maoyan): expose actual fuzzy lock show in rules and notifications"
```

### Task 3: Make Scheduled Fuzzy Attempts Terminal And Notified

**Files:**
- Modify: `worker/src/maoyan/lock-runner.js`
- Test: `worker/test/lock-runner.test.js`

**Interfaces:**
- `runOneLockRule` uses `findCompatibleShows` only when exact target matching returns no show for the waiting rule.
- A unique compatible show persists `matching`, `targetSeqNo`, `targetTime`, `matchMode`, `timeDeltaMinutes`, and actual `hall` before seat-map/order work.
- No candidate returns `{ ok: true, waiting: true }` without notification.
- Ambiguity, seat-map mismatch, seat unavailability, provider rejection, and preparation errors after candidate selection call `terminal(..., "failed", ...)`; uncertain order results call `terminal(..., "unknown", ...)`.

- [ ] **Step 1: Write failing runner tests**

Add tests for: unique same-hall `18:50` candidate from template `18:40` reaches `locked` and calls one order; `18:50` with another hall is still waiting; `19:10` is accepted; `19:11` is waiting; two equal-distance same-hall candidates fail and notify; a selected candidate whose seat map fetch throws fails and notifies; provider rejection fails and notifies; uncertain order result becomes `unknown` and notifies; no candidate does not notify.

- [ ] **Step 2: Run focused tests to verify red**

Run: `node --test test/lock-runner.test.js --test-name-pattern='近时|同厅|通知|waiting'`

Expected: new fuzzy tests fail because the runner only calls exact-time matching and catches preparation errors back into waiting.

- [ ] **Step 3: Implement the runner transition**

Keep exact matching as the first choice. If the rule is a waiting rule and exact matching has no usable target, call `findCompatibleShows` with `rule.hall` and `rule.templateTime`; select only a unique nearest candidate. Persist actual show metadata before loading the seat map. From that point, route errors through `terminal` so `notifyTerminal` runs once. Preserve `unknown` only for uncertain order outcomes and preserve cancellation checks before/after persistence.

- [ ] **Step 4: Run focused tests to verify green**

Run: `node --test test/lock-runner.test.js --test-name-pattern='近时|同厅|通知|waiting'`

Expected: all new and existing focused runner tests pass.

- [ ] **Step 5: Commit the scheduled-lock behavior**

```bash
git add worker/src/maoyan/lock-runner.js worker/test/lock-runner.test.js
git commit -m "feat(maoyan): lock and notify on same-hall nearby shows"
```

### Task 4: Preserve D1 Regression Coverage And The Cache Header Fix

**Files:**
- Modify: `worker/src/maoyan/lock-api.js`
- Test: `worker/test/lock-api.test.js`
- Verify: all files under `worker/test/`

**Interfaces:**
- `/api/lock/template-seats` returns `Cache-Control: no-store` through the response wrapper on the D1 branch.
- D1-backed rule/config/session behavior remains unchanged.

- [ ] **Step 1: Run the existing cache regression test to verify the known red state**

Run: `node --test test/lock-api.test.js --test-name-pattern='template seats expose the sanitized seat map only'`

Expected: FAIL with `null !== "no-store"` because the D1 branch route currently does not pass the header.

- [ ] **Step 2: Restore the route header using the already-tested response helper**

Pass `{ "Cache-Control": "no-store" }` to the existing `response` call. Do not alter D1 persistence behavior.

- [ ] **Step 3: Run the focused cache test**

Run: `node --test test/lock-api.test.js --test-name-pattern='template seats expose the sanitized seat map only'`

Expected: PASS.

- [ ] **Step 4: Run the full D1 worker suite**

Run: `npm test`

Expected: all tests pass with zero failures, including the D1 migration tests.

- [ ] **Step 5: Run repository verification**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit the D1 regression fix**

```bash
git add worker/src/maoyan/lock-api.js worker/test/lock-api.test.js
git commit -m "fix(maoyan): preserve no-store seat-map responses on d1"
```

