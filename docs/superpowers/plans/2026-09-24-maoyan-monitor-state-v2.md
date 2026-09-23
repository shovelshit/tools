# 猫眼监控状态 v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前仍在使用的猫眼监控迁移到每影院一条状态记录和可恢复活跃运行模型，舍弃旧监控历史并避免无变化扫描持续增长 D1。

**Architecture:** 新增 `cinema_state` 保存当前正文和活跃重试正文，`monitor_subscriptions.last_run_id` 标记用户是否完成当前运行。保留用户配置、锁座规则和未发送通知，停用旧 `cinema_batches`、`cinema_snapshots`、`cinema_events` 历史表；不做旧历史回填。

**Tech Stack:** Cloudflare Workers ES modules、D1 SQLite、Durable Objects、Node.js `node:test`。

## Global Constraints

- 当前用户的 `user_config`、`monitor_subscriptions`、`lock_rule` 和未发送 `notification_outbox` 必须保留。
- 内容版本不变时仍然检查锁座和推进 `next_due_at`。
- 活跃运行失败时必须使用同一个 `active_run_id` 和 `active_data` 重试。
- 旧历史不迁移；切换前必须暂停 cron 和 dispatcher。
- 不修改猫眼抓取协议、通知渠道和锁座订单接口。

---

### Task 1: Add v2 state schema and migration fixtures

**Files:**
- Create: `worker/sql/maoyan-monitor-state-v2.sql`
- Modify: `worker/schema.sql`
- Modify: `worker/test/helpers.js`
- Test: `worker/test/monitor-state-migration.test.js`

**Interfaces:**
- `cinema_state` uses `cinema_id` as the primary key and stores `current_*`, `active_*`, `run_state`, cursor, lease and timestamps.
- `monitor_subscriptions.last_run_id` is nullable and indexed with cinema and due time.

- [ ] Add a migration that creates `cinema_state` and adds `last_run_id` without changing user, config, lock or notification tables.
- [ ] Update the fresh schema so new test databases contain only the v2 monitor tables used by runtime code.
- [ ] Add fixture helpers that seed one active user, one current cinema state, and one pending notification.
- [ ] Test that the migration preserves the active subscription, lock rule and pending outbox row, initializes `baseline_version` from the latest current version, and leaves no old batch dependency.
- [ ] Run `node --experimental-sqlite --test test/monitor-state-migration.test.js` and confirm it passes.
- [ ] Commit with `git add worker/sql/maoyan-monitor-state-v2.sql worker/schema.sql worker/test/helpers.js worker/test/monitor-state-migration.test.js && git commit -m "feat: add maoyan monitor state schema"`.

### Task 2: Implement current state, hashing and resumable runs

**Files:**
- Modify: `worker/src/maoyan/monitor-store.js`
- Test: `worker/test/monitor-store.test.js`

**Interfaces:**
- `normalizeCinemaData(data)` returns the public, lock-relevant deterministic representation.
- `hashCinemaData(data)` returns a lowercase SHA-256 hex digest.
- `beginCinemaRun(DB, { cinemaId, runId, nowMs, fetchedData })` returns `{ runId, baseVersion, version, data, changed }` and is idempotent for an existing run.
- `listRunSubscribers(DB, { cinemaId, runId, startedAt, afterUserId, limit })` excludes users whose `last_run_id` already equals the run.
- `completeRunSubscriber(DB, { userId, cinemaId, runId, configVersion, nextDueAt, baselineVersion })` performs a conditional update.
- `completeCinemaRun(DB, { cinemaId, runId, nowMs })` promotes active state to current state and clears active fields.

- [ ] Write failing tests for stable hashes when show order changes, hash changes when time/hall/ticket status changes, and no hash change for irrelevant provider fields.
- [ ] Write a failing test that an existing active run returns its stored data without calling the fetcher again.
- [ ] Write a failing test that a failed subscriber remains selectable while a subscriber with `last_run_id` equal to the run is skipped.
- [ ] Write a failing test that completing a run promotes active data and removes active data atomically.
- [ ] Run the focused monitor-store tests and confirm the new cases fail before implementation.
- [ ] Implement the state and run functions using one D1 batch for each state transition; do not read mutable snapshot tables.
- [ ] Run `node --experimental-sqlite --test test/monitor-store.test.js` and confirm all focused tests pass.
- [ ] Commit with `git add worker/src/maoyan/monitor-store.js worker/test/monitor-store.test.js && git commit -m "feat: make maoyan monitor runs resumable"`.

### Task 3: Process notifications and locks with the same resumable run

