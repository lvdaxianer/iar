# Proposal

## Why

IAR 当前已经具备意图决策、插件生命周期、会话执行和持久化能力，
但这些能力仍按历史实现阶段拆成多个 workspace 包，用户很难判断
哪个包是完整运行时、哪个包只是宿主适配器。现在 Pi 接入已经形成
独立方向，需要同时建立一个不依赖 Pi、HTTP 或具体数据库的独立
`@iar/runtime` 产品入口。

## What Changes

- **BREAKING**：将 `@iar/runtime` 从内部路由包提升为可独立安装和运行的
  IAR 意图/动作运行时，并提供统一初始化入口。
- 将 `agent`、`decision`、`rule-engine`、`workflow` 和运行时观测实现
  收敛为 `runtime` 包内模块；保留清晰的源码目录，不再为每个内部模块
  建立独立发布边界。
- 保留 `contracts`、`plugin`、`plugins`、`storage` 和
  `subscriptions` 作为稳定的公共或可替换边界。
- 保留 `@iar/pi-bridge` 作为 Pi 专用适配器；Pi 不进入 runtime 核心。
- 保留 PostgreSQL、Temporal、HTTP/Service、Sidecar 和隔离执行器作为
  独立 adapter 包。
- 将现有 `@iar/agent` 的统一装配能力迁移到 `@iar/runtime`，提供明确的
  迁移说明和包分发验证，避免消费者依赖源码或内部路径。
- 不改变现有 Plugin/Function/Operation 契约、路由决策语义、Pi Bridge
  协议、会话持久化格式和 fail-closed 行为。

## Capabilities

### New Capabilities

- `standalone-intent-runtime`: 定义可独立安装、初始化和运行的
  `@iar/runtime` 公共入口及其默认依赖边界。

### Modified Capabilities

- `package-distribution`: 将可发布的统一应用入口从 `@iar/agent` 调整为
  `@iar/runtime`，并明确 adapter 与核心运行时的发布边界。

## Impact

- 影响根 `tsconfig`/workspace 引用、多个 package manifest、公共入口、
  测试导入、示例导入、发布包验证和架构文档。
- 需要迁移 `@iar/agent`、`@iar/decision`、`@iar/rule-engine`、
  `@iar/workflow` 及运行时观测实现的源码路径和依赖声明。
- `@iar/pi-bridge`、`@iar/adapters-*` 的协议和职责保持不变，
  只更新其对核心 runtime 公共入口的依赖。
