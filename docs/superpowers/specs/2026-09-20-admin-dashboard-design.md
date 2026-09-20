# Admin 运营看板设计

## 目标

在现有 Admin 管理页增加电影场次监控运营看板，用只读查询回答当前用户、影院、通知和锁座状态；不改 Electron 客户端，不增加 D1 写入，不新增统计表。

## 范围

第一版只支持 `maoyan` 业务线，数据窗口为当前状态和最近 24 小时。管理员登录态复用现有 `X-Admin-Token` 与 Admin Worker 地址，不引入第二套认证。

看板包含：

- 指标卡：有效用户、监控中用户、活跃影院、通知成功率、锁座成功数、锁座失败数。
- 用户监控表：用户/备注、影院、监控状态、最近检查、当前锁座状态、最近通知状态。
- 影院排行：影院、监控用户数、近 24 小时新增场次、通知数、锁座成功/失败数。
- 通知与锁座异常：待发送、发送中、最终失败、最近失败原因和 HTTP 响应摘要。
- 系统健康：最近影院批次时间、通知队列积压、数据更新时间；没有数据时显示明确的“暂无数据”。

## 数据原则

Dashboard API 只执行 `SELECT`，不写入 D1、KV 或 Durable Object。统计直接聚合 `users`、`monitor_subscriptions`、`notification_outbox`、`lock_rule`、`cinema_batches`、`cinema_events`；锁座终态以 `notification_outbox.kind='lock-terminal'` 的事件记录为历史来源，当前状态以 `lock_rule` 为准。

所有用户、影院和失败详情均按当前管理员权限返回；HTTP 响应正文沿用现有截断和脱敏约束，不返回 Cookie、签名、通知秘钥或访问密钥。

## 接口

新增 `GET /api/admin/dashboard?businessLine=maoyan&window=24h`，复用现有 Admin 鉴权。响应固定为：

```json
{
  "ok": true,
  "generatedAt": 0,
  "window": "24h",
  "summary": {
    "activeUsers": 0,
    "monitoringUsers": 0,
    "activeCinemas": 0,
    "notificationSuccessRate": null,
    "lockSuccess": 0,
    "lockFailed": 0
  },
  "users": [],
  "cinemas": [],
  "notifications": { "pending": 0, "sending": 0, "failed": 0, "recent": [] },
  "health": { "latestBatchAt": null, "oldestPendingNotificationAt": null }
}
```

查询使用明确的 `business_line='maoyan'`、有效账号条件和 24 小时边界；接口不接受任意 SQL、表名或排序字段。响应设置 `Cache-Control: no-store`，前端只在登录、手动刷新、切换到看板时读取，不使用定时轮询。

## 页面

Admin 顶部增加“运营看板”入口，与账号管理并列。看板默认折叠异常详情，表格使用现有深色样式和移动端横向滚动规则。看板刷新失败只影响看板区域，不退出登录、不清空账号列表；显示“读取失败”和重试按钮。

## 性能与演进

首版使用一次 D1 batch/read 查询返回所有模块，限制排行和最近异常各 20 条；不增加写放大。若数据量增长，下一步只增加索引或把查询拆成只读接口，不在请求期间写汇总数据。长期趋势可后续基于已有事件表离线汇总，不作为本期范围。

## 验收

- 非管理员不能访问接口，业务线不为 `maoyan` 的账号不会混入看板。
- 全部计数在空数据、只有失败通知、只有待发送通知、无当前锁座规则时返回 0/null 而不是报错。
- 通知成功率分母只统计最近 24 小时已完成的 `sent` 和最终 `failed`，无分母时为 `null`。
- 当前锁座状态来自 `lock_rule`，历史成功/失败来自终态通知事件，失败详情使用 textContent 渲染。
- 单元测试覆盖 SQL 聚合、权限、时间窗口和异常数据；页面测试覆盖加载、刷新失败、移动布局。
