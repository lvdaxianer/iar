# Proposal

## Why

IAR 已经能够在模型配置文本中解析 `${VAR_NAME}`，但实际的普通交互 Provider 只读取通用 URL/密钥，模型名仍固定在 profile；Intent Model 还没有独立的 HTTP Provider。因此部署到不同环境或切换模型时，需要修改配置文件，且无法让意图识别模型与普通交互模型分别使用自己的 endpoint、密钥和模型名。

## What Changes

- 为普通交互模型和 Intent Model 增加独立的 OpenAI-compatible Provider 配置入口。
- URL、API key、model ID 均支持环境变量覆盖；未配置覆盖变量时回退到 profile 默认值。
- Intent Model Provider 使用固定的 `iar.intent-decision-prompt/v1` 输入并复用现有 `DecisionResult` 校验，不改变 JEV 优先级和路由权限边界。
- 对环境变量解析、优先级、缺失密钥、请求地址和模型名进行测试，禁止真实密钥进入配置文件、审计和错误响应。
- 更新根配置、sandbox 示例、`.env.example`、README 和实现审计。

## Capabilities

### New Capabilities

- `model-provider-configuration`: 为不同模型 backend 提供可审计、可覆盖、fail-closed 的 endpoint、凭据和模型标识配置。

### Modified Capabilities

- `bounded-routing`: Intent Model 的实际 Provider 必须继续使用统一 Prompt、`iar.decision/v1` 和既有 JEV 优先/权限复核约束。

## Impact

- 修改 `packages/decision` 的 profile/provider 配置契约和 OpenAI-compatible Provider。
- 修改 `examples/agent-sandbox` 的 Provider、模型 profile 与环境变量说明。
- 增加本地 deterministic provider 测试，不发送真实网络请求。
- 不改变 `DecisionResult`、`ModelGatewayResult`、`RouteResult` 或公开 API 字段。
