# Spec Delta

## ADDED Requirements

### Requirement: Canonical identifiers drive nested route validation

The runtime SHALL treat the model-proposed `plugin_id`, `function_id` and `operation` from the finite nested tool set as the routing identity, while natural-language semantic fields remain non-authoritative context.

#### Scenario: Natural language maps to a canonical Function

- **WHEN** the user asks “帮我创建一张工单” and the model proposes `ticket.create`
- **THEN** the runtime validates and routes `ticket.create` without requiring `semantic.intent` to equal the natural-language phrase or the Function ID

#### Scenario: Canonical identity is not registered

- **WHEN** the model proposes a Plugin, Function or Operation that is absent from the current enabled registry
- **THEN** the runtime returns a stable rejection or clarification and does not construct or execute an Action

### Requirement: Nested route rejection preserves selected identity

The runtime SHALL retain the validated or attempted Plugin and Function identifiers in rejected route evidence whenever the model returned them.

#### Scenario: Plugin rule rejects a selected Function

- **WHEN** a model proposes `ticket-support-v1` and `ticket.create` but a later rule rejects the proposal
- **THEN** route evidence contains both identifiers and an explicit rejection reason rather than silently replacing the Plugin with an empty value
