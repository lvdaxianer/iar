# Phase 2 Task 2.2 实现计划

## Task boundary and dispatch

- 模块：`packages/decision/`。
- 责任：Mock DecisionProvider、有限候选输入、统一 choice/score/rejection/noul 校验。
- 允许修改：`packages/decision/**`、`tests/routing/**`、本任务审计和 OpenSpec checklist。
- 依赖：Phase 1 `DecisionResult` contract、Phase 2 Task 2.1 的有限候选证据。
- 排除范围：真实模型 Provider、Function/Plugin 两阶段 Orchestrator、Policy Gate、确认、Action 执行、持久化和外部网络。
- 聚焦验证：`npm test -- --run tests/routing`。
- 广度验证：`npm run lint && npm run build && npm test`。
- 交接证据：Mock provider 输入边界、choice/score/rejection/noul 结果、阈值/空候选/不可区分测试和 replay-safe 输出。

## 设计决策

1. Provider 接收只读、有限且带结构化约束的候选集合。
2. Provider 的原始输出视为不可信值，必须经过统一运行时校验。
3. `choice` 必须属于输入候选；额外候选、错误版本、错误 decisionType 和非法分数统一拒绝。
4. 分数低于阈值返回 `needs_clarification`，不产生可执行 choice。
5. 空候选返回 `noul`；最高 priority/specificity 并列返回 `needs_clarification`。
6. 校验结果只描述决策，不授予 capability、不改变 Function ownership、不绕过插件状态门禁。
