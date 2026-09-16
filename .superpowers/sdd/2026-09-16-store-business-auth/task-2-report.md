# Task 2 Report: Route Authorization and Store Sessions

## Outcome

Implemented business-scoped Worker authorization and Store browser sessions.

## TDD Evidence

Initial red command, from `worker`:

```sh
node --experimental-sqlite --test test/business-auth.test.js
```

Observed failure: the Store-key request to `GET /api/status` returned `200` instead of the required `403 FORBIDDEN`.

Expanded red command, from `worker`:

```sh
node --experimental-sqlite --test test/business-auth.test.js test/store-auth.test.js
```

Observed failure: `1/5` passed. The Maoyan session exchange accepted a Store key (`200` rather than `403`), and all Store auth endpoints returned `404` because no browser-session implementation existed.

Cache-control regression red command, from `worker`:

```sh
node --experimental-sqlite --test test/store-auth.test.js
```

Observed failure: rejected Store session mutation lacked `Cache-Control: no-store`.

Final green commands, from `worker`:

```sh
node --experimental-sqlite --test test/business-auth.test.js test/store-auth.test.js test/account-auth.test.js
npm test
```

Observed result: focused authentication `16/16` passing; full Worker suite `306/306` passing with zero failures.

## Files

- `worker/src/common/business.js`: business-line guard with administrator bypass.
- `worker/src/store/auth.js`: hashed Store sessions, same-origin JSON mutations, cookie lifecycle, renewal, and protected access checks.
- `worker/src/index.js`: Store route protection and Maoyan business gate before restricted-route exemptions.
- `worker/src/maoyan/auth.js`, `worker/src/maoyan/account-api.js`: business-aware principals/session exchange and non-cacheable auth errors.
- `worker/schema.sql`, `worker/migrations/0002-business-lines.sql`: Store-session persistence.
- `worker/test/business-auth.test.js`, `worker/test/store-auth.test.js`, `worker/test/account-auth.test.js`: cross-business, session, account-state, renewal, rotation, and compatibility coverage.

## Self-review

- Store secrets are generated as 32 random bytes and only SHA-256 hashes are persisted.
- Store cookies are `HttpOnly`, `SameSite=Lax`, path-scoped to `/store/`, HTTPS-secure, and deleted on the same path.
- Store session mutations reject foreign origins and cross-site fetches; session responses and errors are non-cacheable.
- Protected Store proxy/file routes re-read session and account state on every request; expired users may inspect and renew only their own account without Maoyan resume behavior.
- Maoyan administrator APIs remain on `X-Admin-Token`; Store sessions do not enter that route.

## Concerns

- `0002-business-lines.sql` remains the existing one-time migration for deployed D1 databases and must be applied before deploying this schema change; no remote D1 action was performed.
