# Phase 2 Task 2.4 实现计划

## Task boundary and dispatch

- 模块：`packages/workflow/` 本地确定性工作流、Policy Gate 和确认/重试扩展。
- 责任：状态机转移、风险/能力策略门禁、确认 scope hash、retryable 错误分类、超时、取消、resume 和 Action 幂等提交。
- 允许修改：`packages/workflow/**`、必要的 `packages/runtime/**` 导出、`tests/workflow/**`、本任务审计和 OpenSpec checklist；同步更新 workspace `package-lock.json` 以记录 workflow/runtime 依赖。
- 依赖：Phase 1 contracts/runtime `ActionIdempotencyLedger`、Phase 2 Task 2.3 路由结果。
- 排除范围：真实模型、Fastify/PostgreSQL/Temporal、远程插件、真实 executor 和跨进程 durable worker。
- 聚焦验证：`npm test -- --run tests/workflow`。
- 广度验证：`npm run lint && npm run build && npm test`。
- 交接证据：本地状态图、Policy/confirmation hash、retry/timeout/cancel/resume 结果、重复 Action 幂等证据。

## 设计决策

1. WorkflowDefinition 只允许显式 transition；未知状态、非法事件和终态转移 fail-closed。
2. Policy Gate 在 Action 提交前同时检查风险、required capabilities、授权结果和确认 scope hash。
3. 高风险或显式要求确认的动作必须有匹配当前 actionId、pluginId、input 和 scope 的 confirmed state。
4. retry 只允许 retryable 错误且不改变 actionId/idempotencyKey；不可重试错误直接 failed。
5. timeout 和 cancel 进入稳定终态，executor 不会在 gate 失败、未确认或取消后被调用。
6. resume 只从 waiting/running 的非终态恢复，并复用同一 ActionIdempotencyLedger，重复副作用返回第一次结果。

## 一致性说明

Task 2.4 只新增本地内存 workflow 包；已有 runtime ActionIdempotencyLedger 作为唯一 Action 幂等边界复用，不重复实现持久化存储或执行器。
