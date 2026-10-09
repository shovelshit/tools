# 模块注册表

`tools` 是主仓库，电影监控和应用商店是其中的两个业务模块。模块保留独立的源码、测试和客户端发布入口，但共享 Worker、构建脚本和发布流程。

| 模块 | 源码目录 | 公开地址 | 内部业务标识 |
|---|---|---|---|
| movie | [`modules/movie`](movie/), `worker/src/maoyan/` | `https://movie.ltools.asia/` | `maoyan` |
| store | [`modules/store`](store/), `worker/src/store/` | `https://store.ltools.asia/` | `store` |

## GitHub 模块方式

`movie` 和 `store` 通过 Git submodule 固定到已验证的提交。子仓库拥有各自的页面、测试和 Movie Electron 客户端源码；`tools` 仍拥有 Worker、数据库迁移、静态资源构建和生产部署权限。更新模块时先在子仓库合并，再由主仓库更新 gitlink。

```bash
git submodule update --init --recursive
git -C modules/movie log -1 --oneline
git -C modules/store log -1 --oneline
```

## 上线前置条件

需要在 Cloudflare 的 `ltools.asia` 区域创建并代理以下 DNS 记录，然后再部署 Worker：

- `movie.ltools.asia`
- `store.ltools.asia`

仓库中的 Wrangler 路由只声明 Worker 绑定，不会替代 DNS 配置，也不会自动完成域名证书或代理状态设置。
