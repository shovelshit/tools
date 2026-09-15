# 猫眼监控与锁座 Electron 桌面端设计

## 背景

当前猫眼监控与锁座工具以 Web 页面运行。监控、影院搜索、座位选择、规则管理和云端锁座均由 Web 页面调用 Cloudflare Worker 完成，但猫眼登录态需要用户先在本地运行 Python/Playwright 脚本，再手动上传 JSON 文件。这对没有开发环境的用户不友好，也无法在普通浏览器内直接完成，因为网页不能跨域读取猫眼 Cookie 和请求签名。

首版新增 Electron 桌面端，同时支持 macOS 和 Windows。桌面端承载完整工具页面，并提供原生猫眼登录能力。Web 与 Electron 必须使用同一份前端源码，避免功能和交互长期分叉。

## 目标

- macOS 与 Windows 用户无需安装 Python、Playwright 或浏览器扩展即可使用完整工具。
- `pages/maoyan` 是 Web 与 Electron 的唯一业务前端源码。
- Electron 在锁座弹窗内提供一键猫眼登录，自动捕获并上传登录态。
- Web 保留手动上传登录态能力，并明确提示一键登录不受支持。
- 入口页始终显示 Worker 地址输入框，允许连接 HTTP 或 HTTPS Worker。
- Worker 地址、访问令牌和运行状态按 Worker 隔离，切换地址时不串用凭据。
- 自动捕获的猫眼登录态不进入 renderer，不写磁盘，不写日志。
- 首版提供未签名 macOS/Windows 安装包和版本提醒，更新由用户手动安装。

## 非目标

- 不支持 Linux、iOS 或 Android。
- 不调用支付接口，仍然只创建猫眼待支付订单。
- 不在本机长期保存猫眼 Cookie、`mtgsig` 或登录态 JSON。
- 不加载用户填写的 Worker 所返回的远程页面。
- 不在首版实现静默更新或应用内自动安装。
- 不替换现有 Worker 锁座协议，也不迁移已存储的云端会话。

## 总体架构

```text
pages/maoyan（唯一前端源码）
├── Web 容器
│   ├── 浏览器 fetch 调用 Worker
│   ├── 登录猫眼：禁用并提示 Web 版不支持
│   └── 手动上传登录态：浏览器读取所选 JSON
└── Electron 容器
    ├── 本地打包并加载 pages/maoyan
    ├── preload 暴露最小能力
    ├── 主进程代理 Worker API
    ├── 临时猫眼登录窗口
    ├── 系统安全存储中的 Worker Token
    └── GitHub Releases 版本检查
```

Electron 主窗口加载安装包内的共享页面。Worker 地址只作为 API 基地址使用，绝不作为页面导航地址。这样任意 Worker 无法向 Electron 注入可执行页面，同时 Web 与 Electron 仍共享业务 UI 和业务逻辑。

## 代码组织

```text
pages/maoyan/
├── index.html
├── app.js
├── lock.js
├── runtime.js             # 新增：Web/Electron 运行时适配
└── ...                    # 现有共享样式和组件

desktop/
├── package.json
├── main/
│   ├── index.js           # 应用生命周期和窗口
│   ├── worker-client.js   # Worker 地址、Token 与 API 代理
│   ├── maoyan-login.js    # 临时登录窗口与登录态捕获
│   ├── credential-store.js
│   └── updates.js
├── preload/
│   └── index.js           # 固定 IPC API
├── test/
└── build/                 # 图标与打包资源
```

Electron 构建直接包含 `pages/maoyan`，不复制出第二套可独立修改的页面。Web 发布与 Electron 打包都从该目录取源码。

## 运行时适配

共享页面通过统一的 runtime 接口完成网络和原生操作。

Web runtime：

- 使用浏览器 `fetch` 调用 Worker。
- 使用现有文件输入读取登录态 JSON。
- `loginMaoyan` 返回不支持状态。
- 外部链接使用浏览器默认行为。

