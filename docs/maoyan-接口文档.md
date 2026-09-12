# 猫眼监控站点 接口文档

- 版本：2026-09-12（含状态码统一改造）
- 基地址：`https://ltools.asia`（自定义域）｜`https://tools-a65.pages.dev`（Pages 源站）
- 实现：Cloudflare Worker `tools-api`（`worker/wrangler.toml`），前端 `pages/maoyan/`
- 存储：KV `MAOYAN_KV`（令牌清单 + 按 `u:<令牌ID>:` 前缀隔离的用户数据）

---

## 一、通用约定

### 请求

| 项 | 说明 |
| --- | --- |
| 传输 | HTTPS，请求/响应均为 `application/json; charset=utf-8` |
| CORS | `Access-Control-Allow-Origin: *`；允许方法 `GET, POST, OPTIONS`；允许头 `Content-Type, X-Token, X-Admin-Token` |
| 预检 | 任意路径 `OPTIONS` → **204**，带完整 CORS 头 |
| 用户鉴权 | 请求头 `X-Token: <访问令牌>`（令牌由管理员在 `/api/admin/tokens` 下发） |
| 管理鉴权 | 请求头 `X-Admin-Token: <ADMIN_TOKEN>`（Worker secret） |

> 令牌只走请求头，**不接受** URL 参数（避免进入日志/浏览器历史）。前端把它加密存在本机 localStorage（`secure-store.js`）。

### 状态码（2026-09-12 起统一）

| 状态码 | 含义 | 典型场景 |
| --- | --- | --- |
| 200 | 成功 | — |
| 201 | 已创建 | 创建锁座规则 |
| 204 | 无内容 | CORS 预检 |
| 400 | 请求参数/配置错误 | 缺少参数、ID 非纯数字、渠道无效、凭据未配置 |
| 401 | 鉴权失败 | `X-Token`/`X-Admin-Token` 缺失或错误 |
| 404 | 资源不存在 | 未知接口、未上传会话、令牌不存在 |
| 405 | 方法不允许 | 管理接口用了不支持的方法 |
| 409 | 状态冲突 | 监控已停止/未开始/已到期、已有进行中的锁座规则 |
| 500 | 服务端内部错误 | 未预期异常 |
| 502 | 上游异常 | 猫眼请求失败、推送渠道返回异常、AList 反代失败 |
| 503 | 服务未启用 | 锁座服务未开启（`LOCK_SERVICE_ENABLED != "true"`） |

### 响应体

- 成功：`{ "ok": true, ... }`
- 失败：`{ "ok": false, "error": "<可读原因>" }`（401 / 部分 404 只有 `error` 字段）

> **变更提示**：改造前 `/api/shows`、`/api/check`、`/api/config` 的业务失败会返回 `200 + ok:false`，与 `/api/cinemas`、`/api/lock/*` 的 4xx 风格不一致，导致前端无法区分"成功但无变化"和"根本没执行"。现在全部按上表语义返回；调用方只需判断 HTTP 状态即可。

---

## 二、用户 / 监控接口（需 `X-Token`）

### 1. `GET /api/status`

获取监控状态、变化记录与 cron 批次信息。

**响应 200**

```json
{
  "ok": true,
  "authMode": "token",
  "lockServiceEnabled": false,
  "status": {
    "lastCheckTs": 1789000000000,
    "lastCheck": "2026-09-12T03:10:21.000Z",
    "lastError": null,
    "cinemaName": "万达影城(天和广场)",
    "newTotal": 3,
    "enabled": true,
    "monitorDdl": "2026-10-12T02:53:13.900Z"
  },
  "changes": [
    { "time": "2026-09-12T03:16:56.463Z", "type": "new", "text": "新增 2 场《捕风追影》: ..." }
  ],
  "cronMinutes": 30,
  "cronExprs": ["*/30 * * * *"],
  "cronText": "每 30 分钟一批",
  "cronMinuteStep": true
}
```

| 字段 | 说明 |
| --- | --- |
| `status.enabled` | 是否**正在监控**（`config.enabled === true`） |
| `status.monitorDdl` | 监控截止时间；每次「开始监控」刷新为 30 天后。**停止后仍保留原值** |
| `status.lastError` | 上次检查失败原因，成功时清空为 `null` |
| `changes[]` | 最近 100 条，新的在前；`type ∈ new / ok / warn / error / info` |
| `cronMinuteStep` | 全部 cron 均为"分钟步进型"时前端才展示下批次时间 |