**Files:**
- Modify: `worker/src/maoyan/monitor-coordinator.js`
- Modify: `worker/src/maoyan/monitor-dispatcher.js`
- Test: `worker/test/monitor-coordinator.test.js`
- Test: `worker/test/monitor-dispatcher.test.js`

**Interfaces:**
- `processCinemaRun(env, { cinemaId, runId, nowMs, fetchCinema, runLock })` resumes an existing run and returns `completed`, `retryable`, subscriber and lock counters.
- `dispatchCinema` sends the run ID to the cinema coordinator; a retry must reuse the same run ID.

- [ ] Add a failing test that an unchanged content run still checks a waiting lock and advances `next_due_at`.
- [ ] Add a failing test that a failure after the first subscriber resumes the same run and does not duplicate its notification.
- [ ] Add a failing test that a rejected lock handoff leaves the run retryable and a successful terminal lock permits completion.
- [ ] Add a failing dispatcher test that the alarm resumes the same run before accepting a newer run.
- [ ] Run the focused coordinator and dispatcher tests and confirm the new tests fail before implementation.
- [ ] Implement per-run subscriber selection using `last_run_id`; process notification baseline advancement separately from lock eligibility; only mark the user complete after lock handoff has a defined result.
- [ ] Remove reads and writes to `cinema_batches`, `cinema_snapshots` and `cinema_events` from the runtime path.
- [ ] Run `node --experimental-sqlite --test test/monitor-coordinator.test.js test/monitor-dispatcher.test.js` and confirm all tests pass.
- [ ] Commit with `git add worker/src/maoyan/monitor-coordinator.js worker/src/maoyan/monitor-dispatcher.js worker/test/monitor-coordinator.test.js worker/test/monitor-dispatcher.test.js && git commit -m "feat: resume maoyan monitoring by run state"`.

### Task 4: Migrate the one active user and update dashboard queries

**Files:**
- Create: `worker/scripts/migrate-maoyan-monitor-state.mjs`
- Modify: `worker/src/maoyan/dashboard.js`
- Test: `worker/test/dashboard.test.js`
- Test: `worker/test/monitor-state-migration.test.js`

**Interfaces:**
- `migrateActiveMonitorState(DB, { nowMs, userId })` returns `{ migratedUsers, migratedCinemas, preservedOutbox, resetBaselines }`.
- The dashboard reads current cinema names and timestamps from `cinema_state`, not historical batches.

- [ ] Add a failing migration test for a user with a latest committed batch, a waiting lock rule and pending notification.
- [ ] Add a failing migration test for a user whose cinema has no committed batch; it must initialize version zero and establish a baseline on the first scan.
- [ ] Implement migration to pause at the caller boundary, copy only the active subscription and latest public data, preserve waiting rules and pending outbox rows, and initialize `cinema_state`.
- [ ] Update dashboard queries for latest cinema state and remove historical batch/event dependencies.
- [ ] Run `node --experimental-sqlite --test test/monitor-state-migration.test.js test/dashboard.test.js` and confirm all tests pass.
- [ ] Commit with `git add worker/scripts/migrate-maoyan-monitor-state.mjs worker/src/maoyan/dashboard.js worker/test/dashboard.test.js worker/test/monitor-state-migration.test.js && git commit -m "feat: migrate active maoyan monitor state"`.

### Task 5: Remove old monitor history and verify the cutover

**Files:**
- Modify: `worker/schema.sql`
- Modify: `worker/sql/maoyan-monitor-state-v2.sql`
- Modify: `docs/superpowers/specs/2026-09-24-maoyan-monitor-state-v2-design.md`
- Test: `worker/test/monitor-store.test.js`
- Test: `worker/test/monitor-coordinator.test.js`

- [ ] Add a test proving an unchanged scan creates no new historical monitor row and stores no second full JSON copy.
- [ ] Add a test proving the migration no longer requires `cinema_batches`, `cinema_snapshots` or `cinema_events` after the cutover.
- [ ] Run the complete worker suite with `npm test` from `worker`.
- [ ] Run `git diff --check` and inspect all SQL references to retired tables.
- [ ] Run the deployment preflight with `npm run deploy:preflight`.
- [ ] Record the cutover checklist: pause cron, migrate state, validate counts, deploy Worker, run one manual cinema check, restore cron and dispatcher.
- [ ] Commit with `git add worker/schema.sql worker/sql/maoyan-monitor-state-v2.sql docs/superpowers/specs/2026-09-24-maoyan-monitor-state-v2-design.md worker/test/monitor-store.test.js worker/test/monitor-coordinator.test.js && git commit -m "refactor: retire maoyan monitor history tables"`.
