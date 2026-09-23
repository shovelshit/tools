# 猫眼账号维护扫描简化实施计划

日期：2026-09-23（北京时间）
范围：账号提醒生成、三十天归档、撤销清理的扫描进度与后台维护状态。设计依据：`../specs/2026-09-23-maoyan-maintenance-simplification-design.md`。

## 1. 维护扫描及每日状态

- 修改 `worker/src/maoyan/tokens.js`、`worker/src/maoyan/maintenance-store.js` 和必要的 cron 路由。保留原表结构与短租约，移除持久游标的行为依赖；每个维护 tick 重新查询未处理候选，每项至多处理 50 条。
- 提醒按北京时间当前阶段筛选，并以已入队的 `event_key` 排除成功候选；归档和撤销使用剩余业务标记。成功扫描后同日继续可查；关窗后仅核验，不生成提醒。
- 首次观测写入可去重的审计记录；区分未开始观测、未执行、未完成、已完成。当天窗口修改后仍可重新扫描，过往日期不重新计算。
- 在 `worker/test/tokens.test.js`、`worker/test/maintenance-store.test.js` 等增补同日新增、51 条分页、窗口末尾、并发租约、空集、关窗、跨日、旧表兼容等回归测试。先看到目标用例失败，再实现。

## 2. 看板及运维说明

- 扩展 `worker/src/maoyan/dashboard.js` 和 `worker/test/dashboard.test.js`：逐项提供当前维护日的扫描状态和完成时间，保留通知送达状态的独立展示。
- 更新 `pages/maoyan/admin.html`、`pages/maoyan/admin-dashboard.js`，显示提醒、归档、撤销三项状态与完成时间，解释状态仅代表扫描入队。
- 更新 `worker/DEPLOY-D1.md` 和设计文档状态，说明现有 D1 表结构仍可用、旧 `cursor` 不参与进度判断，以及首次观测的含义。为反复查询审计事件增加可重放的加法索引迁移。

## 3. 核验及交付

- 执行 Worker 和前端相关测试、静态资源构建、Wrangler dry-run、迁移兼容性验证及 `git diff --check`。
- 独立测试和需求验收复核后提交实现与注明日期及范围的文档；尝试推送已有分支。生产 D1 迁移和 Worker 部署另行执行。
