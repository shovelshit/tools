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

本仓库只支持使用当前 `schema.sql` 初始化全新的 D1，不支持对旧版本 schema 做原地升级。更新代码后如果数据库 schema 已过期，请创建新的 D1，重新执行第 4 节的初始化命令，并把新 `database_id` 写入配置后再部署；不要把当前 Worker 部署到旧 schema，也不要尝试拼接历史 SQL 升级现有数据库。

更换 D1 会从空数据库开始，旧库数据不会自动迁移。切换前请自行确认需要保留的数据，并按当前 schema 重新导入；访问密钥明文无法从数据库找回。

Wrangler 配置中的 `[[migrations]]` 与上述 D1 策略无关。它们只用于注册 Durable Object 类，部署新环境和后续发布时都应保留。
