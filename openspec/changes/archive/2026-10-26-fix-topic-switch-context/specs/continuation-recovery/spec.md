# Spec Delta

## MODIFIED Requirements

### Requirement: Persisted target is restored before incomplete pass-through

The runtime SHALL resolve an active parameter collection first, then the current verified Function/Plugin route, before applying the semantic incomplete gate or bridge pass-through. A recovered Function SHALL be matched to the current enabled and authorized Plugin registration when the Function has a Plugin owner.

#### Scenario: Unknown semantic frame continues a verified route

- **WHEN** semantic extraction returns unknown intent or action and BehaviorContext contains a verified route
- **THEN** Runtime restores the exact Function and Plugin, preserves a legal action or enters structured clarification, and does not return pass-through solely because the frame is incomplete

#### Scenario: Stable route recovers a generic continuation

- **WHEN** the current session has a verified Function/Plugin route and the user sends a generic continuation such as modifying, retrying or executing the current request, but semantic extraction omits intent or action
- **THEN** the runtime restores that exact registered target and does not return `pass_through` solely because the current frame is incomplete

#### Scenario: Parameter collection keeps its Function target

- **WHEN** a parameter collection is active and the next user input supplies or changes a field without naming the Function
- **THEN** the runtime keeps the collection's Function/Plugin target and sends the new value through the same installed input Schema

#### Scenario: Function exists but its Plugin is unavailable

- **WHEN** a persisted Function resolves to a disabled, missing or unauthorized Plugin
- **THEN** Runtime returns stable unavailable or clarification state and never invokes the Function Handler or asks a model to fabricate execution