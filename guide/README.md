# 本地预览

需要 Node.js 22。教程站独立于 Worker，不写入 `worker/public/`。

```sh
npm --prefix guide ci
npm --prefix guide run build
npm --prefix guide test
npm --prefix guide run dev
```

开发服务器输出的本地地址可直接在浏览器打开。构建产物在 `guide/.vitepress/dist/`；`npm --prefix guide run preview` 可预览构建结果。

生产站点由 Cloudflare Pages 项目 `ltools-guide` 从 GitHub `master` 自动构建：根目录 `guide/`，构建命令 `npm run build`，输出目录 `.vitepress/dist/`，自定义域名 `guide.ltools.asia`。工具箱首页由独立的 `tools` Pages 项目从 `pages/` 目录发布；教程站不使用 Worker。
