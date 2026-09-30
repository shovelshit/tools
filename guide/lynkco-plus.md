# Lynkco-plus 配置教程

> ⚠️ **声明**：本项目免费，为了防止滥用，采用一人一码邀请机制（自助领取）。如果花钱了，那么恭喜你被骗了。
>
> ⚠️ **提醒**：云端版本需要上传私人登录态，如果介意请使用[本地项目版本](https://github.com/shovelshit/LynkCoHelper)。

本教程指导你通过抓包获取领克 `App` 的登录态，并配置云端自动签到任务。全程约 10 分钟，需要一部 `iPhone` 或已ROOT的安卓手机。下面教程已 `iPhone` 为例。安卓原理相同，可以请教豆包。

## 1、准备抓包环境

抓包仅限自己的设备和已获授权的流量；完成后建议按需关闭抓包，并撤销不再使用的证书信任。

1. 安装 `ProxyPin`：苹果在 `App Store` 搜索 `ProxyPin`（或 `Stream`），确认应用名称后下载；安卓前往[下载页](https://github.com/wanghongenpin/proxypin/releases/tag/v1.3.1)获取安装包。

   <GuideFigure src="/images/lynkco-plus/01-appstore-install.webp" alt="App Store 中的 ProxyPin 安装页面" caption="图 1 · 安装 ProxyPin" />

2. 打开 `ProxyPin` 的 `HTTPS` 代理设置，进入“安装根证书”。

   <GuideFigure src="/images/lynkco-plus/02-certificate-entry.webp" alt="ProxyPin 设置中的 HTTPS 证书入口" caption="图 2 · 打开证书设置" />

3. 按提示下载证书描述文件，在系统弹窗中允许下载。

   <GuideFigure src="/images/lynkco-plus/03-download-profile.webp" alt="ProxyPin 的下载证书描述文件页面" caption="图 3 · 下载证书描述文件" />

4. 在 `iPhone` 设置中找到已下载的 `ProxyPin CA` 描述文件，点击“安装”。

   <GuideFigure src="/images/lynkco-plus/04-install-profile.webp" alt="iPhone 设置中的安装描述文件页面" caption="图 4 · 安装描述文件" />

5. 阅读系统关于根证书的警告，确认确实要信任此证书后继续安装。

   <GuideFigure src="/images/lynkco-plus/05-certificate-warning.webp" alt="iPhone 安装根证书时的警告页面" caption="图 5 · 确认证书警告" />

6. 进入“设置 → 通用 → 关于本机 → 证书信任设置”，开启 `ProxyPin CA` 的完全信任。

   <GuideFigure src="/images/lynkco-plus/06-trust-certificate.webp" alt="iPhone 设置中的根证书信任开关" caption="图 6 · 信任根证书" />

7. 回到 `ProxyPin` 首页，点击右下角的开始按钮。

   <GuideFigure src="/images/lynkco-plus/07-start-capture.webp" alt="ProxyPin 首页的开始抓包按钮" caption="图 7 · 开始抓包" />

8. 首次启动时，系统会询问是否允许添加 `VPN` 配置；确认只抓取已获授权的流量后点击“允许”。

   <GuideFigure src="/images/lynkco-plus/08-allow-vpn.webp" alt="iPhone 的 VPN 配置授权提示" caption="图 8 · 允许 VPN 配置" />

## 2、触发登录请求

需要抓到 `mobileCodeLogin` 或 `refresh` 任一请求，二选一即可：

- **主动触发**：在领克 `App` 退出登录，使用手机号验证码方式重新登录，会产生 `mobileCodeLogin` 请求；
- **被动触发**：超过半小时未打开领克 `App`，再次打开时会自动产生 `refresh` 请求。

触发后回到 `ProxyPin`，搜索 `refresh` 或 `mobileCodeLogin` 确认请求已出现。如果搜索不到，先确认抓包仍在运行，再在应用内重新执行上述操作后搜索。

<GuideFigure src="/images/lynkco-plus/10-refresh-request.webp" alt="ProxyPin 搜索 refresh 的请求列表" caption="图 10 · 查找 refresh 请求" />

## 3、触发分享请求

在领克 `App` 首页打开任意一条动态。

<GuideFigure src="/images/lynkco-plus/11-lynkco-post.webp" alt="领克 App 中的一条动态" caption="图 11 · 打开领克动态" />

点击动态底部的分享按钮，打开分享菜单（无需真正分享出去）。

<GuideFigure src="/images/lynkco-plus/12-share-sheet.webp" alt="领克动态的分享菜单" caption="图 12 · 分享动态" />

然后返回 `ProxyPin` 搜索 `getShareCode`，确认分享请求已出现。如果没有结果，确认抓包仍在运行，并重新打开动态的分享菜单。

<GuideFigure src="/images/lynkco-plus/13-share-code-request.webp" alt="ProxyPin 搜索 getShareCode 的请求列表" caption="图 13 · 查找 getShareCode 请求" />

## ~~4、获取车辆详情~~

~~1. 在领克 `App` 爱车页面点击一次更多，触发 `vehicle-detail` 接口。~~

## 5、导出 `HAR`

1. 在 `ProxyPin` 请求列表点击右上角菜单，选择“视图导出”。（导出前要把上方搜索栏清空）

   <GuideFigure src="/images/lynkco-plus/14-export-menu.webp" alt="ProxyPin 请求列表的视图导出菜单" caption="图 14 · 打开视图导出" />

2. 选择 `HAR` 并保存文件，在本地核对其中是否包含 `mobileCodeLogin`（或 `refresh`）和 `getShareCode` 请求。

   <GuideFigure src="/images/lynkco-plus/15-export-har.webp" alt="ProxyPin 视图导出的 HAR 选项" caption="图 15 · 选择 HAR" />

## 6、领取邀请码，配置云端任务

完成上述步骤后，获取[免费邀请码](https://lynkco.ltools.asia/claim/KjybyNSjUwtbw6eFC55w9D89MMxHXpxCJzC_oUUHbVM)，按页面指引上传 `HAR` 并开启云端自动签到即可。已在其他渠道领取过邀请码的请勿重复领取。
