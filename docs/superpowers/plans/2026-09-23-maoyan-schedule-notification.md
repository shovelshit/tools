# 猫眼业务时间与实时通知 Implementation Plan

计划日期：2026-09-23（北京时间）。改动范围：猫眼 Worker 的调度、通知出箱与 DO、管理员业务窗口配置、用户端时段展示、D1 加法迁移及相关测试和部署文档；Store 业务和锁座下单规则不在范围内。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用单个三分钟业务 cron 和管理员配置的业务窗口隔离监控与账号维护，并让新场次、锁座终态和座位反馈在持久化后立即、互不阻塞地尝试推送。架构已于 2026-09-23 经用户人工复核，同意进入开发；生产迁移和发布不属于本次代码推送。

**Architecture:** 沿用现有 `tools-api` Worker、D1 出箱与 `NOTIFICATION_DISPATCHER` DO 类。D1 保存业务时间配置和消息事实，DO 协调即时发送及重试。管理员后台配置北京时间监控与维护窗口；紧急出箱按 `(kind,userId)` 唤醒不同 DO 实例，仅账号到期提醒由独立维护窗口 DO 发送。设计与两张流程图见 [架构说明](../specs/2026-09-23-maoyan-schedule-notification-design.md)。

**Tech Stack:** Cloudflare Workers、SQLite D1、Durable Objects alarm、ES modules、Node.js `node:test`、Wrangler。

## Global Constraints

- 先请用户人工复核架构说明中的默认时段、管理员可配置规则、三十分钟边界与座位反馈即时发送；未获批准不开始实现。
- 当前工作区已有未提交的第二条每日 cron、单 DO 优先级和对应测试草稿。逐段理解并替换冲突内容，不重置或覆盖无关改动。
- `*/3 * * * *` 是唯一业务 cron；猫眼策略初始监控 `[07:00,23:00)`、维护 `[01:00,02:00)`，管理员可在后台修改，按 `Asia/Shanghai` 半开区间判断，无需修改 cron。
- 已在监控窗口接纳的批次可以跨窗完成；`new-shows`、`lock-terminal`、`seat-feedback` 全天发送、全天重试，不重新按当前监控窗口拦截。
- 账号到期的即时资格判断不依赖维护运行；前一自然日提醒不能在错过后伪装补发，续期、撤销时不得发送过时提醒。
- 通知失败不能重复创建订单；出箱保留事件键唯一约束、敏感数据脱敏和租约领取。只有可控的入队/领取为幂等，外部渠道不承诺精确一次。
- 生产 D1 必须保留原数据，先执行加法 SQL 迁移再部署兼容代码；不得重建生产数据库。

---

### Task 1: 单 cron、管理员业务时间配置

**Files:**
- Create: `worker/src/maoyan/business-time.js`、`worker/src/maoyan/business-policy-store.js`、`worker/sql/maoyan-business-policy.sql`。
- Modify: `worker/schema.sql`、`worker/src/maoyan/cron.js`、`worker/src/index.js`、`worker/src/maoyan/account-api.js`、`worker/src/maoyan/status-api.js`、`worker/public/maoyan/admin.html`、`worker/public/maoyan/admin.js`、`worker/public/maoyan/app.js`、`worker/wrangler.toml`、`worker/wrangler.example.toml`。
- Test: `worker/test/cron-window.test.js`、`worker/test/scheduled-routing.test.js`、`worker/test/business-policy.test.js`（新建）、`worker/test/account-admin.test.js`。

**Interfaces:** `readBusinessPolicy(DB)` 返回数据库当前版本的北京时间窗口；`businessTime(nowMs, policy)` 返回 `{ localDate, monitorOpen, maintenanceOpen }`；`nextMaintenanceStart(nowMs, policy)` 返回严格晚于 `nowMs` 的时间戳。`scheduled` 以实际开始时间和策略确定能否接受新批次，`scheduledTime` 只用于批次身份。

  ```js
  const actualNowMs = Date.now();
  const policy = await readBusinessPolicy(env.DB);
  const { monitorOpen, maintenanceOpen } = businessTime(actualNowMs, policy);
  // event.scheduledTime 只参与 batchId，不参与窗口准入或维护业务日期。
  ```

