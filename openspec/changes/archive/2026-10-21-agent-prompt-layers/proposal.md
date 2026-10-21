# Proposal

## Why

当前自我介绍 Plugin 已经返回 `mode: model`，但 Agent 没有统一的总体提示词配置，IAR Response Model 和 Pi Agent 各自使用固定提示词，导致用户无法在创建 Agent 时统一指定 Markdown、语气和表达风格。与此同时，路由面板只展示 `handled`，无法明确区分 Function 直出、Response Model 汇总和 Pi Agent 兜底。

## What Changes

- 为 Agent 增加有界、不可变的总体提示词配置，并在创建 Agent 时保存。
- 保留 Runtime 的固定安全与结构化输出协议，用户总体提示词不能覆盖这些协议。
- 将总体提示词注入 IAR Response Model 和 Pi Agent；不注入语义识别和压缩模型，避免表达偏好干扰结构化协议。
- 允许 `response.generate` 在 `iar.response/v1.text` 内使用 Markdown，同时继续要求外层返回固定 JSON。
- 保持 Function 回复模式语义：`model` 交给 Response Model，`direct` 直接返回，`none` 不生成普通聊天回复。
- 保留自我介绍 Plugin 的 `extraPrompt`，将其作为 Plugin 级附加提示词参与 Response Model 汇总。
- 增加回复来源元数据，明确显示 `direct_function`、`response_model`、`pi_agent` 或 `none`。
- 补充配置校验、模型输入、Pi 提示词、路由元数据和端到端回归测试。

## Capabilities

### New Capabilities

- `agent-prompt-configuration`: Agent 总体提示词的配置、边界、组合顺序和跨回复模型传递行为。

### Modified Capabilities

- `self-introduction-plugin`: 自我介绍结果继续作为结构化数据交给 Response Model，并叠加 Agent 总体提示词和 Plugin 附加提示词。
- `function-response-contract`: 明确 `model` 模式必须经过 Response Model，且 Response Model 的 `text` 允许 Markdown。
- `structured-model-context`: 扩展适用的回复模型上下文，增加有界 Agent 总体提示词和可审计的回复来源。

## Impact

- 公共 Runtime 初始化配置：`packages/runtime/src/bootstrap/types.ts`、`packages/runtime/src/bootstrap/runtime.ts`。
- Agent Sandbox 的会话配置、Response Model 输入和 Pi Agent 委托。
- Pi bridge/API 的路由与回复来源元数据，以及对应页面调试展示。
- 现有 Plugin 回复契约和模型调用测试；不新增外部依赖，不改变 Function 输入输出 Schema 的固定边界。
