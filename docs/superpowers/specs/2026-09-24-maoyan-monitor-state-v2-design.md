# 猫眼单活跃用户监控状态化重构设计

设计日期：2026-09-24（北京时间）

状态：待实施。当前只保留一个活跃监控用户；旧监控历史可以舍弃，但该用户当前的影院、监控基线、等待中的锁座规则和未发送通知必须保留。

## 目标

将猫眼监控从“每次扫描保存一个永久批次”改成“每个影院一条当前状态和一条可恢复的活跃运行记录”，停止无变化扫描产生永久 `cinema_batches` 行和完整场次 JSON，同时保留失败重试使用固定输入的能力。

## 范围

- 保留当前活跃用户的 `user_config`、`monitor_subscriptions`、`lock_rule` 和未发送通知。
- 为每个影院保存一份当前规范化场次和最多一份活跃重试场次。
- 订阅通知基线、锁座检查和本轮完成状态分开处理。
- 旧的批次、影院快照和影院事件历史不迁移。
- 不改猫眼抓取协议、通知渠道、锁座订单流程和用户配置 API。

## 非目标

- 不保留监控批次审计历史。
- 不迁移已发送通知和旧 `change_log`，除非管理后台明确需要最近历史。
- 不在本次切换中引入 KV/R2 等外部正文存储。
- 不通过提高并发改变猫眼上游请求频率。

## 新数据模型

新增 `cinema_state`，每个影院一行：

```sql
CREATE TABLE cinema_state (
  cinema_id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  current_hash TEXT,
  current_data TEXT,
  active_run_id TEXT,
  active_base_version INTEGER,
  active_base_hash TEXT,
  active_data TEXT,
  active_version INTEGER,
  run_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (run_state IN ('idle', 'processing', 'retryable', 'completed')),
  subscriber_cursor TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_until INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_cinema_state_active
  ON cinema_state(run_state, lease_until, cinema_id);
```

给 `monitor_subscriptions` 增加当前运行完成标记：

```sql
ALTER TABLE monitor_subscriptions ADD COLUMN last_run_id TEXT;
CREATE INDEX idx_monitor_subscriptions_run
  ON monitor_subscriptions(cinema_id, last_run_id, next_due_at, user_id);
```

`last_run_id` 用于中断恢复。一次运行中已完成的用户不会重复处理；未完成的用户在同一个 `active_run_id` 重试时仍会被选出。更新时必须继续校验 `config_version`、影院和启用状态。

保留的现有表：

- `users`
- `user_config`
- `monitor_subscriptions`
- `lock_rule`
- `notification_outbox`
- `change_log`

停用并删除旧监控历史表：

- `cinema_batches`
- `cinema_snapshots`
- `cinema_events`

## 运行流程

1. 影院 Durable Object 创建或恢复 `active_run_id`。如果已有 `processing/retryable` 运行，继续使用其输入，不重新抓取。
2. 首次运行读取 `current_data/current_hash`，抓取影院场次，规范化会影响通知和锁座的字段并计算 SHA-256 hash。
3. 将本轮数据写入 `active_data`，保存 `active_base_hash`、`active_version` 和 `run_state='processing'`。内容未变化时 `active_version` 保持当前版本，但本轮仍然检查锁座和推进检查时间。
4. 按 `next_due_at <= started_at`、`last_run_id IS NULL OR last_run_id <> active_run_id` 分页读取订阅者。每个用户先按配置版本做 CAS，再产生通知，检查等待中的锁座规则，锁座交接明确成功或进入自身终态后写入 `last_run_id` 和 `next_due_at`。
5. 通知基线只有在内容版本确实前进时更新；内容版本不变不能跳过锁座检查。
6. 页面和用户处理全部完成后，将 `active_data/active_hash/active_version` 提升为 `current_data/current_hash/current_version`，清空活跃字段并将运行标记为 `completed`。提交前不得删除活跃输入。
7. 运行失败时保留 `active_data`、游标和尝试次数，设置 `retryable` 与租约；重试读取同一个输入。若配置在运行中变化，CAS 使旧运行跳过该用户，不覆盖新配置。

