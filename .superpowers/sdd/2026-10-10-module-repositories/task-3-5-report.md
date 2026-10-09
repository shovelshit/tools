# Tasks 3-5 Integration Report

## Parent changes

- Registered `modules/movie` and `modules/store` as Git submodules. The
  current pins are `db68e9fd139e94937da49ad4e479f2eace02144c` and
  `ad77d7417b334a01746194afe4933f5bf8e7f36d`.
- Changed the static asset builder to read both submodules and fail with an
  initialization command when a source is unavailable.
- Migrated Electron CI, release paths, cache paths, and test commands to
  `modules/movie/desktop`; CI checks out submodules recursively and tests Store
  pages as well.
- Moved the complete Electron release workflow assertion suite to
  `worker/test/electron-release-workflow.test.cjs`, where it can inspect the
  parent workflow and child package without a parent file inside the child
  repository.
- Added child CI workflows and `.github/workflows/module-update.yml`. The
  update workflow only creates/updates a PR and never deploys.
- Removed duplicate parent `pages/maoyan`, `pages/store`, and `desktop` source
  trees after the submodule-backed build and tests passed. Existing generated
  root desktop output was preserved outside the checkout and remains ignored.
- Added `knowledge/README.md` and reduced the root README to a concise entry
  point with quick commands and public URLs.

## Published child commits

- Movie: `https://github.com/shovelshit/movie` at
  `db68e9fd139e94937da49ad4e479f2eace02144c` (child CI plus removal of the
  parent-workflow-coupled assertion).
- Store: `https://github.com/shovelshit/store` at
  `ad77d7417b334a01746194afe4933f5bf8e7f36d` (child CI).

## Verification

- `node --test modules/movie/pages/maoyan/*.test.cjs`: 142 passed.
- `npm --prefix modules/movie/desktop test`: 80 passed.
- `node --test modules/store/pages/store/*.test.cjs`: 4 passed.
- `npm --prefix worker run build:assets`: built 31 whitelisted assets.
- `npm --prefix worker test`: 497 passed.
- `node --test worker/test/electron-release-workflow.test.cjs`: 7 passed.
- `npm run package:mac -- --dir` and `npm run test:smoke -- --packaged` in
  `modules/movie/desktop`: packaged asar allowlist verified (24 files) and
  Electron smoke passed.
- `git diff --check`: passed.
- `git submodule status`: matches the published SHAs above.

## Unresolved concerns

- GitHub Actions must be configured to permit the repository token to create
  pull requests for `module-update.yml`; otherwise use an approved PAT/setting
  without exposing its value.
- The parent integration/browser test that launches Chrome still requires the
  child desktop dependencies to be installed first.
- No Worker deployment or production DNS/secret changes were performed.

## Follow-up split-path verification

- Movie child pin advanced to `ef0b75722b94e45fd409b36f1fa526e49da01f25` and
  was pushed to `shovelshit/movie`.
- `desktop/test/support/web.cjs` now serves Movie assets from the child and
  Store assets from the parent checkout when `TOOLS_REPO_ROOT` is provided;
  standalone child runs remain independent.
- `claim-integration.cjs` resolves parent Worker fixtures and built assets via
  `TOOLS_REPO_ROOT`; parent Electron CI supplies it and runs the integration
  only after dependency installation and asset build.
- Added a child path-resolution test and made the UI fixture's show date and
  inferred target date relative to the current Beijing date, preserving the
  real-show/inferred-show distinction.
- Focused checks passed: path-resolution 1/1, claim integration (all PASS
  checkpoints), Store UI E2E, and Movie UI E2E. Movie UI E2E completed with
  the option-900 inferred-seat assertions and screenshots.
