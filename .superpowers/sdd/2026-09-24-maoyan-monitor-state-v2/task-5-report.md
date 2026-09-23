# Task 5 report

Commit: `a611e4b refactor: retire maoyan monitor history tables`

- Fresh `worker/schema.sql` no longer creates `cinema_batches`, `cinema_snapshots`, or `cinema_events`.
- `worker/sql/maoyan-monitor-state-v2.sql` documents the ordering boundary: pause cron/dispatcher, run the one-time migration against the legacy source, validate, deploy the v2 Worker, then remove the source tables.
- Runtime tests cover an unchanged scan retaining one current JSON body, creating no `change_log` history, and completing after the legacy tables are absent.
- Migration fixtures now create legacy source tables explicitly instead of treating them as part of the fresh production schema. Dashboard coverage reads only `cinema_state`.
- The design spec records the cutover checklist and the runtime versus one-time migration boundary.

## Verification

- `node --experimental-sqlite --test test/monitor-store.test.js test/monitor-coordinator.test.js`: 24 passed.
- `npm test` from `worker`: 471 passed, 0 failed.
- `git diff --check`: passed.
- `npm run deploy:preflight`: the script requires an explicit `--config`; with `npm run deploy:preflight -- --config wrangler.toml`, it ran and reported missing `ADMIN_TOKEN`, `SESSION_ENCRYPTION_KEY`, and `ENROLLMENT_HMAC_KEY` secrets. Deployment preflight is therefore not fully passing in this local environment.

## Cutover checklist

1. Pause cron and the monitor dispatcher.
2. Run the state migration while the legacy source tables still exist.
3. Validate active subscription, cinema, lock-rule, and unsent outbox counts.
4. Deploy the v2 Worker and run one manual cinema check.
5. Restore cron and the dispatcher after the manual check succeeds.
6. Remove the three legacy history tables only after validation; keep them for retry if migration fails.

## Remaining risks

- Production cutover still requires an operator to pause and resume the external schedulers and supply deployment secrets.
- The one-time migration must be run before the legacy source tables are dropped.
