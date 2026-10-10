# Cloudflare 运维

## 发布链路

`tools` 主分支由 Cloudflare Dashboard 的 Git 集成自动构建。GitHub 的
`Electron releases` 只测试、打包和发布桌面安装包，不部署 Worker 或 Pages。

| 项目 | 用途 | 域名 |
|---|---|---|
| Worker `tools-api` | Movie/Store 页面、API、D1/KV/DO、Cron | `movie.ltools.asia`、`store.ltools.asia` 和旧路径 |
| Pages `tools` | 工具入口 | `ltools.asia`、`www.ltools.asia` |
| Pages `ltools-guide` | 教程 | `guide.ltools.asia` |

Worker 的根目录为 `worker/`，安装依赖后按 `wrangler.toml` 的 build 命令
生成 `worker/public`，随后部署。构建需要完整初始化 `modules/movie` 和
`modules/store`；缺失时执行 `git submodule update --init --recursive`。
不要把生产 Worker 改为从子仓库单独部署，也不要添加第二条自动发布链路。

## 域名与认证

两个模块是没有独立源站的 Worker 应用，使用 `custom_domain = true`，
Cloudflare 自动建立 DNS 和证书。普通 `hostname/*` route 本身不会创建
DNS，不能用于替代 Custom Domain。旧路径继续保留，不强制用户迁移。

当前 Turnstile 站点的授权域名为 `ltools.asia`，包含其子域名，覆盖 Movie
申请页；API 仍单独验证实际 hostname 和 action。不要轮换已有 secret
或清空账号以排查域名问题。Store 会话保持 host-only，子域名 cookie 的
Path 为 `/`；新域名首次访问需重新登录，不会搬运旧 cookie。

## 上线核验

先区分失败来源：查看 GitHub commit checks 中的 `Workers Builds`、
`Cloudflare Pages` 和 `Electron releases`，不要把客户端失败当成云端部署失败。
以下命令为只读检查，在 `worker/` 中执行：

```bash
wrangler whoami
wrangler deployments list --config wrangler.toml
wrangler secret list --config wrangler.toml
```

只核对 secret 名称：`ADMIN_TOKEN`、`SESSION_ENCRYPTION_KEY`、
`ENROLLMENT_HMAC_KEY`；公开申请另需 `TURNSTILE_SECRET_KEY`。不要打印值。
`deploy-preflight --secrets ...` 接收已核对的名称，不会自行查询 Cloudflare。

```bash
curl -I https://movie.ltools.asia/
curl -I https://store.ltools.asia/
curl https://movie.ltools.asia/api/capabilities
curl -i https://store.ltools.asia/auth/session
curl -I https://ltools.asia/maoyan/
curl -I https://ltools.asia/store/
```

两首页应为 HTML `200`，Movie capabilities 为 JSON `200`，Store 未登录为
JSON `401`；网页有 CSP 和 `no-store`。同时检查 JS/CSS、背景图片、申请页和
下载页。实际登录和通知测试使用本人账号，不在公共日志中暴露密钥。

下载页没有版本时，先独立检查 GitHub Release 是否已经公开且包含三个安装包
和对应 `.sha256`。`/api/releases` 返回 `version: null`、空 `assets`、
`stale: true` 表示 Worker 未取得可用发布信息，不代表打包失败。即使本机
或本地 workerd 请求成功，也不能据此认定生产侧的 GitHub 请求正常。
查看日志中的 `release source unavailable` 及 `reason`，再区分上游 HTTP
错误、重定向、超时和元数据校验失败；未获得日志前不要猜测原因或轮换密钥。
保留日志的 [query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
要求 Cloudflare `Workers Observability Write` 权限，即使使用 `dry: true`
只查询、不保存结果。日志接口的认证错误与业务接口失败是两件事。排查期间可直接从
[GitHub Releases](https://github.com/shovelshit/tools/releases/latest) 下载安装包。

检查远端 D1/KV/四个 DO 绑定和 `*/3 * * * *` Cron 未变化；域名接入不需要
D1 数据迁移或暂停 Cron。涉及数据库迁移则必须按 [部署手册](../worker/DEPLOY-D1.md)
备份、记录用户/配置/进行中任务/通知出箱基线、真正暂停写入和调度后操作。

## 回滚

上线前记录当前 Worker version ID、路由、Custom Domain、Cron 和资源绑定，
保存至仓库外。版本变更出错先核对实际远端状态，不盲目重试。可以在 Dashboard
回滚前一 Worker 版本；回滚代码不会回滚 D1、KV 或已有账号状态。

新增域名发生问题时先保留旧路径，按基线移除本次新增的 Custom Domain；
证书不会随域名解绑自动删除，不要批量删除其他域名或证书。Wrangler 配置
也要同步回退，否则下次主分支构建会再次创建域名。源码 rollback 提交会触发
Workers Builds，应先确认恢复点和当前生效版本。

参考：[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、
[Turnstile hostname](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)。
