# Proposal

## Why

当前 Function 已声明输入和输出 Schema，但运行时只校验注册声明，不能在启动和执行边界统一确认真实输入输出，也没有标准方式表达“结果交给模型汇总、直接返回或不生成聊天回复”。这会让复杂结果与确认/表单状态混用，容易把本应由 UI 或运行时处理的内容错误交给回复模型。

## What Changes

- 为 Function Handler 增加版本化、固定的响应控制信封，支持 `model`、`direct` 和 `none` 三种模式。
- 保持 Function 的业务输入/输出 Schema 为显式契约；注册时校验 Schema，执行时校验真实输入和输出。
- 在 Plugin 启动/注册阶段 fail-closed 校验所有自定义 Function 的 Handler、输入 Schema、输出 Schema 和响应契约，禁止部分初始化。
- 在执行阶段根据已校验的响应模式分流：复杂结果交给 `response.generate`，完整话术直接返回，确认/表单状态不生成聊天回复。
- 将自我介绍和需要结合上下文的动作结果标记为模型汇总；将确认、表单和系统状态路径保持为非模型回复。
- 为非法响应模式、Schema 不匹配和 handler 输出超限增加稳定错误及回归测试。

## Capabilities

### New Capabilities

- `function-response-contract`: 定义 Function 结果响应模式、固定外层协议和模型/直接/UI 回复分流。

### Modified Capabilities

- `runtime-contracts`: Function 注册与执行必须校验输入输出和响应契约。
- `plugin-package-registration`: 启动/注册阶段的自定义 Function Schema 校验必须原子失败。
- `structured-model-context`: 只有 `model` 响应模式进入回复模型；`direct` 和 `none` 保持对应边界。

## Impact

- 影响 `@iar/contracts`、`@iar/plugin`、`@iar/plugins`、`@iar/runtime` 和 agent sandbox 的 Plugin 注册与执行边界。
- 影响内置自我介绍、示例 Plugin、Pi Bridge/HTTP 的结果映射以及普通/流式回复路径。
- 不改变语义路由、Policy、确认和 Action 幂等边界；只明确执行结果的回复分流。