Electron runtime：

- API 请求通过 IPC 交给主进程。
- 用户首次输入 Token 时，Token 会短暂存在于入口输入框并通过 IPC 交给主进程；连接完成后 renderer 清空该值。后续由主进程读取安全存储并加入 `X-Token`，不会把已保存 Token 回传 renderer。
- 一键登录与手动选择 JSON 都由主进程直接上传登录态。
- 外部链接由主进程使用系统默认浏览器打开。
- 版本检查由主进程执行，只向 renderer 返回版本号、更新说明和发布页地址。

preload 只暴露固定方法：

```text
getRuntimeInfo()
connectWorker(workerUrl, token)
requestWorker(path, options)
loginMaoyan(cinemaId)
cancelMaoyanLogin()
uploadSessionFile()
checkForUpdates()
openExternal(approvedUrl)
```

`requestWorker` 只接受相对 `/api/` 路径、受支持的 HTTP 方法和大小受限的 JSON 请求体，不能传入绝对 URL、任意 Header、文件路径或 Node 参数。

## Worker 地址与凭据隔离

入口页在 Web 和 Electron 中都显示：

- Worker 地址
- 访问令牌
- 连接按钮

Worker 地址接受 `http://` 和 `https://`。规范化规则如下：

- 去除首尾空白与末尾 `/`。
- 仅接受 HTTP/HTTPS 协议。
- 拒绝 URL 中的用户名、密码、查询参数和 fragment。
- 允许显式端口和可选基础路径，以支持本地或反向代理部署。
- Worker API 始终在规范化基地址后追加 `/api/...`。

规范化后的完整基地址是 Worker profile 的唯一键。每个 profile 独立保存 Token、最近连接状态和 HTTP 风险确认状态。切换地址后：

- 立即清空当前页面中的影院、监控、座位和规则展示。
- 不自动迁移或发送旧地址的 Token。
- 不自动上传其他 Worker 中的猫眼登录态。
- 只有新地址连接成功后才加载其云端配置。

Worker 地址本身保存在普通应用偏好设置中。Token 使用 Electron 系统安全存储能力加密后落盘，对应 macOS Keychain 和 Windows DPAPI；若系统安全存储不可用，Token 只保存在当前进程内存中，重启后要求重新输入，不降级为明文文件。

## HTTP 风险控制

HTTP 保持可用，但区分本机与非本机地址。

- `localhost`、`127.0.0.1` 和 `[::1]`：显示轻量提示，不要求重复确认。
- 其他 HTTP 地址：首次连接前显示阻断式确认，说明 Token、配置和接口响应可能被读取或篡改。
- 向非本机 HTTP Worker 上传猫眼登录态前再次确认，明确说明 Cookie 和签名可能泄露并导致账号被冒用。
- 主界面连接期间持续显示“不安全 HTTP 连接”状态。
- 风险确认按 Worker profile 保存；Worker 地址变化后必须重新确认。
- HTTPS 证书错误不可忽略，不提供关闭证书校验的开关。

Web 版若运行在 HTTPS 页面中并连接 HTTP Worker，可能被浏览器混合内容策略阻止。页面应把这类错误解释为浏览器安全限制，并建议使用 Electron 或 HTTPS Worker。

## 主窗口安全模型

- `nodeIntegration: false`。
- `contextIsolation: true`。
- 启用 renderer sandbox。
- preload 不暴露 `ipcRenderer`、文件系统、Shell、Cookie、网络库或任意 channel 调用。
- 拦截主窗口导航和新窗口请求，不允许离开本地应用页面。
- 外部链接必须通过 `openExternal`，并由主进程校验允许的 HTTP/HTTPS 地址。
- 页面只处理结构化 JSON；服务端文本统一以 `textContent` 渲染。
- Electron IPC 参数全部在主进程重新校验，不能相信 renderer 已做过的校验。

## 锁座弹窗交互

