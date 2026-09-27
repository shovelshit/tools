# 本地预览

需要 Node.js 22。教程站独立于 Worker，不写入 `worker/public/`。

```sh
npm --prefix guide ci
npm --prefix guide run build
npm --prefix guide test
npm --prefix guide run dev
```

开发服务器输出的本地地址可直接在浏览器打开。构建产物在 `guide/.vitepress/dist/`；`npm --prefix guide run preview` 可预览构建结果。

未来若单独发布到 Cloudflare Pages：构建根目录 `guide/`，构建命令 `npm run build`，输出目录 `.vitepress/dist/`，站点 base `/`，目标域名 `guide.ltools.asia`。本地预览不创建 Pages 项目、DNS 或生产部署；根工具箱首页的发布路径需另行核实。
