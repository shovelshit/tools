# 电影场次监控桌面客户端

支持 macOS（Apple Silicon / Intel）和 Windows x64。桌面端与 Web 版共用 `pages/maoyan` 页面，通过你配置的 Worker API 提供监控和锁座服务。主窗口加载本地页面，服务地址会显示在页面顶栏。

## 安装与首次连接

从 [GitHub Releases](https://github.com/shovelshit/tools/releases) 下载与你的系统和架构相符的 DMG / ZIP，或 Windows 安装程序。所有发行包均未签名、未公证，macOS Gatekeeper 或 Windows SmartScreen 可能显示警告。核对发布者、版本和 SHA-256 后，再根据系统提示决定是否运行。

同一版本的 Assets 中应同时提供安装包和对应的 `.sha256` 文件。macOS 在下载目录执行 `shasum -a 256 -c <安装包名称>.sha256`；Windows 使用 `certutil -hashfile <安装包名称> SHA256`，将结果与 `.sha256` 文件中的摘要比较。摘要相同表示文件与发布附件一致，不能替代发行者身份验证。

首次启动填写 Worker 服务地址和访问令牌，点击“进入监控”。服务地址支持 HTTP / HTTPS 及已有路径前缀，不接受用户名、密码、查询参数或片段。令牌由主进程管理；系统安全存储不可用时只在当前运行期间保留。

建议使用 HTTPS。非本机 HTTP 连接会先弹出原生风险确认；向该服务上传猫眼登录态时还需要一次单独确认，因为 HTTP 会暴露令牌和登录态。取消确认不会发送相关敏感请求。切换服务地址会清理旧影院、影片选择和锁座面板状态；为新服务填写它自己的令牌。

## 登录猫眼与上传

进入锁座面板后点击“登录猫眼”，在独立猫眼窗口中完成登录。客户端只允许猫眼 HTTPS 页面导航，自动获取必要的登录信息并由主进程上传给当前 Worker。页面只接收脱敏的状态；登录过程不会导出会话文件。确认远端登录态上传成功后再进行锁座。

桌面端也支持“上传登录态”调用系统文件选择器，选择已有的有效 JSON 文件。Web 版没有 Electron 登录窗口，可以通过锁座面板的手动上传入口选择 JSON 或填写所需登录字段，再上传给同一个 Worker。这是登录失败时的备用入口；不要把令牌或登录态粘贴到聊天、日志或公开页面。

登录窗口最长等待 10 分钟。上传发送前取消或关闭窗口会终止本次操作并清理临时浏览器状态，不移除 Worker 原有会话。上传已经发送后，取消或关窗会等待结果；超时或网络断开时结果可能未知，需要刷新远端会话状态确认，不能假定上传失败或旧会话仍然有效。明确的上传拒绝不会主动删除原有会话。若清理失败，重启客户端后再登录。

本工具仅创建待支付订单，不自动支付。请在猫眼确认订单、金额和支付时限，按需手动完成支付。

## 更新

客户端最多每天检查一次固定 GitHub 仓库的新版本，只显示提示和发行说明。点击更新链接后手动下载、校验并安装；不会后台下载、自动安装或修改当前应用。新版本同样可能触发未签名警告。

## 开发与发行

使用 Node.js 22.23.2，先执行 `npm --prefix desktop ci`。`npm --prefix desktop start` 启动本地客户端；`npm --prefix desktop test` 运行桌面单元和集成测试；`npm --prefix desktop run test:smoke` 使用临时用户配置启动真实 Electron 并连接本机模拟 Worker。浏览器跨视口验收使用 `npm --prefix desktop run test:e2e -- --output <仓库外绝对目录>`，需要 Chrome/Chromium，并将截图与检查结果写入指定目录。

macOS 上执行 `npm --prefix desktop run package:mac` 生成 arm64 / x64 DMG 和 ZIP；Windows 上执行 `npm --prefix desktop run package:win` 生成 x64 NSIS 安装程序和 ZIP。追加 `-- --dir` 只构建应用目录。产物位于 `desktop/dist/`。构建后执行 `npm --prefix desktop run test:smoke -- --packaged`，检查本机架构的应用、asar 白名单、共享页面加载和 Worker 地址显示。

CI 先运行 Worker、共享页面、桌面和浏览器跨视口验收。`master` 推送验证通过后创建草稿 Release，在 macOS 和 Windows runner 分别构建并启动本机架构应用，生成 SHA-256 并直接上传到该 Release；全部平台成功后才发布，失败则清理未完成草稿和标签。安装包不会上传为 Actions artifact，也不会自动安装到用户机器。

打包器直接读取共享 `pages/maoyan` 源文件，在 asar 内保留 `desktop/main`、`desktop/preload` 与 `pages/maoyan` 目录关系。只收集运行代码和页面资源，不收集测试、Worker、开发密钥、用户配置、浏览器资料或登录态。
