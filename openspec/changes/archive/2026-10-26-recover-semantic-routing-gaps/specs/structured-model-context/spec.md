# Spec Delta

## ADDED Requirements

### Requirement: Clarification state exposes only finite recovery data

When a route is blocked by missing semantic fields, the runtime SHALL provide the response and next semantic calls with a bounded missing-field description, validated context and finite candidate values, while keeping the data non-authoritative.

#### Scenario: Clarification describes a missing field
- **WHEN** the route cannot proceed because a required field is absent
- **THEN** the model context includes the field name and bounded allowed values when available, and excludes any instruction to execute or invent values

#### Scenario: Context cannot supply a safe value
- **WHEN** no finite value can be derived for the missing field
- **THEN** the runtime asks the user to provide the field explicitly and does not let a model-generated guess authorize execution

### Requirement: Recovered context is re-extracted and revalidated

The runtime SHALL treat a clarification answer as a new input, re-run semantic extraction and canonical route validation, and SHALL NOT execute solely because a previous response requested confirmation.

#### Scenario: Clarification answer completes the route
- **WHEN** the user supplies the missing operation or target and the new semantic frame is valid
- **THEN** normal candidate, contract, policy and confirmation gates run before execution

#### Scenario: Clarification answer remains ambiguous
- **WHEN** the new input still lacks a unique route or required parameter
- **THEN** the runtime preserves the pending clarification and returns a bounded follow-up request without a side effect
