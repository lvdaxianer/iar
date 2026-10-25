# Proposal

## Why

当前意图识别请求同时携带当前消息、结构化会话状态、conversation turns、事实历史和最近消息；各集合虽然分别有上限，但组合后的模型输入没有总预算。长会话因此可能产生过大的路由 Prompt，导致延迟、超时或模型上下文溢出，并且裁剪行为不透明。

## What Changes

- 为意图识别模型输入增加统一、确定性的总字符预算。
- 按上下文重要性保留当前消息、当前工作流状态、已确认事实和最近上下文，优先裁剪较早的 conversation turns 与低优先级原文。
- 将上下文预算组装逻辑从 Prompt 字符串拼接中独立出来，保证裁剪后仍是合法的结构化输入。
- 为预算命中、裁剪结果和长会话引用补充集成测试与最小安全观测字段。
- 明确短期版本不引入跨会话记忆、EventLog 语义检索、事实版本图或自动压缩。

## Capabilities

### New Capabilities

无。该变更收敛现有结构化模型上下文，不新增独立能力边界。

### Modified Capabilities

- `structured-model-context`: 为模型输入增加跨集合总预算、确定性优先级裁剪和可观测的裁剪结果。

## Impact

- 修改 `@iar/runtime` Intent Model Prompt 构建和模型适配边界。
- 修改 agent-sandbox 的语义 Prompt 组装，使其使用同一套预算策略。
- 增加 runtime/model-gateway 集成测试和长会话评测场景。
- 不改变公共决策结果协议、Function/Plugin 授权边界、会话持久化格式或现有 fallback 语义。