“猫眼会话”区域调整为：

- Electron：显示可用的“登录猫眼”按钮。
- Web：显示禁用的“登录猫眼（Web 版不支持）”按钮。
- 两端均显示“手动上传登录态”按钮，替代当前“上传或替换”文案。
- 已有云端会话时显示脱敏 UID、来源时间和上传时间。
- 已有云端会话时提供“重新登录”和“删除会话”。

Electron 手动上传使用系统文件选择器，只允许选择一个 JSON 文件，并由主进程限制文件大小、解析、校验和上传。文件内容不返回 renderer。Web 继续使用浏览器文件输入和现有上传接口。

## 猫眼登录流程

前置条件：用户已经连接 Worker，并已选择影院。登录入口位于锁座弹窗。

1. renderer 调用 `loginMaoyan(cinemaId)`。
2. 主进程为本次操作创建随机、非持久化 Electron Session，并打开独立登录窗口。
3. 登录窗口不配置 preload，不启用 Node。顶层页面只允许导航到 `https://maoyan.com` 及其子域名；第三方验证码资源可作为子资源加载，但不能把顶层窗口导航到非猫眼域名。
4. 主进程监听该临时 Session 发往 `www.maoyan.com` 的请求 Header，捕获非空 `mtgsig`，并从白名单查询参数中提取 `yodaReady`、`csecplatform` 和 `csecversion`。
5. 用户完成手机号、验证码或风控验证后，主进程导航至当前影院页面并触发正常页面请求，以获得与本次登录浏览器一致的签名。
6. 主进程从临时 Session 读取猫眼域 Cookie，获得 `_csrf` 和数字 `uid`，并读取登录窗口的真实 User-Agent。
7. 只有 Cookie、`uid`、CSRF、`mtgsig`、User-Agent 和查询参数均通过与 Worker 相同的校验后，才组装会话对象。
8. 若目标是非本机 HTTP Worker，在上传前执行第二次风险确认。
9. 主进程使用当前 Worker profile 的 Token 调用 `POST /api/lock/session`。
10. 上传成功后，renderer 只收到脱敏会话状态；随后主进程清理临时 Session 的 Cookie、缓存、localStorage 和其他站点数据并关闭窗口。

登录态明文只存在于主进程内存和临时 Chromium Session 中，不写入 Electron 配置、不生成本地 JSON、不通过 IPC 返回 renderer。

## 登录失败与恢复

- 用户关闭登录窗口：返回“已取消登录”，不修改 Worker 中已有会话。
- 登录超过 10 分钟：关闭并清理临时 Session，云端旧会话不变。
- 未捕获完整 Cookie 或签名：在 10 分钟期限内窗口保持可操作，提示用户继续登录或重试；用户取消后执行清理。
- 猫眼页面跳出允许的顶层域名：阻止导航并显示安全提示。
- Worker 认证失败：提示重新输入当前 Worker 的 Token，不尝试其他 profile 的 Token。
- Worker 上传失败：保留旧云端会话，清理本次临时 Session；错误内容不得包含登录态字段。
- 猫眼会话后续失效：现有 Worker 错误提示引导用户重新登录，不自动循环登录或下单。
- 应用崩溃：临时 Session 不使用 `persist:` 分区，重启后不会恢复猫眼登录态。

## 日志与敏感信息

允许记录：

- 登录阶段名。
- 成功、取消、超时、校验失败、Worker 上传失败等错误类别。
- HTTP 状态码和脱敏 Worker 主机名。

禁止记录：

- 访问令牌、Cookie、CSRF、`mtgsig`、完整登录态 JSON。
- 完整 Live 请求 Header 或 Body。
- 含查询参数的完整 Worker URL。
- 猫眼 UID 原文。

错误对象进入日志前必须经过统一脱敏函数，禁止直接输出第三方响应或 Electron `webRequest` details。

## 更新与发布

