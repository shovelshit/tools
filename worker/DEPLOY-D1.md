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

把命令返回的 D1 `database_id` 和 KV `id` 写入 `wrangler.local.toml`，不要保留 `REPLACE_WITH_*`。把模板顶部 `routes` 中的示例域名和 `zone_name` 一并替换为自己的域名；只使用 `workers.dev` 时删除整个 `routes` 数组。四个 Durable Object 及 `[[migrations]]` 声明已在模板中列出，无需单独创建。这些声明是 Cloudflare Durable Object 类注册元数据，不是 D1 数据库升级脚本，请勿删除或改写。

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

## 后续部署

2026-09-23 猫眼业务时间与通知调度版本支持保留现有 D1 数据的加法迁移。新建库直接使用当前 `schema.sql`，**不要再执行下面的迁移脚本**。已有库升级前先通过 Cloudflare D1 备份或导出保留恢复点，并确认当前 `notification_outbox` 有 `event_key` 唯一约束，记录原有 `pending`/`sending` 数量。以下命令在 `worker/` 目录执行，库名和配置文件替换成实际环境：

```bash
npx wrangler d1 execute my-maoyan-db --remote --command "PRAGMA table_info(notification_outbox)" --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --command "SELECT state,COUNT(*) AS n FROM notification_outbox GROUP BY state" --config wrangler.local.toml
```

确认 `notification_outbox` 中尚无 `detected_at`、`first_attempt_at`、`sent_at` 三列后，按顺序各执行一次：

```bash
npx wrangler d1 execute my-maoyan-db --remote --file sql/maoyan-business-policy.sql --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --file sql/maoyan-maintenance-checkpoint.sql --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --file sql/maoyan-notification-lanes.sql --config wrangler.local.toml
```

通知迁移中的三条 `ALTER TABLE` 不能重放。如果已有其中部分列，先按 `PRAGMA table_info` 逐条确认并只执行缺失的 `ALTER`，再执行该文件中的 `CREATE INDEX IF NOT EXISTS`；不要对旧库直接运行完整 `schema.sql`。部署前验证策略初始行、维护表、新列和四个索引存在，且原有出箱状态数量未减少：

```bash
npx wrangler d1 execute my-maoyan-db --remote --command "SELECT * FROM maoyan_business_policy WHERE id=1" --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --command "PRAGMA table_info(maoyan_maintenance_runs)" --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --command "PRAGMA table_info(notification_outbox)" --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --command "PRAGMA index_list(notification_outbox)" --config wrangler.local.toml
npx wrangler d1 execute my-maoyan-db --remote --command "SELECT state,COUNT(*) AS n FROM notification_outbox GROUP BY state" --config wrangler.local.toml
```

再构建和部署 Worker。首次部署后确认后台策略默认为监控 07:00-23:00、维护 01:00-02:00，检查通知成功率、积压和最近维护日期。此处只提供操作步骤，不会自动变更远程 D1 或发布 Worker。

Wrangler 配置中的 `[[migrations]]` 与上述 D1 策略无关。它们只用于注册 Durable Object 类，部署新环境和后续发布时都应保留。
