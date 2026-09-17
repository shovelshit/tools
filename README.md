# ltools.asia · 自托管工具箱

跑在 Cloudflare Workers、Static Assets、D1、KV 与 Durable Objects 上的自托管工具集合。

**在线地址**：<https://ltools.asia/>

## 工具一览

| 工具 | 说明 | 形态 |
|---|---|---|
| 🎬 [猫眼场次监控 + 自动锁座](https://ltools.asia/maoyan/) | 监控影院排片变化，新场次推送到手机；开售后自动锁座 | Worker Static Assets + D1 / KV / Durable Objects / Cron |
| 📦 [应用商店](https://ltools.asia/store/) | 浏览和下载 AList 网盘中的应用，云端加速直连、在线预览 | Pages 前端 + Worker 文件代理（无需登录） |
| 🚗 领克签到助手 | 领克 App 自动签到、分享任务、积分查询与 Bark 推送 | Python 脚本 · [独立仓库](https://github.com/shovelshit/LynkCoHelper) |
| 📶 蓝牙调试助手 | 低功耗蓝牙调试工具，扫描/读写特征值/订阅通知，可替代 nRF Connect | 微信小程序 + iOS · [独立仓库](https://github.com/shovelshit/BLE-debug) |

---

## 🎬 猫眼场次监控 + 自动锁座

解决两个痛点：**想看的场次（IMAX/首映）一开售就没了**、**开售时间不可预测要一直刷**。

### 场次监控

- 城市 → 影院模糊搜索 → 勾选关注影片，配置即自动保存
- 推送渠道支持 **Bark / Server酱**，须先发送测试推送验证通过才能开启监控
- 云端 Cron 默认 **每 3 分钟**按影院共享抓取排期（北京时间 07:00~22:59 窗口内），多个用户关注同一影院时复用结果
- 页面只在可见且需要时增量查询；普通监控状态约 3 分钟刷新，活动锁座约 15 秒刷新，后台页停止轮询
- 普通账号默认 15 天有效，到期后有空余名额可自助续期并恢复仍有效的任务；管理员账号永久有效且不占公开名额
- 推送渠道失效时自动停止监控并告警；通知通过 D1 outbox 有限重试，不重新执行锁座订单

### 自动锁座

- 上传一次猫眼登录会话（浏览器 cookie 快照，≤256KiB，仅存于本人数据空间）
- 场次来源三分支：**目标场次** / **其他日期真实可锁场次** / **模板推断场次**（目标日期未开排片时，以最后排期日的末班场次推断未来座位布局，全部可选、开售后按实际售卖为准）
- 座位图与猫眼主站口径对齐：物理格布局（过道占位、孤立座、跨排错位）、情侣座连体渲染、滚轮/拖动/捏合缩放
- **官方座位图按需只读对照**：默认关闭，用户开启后 Worker 才提取官方 seats-block 片段，并在无脚本沙箱 iframe 中按官方 CSS 副本渲染
- 目标场次开售后由 Durable Object（`LockCoordinator`）自动执行锁座，成功后推送通知（座位 + 支付倒计时）
- 单规则约束：同一令牌同时只允许一条进行中的规则，防止并发误下单
- 锁座异常原因可一键上报（seat-feedback），便于定位问题

### 安全设计

- **访问密钥制**：支持管理员签发和可选的 Turnstile 公开申请；申请时只保存 HMAC 后的浏览器标识与初始 IP 摘要，使用时不绑定 IP
- 浏览器侧令牌 AES-GCM 加密后存 localStorage（`secure-store.js`），防设备本地明文泄露
- 猫眼会话仅以加密信封存于本人 KV 空间，通知凭据同样加密；全链路错误信息不含会话凭据
- 访问密钥无法找回；遗失后不提供管理员明文回显，账号自然到期后可重新申请
- 官方座位图片段在不授予 `allow-scripts` 的 sandbox iframe 内渲染，埋点属性剥离；关闭对照后立即清除内容

## 📦 应用商店

浏览 / 下载 AList 网盘中的应用资源。Worker 侧做云端代理直连加速，支持在线预览，无需登录。

---

## 架构

```
浏览器 / Electron
  └── Worker tools-api
      ├── Static Assets       /maoyan/ 申请、监控、锁座和管理页
      ├── D1                  账号、配置、订阅、历史、规则和通知 outbox
      ├── KV                  加密猫眼会话与影院搜索缓存
      ├── Durable Objects     锁座、批次分发、影院协调和通知投递
      ├── Cron Triggers       */3 * * * *，窗口过滤在代码内
      └── 出网                猫眼接口 / Bark / Server酱 / GitHub Release 元数据
```

### 目录结构

```
pages/                    # 前端源码（构建时按白名单复制）
├── index.html            # 工具箱首页
├── maoyan/               # 猫眼监控+锁座
│   ├── index.html        #   工具页（监控配置 + 锁座面板）
│   ├── app.js / lock.js  #   监控逻辑 / 锁座弹窗（座位图、官方对比区）
│   ├── admin.html/js     #   管理端（令牌签发/吊销）
│   └── secure-store.js   #   令牌 AES-GCM 加密存储
└── store/                # 应用商店

worker/                   # Cloudflare Worker（tools-api）
├── wrangler.toml         # Static Assets / cron / D1 / KV / DO 绑定
├── wrangler.example.toml # 不含生产 ID 的自部署模板
├── scripts/              # 静态白名单构建、容量测试和部署预检
├── src/
│   ├── index.js          # 路由分发 + scheduled 入口
│   ├── common/           # HTTP 工具 / 推送渠道（Bark、Server酱）
│   ├── maoyan/           # 猫眼域：api(上游) check(监控) cities user ddl
│   │                     #   cron(窗口) tokens(令牌) log notify
│   │                     #   lock-api/rule/client/runner/session(锁座链路)
│   │                     #   seat-feedback
│   └── store/proxy.js    # 应用商店文件代理
└── test/                 # node:test 单测

local/                    # 本地脚本（部分入库）
└── maoyan_lock.py        # CLI 版锁座工具：Chromium 登录一次 → HTTP 锁座

docs/                     # 本地文档，不入库（.gitignore）
└── maoyan-e2e-*          # E2E 测试方案与执行报告、座位口径报告、OpenAPI
```

---

## 开发与测试

```bash
# Worker 单测与静态资源构建
npm --prefix worker ci
npm --prefix worker test
npm --prefix worker run build:assets

# Web 与 Electron 单测
node --test pages/maoyan/*.test.cjs
npm --prefix desktop ci && npm --prefix desktop test

# 浏览器跨视口交互验收（截图目录必须在仓库外）
npm --prefix desktop run test:e2e -- --output /absolute/path/to/ui-verification
```

- **E2E**：本地 mock Worker + 无头 Chrome 覆盖 1440/1200/1024/768/390/320 视口、监控配置、锁座状态、官方图按需加载和公开申请满额页；截图和结果只写入命令指定的仓库外目录
- **独立部署**：按 [worker/DEPLOY-D1.md](worker/DEPLOY-D1.md) 创建自己的 D1/KV、配置 secret、使用 `schema.sql` 初始化全新数据库并构建，再部署 Worker；不支持旧 D1 schema 原地升级，模板默认关闭公开申请
- **发布**：合入 `master` 后 GitHub Actions 先执行 Worker/Web/Electron 验证，再创建 GitHub Release 并由各平台任务直接上传安装包；不上传 Actions artifact
- **前端发布惯例**：修改 `pages/maoyan/*.js`、`style.css` 等静态资源后，必须同步 bump `index.html` 中对应的 `?v=` 版本参数（格式 `v=YYYYMMDDx`），否则老用户会命中边缘缓存旧版
- **注意**：Worker 的监控批次在北京时间 23:00~06:59 整体跳过（代码内窗口过滤，cron 表达式保持分钟步进型），相关测试需 mock 时钟

---

## 免责声明

本项目仅供个人学习与技术研究。工具中的自动化访问与下单行为可能违反相关平台的服务条款，由此产生的一切后果由使用者自行承担。请勿将本项目用于商业代抢或任何规模化牟利用途。
