# Admin 运营看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Admin 管理页增加电影监控运营看板，以只读 D1 聚合展示用户、影院、通知、锁座和系统健康状态。

**Architecture:** 新增一个经过 Admin 鉴权的 Dashboard API，使用一次只读 D1 查询批次返回固定响应；Admin 页面新增独立看板视图和专用前端模块，复用现有登录态、Worker 地址、深色样式与错误提示。看板不写入 D1、KV 或 Durable Object，不修改 Electron 页面或客户端版本。

**Tech Stack:** Cloudflare Worker、D1 SQLite、原生 JavaScript、现有 `admin.html`/`admin.js`/`style.css`、Node test runner。

## Global Constraints

- 只允许 `businessLine=maoyan`，不得混入 `store` 数据。
- Dashboard API 只执行 `SELECT`，不新增表、迁移、埋点、KV 写入或定时写入。
- 认证复用现有 `X-Admin-Token` Admin 会话；非管理员返回现有未授权响应。
- 失败详情使用现有截断/脱敏字段，不返回 Cookie、签名、通知秘钥、访问密钥。
- 默认时间窗口为 `24h`；前端不使用 `setInterval` 轮询。
- 结果为空时返回 0 或 null，不因缺少 `lock_rule`、通知或影院批次而失败。

---

### Task 1: 只读 Dashboard 查询接口

**Files:**
- Modify: `worker/src/maoyan/account-api.js`
- Modify: `worker/src/maoyan/index.js` 或实际 Admin 路由注册文件（沿用当前 `handleAdminAccountApi` 注册位置）
- Create: `worker/src/maoyan/dashboard.js`
- Test: `worker/test/account-admin.test.js` 或新增 `worker/test/dashboard.test.js`

**Interfaces:**
- Produces: `GET /api/admin/dashboard?businessLine=maoyan&window=24h`
- Produces: `{ generatedAt, window, summary, users, cinemas, notifications, health }`，字段见设计文档。

- [ ] **Step 1: 写失败测试**：用内存 D1 测试夹具插入一个有效监控用户、一个已撤销用户、成功/失败/待发送通知、当前锁座规则和两个影院批次；断言已撤销用户不计入，成功率只使用 24 小时内 `sent/failed`，无分母返回 `null`。
- [ ] **Step 2: 运行测试确认失败**：`npm --prefix worker test -- dashboard.test.js`，预期接口不存在或返回 404。
- [ ] **Step 3: 实现 `readAdminDashboard(DB, { businessLine, window, nowMs })`**：校验 `businessLine === 'maoyan'` 和 `window === '24h'`；用一批参数化 SQL 查询汇总 `users`、`monitor_subscriptions`、`notification_outbox`、`lock_rule`、`cinema_batches`、`cinema_events`；将 JSON 字段解析失败转为 null，不让一行脏数据拖垮整页。
- [ ] **Step 4: 注册路由**：在现有 Admin 鉴权之后调用查询函数；设置 `Cache-Control: no-store`；禁止任意表名、字段名、SQL 或未经允许的窗口参数进入查询。
- [ ] **Step 5: 运行接口测试确认通过**：同一命令应覆盖管理员成功、非管理员拒绝、业务线隔离、空数据和异常 JSON。
- [ ] **Step 6: 提交**：`git add worker/src/maoyan/account-api.js worker/src/maoyan/dashboard.js worker/test/dashboard.test.js && git commit -m "feat: add read-only admin dashboard API"`

### Task 2: Admin 看板结构和视图切换

**Files:**
- Modify: `pages/maoyan/admin.html`
- Modify: `pages/maoyan/admin.js`
- Create: `pages/maoyan/admin-dashboard.js`
- Modify: `pages/maoyan/style.css`
- Test: `pages/maoyan/admin.test.cjs`

**Interfaces:**
- Consumes: `adminApi('/api/admin/dashboard?businessLine=maoyan&window=24h')`。
- Produces: `window.adminDashboard` 或模块函数 `createAdminDashboard({ root, request, renderError })`，不直接读取管理令牌。

