# Spec Delta

## ADDED Requirements

### Requirement: Intent model input has a total context budget

意图识别模型请求 SHALL 在发送前通过一个统一的总字符预算校验。预算 SHALL 覆盖当前消息、结构化上下文、conversation turns、verified facts、summary、recent messages 和候选描述，而不仅是分别限制各集合。

#### Scenario: A normal long session stays within budget

- **WHEN** a session contains multiple bounded context collections whose combined serialized input is below the configured limit
- **THEN** the runtime sends the complete selected context and records the measured input size

#### Scenario: An oversized session is bounded before the provider call

- **WHEN** the combined intent model input exceeds the configured limit
- **THEN** the runtime deterministically reduces lower-priority context before invoking the provider and never sends an over-budget request

### Requirement: Context reduction preserves intent-critical data

预算裁剪 SHALL 按固定优先级执行：当前用户消息、当前 route/workflow/pending action、当前 slots 和最新 verified facts、summary、最近消息、较早 conversation turns。裁剪 SHALL 以完整字段、消息或轮次为单位，不得产生非法 JSON、重排集合或把 raw history 变成可信事实。

#### Scenario: The current request survives truncation

- **WHEN** an oversized session contains a current user request and older conversation content
- **THEN** the current request and current workflow state remain available while older content is removed first

#### Scenario: Structured context remains valid after truncation

- **WHEN** turns, facts or recent messages are reduced to fit the budget
- **THEN** each retained collection remains independently ordered, schema-valid and non-authoritative unless it was already trusted structured state

### Requirement: Context reduction is safely observable

意图识别运行时 SHALL expose bounded diagnostic metadata for the assembled input, including measured size, whether reduction occurred and retained counts per context layer, without记录完整用户原文、凭证、完整 prompt 或模型响应。

#### Scenario: An input is reduced

- **WHEN** the budget assembler removes one or more context items
- **THEN** the decision audit records that reduction occurred and the bounded retained-layer counts

#### Scenario: Diagnostic metadata cannot leak model payloads

- **WHEN** an operator inspects decision diagnostics
- **THEN** diagnostics contain only bounded sizes, flags, counts and stable identifiers, not raw prompt content or provider secrets
