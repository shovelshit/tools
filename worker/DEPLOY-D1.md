# Cloudflare 独立部署

本项目使用 Worker Static Assets、D1、KV、四个 Durable Object 和 Cron。默认模板关闭公开申请；仅管理员自用时不需要 Turnstile。请在自己的 Cloudflare 账号中创建资源，不要复用仓库维护者的生产资源。

## 1. Fork 与安装

```bash
git clone https://github.com/<your-account>/tools.git
cd tools
npm --prefix worker ci
cp worker/wrangler.example.toml worker/wrangler.local.toml
```

`wrangler.local.toml` 已被忽略，不会提交。后续命令都显式使用该文件。

## 2. 创建自己的 D1 和 KV

```bash
cd worker
npx wrangler d1 create my-maoyan-db
npx wrangler kv namespace create MAOYAN_KV
```

把命令返回的 D1 `database_id` 和 KV `id` 写入 `wrangler.local.toml`，不要保留 `REPLACE_WITH_*`。把模板顶部 `routes` 中的示例域名和 `zone_name` 一并替换为自己的域名；只使用 `workers.dev` 时删除整个 `routes` 数组。四个 Durable Object 及迁移声明已在模板中列出，无需单独创建。

## 3. 配置 secret

依次运行并输入随机强值，值不会写入配置文件：

```bash
npx wrangler secret put ADMIN_TOKEN --config wrangler.local.toml
npx wrangler secret put SESSION_ENCRYPTION_KEY --config wrangler.local.toml
npx wrangler secret put ENROLLMENT_HMAC_KEY --config wrangler.local.toml
```

`ADMIN_TOKEN` 用于管理员登录；`SESSION_ENCRYPTION_KEY` 加密猫眼登录态和通知密钥；`ENROLLMENT_HMAC_KEY` 只用于申请标识摘要。三者不要复用。

## 4. 建表、构建和部署

```bash
npx wrangler d1 execute my-maoyan-db --remote --file schema.sql --config wrangler.local.toml
npm run build:assets
node scripts/deploy-preflight.mjs --config wrangler.local.toml --secrets ADMIN_TOKEN,SESSION_ENCRYPTION_KEY,ENROLLMENT_HMAC_KEY
npx wrangler deploy --config wrangler.local.toml
```

预检只核对绑定和 secret 名称，不读取或打印 secret 值。部署后访问 `https://<你的 Worker 域名>/maoyan/`，使用管理员令牌登录，先上传猫眼登录态并测试通知，再开启监控。

## 5. 可选：开启公开申请

在 Cloudflare Turnstile 创建站点后，把以下变量写入本地配置：

```toml
[vars]
TURNSTILE_SITE_KEY = "your-site-key"
ENROLLMENT_ORIGIN = "https://your-worker.example.workers.dev"
ENROLLMENT_HOSTNAME = "your-worker.example.workers.dev"
```

再配置 Turnstile secret：

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.local.toml
node scripts/deploy-preflight.mjs --config wrangler.local.toml --public-enrollment --secrets ADMIN_TOKEN,SESSION_ENCRYPTION_KEY,ENROLLMENT_HMAC_KEY,TURNSTILE_SECRET_KEY
npx wrangler deploy --config wrangler.local.toml
```

部署完成后在管理页把“允许公开申请”打开。公开普通账号默认最多 20 个、每次 15 天；管理员账号不占公开名额且永久有效。开放前应先查看管理员资源摘要并完成真实实例容量验证。仓库中的合成容量报告不能代替 Cloudflare 的 CPU、D1 rows、KV 和 Durable Object 实测。

## 更新与回滚

新建 D1 继续执行第 4 节的 `schema.sql`。已有 D1 更新到带业务线的版本时，不能采用“先迁移、稍后部署”，也不能在新旧版本之间做流量分割：旧版本不识别 `business_line`，一旦数据库中出现 Store 账号，旧版本可能把它当成猫眼账号参与管理或任务分发。

上线前准备并验证两个版本：本次业务线版本，以及一个维护版本。维护版本的 HTTP 请求统一返回 `503`，`scheduled` 和 Durable Object alarm 入口直接停止，不读取或写入 D1。按以下顺序操作：

1. 完成本地构建、全部测试和预检，先上传两个版本但不要给业务线版本分配生产流量。记录当前生产版本 ID。
2. 在迁移前记录 D1 Time Travel bookmark，并把输出保存在发布记录中：

   ```bash
   cd worker
   npx wrangler d1 time-travel info my-maoyan-db --config wrangler.local.toml --json
   ```

3. 将生产流量和定时任务 100% 切到维护版本；确认页面/API 返回维护响应，等待已经开始的旧版本请求结束，并从日志确认旧版本不再访问 D1。不要保留旧版本百分比流量。
4. 维护状态下执行一次迁移和 schema 收敛：

   ```bash
   npx wrangler d1 execute my-maoyan-db --remote --file migrations/0002-business-lines.sql --config wrangler.local.toml
   npx wrangler d1 execute my-maoyan-db --remote --file schema.sql --config wrangler.local.toml
   ```

5. 立即将生产 100% 切到本次业务线版本。验证猫眼账号、Store 账号、两条业务线容量和定时任务后，再结束维护窗口。不要把迁移后的数据库暴露给迁移前版本。

`0002-business-lines.sql` 为既有数据迁移，不可重复执行；它会为已有账号写入 `maoyan` 业务线并保留现有设置。

### 故障恢复

- 迁移执行前失败：可以直接从维护版本切回原生产版本，数据库尚未改变。
- 迁移后失败：保持维护版本，不要使用 `wrangler rollback` 或重新部署迁移前提交。优先部署预先准备的“业务线 schema 兼容恢复版本”；它必须保留业务线鉴权、查询过滤和容量隔离，可以暂时关闭 Store 入口，但不能按旧模型读取账号。
- 只有明确接受丢弃迁移后全部写入时，才可恢复到迁移前 bookmark。先保持维护状态，使用发布记录中的 bookmark 执行 `npx wrangler d1 time-travel restore my-maoyan-db --bookmark <BOOKMARK> --config wrangler.local.toml`，验证数据库已回到迁移前状态，再部署原生产版本并恢复流量。迁移后新增或修改的 Store/猫眼数据必须提前导出或明确放弃。

不要删除 D1、KV 或 Durable Object 数据。访问密钥无法找回，遗失后只能等待账号自然到期并重新申请。
