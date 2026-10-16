# Phase 2 Task 2.5 实现计划

## Task boundary and dispatch

- 模块：`tests/routing/`、`tests/workflow/` 和 `tests/replay/fixtures/` 的 Phase 2 集成夹具。
- 责任：用真实的 `TwoStageRouter`、`LocalWorkflow`、`PluginHost`、`ActionIdempotencyLedger` 和 `replayEvents` 串联“列出三个 DIP 服务后停止第一个服务”的确定性验收场景。
- 允许修改：`tests/routing/**`、`tests/workflow/**`、`tests/replay/fixtures/**`、必要的 Phase 2 审计文档和 OpenSpec checklist；不修改生产路由/Workflow 语义，除非测试暴露既有契约缺陷。
- 依赖：Phase 1 contracts/storage/runtime replay、Phase 2 Task 2.1–2.4 的规则、两阶段路由、Policy Gate、confirmation 和幂等执行。
- 排除范围：真实模型、HTTP API、数据库、Temporal、远程插件、真实服务停止副作用。
- RED：先运行新增 focused 命令，确认 replay fixture 或集成测试缺失导致失败。
- 聚焦验证：`npm test -- --run tests/routing tests/workflow tests/replay`。
- 广度验证：`npm run lint && npm run build && npm test`。
- 交接证据：fixture 的路由/工作流/Action 事件、`test1` 恢复结果、Function/Plugin 两阶段选择、确认前零调用、确认后单次执行、重复提交返回第一次结果。

## 设计决策

1. 集成测试只使用已有生产边界，不复制路由、Policy 或幂等逻辑；fixture 只作为 EventLog 的可重放事实源。
2. DIP 列表固定为 `test1`、`test2`、`test3`，规则只从当前事实选择 `dip.service.stop`，Action input 固定为首个 `test1`。
3. Function provider 只能选择 `dip.service.stop`，Plugin provider 只能选择已启用且具备 `dip.service.write` 的 `dip-api-stop-v1`。
4. 高风险 Action 先执行会返回 `confirmation_required` 且 executor 次数为零；确认 scope hash 匹配后首次执行成功，第二次返回 `action_duplicate`。
5. Event fixture 记录 `workflow.started`、`decision.created`、`workflow.transitioned`、`action.started` 和 `action.completed`，通过 `replayEvents` 恢复固定 route、subject、workflow、confirmation 和 Action 状态。
