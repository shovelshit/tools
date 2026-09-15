# ltools.asia · 自托管工具箱

跑在 Cloudflare Pages + Workers 全家桶上的实用工具集合，几乎零成本、无服务器运维。

**在线地址**：<https://ltools.asia/>

## 工具一览

| 工具 | 说明 | 形态 |
|---|---|---|
| 🎬 [猫眼场次监控 + 自动锁座](https://ltools.asia/maoyan/) | 监控影院排片变化，新场次推送到手机；开售后自动锁座 | Pages 前端 + Worker（KV / Durable Object / Cron） |
| 📦 [应用商店](https://ltools.asia/store/) | 浏览和下载 AList 网盘中的应用，云端加速直连、在线预览 | Pages 前端 + Worker 文件代理（无需登录） |
| 🚗 领克签到助手 | 领克 App 自动签到、分享任务、积分查询与 Bark 推送 | Python 脚本 · [独立仓库](https://github.com/shovelshit/LynkCoHelper) |
| 📶 蓝牙调试助手 | 低功耗蓝牙调试工具，扫描/读写特征值/订阅通知，可替代 nRF Connect | 微信小程序 + iOS · [独立仓库](https://github.com/shovelshit/BLE-debug) |

---

## 🎬 猫眼场次监控 + 自动锁座

解决两个痛点：**想看的场次（IMAX/首映）一开售就没了**、**开售时间不可预测要一直刷**。

### 场次监控

- 城市 → 影院模糊搜索 → 勾选关注影片，配置即自动保存
- 推送渠道支持 **Bark / Server酱**，须先发送测试推送验证通过才能开启监控
- 云端 Cron **每 3 分钟**检查一次排期（北京时间 07:00~22:59 窗口内），新增场次即时推送到手机
- 存储写入按批条件落盘：无变化批次不写库（控制 KV 写额度消耗），页面「上次检查」最多滞后 30 分钟（心跳兜底，有新场次/异常时即时更新）
- 监控有效期 30 天，每次开启自动续期；推送渠道失效时自动停止监控并告警，避免"静默失效"

### 自动锁座

- 上传一次猫眼登录会话（浏览器 cookie 快照，≤256KiB，仅存于本人数据空间）
- 场次来源三分支：**目标场次** / **其他日期真实可锁场次** / **模板推断场次**（目标日期未开排片时，以最后排期日的末班场次推断未来座位布局，全部可选、开售后按实际售卖为准）
- 座位图与猫眼主站口径对齐：物理格布局（过道占位、孤立座、跨排错位）、情侣座连体渲染、滚轮/拖动/捏合缩放
- **官方座位图 1:1 只读对比区**：Worker 提取官方 seats-block 片段，无脚本沙箱 iframe + 官方 CSS 副本渲染，自适应缩放
- 目标场次开售后由 Durable Object（`LockCoordinator`）自动执行锁座，成功后推送通知（座位 + 支付倒计时）
- 单规则约束：同一令牌同时只允许一条进行中的规则，防止并发误下单
- 锁座异常原因可一键上报（seat-feedback），便于定位问题

### 安全设计

- **访问令牌制**：非公开注册。管理端（`X-Admin-Token` 鉴权）签发/吊销访问令牌，各令牌数据完全隔离
- 浏览器侧令牌 AES-GCM 加密后存 localStorage（`secure-store.js`），防设备本地明文泄露
- 猫眼会话仅存于本人 KV 空间；全链路错误信息不含会话凭据
- 官方座位图片段在 `sandbox=""` iframe 内**零脚本**渲染，埋点属性剥离

## 📦 应用商店

浏览 / 下载 AList 网盘中的应用资源。Worker 侧做云端代理直连加速，支持在线预览，无需登录。

---

## 架构

```
浏览器
  ├── Cloudflare Pages（静态前端 pages/）
  │       ├── /           工具箱首页
  │       ├── /maoyan/    猫眼监控+锁座（app.js 监控 / lock.js 锁座 / admin.html 管理端）
  │       └── /store/     应用商店
  │
  └── Worker tools-api（worker/，路由 ltools.asia/api/* 与 /store/*）
          ├── KV（MAOYAN_KV）      用户配置 / 场次快照 / 变更日志 / 锁座规则 / 会话
          ├── Durable Object       LockCoordinator：锁座协调（SQLite-backed）
          ├── Cron Triggers        */3 * * * *：监控批次（窗口过滤在代码内）
          └── 出网                  猫眼接口 / Bark / Server酱
```

### 目录结构

```
pages/                    # Cloudflare Pages 静态资源
├── index.html            # 工具箱首页
├── maoyan/               # 猫眼监控+锁座
│   ├── index.html        #   工具页（监控配置 + 锁座面板）
│   ├── app.js / lock.js  #   监控逻辑 / 锁座弹窗（座位图、官方对比区）
│   ├── admin.html/js     #   管理端（令牌签发/吊销）
│   └── secure-store.js   #   令牌 AES-GCM 加密存储
└── store/                # 应用商店

worker/                   # Cloudflare Worker（tools-api）
├── wrangler.toml         # 路由 / cron / KV / DO 绑定（keep_vars=true）
├── src/
│   ├── index.js          # 路由分发 + scheduled 入口
│   ├── common/           # HTTP 工具 / 推送渠道（Bark、Server酱）
│   ├── maoyan/           # 猫眼域：api(上游) check(监控) cities user ddl
│   │                     #   cron(窗口) tokens(令牌) log notify
│   │                     #   lock-api/rule/client/runner/session(锁座链路)
│   │                     #   seat-feedback
│   └── store/proxy.js    # 应用商店文件代理
└── test/                 # node:test 单测（16 个文件）

local/                    # 本地脚本（部分入库）
└── maoyan_lock.py        # CLI 版锁座工具：Chromium 登录一次 → HTTP 锁座

docs/                     # 本地文档，不入库（.gitignore）
└── maoyan-e2e-*          # E2E 测试方案与执行报告、座位口径报告、OpenAPI
```

---

## 开发与测试

```bash
# Worker 单测（16 个文件：锁座链路 / 监控与写入去重 / 令牌 / 配置 / cron 窗口）
cd worker && npm test

# 前端单测（app / lock 纯函数）
node --test pages/maoyan/app.test.cjs pages/maoyan/lock.test.cjs
```

- **E2E**：本地 mock harness + 无头 Chrome 全链路断言（8 个分部），测试方案与执行报告见 `docs/maoyan-e2e-test-plan.md` / `docs/maoyan-e2e-report.md`
- **部署**：
  - Pages：push 到本仓库自动部署
  - Worker：`wrangler deploy`（`keep_vars=true`，环境变量在 Dashboard 管理；`ADMIN_TOKEN` 为 secret，`wrangler secret put` 注入）
- **前端发布惯例**：修改 `pages/maoyan/*.js`、`style.css` 等静态资源后，必须同步 bump `index.html` 中对应的 `?v=` 版本参数（格式 `v=YYYYMMDDx`），否则老用户会命中边缘缓存旧版
- **注意**：Worker 的监控批次在北京时间 23:00~06:59 整体跳过（代码内窗口过滤，cron 表达式保持分钟步进型），相关测试需 mock 时钟

---

## 免责声明

本项目仅供个人学习与技术研究。工具中的自动化访问与下单行为可能违反相关平台的服务条款，由此产生的一切后果由使用者自行承担。请勿将本项目用于商业代抢或任何规模化牟利用途。
