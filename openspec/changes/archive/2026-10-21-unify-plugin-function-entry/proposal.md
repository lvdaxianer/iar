# Proposal

## Why

当前 IAR 的公共模型把一个 Plugin 绑定到一个 Function，无法表达一个可独立分发的插件包同时提供多项业务能力，也让业务方必须手动拼装 Host、Function 边界和 Handler。现在项目尚未对外发布，因此应直接建立长期稳定的 `Plugin > Function > Operation` 模型，并提供一个统一入口。

## What Changes

- **BREAKING** 将业务插件从单 Function Manifest 改为插件包：一个 Plugin 包含零个或多个 Function 注册项，Function 再包含 Operation 和 Handler。
- **BREAKING** 删除 `FunctionPluginManifest`、`PluginRegistration.handler`、`PluginHost({ functionIds })` 等旧的 Function-first 注册 API。
- 新增 `@iar/plugin`，提供 `definePlugin`、`defineFunction` 和公开注册类型，用于插件作者定义 Plugin 与 Function。
- 新增 `@iar/agent`，提供统一运行时入口，负责校验、安装、启用插件包并暴露 Function/Plugin 路由依赖。
- 重构 `@iar/plugins` 的 Host 和索引，使 Function ID 从已注册插件包中建立，允许一个 Plugin 暴露多个 Function，也允许多个 Plugin 提供同一 Function 的不同实现。
- 保持意图识别、Function/Plugin 两阶段有限决策、动态候选重验证、策略/确认、会话状态和 Pi Bridge 的外部行为不变；只替换能力声明和注册来源。
- 将 sandbox、示例、测试夹具、包导出和 `docs` 架构/使用文档迁移到新模型。
- 将可发布的统一入口和插件 SDK 纳入包分发验证，禁止消费者依赖仓库内部源码路径。

## Capabilities

### New Capabilities

- `plugin-package-registration`: 以 Plugin 包为顶层边界注册多个 Function，并由统一入口完成校验、生命周期管理和路由索引。

### Modified Capabilities

- `runtime-contracts`: 业务 Plugin Manifest 不再拥有单个 Function 所有权，Function 契约改为 Plugin 包内的嵌套注册边界。
- `scoped-plugin-routing`: 路由仍按 Function 再选 Plugin，但候选 Function 和 Plugin 描述来自 Plugin 包索引。
- `bounded-routing`: 保持现有两阶段决策和最终权威重验证，调整候选来源和注册模型。
- `package-distribution`: 新增 `@iar/plugin` 和 `@iar/agent` 的稳定发布入口与导入约束。

## Impact

- 契约层：`@iar/contracts` 的 Plugin/Function 类型、Schema、校验和 ABI Manifest。
- 宿主层：`@iar/plugins` 的 SDK、PluginHost、生命周期事件、候选描述和 Function 索引。
- 运行时层：`@iar/runtime` 的路由候选读取和执行上下文。
- 新包：`packages/plugin`、`packages/agent` 及 workspace/build/package distribution 配置。
- 示例与测试：`examples/agent-sandbox`、`examples/plugins`、路由/安装/分发/服务集成测试。
- 文档：`docs/defining-functions.md`、`docs/defining-plugins.md`、新增架构和统一入口说明。
- Pi：不修改 Pi 源码；`@iar/pi-bridge` 仍通过 IAR 入口转发输入，IAR 会话管理仍是唯一会话状态源。
