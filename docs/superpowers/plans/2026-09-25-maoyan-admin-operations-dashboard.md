# 猫眼运营监控看板重新设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有管理后台样式中实现面向排障的猫眼运营监控工作台，补充用户监控内容、影院运行态和可点击通知详情。

**Architecture:** Worker 在 `dashboard.js` 中一次读取用户配置、`cinema_state`、订阅、锁座规则和通知出箱，返回稳定的看板 DTO；通知详情通过同一管理员鉴权链路提供独立只读接口。前端沿用 `admin.html`、`admin-dashboard.js` 和 `style.css` 的既有结构，将用户/影院表改为全宽、状态异常优先，并用安全的 DOM 文本节点渲染展开行和通知抽屉。

**Tech Stack:** Cloudflare Workers ES modules、D1 SQLite、原生 HTML/CSS/JavaScript、Node.js `node:test`。

## Global Constraints

- 不修改猫眼抓取协议、通知渠道、锁座订单接口和用户配置 API。
- 不引入前端框架或自动轮询；看板继续使用显式刷新。
- 所有动态通知内容使用纯文本节点渲染，不执行 HTML。
- 所有通知详情必须按 `businessLine` 隔离，不能返回通知凭证或完整原始数据库行。
- 影片场次摘要每部最多返回 5 条，保留完整 `showCount` 和 `hasMoreShows`。
- 保持现有深色玻璃面板、表格、状态色和响应式布局约定。
- 页面错误、空数据和数据解析失败必须局部降级，不得导致整个看板不可渲染。

---

### Task 1: Extend the dashboard data contract

**Files:**
- Modify: `worker/src/maoyan/dashboard.js`
- Modify: `worker/test/dashboard.test.js`

**Interfaces:**
- `readAdminDashboard(DB, options)` continues to return `{ generatedAt, window, summary, users, cinemas, notifications, health, seatFeedback }`.
- `summary` adds `monitoredMovies`, `currentShows`, `attentionCinemas`, and `pendingNotifications`.
- `users[].monitorContent` contains selected movie summaries and at most five earliest shows per movie.
- `cinemas[]` contains `movieCount`, `showCount`, `runState`, `activeRunId`, `attemptCount`, and `stale`.

- [ ] **Step 1: Add failing dashboard tests for selected movie aggregation.**

  Seed `user_config.data` with `selectedMovieIds: ["101", "202"]`, seed `cinema_state.current_data` with three movies and multiple shows, and assert that `readAdminDashboard` returns only the selected movies, the correct full `showCount`, at most five `nextShows`, and `hasMoreShows` when more than five shows exist.

- [ ] **Step 2: Run the focused dashboard tests and confirm the new assertions fail.**

  Run: `cd worker && node --experimental-sqlite --test test/dashboard.test.js`

  Expected: existing tests may pass, while the new fields are absent and the new assertions fail.

- [ ] **Step 3: Add dashboard parsing helpers and enrich the user query.**

  Select `c.data AS config_data` and the required `cinema_state` run fields in `readUsers`. Parse `selectedMovieIds` defensively, parse `current_data` defensively, map selected IDs to movie names and normalized shows, sort shows by date/time/sequence, and return the first five show records. Fall back to the movie ID when no name is available.

- [ ] **Step 4: Enrich cinema rows and summary values from the same parsed state.**

  Build one cinema-state map for the dashboard request, count movies and shows from `current_data`, expose `runState`, `activeRunId`, and `attemptCount`, and calculate `stale` from `nextDueAt` and the current monitoring interval. Compute the four new summary counters from the same active subscriptions and state map instead of adding per-row queries.

- [ ] **Step 5: Run the focused dashboard tests and inspect the DTO.**

  Run: `cd worker && node --experimental-sqlite --test test/dashboard.test.js`

  Expected: all dashboard tests pass, with no JSON parse error for malformed or missing `user_config` and `cinema_state` data.

- [ ] **Step 6: Commit the data contract.**

  ```bash
  git add worker/src/maoyan/dashboard.js worker/test/dashboard.test.js
  git commit -m "feat: enrich maoyan operations dashboard data"
  ```

### Task 2: Add the authenticated notification detail API

**Files:**
- Modify: `worker/src/maoyan/dashboard.js`
- Modify: `worker/src/maoyan/account-api.js`
- Modify: `worker/test/dashboard.test.js`
- Test: `worker/test/account-admin.test.js`

**Interfaces:**
- `readAdminNotification(DB, { id, businessLine })` returns a bounded detail DTO or `null`.
- `GET /api/admin/notifications/:id?businessLine=maoyan` returns `{ ok: true, notification }` through the existing admin authentication handler.

- [ ] **Step 1: Add failing tests for notification detail lookup.**

  Seed notifications for two business lines and assert that the requested ID returns title, full bounded content, metadata, user remark, state, attempts, timing, and failure detail only for the requested business line. Assert that a missing ID returns the existing not-found error shape and that invalid IDs are rejected.

- [ ] **Step 2: Run the focused API tests and confirm they fail.**

  Run: `cd worker && node --experimental-sqlite --test test/dashboard.test.js test/account-admin.test.js`

  Expected: the detail reader and route are not available yet.

- [ ] **Step 3: Implement the bounded detail reader.**

  Reuse the existing payload parsing helpers, clamp title/content/error strings, preserve safe metadata values, and omit credential-like keys and raw database columns. Join `users` for the remark and enforce `u.business_line=?` in the query.

- [ ] **Step 4: Add the route and explicit error mapping.**

  Match `/api/admin/notifications/<digits>` before the generic dashboard route, validate `businessLine`, call `readAdminNotification`, return `404` for an absent or cross-business notification, and set `Cache-Control: no-store`.