首版没有 Apple Developer 账号或 Windows 代码签名证书，因此采用“自动检查、手动安装”：

- GitHub Actions 在 macOS 和 Windows 构建环境分别运行测试和打包。
- macOS 发布 Apple Silicon 与 Intel 安装包。
- Windows 发布 x64 安装包。
- GitHub Releases 附带 SHA-256 文件，供完整性核对；它不替代代码签名和发布者身份验证。
- 应用通过 HTTPS 检查固定 GitHub 仓库的最新 Release。
- 发现新版本后展示版本号、更新说明和官方发布页按钮。
- 用户在系统浏览器中打开发布页，手动下载安装。
- 不下载后静默替换应用，不绕过 Gatekeeper 或 SmartScreen。
- 界面明确说明未签名应用在 macOS 首次打开和 Windows 首次运行时可能出现系统警告。

取得签名证书后，可在不改变共享业务页面的前提下增加签名、notarization 和应用内自动安装。

## Worker 兼容性

首版复用现有 Worker API：

- `GET /api/status` 用于连接验证。
- `POST /api/lock/session` 上传登录态。
- `GET /api/lock/session/status` 读取脱敏状态。
- 其他监控、配置、座位和规则接口保持不变。

Electron 不要求 Worker 新增桌面专用 API。现有会话加密、KV 存储和 D1 数据结构不变。

## 测试策略

### 共享前端回归

- 运行现有 Worker 单元与集成测试。
- 验证 Web 入口 Worker 地址可见。
- 验证 Web 登录猫眼按钮禁用且文案明确。
- 验证 Web 手动上传登录态仍可用。
- 验证监控、推送、选座和规则管理没有平台条件分支回归。

### Electron 单元测试

- Worker URL 规范化、HTTP/HTTPS 接受和其他协议拒绝。
- 本机地址判断与两阶段 HTTP 风险确认。
- 不同 Worker profile 的 Token 隔离。
- 安全存储不可用时不写明文 Token。
- API 路径、方法、Header 和 Body 限制。
- 猫眼 Cookie、签名和查询参数捕获与校验。
- 日志脱敏。
- 版本比较和固定 Releases 地址校验。

### Electron 集成测试

- 使用本地 mock Worker 验证连接、鉴权、配置和锁座页面请求。
- 使用本地 mock 登录站点验证登录成功、取消、超时、导航拦截和清理流程。
- 验证自动登录态与手动 JSON 均由主进程上传，renderer 无法取得明文。
- 验证上传失败不会覆盖 mock Worker 中的旧会话。
- 验证切换 Worker 后页面状态和 Token 完全隔离。

### 跨平台构建验证

- macOS Apple Silicon 构建与启动冒烟。
- macOS Intel 构建产物检查。
- Windows x64 构建与启动冒烟。
- 两个平台验证未签名安装提示、版本检查和打开 Releases 页面。
- 使用测试账号执行一次真实猫眼登录 POC，确认 Electron 能捕获当前猫眼页面的 Cookie 与 `mtgsig`；真实下单不纳入自动测试。

## 验收标准

- Web 和 Electron 使用同一份 `pages/maoyan` 业务源码。
- Electron 在 macOS 与 Windows 均能打开完整监控与锁座页面。
- 入口页显示 Worker 地址，HTTP 和 HTTPS 均可连接。
- 非本机 HTTP 连接与登录态上传分别触发风险确认。
- Electron 能从锁座弹窗打开猫眼登录窗口并自动上传有效会话。
- Web 明确显示一键登录不支持，并保留“手动上传登录态”。
- 自动登录过程中 renderer、磁盘和日志中均不出现登录态明文。
- 登录取消、超时或上传失败不会删除或覆盖 Worker 中已有会话。
- Worker profile 切换后 Token 和页面状态不串用。
- 现有 Worker 测试全绿，Electron 测试和 macOS/Windows 构建通过。
- 应用能提示 GitHub Releases 新版本，并由用户手动完成安装。
