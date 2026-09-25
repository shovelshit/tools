# 猫眼运营监控看板重新设计

设计日期：2026-09-25（北京时间）

状态：已确认，待实施

## 目标

将现有“运营看板”从摘要型信息面板改成面向值班排障的运营工作台。管理员打开页面后，先看到当前运行态势和异常，再能沿着用户、影院、通知三条链路查看细节；页面保持现有管理后台的深色玻璃面板、表格和紧凑密度，不引入新的前端框架。

## 设计原则

- 主视图展示当前异常和可行动状态，不用装饰性图表填充空间。
- 用户监控和影院运行各占一整行，避免两个宽表并排导致信息被截断。
- 服务端一次聚合返回展示所需数据，前端不为每个用户或通知发起额外请求。
- 大段内容放入展开行或详情抽屉，主表保持可扫描。
- 通知正文、失败详情和业务元数据只按纯文本渲染，不执行 HTML。
- 所有时间使用北京时间显示；无数据、未知状态和找不到影片名称时提供明确回退文案。
- 保持显式刷新，不引入自动轮询。

## 页面结构

```text
运行总览
  运行态势 + 异常摘要
  核心指标

用户监控（全宽）
  用户 / 影院 / 监控影片 / 场次 / 状态 / 最近检查 / 下次检查 / 锁座 / 最近通知
  展开用户详情：影片场次 + 锁座规则

影院运行（全宽）
  影院 / 运行状态 / 监控用户 / 影片与场次 / 最近完成 / 下次检查 / 新场次通知 / 锁座结果

通知队列                  系统健康
  状态和类型筛选            扫描、队列、维护任务状态
  点击打开通知详情抽屉

座位反馈（全宽）
  默认待处理，已处理记录可切换查看
```

## 服务端数据模型

### 核心指标

`summary` 增加以下字段：

- `monitoredMovies`：活跃监控订阅中去重后的已选影片数量。
- `currentShows`：当前 `cinema_state.current_data` 中已选影片的场次数总和。
- `attentionCinemas`：运行状态为 `processing`、`retryable`，或超过检查间隔仍未完成的影院数量。
- `pendingNotifications`：待发送和发送中的通知数量。

保留现有有效用户、监控用户、影院、通知成功率和锁座统计。

### 用户监控

`readUsers` 读取 `user_config.data` 中的 `selectedMovieIds`，与 `cinema_state.current_data` 的影片和场次合并。每个用户返回：

```js
{
  userId, remark, cinemaId, cinemaName, monitorState,
  lastCheck, lastCheckTs, nextDueAt,
  cinemaRunState, activeRunId, attemptCount,
  monitorContent: {
    selectedCount,
    availableShows,
    movies: [{
      movieId, movieName, showCount, hasMoreShows,
      nextShows: [{ showDate, time, hall, ticketStatus }]
    }]
  },
  lockState, lockMovie, lockHall, orderId, lastError,
  lastNotification
}
```

每部影片只返回最早的 5 个场次作为展开摘要，并用 `hasMoreShows` 表示是否还有更多；`showCount` 保留完整数量。影片名称找不到时使用影片 ID。

### 影院运行

`readCinemas` 基于 `cinema_state` 返回：

```js
{
  cinemaId, cinemaName, monitoringUsers,
  movieCount, showCount, runState, activeRunId, attemptCount,
  latestBatchAt, nextDueAt, stale,
  newShows, notifications, lockSuccess, lockFailed
}
```

排序顺序为：`retryable`、长时间未完成、`processing`、其他异常、正常；同一状态内按用户数和影院 ID 排序。`stale` 由服务端按照当前监控间隔计算，避免浏览器自行猜测阈值。

### 通知详情

看板列表保留最近 20 条通知，并返回 `title`、截断后的 `content`、`meta`、状态、用户备注、重试次数、下次重试时间和失败信息。

增加只读接口：

```text
GET /api/admin/notifications/:id?businessLine=maoyan
```

接口校验通知 ID 和业务线，只返回属于该业务线的通知。返回完整但有上限的标题、正文、业务元数据和投递诊断字段；不返回通知凭证、加密字段或完整原始数据库行。不存在、业务线不匹配和解析失败分别返回明确错误。

## 前端交互

- 用户表的“监控影片”是可展开控制；展开行显示每部已选影片的场次数、最近场次和锁座规则。
- 通知队列每一行是可聚焦按钮，点击后打开右侧详情抽屉；移动端改为底部抽屉。
- 通知详情展示类型、状态、用户、影院、时间、重试信息、正文和可折叠失败详情。
- 通知状态和类型筛选只作用于当前已加载列表，不改变服务端数据。
- 关闭抽屉支持关闭按钮、遮罩点击和 Escape；焦点回到触发通知行。
- 正常状态使用现有成功色，延迟/可重试使用警告色，失败使用危险色；状态同时显示文字，不依赖颜色单独表达。
- 影院运行状态和用户行状态使用原有表格单元格样式，避免新增一套视觉语言。

## 错误和边界

- 看板请求失败时保留现有页面结构并显示顶部错误提示。
- 通知详情请求失败只在抽屉内显示错误，不清空看板。
- 没有影片、场次、通知或座位反馈时显示对应空状态。
- `current_data` 无法解析时，影片区域显示“数据暂不可用”，不让整个接口失败。
- 内容长度在服务端和前端均受限；所有动态内容使用 `textContent` 或等价纯文本节点。
- 不自动刷新，不修改通知状态，不新增任何外部副作用。

## 测试和验收

- Dashboard 单测验证选中影片与当前场次聚合、名称回退、场次数、运行状态、异常排序和新增核心指标。
- Admin API 单测验证通知详情接口的业务线隔离、完整内容返回、无效 ID 和错误响应。
- Admin 页面单测验证全宽面板结构、用户详情展开、通知行可点击、详情抽屉内容和安全文本渲染。
- 响应式检查覆盖桌面宽度和窄屏；宽表允许横向滚动，不产生内容遮挡。
- 运行 Worker 测试、管理页测试和 `git diff --check`。
