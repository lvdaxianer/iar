# Proposal

## Why

当前 workspace 将大量逻辑模块直接提升为独立私有包，形成 18 个核心包和 6 个适配器包。包数量已经超过稳定发布边界的实际需要，增加了 manifest、TypeScript project reference、导出路径和构建维护成本，也让 `examples` 的消费者边界不够直观。

现在收敛包边界，可以保留逻辑模块的职责划分，同时减少物理包之间的耦合和迁移成本；这次只调整包组织和导入路径，不改变运行时语义、契约字段、错误码或持久化行为。

## What Changes

- 将 `abi` 合入 `contracts`，保留 ABI 作为契约包内的逻辑子目录。
- 将 `plugin-sdk` 与 `plugin-host` 合入 `plugins`，保留 SDK 与 Host 的内部目录边界。
- 将 `plugin-distribution` 合入 `control-plane`，保留分发与租户控制面的内部职责。
- 将 `storage`、`persistence-spi`、`persistence-runtime` 和 `persistence-sqlite` 合入统一的 `storage` 包。
- 将 `observability` 与 `built-in-plugins` 合入统一的 `observability` 包。
- 保留 `runtime`、`workflow`、`decision`、`rule-engine`、`subscriptions`、`cli` 和所有 `adapters/*` 的独立边界。
- 将示例插件整理到根目录 `examples/plugins/`；`agent-sandbox` 继续作为完整示例应用保留在 `examples/`。
- 更新 workspace 清单、TypeScript 引用、包入口、测试、脚本和架构文档。
- 保持所有公开行为兼容；旧包名仅在迁移过程中作为待清理的内部引用处理，不新增运行时兼容层。

## Capabilities

### New Capabilities

无。本变更是纯包边界和目录重构，不引入新的系统行为。

### Modified Capabilities

无。本变更不改变任何 OpenSpec 行为要求，因此本 change 使用 `skip_specs: true`。

## Impact

- 影响 `packages/*` 的 package manifest、入口导出、依赖声明和 TypeScript 构建引用。
- 影响 `examples/*`、`tests/*`、`scripts/*` 中的 workspace 包导入路径。
- 影响根目录 README、架构主文档和包分发校验脚本中的包结构说明。
- 不改变运行时数据结构、HTTP/API 契约、插件生命周期、持久化协议、错误码或执行语义。
