# Proposal

## Why

真实模型链路中，语义抽取请求没有明确关闭 thinking，可能让结构化抽取额外消耗推理时间；同时 Pi Bridge 的客户端等待边界没有与模型调用预算形成可配置、可验证的关系，导致后续查询在模型仍处理时被提前判定为桥接超时。

## What Changes

- 为 `semantic.extract` 的 OpenAI-compatible 请求显式发送 `thinking: { type: "disabled" }`。
- 保持 `response.generate` 的原生 thinking 能力和现有独立回复通道不变。
- 为 Pi Bridge 客户端提供受约束的环境超时配置，并保留默认值，避免运行时边界依赖隐藏常量。
- 增加测试，验证结构抽取不会携带 thinking，最终回复仍可携带 thinking，Bridge 超时配置可被安全读取和限制。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `reasoning-stream`: 落实语义抽取和路由模型必须关闭 reasoning，同时保持最终回复模型可使用原生 reasoning。
- `response-observability`: 使 Bridge 等待边界可配置且可验证，避免客户端在服务端阶段仍运行时过早中断。

## Impact

- 影响 `examples/agent-sandbox/src/models/llm-provider.ts`、模型请求传输层和 `packages/adapters/pi` Bridge 客户端。
- 影响真实 brain 模式下的 OpenAI-compatible 请求参数和 Pi 宿主环境配置。
- 不改变 Function/Plugin 选择、动作执行、确认状态和最终回复模型的业务契约。
