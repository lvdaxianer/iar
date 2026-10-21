# Spec Delta

## ADDED Requirements

### Requirement: Applicable reply models receive the Agent overall prompt

The runtime SHALL provide the validated Agent overall prompt to IAR response generation and Pi delegation as bounded instruction context, while semantic extraction and context compaction SHALL retain their fixed structured-output protocols unless explicitly configured by a future role-specific contract.

#### Scenario: Response model receives overall prompt
- **WHEN** a `model` Function result is processed
- **THEN** the response model receives the Agent overall prompt together with the current user message, Function output and structured context

#### Scenario: Pi fallback receives overall prompt
- **WHEN** routing passes an input through to Pi Agent
- **THEN** Pi receives the Agent overall prompt together with its fixed safety boundary and current capability context

#### Scenario: Direct and none do not receive a model call
- **WHEN** a Function result declares `direct` or `none`
- **THEN** no response-model prompt is assembled for that result

### Requirement: Reply source is observable

The bridge and host-facing result SHALL identify whether the user-visible reply came from a direct Function result, IAR response generation, Pi Agent, or no-reply mode, without exposing raw prompts or model payloads.

#### Scenario: Self-introduction source is response model
- **WHEN** self-introduction succeeds with `mode=model`
- **THEN** the result reports `response_model` as its reply source

#### Scenario: Pass-through source is Pi Agent
- **WHEN** no enabled Function handles the input and Pi Agent produces the reply
- **THEN** the result reports `pi_agent` as its reply source
