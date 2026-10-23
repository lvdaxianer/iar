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

### Requirement: Context slots are merged by named schema fields

Recovered parameter values SHALL be merged by declared field name, with current-turn values taking precedence over previously validated values. Unknown names, invalid types, invalid enum values and missing required fields SHALL remain unexecutable and SHALL produce structured parameter clarification.

#### Scenario: Current field overrides history

- **WHEN** a collection contains a validated historical field and the current input supplies the same field with a schema-compatible value
- **THEN** the current value is retained and the historical value cannot overwrite it

#### Scenario: Operation identity is inherited while a new parameter is collected

- **WHEN** a previous validated route established an operation and a continuation supplies only a new operation parameter
- **THEN** the runtime keeps the prior named operation field, validates the new parameter by name and continues to policy/confirmation without asking the model to repeat the operation positionally

#### Scenario: User cancels parameter collection

- **WHEN** a user declines to provide a requested parameter or starts a new topic
- **THEN** Runtime clears the collection and pending action, records the cancellation/new-topic event and does not execute the prior Function
