# Proposal

## Why

当前仓库只有 IAR 的架构方案和参考样例，没有把方案转化为可分阶段交付、可测试、可验收的实施计划。现在固化 Phase 1～5，可以让后续实现从稳定契约和嵌入式 MVP 开始，逐步扩展到模型接入、服务化隔离和长流程能力，同时避免过早引入分布式基础设施。

## What Changes

- 建立从契约、插件宿主、事件存储和行为上下文开始的 Phase 1 基础路线。
- 建立规则路由、Function/Plugin 两阶段决策、策略确认和本地 Workflow 的 Phase 2 核心运行路线。
- 建立 ModelGateway、Semantic Extractor、JEV Adapter、Fastify API 和示例插件的 Phase 3 接入路线。
- 建立 PostgreSQL、Sidecar、CLI、OpenTelemetry 以及 Worker/容器隔离执行的 Phase 4 服务化路线。
- 建立可选 Temporal Adapter、远程插件分发、跨语言 ABI 和多租户控制面的 Phase 5 长流程路线。
- 为每个阶段定义依赖、文件边界、测试策略、验收标准和不可提前引入的范围。
- 将现有 `docs/README.md` 与参考样例作为需求来源，不把参考项目变成 IAR 的强制运行时依赖。

## Capabilities

### New Capabilities

- `runtime-contracts`: 统一契约、Manifest 校验、插件注册和可逆生命周期。
- `behavior-state`: EventLog、BehaviorContext、快照、重放、上下文压缩和完整性校验。
- `bounded-routing`: Function/Plugin 两阶段路由、复合规则、有限候选和类型化决策。
- `policy-workflow-api`: Policy Gate、权限/确认、幂等执行、本地 Workflow 和宿主 API。
- `service-isolation-durable`: 服务化部署、隔离插件执行、观测、远程分发和可选长流程适配。

### Modified Capabilities

无。项目尚未存在已批准的 `openspec/specs/` 能力规格。

## Impact

- 新增 TypeScript + Node.js workspace、JSON Schema/TypeBox/Ajv 契约、Fastify Adapter、模型适配器、存储适配器和测试目录的实施计划。
- 后续实现将涉及 `contracts`、`runtime`、`plugin-host`、`plugin-sdk`、`subscriptions`、`rule-engine`、`decision`、`workflow`、`storage`、`adapters`、`cli` 和 `examples` 等包边界。
- Phase 1～2 默认使用内存/SQLite 和本地确定性状态机；PostgreSQL、Sidecar、Worker、容器和 Temporal 均推迟到对应阶段。
- 计划文件本身不实现业务代码、不接入真实模型、不引入消息队列或向量数据库。
