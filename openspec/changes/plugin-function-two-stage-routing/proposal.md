# Proposal

## Why

当前路由把 Plugin 和 Function 的描述展平后交给模型，模型先看到执行层 Function，之后又需要额外调用 Plugin/Function 决策，既破坏 Plugin > Function 的边界，也增加模型调用次数。需要把“能力包选择”和“能力包内的可执行 Function 及参数提议”拆成两个明确阶段，并让所有模型输出先经过运行时校验。

## What Changes

- 将第一阶段 `semantic.extract` 固定为普通交互模型（`deepseek-v4-pro`）的语义与 Plugin 提案：输入当前会话、结构化上下文和 Plugin 级描述，不再把跨 Plugin 的 Function 描述直接交给模型。
- 增加 `function.call` 结构化契约：运行时在第一阶段选定并重新验证 Plugin 后，只向第二阶段提供该 Plugin 拥有的 Function、Operation 和输入 Schema。
- 为 `function.call` 增加 OpenAI-compatible tool/function calling 传输边界；JEV 优先，未配置 JEV 时使用 Intent Model，二者都只能提出候选调用，不能直接执行。
- 由运行时校验 Plugin 归属、Function、Operation、参数 Schema、权限、风险和确认状态后，才创建 Action 并执行。
- 保留 `response.generate` 使用 `deepseek-v4-pro`，查询/`model` 结果继续交给模型汇总；`direct`/`none` 的确认、表单和 UI 状态继续跳过回复模型。
- 保留旧 `function.select`/`plugin.select` 适配器和配置兼容性，但新 Agent 主路径不再依赖跨 Plugin Function 展平候选。

## Capabilities

### New Capabilities

- `function-call-routing`: 定义 Plugin 内 Function Calling、参数提议和运行时验证边界。

### Modified Capabilities

- `scoped-plugin-routing`: 将主路由顺序从 Function-first/展平候选修正为 Plugin proposal → Function call，并明确禁用 Plugin 和归属校验。
- `runtime-contracts`: 增加版本化 `function.call` 输入、工具描述和输出提议契约。
- `structured-model-context`: 修改语义模型输入的能力边界和模型调用顺序，保持上下文只读且不授予权限。
- `model-provider-configuration`: 为 `function.call` 支持 JEV 优先、Intent Model fallback，并固定各阶段模型角色。

## Impact

- 影响 `packages/runtime` 的模型角色、Function Calling 适配器、候选契约和 Plugin-first 路由。
- 影响 `packages/plugins` 的 Plugin 级描述投影和 Function Schema 投影。
- 影响 `examples/agent-sandbox` 的语义输入、模型 HTTP 传输、Agent 配置和会话路由执行。
- 增加路由、模型传输、Schema 校验、回退、权限、确认和查询回复的单元/集成测试；不引入新的外部依赖。