### 2. `GET /api/config`

读取当前配置（**密钥不回显**）。

**响应 200**

```json
{
  "ok": true,
  "config": {
    "cinemaId": "38569",
    "selectedMovieIds": ["1545360"],
    "notifyChannel": "bark",
    "enabled": true,
    "monitorDdl": "2026-10-12T02:53:13.900Z",
    "hasBark": true,
    "hasServerChan": false,
    "notifyVerified": true,
    "cronMinutes": 30,
    "cronExprs": ["*/30 * * * *"],
    "cronText": "每 30 分钟一批",
    "cronMinuteStep": true
  }
}
```

- `barkKey` / `serverChanKey` / `notifyVerification` 会被过滤，只返回 `hasBark` / `hasServerChan` / `notifyVerified` 三个布尔量。
- `notifyVerified` = 「当前渠道 + 当前密钥」是否已成功发过测试推送（内部用 `SHA-256(渠道\u0000密钥)` 指纹比对）。

### 3. `POST /api/config`

增量更新配置（只提交要改的字段）。

**请求体**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cinemaId` | string | 影院 ID，**必须纯数字**；空串视为"不修改"（防误清空） |
| `selectedMovieIds` | string[] | 勾选的影片 ID |
| `notifyChannel` | `"bark"` \| `"serverchan"` | 非法值 → 400 |
| `barkKey` | string | Bark Key 或完整 URL |
| `serverChanKey` | string | Server酱 SendKey |
| `enabled` | boolean | `true` 开始监控（刷新 `monitorDdl` 为 30 天后）；`false` 停止监控 |

**业务规则**

1. `enabled=true` 时，当前渠道必须**已配置凭据**且**已通过测试推送**，否则 400。
2. 变更后若 `enabled` 仍为 `true`，但当前渠道不可用或未验证 → **自动把 `enabled` 置为 `false`**，并在 `changes` 写入一条 `warn`，响应体额外带 `notice`。
   （防止运行中切到未配置渠道后推送静默失效、界面却仍显示"监控中"。）

**响应 200**

```json
{ "ok": true, "config": { "...": "同上，未回显密钥" } }
```

出现自动停止时：

```json
{
  "ok": true,
  "config": { "enabled": false, "...": "..." },
  "notice": "推送渠道（Server酱）未配置或未验证，监控已自动停止；配置并发送测试推送后可重新开始监控"
}
```

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | 请求体非 JSON 对象 / `cinemaId` 含非数字字符 / `notifyChannel` 无效 / 渠道凭据未配置 / 未通过测试推送 |

### 4. `POST /api/check`

手动「立即检查」（等价于定时批次的一次执行）。

**响应 200**

```json
{ "ok": true, "cinemaName": "万达影城(天和广场)", "newTotal": 2, "enabled": true }
```

**错误**

| 状态码 | `error` | 场景 |
| --- | --- | --- |
| 400 | 未配置影院 | 还没选影院 |
| 409 | 尚未开始监控，请先在界面点「开始监控」 | 选了影院但从未开始监控 |
| 409 | 监控已停止，请先在界面恢复监控 | 已手动停止 |
| 409 | 监控已到期，已自动停止；点「开始监控」可再续 30 天 | 超过 `monitorDdl`（此时已自动停并写入 `warn`） |
| 502 | 猫眼请求失败… / 接口数据异常… | 上游异常（同时写入 `status.lastError`） |

### 5. `POST /api/test-push`

按**当前选中渠道**发一条测试推送，成功后把该渠道标记为已验证。

**响应 200**

```json
{ "ok": true, "channel": "bark", "label": "Bark" }
```

**错误**：400（`Bark 未配置` / `Server酱 未配置`）；502（渠道侧返回异常，如 `Bark 推送失败: HTTP 500`）

### 6. `POST /api/test-bark`（遗留）

早期只支持 Bark 时的接口，前端已改用 `/api/test-push`，仅为兼容保留。响应 `{ "ok": true }`，错误码同 `/api/test-push`。

### 7. `GET /api/cities`

返回内置城市列表。

```json
{ "ok": true, "cities": [{ "id": 10, "name": "上海" }, { "id": 1, "name": "北京" }] }
```

### 8. `GET /api/cinemas?cityId=<id>&kw=<关键词>`

按城市 + 关键词模糊搜索影院（服务端拉全量影院并按名称/地址过滤，KV 缓存 6 小时）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `cityId` | 是 | 纯数字 |
| `kw` | 是 | 关键词，按影院名或地址做包含匹配 |

**响应 200**

```json
{ "ok": true, "cinemas": [{ "id": "38569", "nm": "万达影城(天和广场)", "addr": "..." }] }
```

**错误**：400 `缺少 cityId` / `cityId 无效` / `缺少 kw`；502 猫眼返回异常页面

### 9. `GET /api/shows?cinemaId=<id>`

拉取影院当日排片。`cinemaId` 可省略，此时回落到已保存的配置。

**响应 200**

```json
{
  "ok": true,
  "cinemaId": "38569",
  "cinemaName": "万达影城(天和广场)",
  "movies": [
    {
      "id": 1545360,
      "nm": "捕风追影",
      "showCount": 12,
      "shows": [
        {
          "showDate": "2026-09-12",
          "plist": [
            {
              "seqNo": "202609130348425",
              "tm": "19:30",
              "lang": "国语",
              "tp": "2D",
              "th": "1号厅",
              "vipPrice": "39.9",
              "vipPriceSuffix": "起",
              "ticketStatus": 0
            }
          ]
        }
      ]
    }
  ]
}
```

- `ticketStatus`：`0` 可售，非 `0` 停售/不可售。
- **错误**：400 `缺少 cinemaId` / `cinemaId 无效`；502 猫眼异常（前端会自动重试 3 次）

---

## 三、锁座接口（需 `X-Token`）

> 需 `LOCK_SERVICE_ENABLED="true"`，否则一律 **503** `{ "ok": false, "error": "锁座服务暂时不可用" }`。
> 会话（猫眼 Cookie/签名）在服务端以 AES-GCM 加密存储，接口只回显脱敏 UID。

### 1. `GET /api/lock/session/status`

```json
{ "ok": true, "session": { "uploaded": true, "uploadedAt": "2026-09-12T02:00:00.000Z", "uidMasked": "UID 123***789", "sourceSavedAt": "2026-09-12T01:59:00.000Z" } }
```

未上传时为 `{ "ok": true, "session": { "uploaded": false } }`。

### 2. `POST /api/lock/session`

上传/替换猫眼会话。请求体为本地工具导出的会话 JSON（≤ **256 KiB**）。

```json
{
  "cookies": [{ "name": "uid", "value": "123456789", "domain": ".maoyan.com" }],
  "csrf": "...", "mtgsig": "...", "user_agent": "...",
  "create_order_query": { "yodaReady": "h5", "csecplatform": "4", "csecversion": "2.6.0" },
  "saved_at": "2026-09-12T01:59:00.000Z"
}
```

**响应 200**：`{ "ok": true, "session": { "uploaded": true, "uidMasked": "UID 123***789", ... } }`

**错误**：400 `猫眼会话格式错误` / `猫眼会话不完整，请重新登录后上传` / `会话文件不能超过 256KiB`；500 `锁座服务尚未配置加密密钥`

### 3. `POST /api/lock/session/remove`

删除会话与关联规则。响应 `{ "ok": true, "removed": true }`；404 `未找到锁座资源`

### 4. `GET /api/lock/template-seats?cinemaId=&movieId=&seqNo=`

拉取座位图（三个参数均须为纯数字）。

**响应 200**

```json
{
  "ok": true,
  "seatMap": {
    "seqNo": "202609130348425",
    "sectionId": "1", "sectionName": "1号厅",
    "seats": [{ "seatNo": "1-6-18", "rowId": "1", "columnId": "6", "type": "", "available": true }]
  }
}
```

- `seatNo` 格式为 `行-列-座`；`type` 为 `L`/`R` 表示情侣座（需成对选择）。
- **错误**：400 参数无效；404 `未找到锁座资源`（未上传会话）；502 座位图获取失败/会话验证失败

### 5. `GET /api/lock/rule`

```json
{ "ok": true, "rule": null }
```

有规则时 `rule` 为公开字段对象（见下），并含 `automationEnabled`（锁座开关状态）。

### 6. `POST /api/lock/rule`

创建锁座规则。

**请求体**

```json
{
  "cinemaId": "38569",
  "movieId": "1545360",
  "templateSeqNo": "202609130348425",
  "targetDate": "2026-09-15",
  "seatNos": ["1-6-18", "1-6-19"],
  "riskAccepted": true
}
```

约束：仅接受上述 6 个字段（多传即 400）；`cinemaId`/`movieId`/`templateSeqNo` 须纯数字；`seatNos` 非空且形如 `行-列-座`；`riskAccepted` 必须为 `true`；`targetDate` 须在今天起 30 天内；影片须在当前影院监控配置中已勾选。

**响应 201**

```json
{
  "ok": true,
  "rule": {
    "id": "uuid", "cinemaId": "38569", "cinemaName": "万达影城(天和广场)",
    "movieId": "1545360", "movieName": "捕风追影",
    "targetDate": "2026-09-15", "templateDate": "2026-09-12", "templateTime": "19:30",
    "templateSeqNo": "202609130348425", "targetSeqNo": "202609150000000",
    "seats": [{ "seatNo": "1-6-18", "rowId": "1", "columnId": "6", "type": "" }],
    "state": "waiting_schedule",
    "createdAt": "2026-09-12T02:00:00.000Z", "updatedAt": "2026-09-12T02:00:00.000Z",
    "lastError": null, "orderId": null, "payLeftSecond": null
  }
}
```

`state` 取值：`waiting_schedule`（等目标场次放出）→ `matching`（正在下单）→ `locked`（已锁，仅待支付订单）｜`unknown`（结果不确定，需人工到猫眼确认）｜`failed`｜`expired`｜`completed`｜`cancelled`。

**错误**：400（参数无效 / 未确认风险提示 / 座位无效或不可用 / 情侣座需成对 / 影片未在监控配置中选择 / 目标日期超 30 天 / 已有进行中的锁座规则为 409）；404 未找到锁座资源；502 猫眼会话验证失败或场次失效

### 7. `POST /api/lock/rule/cancel`

取消已保存规则。响应 `{ "ok": true, "removed": true }`；404 `未找到锁座规则`

---

## 四、管理接口（需 `X-Admin-Token`）

### 1. `GET /api/admin/tokens`

列出全部令牌（令牌本身脱敏）。

```json
{
  "ok": true,
  "tokens": [
    { "id": "a9a89e3d-816a-48e0-9745-7690b328b55b", "token": "7287 **** 140", "remark": "张三", "createdAt": "2026-07-21T06:16:35.962Z", "state": "monitoring" }
  ]
}
```

`state` 为 `monitoring`（已开启且未到期）或 `stopped`。

### 2. `POST /api/admin/tokens`

新建令牌。请求体 `{ "token"?: string, "remark"?: string }`；不传 `token` 则自动生成 32 位十六进制。

- 校验：`^[\x21-\x7e]{6,64}$`（6–64 位可见 ASCII），不合法 → 400
- 响应 200：`{ "ok": true, "id": "...", "token": "<明文，仅此一次返回>" }`
- 已存在同值令牌 → 400 `令牌已存在`

### 3. `POST /api/admin/tokens/revoke`

吊销令牌并清理该用户的全部 KV 数据（config / snapshot / changes / status / session / lock-rule）。

- 请求体 `{ "id": "<令牌ID>" }`；响应 `{ "ok": true }`；不存在 → 404

> 鉴权失败（缺少或错误 `X-Admin-Token`）统一 **401** `{ "error": "管理令牌错误或未配置 ADMIN_TOKEN" }`；方法不支持 → 405。

---

## 五、商店接口（无需令牌）

### 1. `ANY /store/api/*`

上游 AList API（`http://appstore.cnmlynk.org`）的反向代理，隐藏真实地址并统一 CORS。上游状态码原样透传；代理失败 → **502** `{ "ok": false, "error": "AList 反代失败: ..." }`。

### 2. `GET /store/file?url=<http 直链>`

代理 http 直链（解决 HTTPS 页面加载 HTTP 资源被拦截）。仅允许上游 AList 域名 `appstore.cnmlynk.org` 的 **http** 直链。

- 400 `无效的 url 参数`
- 403 `仅支持代理上游 AList 域名的 http 直链`

---

## 六、附：cron 与前端行为

- 定时触发：`*/30 * * * *`（`worker/wrangler.toml` 的 `[triggers].crons`）。
- 批次信息由 `/api/status`、`/api/config` 下发（`cronMinutes` / `cronText` / `cronExprs` / `cronMinuteStep`），前端不再提供间隔设置。
- 定时批次只处理 `enabled === true` 的配置；**未开始监控的用户不会被抓取，也不会收到任何告警**。
- 到期保护：`enabled === true` 且超过 `monitorDdl` → 自动停止并写入一条 `warn`。
