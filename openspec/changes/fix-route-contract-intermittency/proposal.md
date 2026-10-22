# Proposal

## Why

路由模型偶发返回缺失或互相冲突的 `operation`，运行时目前把缺失、冲突和非法操作统一显示成“缺少 operation”，既可能造成错误诊断，也无法证明 Function 没有被错误执行。需要把 operation 契约收敛为单一权威来源，并记录安全、可关联的期望值与实际值。

## What Changes

- 将嵌套路由结果中的外层 `operation` 作为唯一权威路由标识，禁止模型在 `arguments` 中重复填写 `operation`。
- 在执行前区分缺失、非法、冲突和参数 Schema 校验错误，所有不符合契约的结果安全阻断，不调用 Handler。
- 增加带 `traceId`/`requestId` 的双语结构化契约校验日志，记录允许值、期望值、实际值、阶段、模型角色和处理结果，不记录原始 Prompt、模型全文或凭据。
- 在宿主诊断信息中展示契约错误码和 Trace 关联信息，保留现有耗时展示。
- 增加单元、集成和重复请求测试，验证偶发错误可分类、可追踪且不会产生副作用。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `nested-plugin-function-routing`: 明确嵌套路由 `operation` 的单一来源，并规定契约冲突时的阻断行为。
- `function-call-routing`: 增加稳定的契约错误分类、operation 校验和执行前阻断要求。
- `response-observability`: 增加模型契约错误的双语日志、期望/实际值和宿主诊断展示要求。

## Impact

- 影响 `packages/runtime` 的嵌套路由和 Function-call 校验边界。
- 影响 Sandbox 会话错误结果、路由证据和 Timing/诊断展示。
- 影响 `safe-log` 的字段白名单与双语格式化日志。
- 不新增外部 API 路由，不改变 Plugin 注册协议；现有合法路由和响应模式保持兼容。
