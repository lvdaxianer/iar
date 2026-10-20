# Proposal

## Why

当前模型调用只接收结构化 BehaviorContext，无法稳定理解依赖最近对话的省略、指代和口语表达；而会话重启后虽然能够恢复结构化快照，却不会重建最近原始消息窗口。路由无法判断时也会重复要求补充参数，缺少通用的、基于 Plugin 动态描述的功能选择兜底。

## What Changes

- 为语义抽取和回复生成增加有界的最近消息窗口，默认读取最近 N 条消息，并将原文明确标记为不可信理解材料。
- 从当前启用且授权的 Plugin 描述动态构造 Function/Plugin 候选目录、操作描述和澄清选项，Runtime 不再依赖业务关键词或固定功能列表。
- 扩展会话恢复流程：从持久化消息源加载最近 N 条原始消息，同时恢复结构化 BehaviorContext。
- 持久化连续澄清次数、待选择候选和候选版本，使服务重启后仍能安全继续澄清流程。
- 增加通用连续 unresolved 状态机：重复无法判断时进入动态候选选择；用户选择后仍须重新经过候选、授权、策略、确认和幂等校验。
- 保持压缩模型只处理结构化状态和事件，不把原始消息窗口并入可信 BehaviorContext 快照。
- 更新模型输入、会话、持久化 SPI/SQLite、流式与非流式入口及回归测试，移除核心 Runtime 中与具体业务相关的上下文和兜底假设。

## Capabilities

### New Capabilities

无。该 change 扩展现有会话上下文、动态路由和持久化能力，不引入独立业务能力。

### Modified Capabilities

- `structured-model-context`: 增加有界最近消息窗口、动态候选描述和连续澄清升级，同时保留结构化状态的权威性与原始历史的不可信边界。
- `session-persistence-provider`: 增加最近消息的有界查询与恢复语义，并持久化可恢复的澄清状态。

## Impact

- 影响 `packages/contracts`、`packages/decision`、`packages/runtime`、`packages/persistence-spi`、`packages/persistence-sqlite` 及 agent sandbox 会话编排。
- 需要兼容现有 SQLite 消息表和快照格式；优先通过 SPI 查询已有消息，不重复把原文写入结构化快照。
- 需要更新 Semantic Extractor、Response Generator 的输入契约，以及流式和非流式调用的共享上下文构造。
- 不改变现有 Policy、Confirmation、Authorization、Idempotency 或 Plugin 执行边界。
