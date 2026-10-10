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

Wrangler 使用 Worker Custom Domain 接入以下子域名，Cloudflare 自动管理 DNS 和证书：

- `movie.ltools.asia`
- `store.ltools.asia`

旧的 `ltools.asia/maoyan/*`、`ltools.asia/store/*` 仍保留为普通 Worker routes，需要已有的代理 DNS。现状、预检和回滚步骤见 [Cloudflare 运维](../knowledge/cloudflare.md)。
