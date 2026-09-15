# 猫眼紧凑玻璃界面实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Web 与 Electron 共用的猫眼监控页面改造成已确认的 B9 紧凑动态版，提供四步导航、分离的进度/主面板和失焦可暂停的几何背景，同时不改变任何 Worker、登录态或锁座请求语义。

**Architecture:** 保留 `pages/maoyan` 的静态共享页面和全部业务 DOM ID。新增一个无依赖的 `workflow.js`，只负责从现有业务状态推导可访问步骤、切换工作区和控制背景动画生命周期；`app.js` 继续拥有网络请求与业务状态。HTML 只重排信息层级，CSS 负责 B9 视觉和响应式，Electron 继续原样打包同一套资源。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node.js test runner、Electron、Playwright Core。

---

### Task 1: 固定四步状态模型与动效生命周期

**Files:**
- Create: `desktop/test/ui-workflow.test.cjs`
- Create: `pages/maoyan/workflow.js`
- Modify: `desktop/package.json`

- [x] 在 `desktop/test/ui-workflow.test.cjs` 写入状态模型测试：未连接停在步骤 1；连接后开放步骤 2；选影院后开放步骤 3；选中影片后开放步骤 4；手动返回已开放步骤有效，越级请求被夹到当前最大步骤。
- [x] 运行 `node --test test/ui-workflow.test.cjs`，确认因 `workflow.js` 尚不存在而按预期失败。
- [x] 实现 `deriveWorkflowState`，返回每步的 `complete/available/active` 和合法 `activeStep`，不读取 DOM、不发请求。
- [x] 再次运行单测并确认通过。
- [x] 增加动效生命周期测试：文档隐藏或窗口失焦时添加暂停状态；重新聚焦且页面可见时恢复；清理后监听器不再生效。
- [x] 运行测试，确认新断言因控制器缺失而按预期失败。
- [x] 实现 `bindAmbientMotion`，只切换页面根节点的 `motion-paused` 类，并返回清理函数。
- [x] 运行 `node --test test/ui-workflow.test.cjs` 和 `npm test`，确认 Task 1 全绿。

### Task 2: 重组共享页面并建立紧凑玻璃视觉

**Files:**
- Modify: `desktop/test/smoke.cjs`
- Modify: `pages/maoyan/index.html`
- Modify: `pages/maoyan/style.css`
- Verify unchanged: `pages/maoyan/maoyan-seat.css`

- [x] 先扩展 Electron smoke：连接后断言存在动态背景、四步导航、两个独立一级玻璃面板；主工作区在桌面不超过视口约 72%；移动视口下进度在主面板上方且操作控件达到触控尺寸。
- [x] 运行 `npm run test:smoke`，确认旧页面因缺少新结构而按预期失败。
- [x] 重组 `index.html`：加入非交互几何背景、紧凑场景栏、独立步骤面板和单一主面板；把影院、影片、通知/运行记录分别放入步骤 2-4；移除“使用说明”卡片；保留全部既有业务 ID 和锁座弹窗结构。
- [x] 在页面中以正确顺序加载 `workflow.js`，同时更新静态资源版本参数，避免 Web 缓存旧布局。
- [x] 重写 `style.css` 的布局和视觉变量：68% 桌面工作区、两块一级玻璃、银灰/青灰/红色几何板、紧凑字段与按钮、稳定 focus/disabled/loading 状态；内层信息用分隔线而非嵌套卡片。
- [x] 将几何板动画限制在 `transform/opacity`，周期 14-19 秒、位移不超过 24px；为 `.motion-paused` 和 `prefers-reduced-motion` 提供停止规则。
- [x] 补齐 1020px、760px 和 640px 以下布局：移动端单列、横向步骤、输入和按钮至少 40px，锁座图可平移且不被工具栏覆盖。
- [x] 确认 `maoyan-seat.css` 仅用于沙箱内官方座位图，不应被外层主题或缓存版本改动。
- [x] 运行 `npm run test:smoke`，确认结构、桌面和移动布局断言通过。

### Task 3: 将现有业务状态接入分步导航

**Files:**
- Modify: `desktop/test/ui-workflow.test.cjs`
- Modify: `desktop/test/smoke.cjs`
- Modify: `pages/maoyan/app.js`

- [x] 先为步骤渲染行为补测试：每次只显示一个工作区；完成态和 `aria-current` 正确；不可用步骤不能进入；返回按钮可回到已开放步骤。
- [x] 运行相关测试，确认因页面尚未接线而按预期失败。
- [x] 在 `app.js` 中建立单一 `workflowStep` 和 `syncWorkflowUi`，输入仅来自现有 `connected`、`cinemaSelected`、`getSelectedIds()`、`pushVerified`、`monitorEnabled`。
- [x] 在连接成功、配置恢复、影院选择/失败、影片勾选、渠道测试、监控启停和 profile 重置后同步步骤，不改变原 API 调用顺序和请求体。
- [x] 接入步骤按钮、上一步和下一步；下一步只在前置条件满足时开放，错误提示留在相关步骤内。
- [x] Worker 地址继续经过既有规范化与 HTTP 风险逻辑，页面不写入或展示 Token。
- [x] 运行 `node --test test/ui-workflow.test.cjs` 和 `npm run test:smoke`，确认状态与真实 Electron 流程通过；Electron 全量回归放在最终验证统一执行。

### Task 4: 视觉与回归验证

**Files:**
- Modify: `desktop/test/smoke.cjs`（仅在发现缺失覆盖时）
- Create: `desktop/dist/ui-desktop.png`
- Create: `desktop/dist/ui-mobile.png`

- [x] 使用 Electron/Playwright 在 1440 x 900、1024 x 720、768 x 1024 和 390 x 844 检查布局；保存代表性桌面与移动截图到 `desktop/dist`（构建产物不提交）。
- [x] 比较两次背景采样：几何色板应发生位移，而主面板边界和控件坐标保持不变；窗口失焦和 reduced-motion 下背景位置保持稳定。
- [x] 检查连接页、步骤 2-4、运行态和锁座弹窗，无横向溢出、文字遮挡或不可达按钮。
- [x] 运行 `git diff --check`、Electron 全量测试、Worker 全量测试和 Electron smoke。
- [x] 检查 `git status`，只提交源码、测试和计划，不提交 `dist`、登录态、`.DS_Store` 或 `.superpowers`。
- [ ] 提交并推送 `codex/maoyan-compact-glass-ui`。
