# Proposal

## Why

当前 Runtime 已能区分 `model`、`direct` 和 `none`，但“查询 Function 的结构化结果必须交给 Response Model 汇总”仍主要依赖调用路径约定，容易出现查询结果被直接展示、回复来源不清晰或把历史事实追问误标为普通澄清的问题。需要把回复策略、模型输入和 Bridge 可观测性统一成可校验的运行时契约。

## What Changes

- 将本次执行的 `operation.kind` 作为回复策略判断依据；`read/query` 结果默认且必须进入 Response Model。
- 保留 `direct` 作为少量明确固定回执的例外，保留 `none` 作为确认、表单和纯 UI 状态更新的例外。
- 统一 Response Model 输入，确保总体提示词、Agent 提示词、Function 输出、可信事实和当前用户问题按固定边界传入。
- 保证自我介绍、工单查询、数据查询和历史事实追问都由 Response Model 生成最终用户文本，Function 只返回结构化事实。
- 在自定义 Plugin 启动和 Function 执行边界校验 response mode 与 operation kind 的兼容性，违规时 fail closed。
- 增强 Pi Bridge 的路由证据和回复来源展示；区分业务 Plugin 命中、历史事实回答和真正需要澄清的结果。
- 为查询、模型汇总、固定回执、无聊天回复、历史事实追问和不兼容契约补充契约测试、集成测试和 Pi Host 展示测试。

## Capabilities

### New Capabilities

<!-- 本变更复用现有契约能力，不新增独立能力。 -->

### Modified Capabilities

- `function-response-contract`: 增加 query/read 结果必须使用模型回复的策略约束，以及 operation kind 与 response mode 的兼容校验。
- `structured-model-context`: 统一查询结果进入 Response Model 的输入边界，并增加历史事实回答与业务路由澄清的可观测区分。

## Impact

- 影响 `examples/agent-sandbox` 的 Function 执行、回复生成、历史事实追问和 Pi Host Bridge 适配。
- 影响 `@iar/contracts`、Plugin Function response 校验和 Runtime 的执行边界。
- 影响 Response Model 输入协议及现有 scripted/brain 两种模式的测试行为。
- 不改变 Plugin 的业务执行权限；模型只获得已校验的结构化结果和当前 Agent 的有限上下文。
