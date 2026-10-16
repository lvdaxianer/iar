# Phase 3 Task 3.2 实现计划

## Task boundary and dispatch

- 模块：`packages/decision/src/model-gateway/`，复用 Phase 3.1 的 `ModelProfileRegistry`、`ModelAuditRecorder` 和 `config/models.yaml`。
- 责任：实现统一 `ModelGateway` provider 边界，以及 Semantic Extractor、JEV Function Decision、JEV Plugin Decision、Context Compactor、Response Generator 五类 adapter。
- 允许修改：`packages/decision/**`、`tests/integration/model-gateway/**`、本任务计划/审计和 OpenSpec checklist。
- 依赖：Phase 2 `DecisionProvider`/`DecisionResult`、contracts 的 Decision/Compaction Schema、Phase 3.1 profile/redaction/audit contract。
- 排除范围：真实模型 SDK、API/HTTP、Fastify、示例插件、改动两阶段路由/Policy/Workflow 语义，以及真实 provider fallback 调度以外的业务编排。
- RED：先添加 provider timeout、schema invalid、threshold rejection、retry/fallback、五类 role routing 和 audit/event focused tests。
- 聚焦验证：`npm test -- --run tests/integration/model-gateway tests/routing/decision-provider.test.ts`。
- 广度验证：`npm run lint && npm run build && npm test`。

## 设计决策

1. `ModelGateway` 只接受结构化 JSON input，按 profile.provider 选择显式注册的 `ModelProvider`；未知 provider、非法请求和异常均返回稳定错误，不泄漏原始异常消息。
2. 每次 primary 调用使用 profile 的 timeout/retryPolicy；primary 终止失败后才按 `fallbackProfileId` 使用 fallback。fallback 缺失、provider 不存在、超时和 schema 失败都保持可审计的 outcome/event。
3. provider 原始输出永远先进入 role adapter 的 Schema/contract validator；JEV 复用 `validateDecisionOutput`，Context Compactor 复用 `validateContract('compactionResult', ...)`，Semantic/Response 使用本任务的严格 JSON validator。
4. threshold rejection、`needs_clarification`、`noul` 是合法 DecisionResult 的稳定结果和事件，不得被转换成可执行 choice；真正的 provider、timeout、schema 和 fallback failure 走 ModelGateway error。
5. provider request 可以携带业务输入，但 audit metadata、公开事件和错误 details 必须经过 `redactModelRequest`；真实模型 SDK 不在本任务引入。
