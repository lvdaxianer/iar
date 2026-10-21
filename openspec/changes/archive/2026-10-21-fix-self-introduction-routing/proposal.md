# Proposal

## Why

真实 LLM 当前被语义 Prompt 要求把“你是谁”和“介绍下自己”识别为
`unknown`，导致内置自我介绍 Plugin 永远无法从真实模型路径进入路由。
同时 Runtime 将自我介绍错误地视为不可关闭能力，与 Agent 级 Plugin 配置契约不一致。

## What Changes

- 将身份、能力介绍类请求识别为已启用的自我介绍 Function。
- 保留普通寒暄和无关问题的 `unknown` 行为，让它们继续交给普通 Agent 回复。
- 将当前启用且可路由的能力描述作为模型的基础上下文；关闭的 Plugin 不进入候选或上下文。
- 自我介绍 Plugin 默认安装，但允许在创建 Agent 时通过 `disabledPluginIds` 关闭。
- 当自我介绍 Plugin 命中时，使用其结构化能力汇总和额外提示词生成最终回复。
- 增加真实 LLM Prompt、关闭配置、上下文隔离和回归路由测试。
- 在 pass-through Bridge 响应中携带当前启用能力目录，供 Pi Host 的后续模型调用使用。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `self-introduction-plugin`: 修正身份/能力询问的可路由行为，并允许内置 Plugin 被显式关闭。
- `structured-model-context`: 明确启用能力目录始终作为基础模型上下文，关闭能力不得注入。
- `standalone-intent-runtime`: 修正内置自我介绍默认启用但可关闭的 Agent 配置行为。
- `scoped-plugin-routing`: 确保关闭配置在语义候选、路由候选和能力上下文生成前生效。
- `pi-bridge-context-isolation`: 增加 pass-through 时的有界能力上下文传递，同时保持 IAR 业务结果不进入 Pi 历史。

## Impact

- 影响 `examples/agent-sandbox` 的语义 Prompt、路由兜底和模型上下文构造。
- 影响 `packages/runtime` 的 Agent 创建配置筛选。
- 影响现有自我介绍、Runtime、Pi bridge 和 Pi Host 集成测试；Bridge 增加向后兼容的可选上下文字段。
