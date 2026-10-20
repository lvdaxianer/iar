# Proposal

## Why

当前结构化事实以 `functionId.field` 作为唯一键，同一能力连续产生多个结果时会发生覆盖，导致“这个的上一个”“前一个结果”等自然语言引用无法可靠解析。需要将可信结果改为有序、可追溯、可持久化的事实链，并让模型只负责理解关系，运行时负责安全解析。

## What Changes

- 将结构化事实从覆盖式键值表改为有界追加式事实记录，保留记录顺序、来源事件、动态能力标识和字段值。
- 扩展语义引用契约，支持 `current`、`previous`、`next`、`first`、`last`、`offset` 等通用关系及不透明记录 ID。
- 将自然语言关系解析与事实记录解析分层：模型输出通用关系，运行时校验会话归属、顺序和有效性后再解析目标记录。
- 将事实链、当前焦点记录和来源信息纳入事件重放、快照恢复、SQLite 持久化和上下文压缩边界。
- 保持最近 N 条原始消息作为非可信模型输入；原始消息不能直接产生事实、授权或副作用。
- 对无锚点、无目标、过期引用和重复无法解析提供动态澄清与有限次数兜底，不写死具体业务能力、字段或选择项。
- **BREAKING**：移除运行时对 `facts[functionId.field]` 覆盖语义的依赖，并兼容读取旧快照后转换为新事实记录。

## Capabilities

### New Capabilities

<!-- No new top-level capability; the behavior extends existing structured-context and persistence contracts. -->

### Modified Capabilities

- `structured-model-context`: 事实改为有序追加记录，模型输入和引用输出支持通用历史关系，并增加无效/歧义引用的安全兜底。
- `behavior-state`: BehaviorContext 和事件投影保留事实记录顺序、来源和当前焦点，重放与压缩不得覆盖或重排可信事实。
- `session-persistence-provider`: SQLite 及 Provider SPI 持久化并恢复新的事实链结构，同时保持有界消息窗口与快照版本安全。

## Impact

- 影响 `packages/contracts` 的 BehaviorContext、事实和语义帧契约及其 schema 校验。
- 影响 `packages/runtime` 的事实投影、引用解析、上下文构建、澄清和压缩逻辑。
- 影响 `packages/decision` 与示例模型适配器的引用输出协议和通用提示词。
- 影响 SQLite 快照/事件恢复测试、模型网关测试、会话澄清测试和回放测试。
- 不新增业务领域判断；所有能力、字段和选项继续来自运行时过滤后的 Plugin 描述。
