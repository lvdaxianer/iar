# Phase 3 Task 3.1 实现计划

## Task boundary and dispatch

- 模块：`config/models.yaml` 与 `packages/decision/` 的 ModelProfile、配置 registry、请求脱敏和 profile/model 版本审计。
- 责任：定义角色配置、timeout/retry/fallback、structured output、配置版本和模型版本；提供不记录 API key、raw prompt、raw user input 的审计入口。
- 允许修改：`config/models.yaml`、`packages/decision/**`、`tests/integration/model-gateway/**`、本任务计划/审计和 OpenSpec checklist；不实现 ModelGateway provider 调用。
- 依赖：Phase 2 `DecisionProvider`/DecisionResult contracts；后续 Task 3.2 复用 profile registry 和审计字段。
- 排除范围：真实模型 SDK、API key 读取/发送、HTTP、Fastify、fallback 的实际 provider 调度和 prompt 模板。
- RED：先添加 profile/redaction/audit 测试，确认当前 decision 包没有 ModelProfile 和配置入口。
- 聚焦验证：`npm test -- --run tests/integration/model-gateway`。
- 广度验证：`npm run lint && npm run build && npm test`。
- 交接证据：五类 role profile、版本化配置、timeout/retry/fallback 元数据、structured output 标识、脱敏审计快照和敏感字段回归测试。

## 设计决策

1. `models.yaml` 使用 JSON-compatible YAML 子集，避免 Phase 3.1 引入解析依赖；registry 通过 JSON parse 和公共运行时校验加载。
2. 每个 profile 固定 `profileId`、`profileVersion`、`modelId`、`modelVersion`、role、timeout、retryPolicy、fallbackProfileId 和 structuredOutput。
3. fallback 只作为不可变配置元数据，不在 Task 3.1 执行 provider 调用或自动切换。
4. ModelAuditEntry 只保存 trace/run、role、profile/model 版本、attempt、outcome 和脱敏 metadata；raw prompt、raw user input、API key、authorization 永不进入 entry。
5. 脱敏递归复制 JSON-safe 请求，匹配敏感 key 时统一替换 `[REDACTED]`，不修改调用方对象。
