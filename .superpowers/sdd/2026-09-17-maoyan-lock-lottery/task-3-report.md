# Task 3 Report: Remove Unsupported Legacy Runtime Paths

## Status

Complete.

## Changes

- Lock sessions now require D1 and use only D1 version pointers, versioned KV keys, v2 envelopes, and version-bound AAD.
- Unversioned session KV objects are ignored; no read-time migration or missing-D1 storage mode remains.
- Plaintext notification credential fields are ignored at read time and are not migrated. Current writes and reads continue to use encrypted `notifyCredentials`.
- Removed the legacy `/api/test-bark` route. `/api/test-push` remains the supported notification test route.
- Web startup reads only profile-scoped tokens and no longer migrates or deletes the global token.
- Web connections require `/api/capabilities` and `/api/auth/session`; a capabilities 404 no longer falls back to status authentication.
- Updated runtime tests and non-migration test fixtures to use encrypted notification config and D1-versioned session data.

## TDD Evidence

RED focused run:

- Worker focused tests: 4 intended failures covering `/api/test-bark`, missing D1, unversioned session KV, and plaintext notification credentials.
- Page focused tests: 2 intended failures covering global-token migration and capabilities-404 fallback.

GREEN focused run:

- Worker focused tests: 30 passed, 0 failed.
- Page focused tests: 40 passed, 0 failed.

## Final Verification

- `cd worker && npm test`: 346 passed, 0 failed.
- `node --test pages/maoyan/*.test.cjs`: 103 passed, 0 failed.

## Concerns

None. Worker migrations, business-migration fixtures/helpers, `README`, and `DEPLOY-D1.md` were not changed.
