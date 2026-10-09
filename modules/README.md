# 模块注册表

`tools` 是主仓库，电影监控和应用商店是其中的两个业务模块。模块保留独立的源码、测试和部署入口，但共享 Worker、构建脚本和发布流程。

| 模块 | 源码目录 | 公开地址 | 内部业务标识 |
|---|---|---|---|
| movie | `pages/maoyan/`, `worker/src/maoyan/`, `desktop/` | `https://movie.ltools.asia/` | `maoyan` |
| store | `pages/store/`, `worker/src/store/` | `https://store.ltools.asia/` | `store` |

## GitHub 模块方式

当前 `movie` 和 `store` 没有对应的独立 GitHub 仓库，因此不添加 `.gitmodules` 或无效的 Git submodule 指针。需要拆分时，应先创建独立仓库，再通过 Git submodule 或 subtree 引入，并同步调整构建和发布权限。

当前阶段使用主仓库内的模块注册表，避免拆分时丢失共享 Worker、数据库迁移和桌面端依赖。

## 上线前置条件

需要在 Cloudflare 的 `ltools.asia` 区域创建并代理以下 DNS 记录，然后再部署 Worker：

- `movie.ltools.asia`
- `store.ltools.asia`

仓库中的 Wrangler 路由只声明 Worker 绑定，不会替代 DNS 配置，也不会自动完成域名证书或代理状态设置。
