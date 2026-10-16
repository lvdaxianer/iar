# Phase 3 Task 3.3 实现审计

## 结论

- 状态：通过，可交接 Phase 3 Task 3.4。
- 范围：`packages/adapters/fastify/`、Fastify runtime dependency、Fastify integration contract tests。
- 未实现：真实身份认证、数据库/远程服务、模型调用、示例插件和执行器扩展。

## 实现结果

- 新增 Fastify adapter，提供 `POST /v1/runs`、`POST /v1/runs/:runId/input`、`POST /v1/runs/:runId/confirm`、`GET /v1/runs/:runId`、`POST /v1/plugins/install`、`POST /v1/plugins/:pluginId/enable` 和 `POST /v1/plugins/:pluginId/disable`。
- 所有成功、业务失败、非法 JSON、未知路由和未预期异常均使用 `iar.fastify-response/v1` envelope，包含 `traceId`、`runId`、`version` 和 `error`。
- Workflow API 只暴露 run 状态、confirmation 和错误摘要；definition、Action input、raw prompt、raw user input、密钥和完整敏感上下文不会进入公开响应。
- Plugin lifecycle 委托现有 `PluginHost` 的契约、Function 归属、依赖和状态机校验；HTTP 仅返回 pluginId、functionId、version、state 摘要。
- 请求 hook 只记录 requestId、traceId、method、path、耗时和状态；解析错误、未知路由和内部异常通过统一安全 error handler 收敛。
- follow-up input 只验证 JSON 边界并返回 accepted，不在 adapter 内部保存原始输入；confirmation 继续由 `LocalWorkflow` 校验 run、scope hash、终态和 Policy 语义。

## RED -> GREEN 证据

- RED：focused tests 首先因 `packages/adapters/fastify/src/index.js` 尚不存在而编译失败。
- GREEN：引入 Fastify 依赖并实现 adapter 后，Fastify focused suite 通过 4/4；reviewer 补充了 invalid JSON、unknown route、unknown plugin 和统一日志边界回归。

## 验证与审查

- `npm run lint`：通过。
- `npm run build`：通过。
- Fastify focused tests：4/4 通过。
- `npm test`：132/132 通过。
- package imports：通过，包含 Fastify adapter 构建产物和现有 decision/workflow 包入口。
- `openspec validate iar-five-phase-roadmap --strict`：通过。
- `git diff --check`：通过。
- canonical reviewer：PASS；MUST/SHOULD 均无。reviewer 确认 7 条路由均复用现有核心服务，公开投影、错误映射、异常边界、日志字段和文件规模符合约束。

## 安全边界

- raw prompt、raw user input、API key、Authorization、Action password 和完整 Manifest 不出现在响应 envelope 或 request log。
- JSON parser、getter/prototype、循环引用、未知路由和内部异常均 fail-closed 为稳定错误，不透传 Fastify/Workflow 原始错误正文。
- Fastify 只作为 HTTP adapter；不复制 route、Policy、confirmation、PluginHost 生命周期或 Workflow 状态语义。
