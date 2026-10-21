# Agent Prompt Configuration

为 IAR Agent 提供可校验、可持久化且有明确优先级的总体提示词配置，使回复模型能够共享表达偏好，同时不破坏运行时安全规则和结构化输出协议。

## Requirements

### Requirement: Agent creation accepts a bounded overall prompt

The runtime SHALL accept an optional Agent-level overall prompt when an Agent is created, validate its type and length, and preserve it in the immutable Agent configuration snapshot.

#### Scenario: Valid prompt is persisted
- **WHEN** an Agent is created with a non-empty overall prompt within the configured bound
- **THEN** the configuration snapshot contains the same prompt and later model calls can access it

#### Scenario: Invalid prompt fails closed
- **WHEN** an Agent is created with a non-string, oversized or otherwise invalid overall prompt
- **THEN** creation fails with a stable configuration validation error and no partial Agent is exposed

### Requirement: Prompt layers have a fixed precedence

The runtime SHALL compose prompts in the order of fixed runtime rules, Agent overall prompt, Plugin or scenario supplementary prompt, and role-specific output protocol; user-configured text SHALL NOT remove or override the fixed runtime rules or role protocol.

#### Scenario: Overall prompt requests Markdown
- **WHEN** an Agent overall prompt requests Markdown responses
- **THEN** the response model and Pi Agent receive that presentation preference while their required output protocols remain enforced

#### Scenario: Prompt attempts to grant capability
- **WHEN** a user prompt asks the model to enable, invent or execute a disabled capability
- **THEN** the runtime still exposes only the current enabled and authorized capability set

### Requirement: Prompt configuration is bounded and non-secret

The runtime SHALL bound configured prompt size, reject invalid values before model invocation, and SHALL NOT include configured prompts or model payloads in stable errors or unsafe production logs.

#### Scenario: Prompt exceeds the bound
- **WHEN** the overall or supplementary prompt exceeds its configured maximum
- **THEN** configuration or Function input validation rejects it before it reaches a model call

#### Scenario: Model call fails
- **WHEN** a model call using configured prompts fails
- **THEN** the public error remains stable and safe without exposing the prompt or credentials