- [ ] 写失败测试：默认北京时间 06:59/07:00、22:59/23:00、00:59/01:00、01:59/02:00 分别断言半开窗口；管理员修改后的 22:00-次日 02:00 监控、03:00-04:00 维护互不冲突，延迟到达的 22:59 计划触发仍以实际窗口准入。维护窗口禁止跨自然日及与监控重叠。
- [ ] 运行 `cd worker && node --test test/cron-window.test.js test/scheduled-routing.test.js`，确认新断言在当前双 cron/固定字符串分流下失败。
- [ ] D1 新库与旧库加法脚本均创建单行 `maoyan_business_policy`，字段为四个起止分钟、`version`、`updated_at`，默认 07:00-23:00 与 01:00-02:00。只通过已鉴权管理员 API 读取/修改；按 `expectedVersion` 条件更新并写审计事件，校验分钟范围、窗口不重叠、维护窗口至少包含一个三分钟触发点；错误设置拒绝保存，不以旧缓存悄悄运行。
- [ ] 管理后台猫眼业务设置增加两个时段输入和独立保存操作，其他业务线不展示。保存后显示当前生效值及版本，冲突时刷新并明确报错；用户端监控时间文案改由当前策略生成，不再写死 07:00-22:59。保存设置立即 wake routine DO 重算 alarm；窗口当下开放时积压提醒可发送，新维护任务由下个 cron 处理。
- [ ] 调度入口先读 D1 当前策略并按实际时间决定窗口，监控只派发影院批次，维护只调用维护入口；无对应业务时不执行全表扫描。策略读取失败停止新的定时业务和 routine 并报警，不用硬编码窗口顶替；紧急 DO 不依赖此策略。删除按 `MAINTENANCE_CRON_EXPRESSION` 过滤 Dashboard cron 列表的逻辑，前端监控频率仍报告唯一 cron。
- [ ] 把两个 Wrangler 模板的 `triggers.crons` 精确改成 `["*/3 * * * *"]`；验证策略变更对下一 cron 立即生效、在途批次完成、routine alarm 迁移及版本冲突，再运行聚焦测试和 `npx wrangler deploy --dry-run`，核对 DO 绑定仍在。

### Task 2: 可续跑的账号维护与自然日前提醒

**Files:**
- Create: `worker/src/maoyan/maintenance-store.js`、`worker/sql/maoyan-maintenance-checkpoint.sql`。
- Modify: `worker/src/maoyan/tokens.js`、`worker/src/maoyan/user.js`、`worker/schema.sql`。
- Test: `worker/test/tokens.test.js`、`worker/test/maintenance-store.test.js`（新建）。

**Interfaces:** `runScheduledMaintenance(env, nowMs)` 每次只处理有界分页；`claimMaintenanceDay(DB, {job, localDate, nowMs})`、`saveMaintenanceCursor(...)` 和 `completeMaintenanceDay(...)` 用 D1 条件更新控制同日租约。业务日期由 Task 1 的时间策略给出。

- [ ] 写失败测试：同一天多次触发只生成一组事件；分页中途失败由下一 tick 接续；跨日期不沿用旧完成标记；后天 00:10 到期的账号在前一天 01:00 收到 `one-day`，而非按剩余 24 小时遗漏。
- [ ] 再加发送边界测试：`one-day` 当天待发送则允许，下一自然日仍 pending 则标记过时且不推送；默认窗口中 01:03 维护失败、01:06 续跑仍能提醒；整日前一日没有成功维护时暴露漏发，账号真正过期后的下一维护窗口只产生 `expired` 事件；配置窗口结束仍未完成的归档/清理持久化游标并在次日续跑，过期提醒不能盖过新日期有效提醒。
- [ ] 运行 `cd worker && node --test test/tokens.test.js test/maintenance-store.test.js` 确认失败；为新库和已有库分别设计同构表：`job_id`、`local_date` 组成主键，另有 `cursor`、`lease_until`、`completed_at`、`updated_at`。已有库脚本只做 `CREATE TABLE IF NOT EXISTS`。

  ```sql
  CREATE TABLE IF NOT EXISTS maoyan_maintenance_runs (
    job_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    cursor TEXT,
    lease_until INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, local_date)
  );
  ```
- [ ] 按 `users.id` 有界分页，整页成功才推进游标，提醒、归档、清理各有独立 `(job, localDate)` 进度，全部页完成才写对应任务当天成功标记。窗口内优先完成今日提醒，再续跑历史未完成的归档、清理和已到期通知；当前配置的维护窗口结束即停止并保留进度/报警，次日继续，不能补发已错过自然日的预提醒。保留现有三天提醒种类、三十天归档条件和撤销清理；`one-day` 使用上海到期日期减一天，事件键仍包含 `userId/expiresAt/stage`。
- [ ] 在维护阶段依据当前 `expires_at` 与本地日期产生正确事件；把发送时再次校验当前期限和阶段有效日交给 Task 3。错过整日前一日时不补发同一标题，记录维护未完成告警并继续执行到期阶段。
- [ ] 运行上述测试及 `cd worker && npm test`；按预期账号规模与管理员配置的窗口长度验证三分钟 tick 有界分页能完成任务，窗口过短或超量显示未完成/报警；窗口外不读取用户全表。

### Task 3: 通知出箱分片和静默准入

