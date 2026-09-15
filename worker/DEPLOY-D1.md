# D1 全链路迁移部署手册（feature/d1-migration 分支）

用户状态（tokens / config / status / snapshot / changes / seatfb / lock-rule）已从 KV 迁移到 D1。
KV 仅保留两类数据：`maoyan-session` 加密会话信封、`cache:cinemas:*` 影院搜索缓存（带 TTL）。

## 为什么迁 D1

| | KV（免费档） | D1（免费档） |
|---|---|---|
| 写入 | **1,000/天**（硬顶） | **100,000 行/天** |
| 读取 | 100,000/天 | 5,000,000 行/天 |
| 附带收益 | changes 上限 100 条 | 变化记录全量历史（读取仍返回最新 100 条，API 形状不变） |

main 分支的 KV 条件写优化后约 40 写/天/令牌，10+ 令牌内安全；本分支是规模化铺路，**建议活跃令牌接近 5-10 个或需要完整场次历史时再上线**。

## 上线步骤

```bash
cd worker

# 1. 建库（输出 database_id）
npx wrangler d1 create tools-db

# 2. 把 database_id 填入 wrangler.toml 的 [[d1_databases]]（替换 REPLACE_WITH_REAL_D1_ID）

# 3. 建表（远程）
npx wrangler d1 execute tools-db --remote --file schema.sql

# 4. 部署本分支
npx wrangler deploy

# 5. 迁移存量 KV 数据（幂等，可重复执行；不删任何 KV 数据）
curl -X POST https://ltools.asia/api/admin/migrate-kv-to-d1 -H "X-Admin-Token: <ADMIN_TOKEN>"
# 返回: {"ok":true,"tokens":N,"configs":N,"statuses":N,"snapshots":N,"changes":N,"lockRules":N,"seatFeedback":N}

# 6. 验证: 页面登录 / 立即检查 / 状态读取 / 锁座链路；观察一天后再执行第 7 步
# 7. （可选）确认稳定后清理 KV 旧键：仅 u: 与 seatfb: 前缀与 meta:tokens（勿删 maoyan-session 与 cache:cinemas:*）
```

## 回滚

重新部署 main（KV 版）即可：迁移端点全程只读 KV、不删任何 KV 键，KV 数据始终是完整快照。
D1 侧数据残留无害（KV 版代码不读 D1）。

## 本地验证

```bash
cd worker
npx wrangler d1 execute tools-db --local --file schema.sql   # 本地建表
npx wrangler dev                                              # 本地服务(http://127.0.0.1:8787)
# .dev.vars 提供 ADMIN_TOKEN / SESSION_ENCRYPTION_KEY / LOCK_SERVICE_ENABLED（已被 .gitignore 排除）
```

## 代码结构

- `src/maoyan/db.js`：唯一 D1 访问层（函数首参一律是数据库实例，全部 UPSERT，迁移幂等）
- `src/maoyan/migrate.js`：KV→D1 迁移逻辑（maoyan-session / cache:cinemas 不迁移）
- `schema.sql`：建表 SQL（wrangler d1 execute 用）
- 测试：`test/helpers.js` 的 `MemoryD1`（node:sqlite 实装真 SQL）+ `createDB` 种子工厂；
  `npm test`（node --experimental-sqlite --test）173 用例全绿

## 已知行为差异（有意为之）

1. `changes` 在 D1 中保留全量历史，`/api/status` 仍只返回最新 100 条（与 KV 版响应一致）。
2. 上游消失影片的 snapshot 旧行保留（与 KV 版一致，避免影片回归时被误判"首次出现"）。
3. `tokens` 表按 `token` UNIQUE 索引点查鉴权，替代 KV 版每次请求全量读数组。
