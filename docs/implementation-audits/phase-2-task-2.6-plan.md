# Phase 2 Task 2.6 实现计划

## Task boundary and dispatch

- 模块：`packages/workflow/` 的本地可重放事件 sink，以及 `tests/workflow/**`、`tests/replay/**` 的 Phase 2 集成验证。
- 责任：让 Workflow 启动/状态转移、Action started/completed/failed 和有效 Action 拒绝路径产生版本化 EventEnvelope；验证事件可被 `replayEvents` 投影。
- 允许修改：`packages/workflow/**`、`tests/workflow/**`、`tests/replay/**`、本任务审计和 OpenSpec checklist；不修改 Phase 2 路由/Policy 的语义。
- 依赖：Phase 1 EventEnvelope/BehaviorContext/replay/storage、Task 2.4 LocalWorkflow/ActionExecutionService、Task 2.5 stop-service fixture。
- 排除范围：PostgreSQL、Temporal、HTTP API、外部模型、真实插件 executor 和跨进程 durable queue。
- RED：先添加 Action 事件回放集成测试，确认当前 LocalWorkflow 结果没有事件输出。
- 聚焦验证：`npm test -- --run tests/workflow tests/replay`。
- 广度验证：`npm run lint && npm run build && npm test`。
- 交接证据：成功、Policy/confirmation 拒绝、executor 失败、重复 Action 和状态竞态均有 `action.*` 事件，并可由 `replayEvents` 恢复安全投影。

## 设计决策

1. 使用可注入的进程内 `WorkflowEventLog`，默认使用稳定递增 eventId；测试注入固定 clock，生产调用可使用宿主 clock。
2. `LocalWorkflow` 暴露只读事件快照并记录 Workflow started/transitioned；`ActionExecutionService` 记录 Action started/completed/failed。
3. Policy/confirmation/terminal/waiting/idempotency 等有效 Action 拒绝统一记录 `action.failed`，payload 保留稳定 reasonCode；无法形成合法 Action 的 malformed 输入不伪造事件。
4. 事件只记录 JSON-safe Action 摘要和结果，不调用 executor，不把事件回放当作副作用执行。
5. 事件 sink 是本地验证边界，不替代 Phase 4 durable EventStore；后续适配器只需复用 EventEnvelope 语义。
