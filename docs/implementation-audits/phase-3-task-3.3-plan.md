# Phase 3 Task 3.3 实现计划

## Task boundary and dispatch

- 模块：`packages/adapters/fastify/`，复用 `LocalWorkflow`、`PluginHost`、contracts runtime validation 和 Phase 3.1 的脱敏原则。
- 责任：提供创建 run、提交 follow-up input、提交 confirmation、查询 run，以及 plugin install/enable/disable 的 Fastify HTTP adapter。
- 允许修改：`packages/adapters/fastify/**`、根 `package.json`/`package-lock.json` 的 Fastify 依赖、`tests/integration/fastify/**`、本任务计划/审计和 OpenSpec checklist。
- 依赖：Phase 2 `LocalWorkflow`/`PolicyGate`/`PluginHost`/contracts；不改变两阶段路由、策略、确认或工作流语义。
- 排除范围：真实模型调用、数据库/网络外部副作用、身份认证系统、完整敏感上下文回显、Phase 3.4 示例插件。
- RED：先添加 Fastify inject contract tests，验证 7 条路由、统一 `traceId`/`runId`/`version`/`error` 响应、坏请求稳定错误、敏感请求字段不回显，以及 plugin lifecycle delegation。
- 聚焦验证：`npm test -- --run tests/integration/fastify`。
- 广度验证：`npm run lint && npm run build && npm test`。

## API design decisions

1. 所有成功和失败响应都使用版本化 envelope；成功返回有限的 `data`，失败只返回稳定 `code`/`message`/`retryable`，不传播内部异常正文。
2. `WorkflowRun` 只向 HTTP 暴露状态、确认和错误摘要，不暴露 `definition`、Action input、raw prompt、raw user input、密钥或完整上下文。
3. follow-up input 只记录脱敏摘要和接收时间，不把原始输入放入 adapter 内部状态或响应；confirm 仍交给 `LocalWorkflow.confirm` 做 scope hash 和 Policy 边界校验。
4. plugin install/enable/disable 只委托 `PluginHost`，响应仅返回 pluginId、functionId、version、state 等有限 manifest 摘要。
5. Fastify 只负责 HTTP 参数/JSON 边界和序列化，真实业务编排继续由 runtime/workflow/plugin-host 持有。
