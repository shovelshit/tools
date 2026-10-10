# ltools.asia 工具箱

Cloudflare Worker 部署总仓，包含电影监控和应用商店。在线入口：
[ltools.asia](https://ltools.asia/)、[movie.ltools.asia](https://movie.ltools.asia/)、
[store.ltools.asia](https://store.ltools.asia/)。

先读[仓库知识库](knowledge/README.md)；[Movie 架构与代码解释](knowledge/movie.md)包含架构图、调度、座位解析及前端/Electron 导航。源码入口见[模块注册表](modules/README.md)、
[Movie](modules/movie/README.md)和[Store](modules/store/README.md)。

## 快速检查

```bash
git submodule update --init --recursive
npm --prefix worker ci
npm --prefix worker run build:assets
npm --prefix worker test
node --test modules/movie/pages/maoyan/*.test.cjs
node --test modules/store/pages/store/*.test.cjs
npm --prefix modules/movie/desktop ci
npm --prefix modules/movie/desktop test
```

主仓库拥有 Worker、D1/KV/DO、Cron、静态资源构建和生产发布；子仓库拥有
页面与 Movie Electron 客户端。不要提交 secret、`.dev.vars`、
`worker/public`、Electron `dist` 或用户会话。生产发布需要先核实 DNS、绑定、
密钥和可回滚材料；模块更新工作流只提 PR，不会部署。