**Files:**
- Modify: `worker/src/maoyan/notification-outbox.js`、`worker/src/common/notify.js`、`worker/schema.sql`。
- Create: `worker/sql/maoyan-notification-lanes.sql`。
- Test: `worker/test/notification-outbox.test.js`、`worker/test/notification-dispatcher.test.js`（新建）、`worker/test/notify-channels.test.js`。

**Interfaces:** `wakeNotificationDispatcher(env, {kind, userId})` 使用稳定 DO 名称 `urgent:<kind>:<userId>`；常规消息使用 `routine`。DO 的 wake 请求先持久化通道身份及备用 alarm，再直接启动串行化的 drain 并快速确认；`alarm()` 负责恢复和到期重试，不能作为正常首次尝试的唯一启动点。`deliverOutbox(env, {lane, nowMs, limit, send})` 仅领取本通道允许的行，分别以 `pending.next_attempt_at` 和 `sending.lease_until` 查询到期消息。

- [ ] 写失败测试：100 条慢新场次不阻塞另一用户的锁座或管理员反馈；`wake` 在模拟渠道请求尚未完成时已经返回、首次发送已开始；同一事件重复 wake 只领取一次；监控关窗后的 urgent 继续首次发送及重试；用户反馈在维护窗口外仍立即尝试；到期提醒在配置窗口外绝不发送，下一 alarm 指向新配置的维护窗口而不是每秒唤醒。
- [ ] 运行 `cd worker && node --test test/notification-outbox.test.js test/notification-dispatcher.test.js` 确认失败；新库和旧库迁移均为紧急用户分片与全局 routine 建立独立的 pending/租约索引，保留现有 due 索引和 `event_key` 唯一约束。

  ```sql
  ALTER TABLE notification_outbox ADD COLUMN detected_at INTEGER;
  ALTER TABLE notification_outbox ADD COLUMN first_attempt_at INTEGER;
  ALTER TABLE notification_outbox ADD COLUMN sent_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_notification_outbox_lane
    ON notification_outbox(user_id, kind, state, next_attempt_at, id);
  CREATE INDEX IF NOT EXISTS idx_notification_outbox_lane_lease
    ON notification_outbox(user_id, kind, lease_until, id) WHERE state='sending';
  CREATE INDEX IF NOT EXISTS idx_notification_outbox_routine
    ON notification_outbox(kind, state, next_attempt_at, id);
  CREATE INDEX IF NOT EXISTS idx_notification_outbox_routine_lease
    ON notification_outbox(kind, lease_until, id) WHERE state='sending';
  ```
- [ ] 迁移脚本的三条 `ALTER` 只对确认缺列的现有库执行一次；先通过 `PRAGMA table_info(notification_outbox)` 检查，已执行过的脚本不重放。新库 `schema.sql` 直接含同名字段，历史行保持 NULL。
- [ ] 将 `lock-terminal`、`new-shows`、`seat-feedback` 定为全天可发送的独立紧急通道；仅 `account-expiry` 进入维护窗口通道。领取用 D1 条件更新及现有租约；验证消息仍有效之后、调用渠道之前以 `COALESCE(first_attempt_at, nowMs)` 记录第一次发送尝试；成功写 `sent_at`，失败不改该字段。发送前再次检查账号当前期限、提醒阶段对应的本地日期及订阅版本，过时消息不发送。失败继续使用有界重试；收到 `429` 时尊重渠道 `Retry-After` 并保留脱敏错误。
- [ ] DO `fetch` 在持久化目标身份及备用 alarm 后调用互斥 drain Promise，但不等待网络发送才返回。DO 的未完成 I/O 维持执行；`waitUntil` 在 DO 不延长生命周期。Promise 失败必须捕获、记录脱敏错误并重新设 alarm。routine 领取前读 D1 最新策略，窗口外接到 wake 或管理员保存策略时重算下一允许 alarm，不开始渠道调用。
- [ ] 发送结束后按本通道最早可发送时刻设置 alarm；routine 窗口外对到期行使用 `nextMaintenanceStart(nowMs, policy)`，urgent 不以业务窗口延迟。旧 `main` DO 可停止旧 alarm，但不得删除出箱消息，`sending` 行在租约到期后由新通道接手。routine 仅查询 `kind='account-expiry'`，将 pending 与 sending 分开读取再合并排序。
- [ ] 运行聚焦测试、`cd worker && npm test`；用 `EXPLAIN QUERY PLAN` 和 D1 `rows_read` 验证紧急分片及全局 routine 的领取查询都使用对应索引，不随所有 pending 行线性增加。

### Task 4: 事件产生后立即唤醒