## 迁移方案

切换前暂停监控 cron 和 dispatcher，等待正在执行的影院运行结束。无法确认已完成的旧批次不直接丢弃，使用其最新 `public_data` 作为 `active_data`，标记为 `retryable`。

对当前仍启用的用户：

1. 从 `monitor_subscriptions` 读取影院、配置版本、启用状态和 `next_due_at`。
2. 从该影院 `cinema_batches` 按 `captured_at` 取最新完整 `public_data`。若不存在，创建 `current_version=0`、`current_data=NULL` 的状态，第一次扫描只建立基线。
3. 对规范化数据计算 `current_hash`，用旧批次 `version` 作为 `current_version`，写入 `cinema_state`。
4. 将订阅的 `baseline_version` 设置为当前版本，`last_run_id` 置空，保留原 `next_due_at`。
5. 保留 `lock_rule` 原行。`matching` 状态的规则必须等当前操作结束后再切换；不能无条件重置为等待状态，否则可能重复下单。
6. 保留 `notification_outbox` 中 `pending/sending/failed` 的行；已发送通知和旧 `change_log` 可清空。
7. 校验启用订阅数、锁座规则数、未发送通知数和迁移后的影院数量，再删除旧监控历史表。

若当前没有可迁移的最新批次，则新架构第一次扫描建立基线，不发送历史场次通知。

## 清理和保留

新模型没有按扫描追加的永久批次。`cinema_state` 只保留当前正文和活跃正文，运行成功后清理活跃字段。`notification_outbox` 继续保留待发送和失败消息；已发送消息按现有业务保留期清理。`change_log` 只在仍需要用户历史时保留最近记录。

## 性能目标

以一个影院、20 个订阅为例：

| 指标 | 当前实现 | 新模型目标 |
| --- | ---: | ---: |
| 无变化扫描新增永久行 | 1 条 `cinema_batches` | 0 条 |
| 无变化扫描新增完整 JSON | 1 份 | 0 份 |
| 每个影院保留的场次正文 | 多个历史批次 | 当前 1 份，活跃重试最多 1 份 |
| 新批次提交后的重复回读 | 3 次查询 | 0 次完整批次回读 |
| 新批次读查询 | 约 27 次 | 约 24 次；按页批量推进后目标 4～8 次 |
| 上游影院抓取次数 | 1 次 | 1 次 |

新场次发生时，每个用户的 `change_log` 和 `notification_outbox` 仍然各写一条，不能为了减少存储而合并用户通知事实。

## 风险和控制

- **重复通知**：迁移时将最新版本写入 `baseline_version`；通知使用现有 `event_key` 去重。
- **中途失败漏锁座**：`last_run_id` 不与 `next_due_at` 混用，锁座检查不依赖通知版本是否变化。
- **重复下单**：保留规则 ID、Durable Object 串行和终态检查；外部调用成功但完成写入失败时，重试必须先读取规则状态。
- **配置竞争**：用户配置版本、影院和启用状态继续作为 CAS 条件。
- **切换期间丢通知**：暂停 dispatcher 后只保留未发送出箱；切换校验通过后再恢复发送。
- **回滚**：切换前导出保留用户状态和未发送出箱；新表验证失败时恢复旧 Worker 和旧监控表，不依赖被清理的历史批次。

## 验收标准

- 当前用户、影院和锁座规则迁移后仍存在。
- 迁移前已有场次不会重复通知。
- 下一轮新增场次只产生一次通知。
- 无变化扫描不新增永久批次行，也不重复写完整 JSON。
- 处理订阅者中途失败后，同一运行可以继续，已完成用户不重复发送通知。
- 内容版本不变时仍检查等待中的锁座并推进下次检查时间。
- 未发送通知不丢失，旧已发送历史可按选择清理。
- 监控、调度器、锁座和通知相关测试全部通过。
