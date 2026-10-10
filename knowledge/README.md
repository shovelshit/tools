# 仓库知识库

本仓库是 `ltools.asia` 的部署总仓。当前代码、配置和已固定的
submodule 才是现状依据；历史说明不能替代线上状态核实。

## 请求路由与构建

`worker/src/index.js` 先处理账号/认证，再按 Host 和路径分流 API、文件和
HTML；`serveMaoyanAsset`、`serveStoreAsset` 负责子域名和 `/maoyan/*`、
`/store/*` 的规范化。`worker/scripts/build-assets.mjs` 只按白名单从
`modules/movie/pages/maoyan` 与 `modules/store/pages/store` 复制到被忽略的
`worker/public`，缺少未初始化的 submodule 会直接报出初始化命令。

页面发布惯例：修改带缓存版本的 Movie 静态文件时同步更新 `index.html`
中的 `?v=`；带版本参数的资源才设置长期 immutable 缓存。

## Module Registry and Ownership

- `modules/movie` (`shovelshit/movie`) owns the Movie web UI and Electron
  client. Its pinned commit is recorded by the parent gitlink.
- `modules/store` (`shovelshit/store`) owns the Store web UI. Store Worker
  handlers remain in `worker/src/store/` because they import shared account and
  authentication code.
- `worker/` owns routing, auth/data APIs, D1 migrations, KV, Durable Objects,
  cron scheduling, static-asset assembly, and production deployment.

Initialize the exact pins after cloning:

```bash
git submodule update --init --recursive
git submodule status
```

## Build and Test Boundaries

```bash
npm --prefix worker ci
npm --prefix worker run build:assets
npm --prefix worker test
node --test modules/movie/pages/maoyan/*.test.cjs
npm --prefix modules/movie/desktop ci
npm --prefix modules/movie/desktop test
node --test modules/store/pages/store/*.test.cjs
```

`worker/public`, `node_modules`, Electron `dist`, `.dev.vars`, credentials,
and user sessions are local or generated data and must not be committed.

## 认证、数据和调度边界

Worker 负责令牌签发/校验、公开申请、共享账号生命周期、会话加密、D1
schema/迁移、KV 和 Durable Object。Store 登录由 `worker/src/store/auth.js`
创建浏览器会话，代理由 `worker/src/store/proxy.js` 做同源和账号检查；
Store 页面不复制这些逻辑。Movie 锁座入口在 `worker/src/maoyan/lock-api.js`
和 `lock-runner.js`，始终保留供应商原始 `seatNo`，展示坐标不能反向生成
下单参数。座位解析策略在 `worker/src/maoyan/seat-layout/strategies/`。

Cron 每 3 分钟触发 Worker scheduled 入口；`cron.js` 解析步进表达式，
`tokens.js` 执行监控和维护扫描，`lock-runner.js` 在数据落库后协调锁座。
业务窗口和重试由代码判定，不能仅凭配置中的“暂停”字段推断已停止写入。

正式下单使用移动站/主站对应接口和 Cookie/User-Agent；旧 Electron 登录捕获
及本地实验仍保留 `mtgsig` 校验，不能因此推断正式下单动态生成签名。

## 部署、DNS 与密钥

只有主仓库部署 Worker。切换前备份并记录 D1/KV/DO 基线，真正暂停相关写入
和调度并保留可回滚材料；远程写入后独立核对数量、版本和任务状态。需要在
`movie.ltools.asia`、`store.ltools.asia` 使用 Wrangler `custom_domain = true`，
由 Cloudflare 管理 DNS 和证书；旧路径的普通 routes 不会创建 DNS。
当前主分支由 Cloudflare Workers Builds 自动发布 Worker，两个 Pages 项目
分别发布工具入口和教程；不是 GitHub Actions 部署。具体配置、核验和
回滚见 [Cloudflare 运维](cloudflare.md)。

生产需要 `worker/DEPLOY-D1.md` 和 Wrangler 配置中的绑定及
`ADMIN_TOKEN`、`SESSION_ENCRYPTION_KEY`、`ENROLLMENT_HMAC_KEY` 等 secret。
预检只核对名称，不打印值。子仓库 CI 只测源码；主仓库
`.github/workflows/module-update.yml` 只更新 gitlink 并创建/更新 PR，绝不
自动部署 Worker；PR 合并到主分支后会触发上述 Cloudflare 构建。
创建 PR 需要仓库允许 Actions 使用可创建 PR 的 token。