**Files:**
- Modify: `worker/src/maoyan/monitor-coordinator.js`、`worker/src/maoyan/monitor-store.js`、`worker/src/maoyan/check.js`、`worker/src/maoyan/db.js`、`worker/src/maoyan/lock-runner.js`、`worker/src/maoyan/lock-rule.js`、`worker/src/maoyan/seat-feedback.js`。
- Test: `worker/test/monitor-coordinator.test.js`、`worker/test/tokens.test.js`、`worker/test/lock-runner.test.js`。

**Interfaces:** 每个已提交的新场次通知携带 `(kind="new-shows",userId)` 唤醒；锁座终态事务提交后唤醒 `(kind="lock-terminal",userId)`；反馈记录与出箱提交后唤醒 `(kind="seat-feedback",userId=ADMIN_USER_ID)` 紧急 DO。测试推送继续是用户发起的同步 API，不改造成后台任务。

- [ ] 写失败测试：当锁座模拟阻塞时，新场次已开始发送；两个用户的新场次和锁座互不排队；窗口结束后完成的批次照样唤醒；手动与后备监控路径也不会直推或重复创建同一事件。
- [ ] 运行 `cd worker && node --test test/monitor-coordinator.test.js test/lock-runner.test.js test/tokens.test.js` 确认失败。
- [ ] 在 `advanceSubscriber` 提交后、`runBounded` 开始前唤醒对应订阅用户的新场次 DO。每页可合并同用户同类型的 wake，但不能等锁座处理结束；唤醒只等待快速确认，不能等待实际渠道响应。新场次确认时记录真实 `detected_at`，事务入队时记录真实 `created_at`，不使用计划 cron 时间代替。
- [ ] 让后备 `check.js` 的新增场次写入带稳定事件键的 D1 出箱，含用户、影院、电影、检查批次与场次摘要，覆盖相同编号的场次在不同日期再次出现的情况。快照进度、change log 和通知入队同事务提交；锁座后备路径亦归入终态出箱，绝不因推送失败重做订单。
- [ ] 用户手动座位反馈与管理员通知出箱同事务落 D1，提交后即时 wake 管理员反馈 DO；自动解析失败继续按中国自然日去重、锁座主流程不依赖反馈成功。手动 API 仅在反馈记录及出箱已持久化时返回 `recorded: true`，留档失败给明确错误；外部渠道发送失败时反馈仍留档，出箱按策略重试。增加 `worker/test/seat-feedback.test.js` 与锁座 API 验收：配置窗口外也立即首发、慢新场次不阻塞、失败记录仍可见。保留手动测试推送的同步成功/失败。运行以上测试和 `cd worker && npm test`，核对所有业务生产者已使用统一出箱。

### Task 5: 故障补偿、观测与安全上线

**Files:**
- Modify: `worker/src/index.js`、`worker/src/maoyan/dashboard.js`、`worker/src/maoyan/resource-budget.js`、`worker/DEPLOY-D1.md`。
- Test: `worker/test/cron-window.test.js`、`worker/test/notification-outbox.test.js`、`worker/test/resource-budget.test.js`。

**Interfaces:** 单一业务 cron 只做有界的待唤醒 urgent 补偿；看板展示按消息类型的积压、最老等待时长、最后成功维护日和发现至首发的耗时，不把到期提醒计入影院监控通知。

- [ ] 测试直接唤醒失败但出箱仍待发送、下次 tick 能唤醒；旧 `main` DO 遗留 pending/sending 不丢不双领；外部发送成功后账本写回失败只按至少一次语义重试。
- [ ] 看板和资源摘要只统计有效用户的活跃影院；按通知类型分开显示积压和失败，不把到期提醒归到影院。新通知从 `detected_at/created_at/first_attempt_at/sent_at` 计算发现至首发耗时；旧行 NULL 明确显示未知，不用可变的 `updated_at` 冒充送达时刻。
- [ ] 更新 `DEPLOY-D1.md`：新装库运行完整 `schema.sql`；现有生产库先备份并检查对象，再依次执行业务时间策略、维护进度、通知通道三份加法 SQL 迁移，验证索引、策略初始值和表后才部署；不得以重建数据库替代迁移。
- [ ] 运行 `cd worker && npm test`、`git diff --check`、`cd worker && npx wrangler deploy --dry-run`。用固定时间与模拟慢渠道演练跨窗、批次并发、迁移接管和免费配额计数；记录结果供独立 tester 与 acceptance agent 审核。
- [ ] 人工复核通过后才安排真实部署和推送；部署时先迁移 D1，验证现有 pending 数，再发布 Worker，确认通知成功率、维护成功日、DO 请求/时长及 D1 读写没有异常增长。

## Review Gate

用户已审阅 [架构说明](../specs/2026-09-23-maoyan-schedule-notification-design.md) 并于 2026-09-23 指示开始开发。此复核针对架构和代码实现，不等同于授权生产 D1 迁移或 Worker 发布。
