# Phase 4 Task 4.2 实现计划

## Task boundary and dispatch

- 模块：`packages/adapters/service/**`、`packages/adapters/sidecar/**`、`packages/cli/**`、`tests/integration/service/**`、`tests/integration/sidecar/**`、`tests/integration/cli/**`。
- 责任：把现有 Fastify `/v1` contract 提升为带 tenant/actor 授权的 Service API，提供可独立传输的 Sidecar JSON/HTTP 边界，并提供 `install`、`enable`、`disable`、`inspect`、`replay` CLI 命令。
- 允许修改：上述模块、root workspace/package-lock、Task 4.2 focused tests、该计划/审计文件和 OpenSpec checklist；不改变 Fastify v1 envelope、LocalWorkflow、PluginHost 或 PostgreSQL storage 的既有语义。
- 排除范围：Worker/container executor、OpenTelemetry/Pino、真实远程插件目录、Temporal、消息队列和跨语言 ABI。
- 依赖：Phase 3 `createFastifyApp`、`FastifyApiResponse`、`LocalWorkflow`、`PluginHost`、`replayEvents`；Phase 4.1 的 tenant authorization vocabulary 只复用于请求边界。
- RED：先添加 Embedded/Fastify 与 Service/Sidecar 同 fixture 的 contract test、授权拒绝 test、malformed transport test 和 CLI command test，确认 service API/sidecar/CLI 入口尚不存在。
- 聚焦验证：`npm test -- --run tests/integration/service tests/integration/sidecar tests/integration/cli`。
- 广度验证：`npm run lint && npm run build && npm test`。

## Design decisions

1. `ServiceApi` 是唯一 transport-neutral service boundary。请求包含 `protocolVersion`、`requestId`、`traceId`、`TenantRequestContext`、有限 operation 和 JSON payload；响应保留既有 `iar.fastify-response/v1` 的 `data/error/runId/version` 语义，并附带 service `protocolVersion`、requestId 和 tenantId。
2. Service API 在每次请求处理前执行 actor/tenant authorizer，授权失败 fail-closed；授权通过后按 tenant 缓存同一 `FastifyHostOptions` app，因此同一租户的 Workflow/PluginHost 状态可跨请求保留，不同租户不能共享状态。
3. Sidecar transport 只做 JSON/HTTP framing、协议校验和请求转发，不复制运行时语义。`handleJson` 用于 Unix socket/stdio 等宿主，`createSidecarServer` 提供标准 Node HTTP server；两条路径都调用同一个 ServiceApi。
4. CLI 是 ServiceApi 的 typed client，不直接访问 `LocalWorkflow`、`PluginHost` 或 SQL。命令参数只接受 JSON manifest/ID/tenant/actor，输出结构化 JSON，错误使用稳定 exit code 和 service error，不回显原始 payload。
5. `inspect` 支持 plugin 摘要，`replay` 按 tenant/可选 runId 对 workflow event log 调用 `replayEvents`；嵌入式、Service 和 Sidecar 使用相同 deterministic fixture 比较状态与错误。

## Reliability and security evidence

- 协议：拒绝错误版本、未知 operation、非 JSON payload、缺失 request/context 字段和超限 body；响应不携带原始异常文本。
- 授权：authorizer 在 host 工厂和任何业务操作前执行；授权器抛错按拒绝处理；tenant 只参与 host/cache key，不由 payload 覆盖。
- 一致性：Service API 的 run/plugin operations 通过现有 Fastify routes；Sidecar 不新增第二套状态机；replay 只读取事件并返回投影。
- 资源：Sidecar HTTP body 有明确上限，客户端和 server 在请求结束时释放资源；CLI 不启动隐式网络连接。
- 日志：本任务不新增生产日志，不记录 manifest payload、raw input、API key 或 authorization；Fastify 已有安全 request boundary 继续生效。

## TDD steps

1. RED：新增 service/sidecar/cli focused tests，先验证入口缺失或返回失败。
2. GREEN：实现 protocol types、ServiceApi、Sidecar JSON/HTTP transport 和 CLI parser/dispatcher。
3. REFACTOR：补充租户 cache、协议错误、body limit、replay filtering 和稳定 JSON 输出。
4. REVIEW：固定 reviewer 通过后写 implementation audit，单独勾选 OpenSpec 4.2。
