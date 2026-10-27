# Proposal

## Why

已完成、已取消或已失败的工作流仍被当作下一轮输入的强约束，导致事实追问被错误解释为旧工作流事件，并在进入事实回答前返回 `workflow_transition_invalid`。同时，模型在查询已验证结果时可能输出能力样式的 intent，当前运行时缺少统一的只读上下文归一化边界。

## What Changes

- 将进行中的 Workflow 状态与终态结果分离；终态只保留为历史结果，不阻塞下一轮新请求。
- 增加只读上下文问答事件语义，事实查询不推进工作流、不授予执行权限。
- 在普通和流式入口共享事实追问归一化，避免模型输出的能力样式 intent 进入业务路由。
- 保留参数收集、确认和执行阶段的非法事件拒绝与现有安全门禁。
- 增加状态投影、提示词、普通/流式会话和 Pi bridge 回归测试，并用 Agent Sandbox 手工清单验证多轮上下文场景。

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `behavior-state`: 进行中状态与 completed/cancelled/failed 终态结果分离，保留可恢复事实和路由证据。
- `workflow-event-protocol`: 增加上下文问答的非迁移语义，终态允许进入新的受控输入但不授予执行权。
- `structured-model-context`: 事实追问统一归一化为只读上下文回答，并保持普通、流式和 Pi bridge 的安全边界一致。

## Impact

- 影响 `packages/runtime` 的 Workflow context 投影与转换表。
- 影响 `examples/agent-sandbox` 的语义提示、普通/流式会话编排和 Pi bridge 兜底。
- 影响 contracts 中的 Workflow event 枚举，但保持现有字段结构和执行门禁兼容。
- 不新增业务专用关键词、Function、Plugin 或模型调用。
