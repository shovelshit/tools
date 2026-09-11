# 猫眼云端锁座 Beta 设计

## 目标

在现有猫眼监控页的“监控设置与控制”卡片中提供“锁座 Beta”入口。用户上传由本地 `maoyan_lock.py login` 生成的会话文件，选择当前已有场次和任意数量座位，设置未来目标日期。目标日期实际排期出现与模板完全相同 `HH:mm` 的同影院同影片场次后，Worker 自动创建待支付订单，不调用支付接口。

## 范围与限制

- 不修改本地 session 生成逻辑，也不新增桌面或移动端登录工具。
- 不支持 Pages 自行登录猫眼；用户主动上传本地 session 文件。
- 不提供付款、取消订单、自动换座、自动改时间或多规则并发。
- Beta 阶段每个访问 token 最多有一个活动规则。
- 规则严格匹配目标日期、影院、影片和 `HH:mm`。例如模板 `20:00` 只匹配未来 `20:00`，不接受 `19:59` 或 `20:05`。
- 规则使用当前模板场次的座位数据推断未来场次。影厅、时间、布局或售卖状态变化都可能导致失败。

## 会话上传与身份

1. 用户在弹框中选择 `maoyan-lock-session.json` 文件。
2. 浏览器仅在上传请求期间读取文件内容，不写入 URL、localStorage 或 IndexedDB。
3. Worker 校验格式并归一化为实际请求需要的 Cookie 名值、`_csrf`、`mtgsig`、User-Agent 和受控 create-order 查询参数。
4. Worker 使用 `SESSION_ENCRYPTION_KEY` 进行 AES-GCM 加密，将密文存入 `u:<tokenId>:maoyan-session`。
5. 原文件的 `uid` Cookie 用作账号标识。它只用于让用户确认当前上传的是哪个账号，接口仅返回脱敏 UID，例如 `UID 123***789`；不存储或展示手机号。
6. 用户可替换或删除会话。删除访问 token 时，既有 token 清理流程同时删除会话和锁座规则。

`SESSION_ENCRYPTION_KEY` 是 Worker Secret，值为 Base64 编码的 32 字节随机密钥。没有该 Secret 时，上传和锁座接口返回配置错误，不接受会话明文落库。

## 弹框交互

“锁座 Beta”按钮位于当前监控设置卡片，未加载影院或未勾选影片时禁用。

弹框依次展示：

1. 会话状态、上传/替换/删除操作和脱敏 UID。
2. 当前影院信息，以及已勾选影片中的影片选择器。
3. 当前已有场次选择器。该场次提供模板时间和座位表。
4. 座位图。用户可选择任意数量的当前可选座位；页面不限制为两张，也不强制相邻。
5. 目标未来日期。必须晚于模板场次日期且不超过 30 天。
6. 明确风险确认框和“启用自动锁座”命令。

风险文案：

> Beta：未来场次与座位根据当前场次推断。实际开场时间、影厅、座位布局和售卖状态可能变化，可能导致自动锁座失败。锁座成功后仅生成待支付订单，需要在有效时间内自行支付。

## 规则数据与状态

锁座规则存储在 `u:<tokenId>:maoyan-lock-rule`：

```json
{
  "id": "random-id",
  "cinemaId": "25428",
  "movieId": "1510281",
  "targetDate": "2026-09-12",
  "templateTime": "20:00",
  "seats": [
    { "seatNo": "1-6-18", "rowId": "6", "columnId": "18" },
    { "seatNo": "1-6-19", "rowId": "6", "columnId": "19" }
  ],
  "state": "waiting_schedule"
}
```

状态只允许 `waiting_schedule`、`matching`、`locked`、`failed`、`expired` 和 `unknown`。

- `waiting_schedule`：目标场次尚未发布。
- `matching`：发现严格匹配场次，正在验证座位并尝试创建订单。
- `locked`：订单创建成功，规则永久停止。
- `failed`：匹配场次的座位不存在、不可选、布局变化或猫眼明确拒绝订单。
- `expired`：目标日期结束前未发现严格匹配场次。
- `unknown`：创建订单请求结果不明确；为避免重复订单，禁止自动重试，需要用户手动确认。

## 自动锁座

增加单独的每分钟 cron 触发锁座检查，普通监控仍按当前自身间隔运行。自动建单受 Worker 环境变量 `LOCK_AUTOMATION_ENABLED` 控制，默认 `false`；关闭时规则可保存和查询，但不会发起 create-order，界面明确显示“等待服务验证”。

对每个活动规则：

1. 查询目标日期所在的实际排期。
2. 找到同影院、同影片、目标日期、完全相同 `HH:mm` 的唯一场次。没有匹配则继续等待；多个相同时间场次则失败并推送，不猜测选择哪一场。
3. 使用上传的会话加载未来场次选座页。
4. 严格查找每个已保存座位的 `seatNo`、`rowId`、`columnId`。所有座位都必须存在且可选。
5. 使用未来场次自己的 `sectionId`、`sectionName`、`seqNo` 和该场次实际座位对象调用 create-order。
6. 成功后记录订单号和支付剩余秒数，发送推送，规则进入 `locked`。
7. 明确失败时发送推送并进入 `failed`；网络/超时等不确定结果进入 `unknown`，不自动重试。

同一个 token 的规则执行通过 Durable Object 串行化，以防 cron 重叠时创建重复订单。

## 接口

所有接口都使用现有 `X-Token` 鉴权。

```text
POST /api/lock/session
GET  /api/lock/session/status
POST /api/lock/session/remove

GET  /api/lock/template-seats?cinemaId=&movieId=&seqNo=
POST /api/lock/rule
GET  /api/lock/rule
POST /api/lock/rule/cancel
```

- 上传、状态和规则接口绝不返回 Cookie、`mtgsig`、原始 HTML、订单原始响应或完整 UID。
- 所有 cinemaId、movieId、seqNo、rowId、columnId 均限制为十进制数字；seatNo 限制为 `section-row-column` 数字格式。
- create-order 仅可从自动规则执行路径调用；前端没有支付接口或支付 URL。

## 验证与上线门槛

1. 使用本地生成的 session 上传，确认 KV 中只存密文且状态只显示脱敏 UID。
2. 通过模板场次读取座位图，选择多于两张的可选座位并保存规则。
3. 经用户当次明确授权后，使用一次手动的、未支付 create-order 验证 Cloudflare Worker 的出口 IP 与上传 session / `mtgsig` 可被猫眼接受。
4. 只有第 3 步成功，才将 `LOCK_AUTOMATION_ENABLED` 设为 `true` 并启用每分钟自动锁座 cron。
5. 验证严格时间匹配、座位变化失败、目标日期过期、会话删除和不确定订单结果不会重复提交。
