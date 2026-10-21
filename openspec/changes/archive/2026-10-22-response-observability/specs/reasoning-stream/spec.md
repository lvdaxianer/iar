# Spec Delta

## Purpose

为最终回复模型提供原生 thinking 与最终答案的独立、可观测流式通道，使用户可以直接查看模型实际返回的 thinking，同时保持意图识别链路简洁且不泄露到运行日志。

## ADDED Requirements

### Requirement: The response model can stream native reasoning separately

When the configured response model supports native reasoning, the runtime SHALL preserve its raw reasoning deltas and answer deltas as separate ordered event types without rewriting or fabricating either stream.

#### Scenario: Native reasoning and answer are received
- **WHEN** the response model emits reasoning content followed by answer content
- **THEN** the host receives separate reasoning and answer delta events, while the final persisted result contains only the answer

#### Scenario: Provider has no native reasoning
- **WHEN** the response model does not return a native reasoning field
- **THEN** the runtime emits no fabricated reasoning content and continues with the answer stream or reports the provider capability accurately

### Requirement: Intent extraction does not expose reasoning

Semantic extraction and routing model calls SHALL disable reasoning output and SHALL expose only their validated structured decision results to the runtime and host.

#### Scenario: Intent extraction completes
- **WHEN** the intent model returns a semantic decision
- **THEN** no reasoning event is sent to the host and only the validated decision and timing metadata are available

### Requirement: Reasoning is not written to ordinary logs

The runtime SHALL record response reasoning timing, status and model metadata without writing raw reasoning, prompts or complete answers to ordinary operational logs.

#### Scenario: Reasoning stream is visible in the UI
- **WHEN** a user-facing response has native reasoning enabled
- **THEN** the UI can render the raw reasoning in its dedicated area while ordinary logs contain only safe phase metadata

#### Scenario: Reasoning stream fails
- **WHEN** reasoning or answer streaming times out, disconnects or returns an invalid response
- **THEN** the host receives a stable failure classification and completed timing information without treating partial reasoning as a complete answer
