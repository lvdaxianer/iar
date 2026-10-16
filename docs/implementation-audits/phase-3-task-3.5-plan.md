# Phase 3 Task 3.5 实现计划

## Task boundary and dispatch

- 模块：`tests/integration/model-gateway/**`、`tests/integration/fastify/**`、`tests/contract/examples/**` 的测试补强。
- 责任：补足 Mock Provider、API contract、Plugin contract 和三个示例通过宿主边界的确定性端到端测试。
- 允许修改：测试目录、`docs/implementation-audits/phase-3-task-3.5*`、OpenSpec checklist；不新增生产业务语义。
- 依赖：Phase 3.1–3.4 已交付的 ModelGateway、Fastify adapter、PluginHost 和三个示例插件。
- 排除范围：真实模型 SDK、真实网络、真实工单/知识库/人工队列、生产路由/Policy/Workflow 修改。
- RED：先添加真实 provider unavailable、API error envelope、PluginHost+Handler 端到端测试，确认测试缺少对应跨边界覆盖。
- 聚焦验证：`npm test -- --run tests/integration/model-gateway tests/integration/fastify tests/contract/examples`。
- 广度验证：`npm run lint && npm run build && npm test`。

## Design decisions

1. Mock Provider 只产生确定性成功、不可用、超时和 schema-invalid 结果，验证真实 provider 不可用时 gateway 仍返回安全稳定结果。
2. API contract tests 通过 Fastify `inject` 验证统一 envelope、坏 JSON、未知路由、敏感字段和 Plugin lifecycle，不监听真实端口。
3. 示例端到端测试从 Fastify install/enable 入口取得 PluginHost，再调用真实 SDK Handler，验证同一 Manifest/Handler 边界贯通且无外部副作用。
