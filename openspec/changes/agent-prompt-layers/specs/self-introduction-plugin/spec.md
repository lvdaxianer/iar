# Spec Delta

## ADDED Requirements

### Requirement: Self-introduction output is always summarized by the response model

When self-introduction is enabled and its Function succeeds, the runtime SHALL pass the bounded capability inventory and supplementary prompt to the response model and SHALL return the model-generated text; the Plugin SHALL NOT directly construct the user-facing introduction.

#### Scenario: Self-introduction uses model mode
- **WHEN** an enabled Agent receives a capability-introduction request and the self-introduction Function succeeds
- **THEN** the response model receives the Function output and the final assistant message is generated from that model response

#### Scenario: Model response preserves Agent style
- **WHEN** the Agent overall prompt requests Markdown or a specific presentation style
- **THEN** the self-introduction response follows that style while remaining limited to the current capability inventory

#### Scenario: Disabled self-introduction remains unavailable
- **WHEN** the self-introduction Plugin is disabled at Agent creation
- **THEN** no self-introduction Function output is sent to the response model