- [ ] **Step 1: 写失败页面测试**：断言 Admin 有“运营看板”入口、指标卡容器、用户/影院/通知/健康区块，且看板没有任何 `setInterval`。
- [ ] **Step 2: 运行页面测试确认失败**：`node --test pages/maoyan/admin.test.cjs`，预期找不到看板结构。
- [ ] **Step 3: 增加 HTML 结构**：新增看板视图容器、返回账号管理按钮、刷新按钮、6 个指标卡、用户监控表、影院排行表、通知状态区、系统健康区；默认进入账号管理，不改变现有登录流程。
- [ ] **Step 4: 实现 `admin-dashboard.js`**：只接收已认证的 `request` 回调；将响应写入 `textContent`；按 `generatedAt` 显示数据时间；处理空数组、null 成功率和失败响应；刷新期间禁用按钮，失败时只显示看板错误。
- [ ] **Step 5: 接入 `admin.js`**：登录成功后保留当前账号页，点击看板时读取一次；切换业务线时隐藏看板入口或清空电影看板，防止显示 Store 数据；退出登录清除看板内容。
- [ ] **Step 6: 运行页面测试确认通过**：覆盖加载成功、空数据、401、500、重复点击刷新和返回账号页。
- [ ] **Step 7: 提交**：`git add pages/maoyan/admin.html pages/maoyan/admin.js pages/maoyan/admin-dashboard.js pages/maoyan/style.css pages/maoyan/admin.test.cjs && git commit -m "feat: add admin operations dashboard"`

### Task 3: 可读性、移动布局和安全回归

**Files:**
- Modify: `pages/maoyan/style.css`
- Modify: `pages/maoyan/admin.test.cjs`
- Modify: `desktop/test/ui-e2e.cjs`（仅若现有 Admin 验收入口可复用）
- Modify: `README.md`（管理员功能说明）

- [ ] **Step 1: 写失败布局测试**：在 390px 和桌面宽度下断言看板不产生水平溢出，指标卡不被压扁，表格可横向滚动，长失败响应不会撑开页面。
- [ ] **Step 2: 运行测试确认失败**：`node --test pages/maoyan/admin.test.cjs`。
- [ ] **Step 3: 实现样式**：复用 `.admin-toolbar`/`.admin-table-panel`，增加紧凑指标网格、异常色阶、更新时间和移动端单列布局；不增加独立主题或客户端资源。
- [ ] **Step 4: 补文档**：说明看板是管理员只读视图、统计窗口为 24 小时、数据来自现有表、不会写入 D1，并列出空数据和延迟含义。
- [ ] **Step 5: 运行回归**：`node --test pages/maoyan/*.test.cjs`、`npm --prefix worker test`、`npm --prefix desktop run test:e2e -- --output /tmp/maoyan-admin-dashboard`。
- [ ] **Step 6: 提交**：`git add pages/maoyan/style.css pages/maoyan/admin.test.cjs desktop/test/ui-e2e.cjs README.md && git commit -m "test: verify admin dashboard layout and isolation"`

### Task 4: 集成验收和发布检查

**Files:**
- No new production files; review all files from Tasks 1–3.

- [ ] **Step 1: 运行完整测试**：`node --experimental-sqlite --test --test-reporter=dot pages/maoyan/*.test.cjs worker/test/*.test.js desktop/test/*.test.cjs`。
- [ ] **Step 2: 运行 Worker 静态资源构建**：`npm --prefix worker run build:assets`，确认 Admin 页面和新脚本进入 Worker `public`。
- [ ] **Step 3: 运行真实浏览器验收**：登录 Admin，打开看板、刷新、切换账号管理；确认 Network 只有只读 Dashboard 请求且没有写请求。
- [ ] **Step 4: 运行 Electron 冒烟**：`npm --prefix desktop run test:smoke`，确认客户端页面和版本包不增加看板资源。
- [ ] **Step 5: 复核差异**：`git diff --check`、确认没有迁移文件、D1 INSERT/UPDATE/DELETE、`setInterval` 或敏感字段输出。
- [ ] **Step 6: 集成提交**：由维护者在所有验收通过后合并任务提交；本功能不修改客户端版本和 Electron 构建流程。

## 后续看板候选

不放入第一版的扩展按优先级排序：

1. 7/30 天趋势：监控用户、影院场次、通知成功率、锁座成功率。
2. 猫眼接口质量：`cinemaDetail`、座位图、`createOrder` 的 400/403/5xx、延迟和成功率。
3. 锁座耗时：排片发现到下单、下单到通知的分位数。
4. 通知渠道对比：Bark 与 Server酱成功率、失败原因、重试积压。
5. 资源容量：Cron 批次耗时、活跃影院数、通知队列峰值、Durable Object 执行量。
6. 用户生命周期：到期用户、续期率、暂停/撤销变化、名额释放预测。
7. 异常影院：情侣座/座位图异常反馈、重复失败影院和最近反馈趋势。

这些扩展仍应优先使用现有事件和 outbox 数据；只有现有数据无法支持长期趋势时，才单独评估离线汇总表，不在请求期间写入 D1。
