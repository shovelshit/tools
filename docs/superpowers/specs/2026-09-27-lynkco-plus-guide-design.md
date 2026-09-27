# Lynkco-push 配置教程设计

## 目标与范围

将独立的 VitePress 教程站缩减为单项目教程。首页和侧栏只展示“Lynkco-push 配置教程”；教程正文目前只有第一章“1、抓包”，以后再补充后续配置步骤。新地址为 `/lynkco-plus`，不提供 `/lynkco` 的旧页面或重定向。

删除教程站中猫眼、应用商店、蓝牙以及旧领克四篇 Markdown 页面和仅供这些页面使用的图片；不修改工具箱首页 `pages/index.html` 或工具本身。删除范围限于教程站，其他仓库内容不受影响。

## 页面与素材

- `guide/index.md` 改为单项目入口，指向 `/lynkco-plus`。
- `guide/.vitepress/config.mts` 的站点标题、侧栏改为 Lynkco-push 教程；保留返回工具箱导航。
- `guide/lynkco-plus.md` 用九张已裁掉顶部状态栏的 ProxyPin 截图，按 App Store 安装、证书安装与信任、开启抓包的时间顺序撰写操作说明。使用现有 `GuideFigure` 组件的图片放大能力，配准确的替代文本和图注。
- 仅将审阅过的九张 WebP 复制到 `guide/public/images/lynkco-plus/`。不复制原视频、总览图、备份图或任何含账号/请求数据的帧。
- 正文提示根证书及 VPN 授权仅用于自己的设备与已获授权流量。截图不暗示安装、信任或抓包已由读者实际完成。

## 验证

- 站点构建后首页和 `/lynkco-plus` 可访问，九张图片均可加载；`/lynkco`、`/maoyan`、`/store`、`/ble` 不生成页面。
- 更新站点测试，核对标题、导航、步骤顺序、图片路径、替代文本、404 与不含私密素材；运行构建和测试，并在本地预览桌面/手机布局。