- [ ] **Step 5: Run the focused API tests and verify business-line isolation.**

  Run: `cd worker && node --experimental-sqlite --test test/dashboard.test.js test/account-admin.test.js`

  Expected: all focused tests pass and cross-business notification IDs cannot be read.

- [ ] **Step 6: Commit the detail API.**

  ```bash
  git add worker/src/maoyan/dashboard.js worker/src/maoyan/account-api.js worker/test/dashboard.test.js worker/test/account-admin.test.js
  git commit -m "feat: add admin notification detail API"
  ```

### Task 3: Rebuild the dashboard structure in the existing visual system

**Files:**
- Modify: `pages/maoyan/admin.html`
- Modify: `pages/maoyan/style.css`
- Modify: `pages/maoyan/admin.test.cjs`

**Interfaces:**
- The page keeps the existing `dashboard-*` IDs used by `admin.js` and `admin-dashboard.js` unless a renamed element is updated in both files.
- User and cinema sections render full-width table containers.
- The notification area exposes status/type selectors and a hidden accessible detail drawer.

- [ ] **Step 1: Add failing structural tests for the redesigned layout.**

  Assert that the page has full-width user and cinema sections, the new user columns for monitored movies and show count, notification filters, a notification detail drawer with close control, and the existing health and seat-feedback sections.

- [ ] **Step 2: Run the admin page tests and confirm the new structure assertions fail.**

  Run: `node --test pages/maoyan/admin.test.cjs`

  Expected: the current two-column layout and missing drawer/filter elements fail the new assertions.

- [ ] **Step 3: Update the HTML structure.**

  Convert user and cinema panels to stacked full-width sections, add the data columns required by the DTO, add notification filter controls, add the notification drawer/overlay with `role="dialog"`, and keep existing admin navigation and resource/account panels unchanged.

- [ ] **Step 4: Update only dashboard-specific CSS.**

  Use the existing CSS variables and panel/table classes, set user/cinema grids to one column, add bounded table overflow, style status text consistently, and add responsive drawer behavior that becomes a bottom sheet on narrow screens. Do not change global account-table behavior.

- [ ] **Step 5: Run the admin page tests and inspect desktop/mobile layout.**

  Run: `node --test pages/maoyan/admin.test.cjs`

  Expected: all structural and existing admin lifecycle tests pass; tables remain bounded on narrow viewports.

- [ ] **Step 6: Commit the structure and styles.**

  ```bash
  git add pages/maoyan/admin.html pages/maoyan/style.css pages/maoyan/admin.test.cjs
  git commit -m "refactor: reshape maoyan admin dashboard layout"
  ```

### Task 4: Implement safe dashboard interactions

**Files:**
- Modify: `pages/maoyan/admin-dashboard.js`
- Modify: `pages/maoyan/admin.test.cjs`

**Interfaces:**
- `createAdminDashboard({ root, request })` keeps the existing `{ load, clear }` return shape.
- User row expansion is local to the loaded dashboard DTO.
- Notification detail uses `request("/api/admin/notifications/<id>?businessLine=maoyan")` and renders the returned DTO as text.

- [ ] **Step 1: Add failing interaction tests.**

  Load the dashboard module in the existing VM harness with a fake root and request callback. Assert that rendering creates an expandable user detail row, notification rows are buttons, selecting a notification calls the detail URL, the drawer renders title/content/error as text, and a `<script>` string in the content remains literal text.

- [ ] **Step 2: Run the focused interaction tests and confirm they fail.**

  Run: `node --test pages/maoyan/admin.test.cjs`

  Expected: current notification paragraphs are not buttons and no drawer/detail request exists.

- [ ] **Step 3: Implement rendering helpers for status, user details, and notifications.**

  Render all dynamic values through `textContent`, add accessible buttons with `aria-expanded`/`aria-controls`, map movie/show data into a compact expandable table, and keep error/empty states local to their section.

- [ ] **Step 4: Implement notification detail lifecycle.**

  Open the drawer from a notification row, show a loading state, request the detail DTO, render success/error states, close on button/overlay/Escape, and restore focus to the triggering row. Do not change notification state from the dashboard.

- [ ] **Step 5: Run the focused interaction tests and verify no unsafe rendering.**

  Run: `node --test pages/maoyan/admin.test.cjs`

  Expected: all admin tests pass, including literal rendering of markup-like notification content and keyboard-close behavior.

- [ ] **Step 6: Commit the dashboard interactions.**

  ```bash
  git add pages/maoyan/admin-dashboard.js pages/maoyan/admin.test.cjs
  git commit -m "feat: add dashboard drill-down interactions"
  ```

### Task 5: Full verification and branch handoff

**Files:**
- Verify: all files changed by Tasks 1-4

- [ ] **Step 1: Run the full Worker test suite.**

  Run: `cd worker && npm test`

  Expected: exit code 0 with no failed tests.

- [ ] **Step 2: Run the admin page test suite.**

  Run: `node --test pages/maoyan/admin.test.cjs`

  Expected: exit code 0 with no failed tests.

- [ ] **Step 3: Run static diff validation.**

  Run: `git diff --check`

  Expected: no whitespace errors.

- [ ] **Step 4: Inspect the final diff and working tree.**

  Run: `git status --short --branch && git diff --stat origin/master...HEAD`

  Expected: only the approved dashboard redesign files and tests are changed; no local generated artifacts are staged.

- [ ] **Step 5: Keep the branch unmerged.**

  Do not merge or push. Report the commits, verification results, and the branch state for the later combined merge.
